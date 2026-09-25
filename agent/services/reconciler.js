import { isOurs, parseLabel, labelIntentId, ownedByIntent } from '../lib/trade-labels.js'
import { recordTradePlan, planProblems, PLAN_ABSURD_RISK_FRACTION } from './trade-plans.js'
import { normPosId } from '../lib/pos-id.js'
import { getState, setState as setAgentState, closeTradeRow } from '../db.js'
import { contractSize } from '../lib/contracts.js'
import { lotsFromUnits } from '../lib/lot-size-registry.js'
import { recordPositionEvent } from './position-events.js'

// cTrader `tradeData.volume` is in units × 100. The whole risk/keeper stack
// treats `trades.volume` as LOTS (bot-placed rows store lots; the keeper does
// lots × meta.lotSize to scale out; the risk margin gate feeds it to
// notionalUsd, which multiplies by contractSize). Storing raw broker units in
// that column made an adopted FX position's notional ~100,000× too large — a
// ~$700M phantom "used margin" that vetoed every new trade with
// `insufficient_margin` and corrupted the keeper's scale-out maths. Convert to
// lots: lots = (volume / 100) / unitsPerLot, unitsPerLot = contractSize(symbol)
// (100k for FX, 1 for indices/crypto). Returns null when volume is absent.
// SECOND SOURCE OF TRUTH, REMOVED (2026-08-06). `contractSize` is a hardcoded
// table that returns 1 for anything unlisted — including every `.HK` share CFD,
// whose real lot is ~60 or ~18 units. An adopted 0003.HK position converted
// through the table becomes 5,000 lots instead of ~83, and that figure feeds the
// margin gate. The broker's own declaration, recorded at order time by
// lot-size-registry.js, now wins; the table remains the fallback for a symbol
// the broker has never described to us. `db` is optional so every existing
// caller keeps working — without it the behaviour is exactly as before.
export function brokerVolumeToLots(bp, symbol, db = null) {
  const units = bp?.tradeData?.volume ? bp.tradeData.volume / 100 : null
  if (units == null) return null
  if (db != null) {
    const { lots } = lotsFromUnits(db, symbol, units)
    if (lots != null) return lots
  }
  const perLot = contractSize(symbol) || 1
  return perLot > 0 ? units / perLot : units
}
// PRODUCER → STRATEGY, for a label that carries no strategy field of its own
// (20-09-2026). The sidecar's tick firer writes `tick:<profileHash>|…|i<id>`:
// field 2 is empty, so parseLabel().strategy is null and the adopted row used
// to land with a blank Strategy column — the attribution loss trade-labels.js
// already records against va_breakout/fvg_retrace, arriving by a different
// door. The intent row names the producer, and the producer names exactly one
// strategy, so the fact is recoverable. `parsed.strategy` still wins wherever
// the label has one; this only fills a hole.
const PRODUCER_STRATEGY = Object.freeze({
  tick_momentum: 'tick_momentum_breakout',
})

/** The producer and resolved state of an intent, for the adoption thesis. Never throws. */
function intentMeta(db, intentId) {
  try {
    const r = db.prepare('SELECT producer_id, state FROM entry_intents WHERE id = ?').get(String(intentId || ''))
    return r ? { producerId: r.producer_id || null, state: String(r.state || '').toUpperCase() || null } : { producerId: null, state: null }
  } catch { return { producerId: null, state: null } }
}

// A permit that was WITHDRAWN and then fired anyway (20-09-2026, checker
// round). `ownedByIntent` is state-agnostic on purpose — an intent that is not
// open, with a live position at the broker, is this repo's ambiguous-
// submission shape, and live risk owned by nobody is the worse failure — but
// it is still a fence breach, and the thesis alone would record it as an
// ordinary adoption. So ownership does not change and the breach is made
// legible: the state goes into the thesis and an `action_log` row names it.
//
// THREE STATES, and the third is the sharpest:
//   REJECTED — the authority refused the entry and it happened anyway.
//   RELEASED — the permit was handed back, then spent.
//   EXPIRED  — the permit was spent past its own TTL. Worse than the other
//              two because nothing withdrew it: the sidecar simply ignored
//              the clock it was given, so the failure is in the thing that
//              enforces the window rather than in a race against a withdrawal.
// Any other state is a normal resolution and writes nothing.
const BREACH_STATES = new Set(['REJECTED', 'RELEASED', 'EXPIRED'])

/** M4: see the call site in reconcilePositions. Returns what was stamped, or null. */
export function stampAdoptedFromIntent(db, { tradeId, label, parsed, acct, symbolName, side, entry, sl, tp }) {
  try {
    const tag = labelIntentId(String(label || ''))
    if (!tag || acct == null) return null
    const it = db.prepare(`SELECT * FROM entry_intents WHERE id = ? AND account_id = ?`).get(tag, String(acct))
    if (!it) return null
    const origin = String(it.order_type || 'MARKET').toUpperCase() === 'MARKET' ? 'bot_market_dispatch' : 'bot_pending_fill'
    const sideWord = side === 'long' ? 'BUY' : 'SELL'
    const strategy = (parsed?.strategy && parsed.strategy !== 'other' ? parsed.strategy : null)
      || PRODUCER_STRATEGY[String(it.producer_id || '')] || null
    const createdMs = Date.parse(it.created_at)
    // PR-1b (20-09-2026): the intent may already NAME its risk event. The
    // window below is anchored on the intent's created_at, and a STANDING
    // tick permit is reserved by the feeder pass minutes-to-hours before its
    // fill — so for a tick fill the window misses by construction and the
    // close died with `missing: direction_reason` (…0949, COIN.US). The fire
    // ledger stamps entry_intents.risk_event_id from the sidecar's own fire
    // ring; when it is there it IS the answer. Strictly additive: an intent
    // without one takes the same window as before.
    let riskEventId = it.risk_event_id ?? null
    if (riskEventId == null && Number.isFinite(createdMs)) {
      const ev = db.prepare(`SELECT id FROM risk_events WHERE account_id = ? AND symbol = ? AND side = ? AND approved = 1
        AND created_at <= ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(String(acct), symbolName, sideWord, new Date(createdMs).toISOString(), new Date(createdMs - 5 * 60_000).toISOString())
      riskEventId = ev?.id ?? null
    }
    db.prepare(`UPDATE trades SET origin = ?, origin_source = 'write', strategy = COALESCE(strategy, ?), risk_event_id = COALESCE(risk_event_id, ?) WHERE id = ?`)
      .run(origin, strategy, riskEventId, tradeId)
    db.prepare(`UPDATE monitored_positions SET strategy = COALESCE(strategy, ?) WHERE trade_id = ?`).run(strategy, tradeId)
    const hasPlan = db.prepare(`SELECT 1 FROM trade_plans WHERE trade_id = ?`).get(tradeId)
    if (!hasPlan) {
      // X1 / W3 (25-09-2026): the intent's sl/tp are in the units the order
      // carried them (entry_intents.sl_units / tp_units). A relative leg is
      // wire points — never a price: it becomes one from the fill (`entry`,
      // the broker's open price the relative bracket was applied to). Before
      // this, `it.sl` went in as a price: #1686 JPM.US planned_sl 1,732,000.
      // A pre-X1 row recorded no units: its value is read as a price only
      // when it IS price-shaped for this entry (right side, within
      // planProblems' scale). Wire points cannot pass that test — a stop
      // 0.1–5 % away is 100–5,000× the price in points — so they fall back to
      // the broker's own stop / target on the position.
      const dir = sideWord === 'BUY' ? 1 : -1
      const e = Number(entry)
      const haveEntry = entry != null && Number.isFinite(e) && e > 0
      const legPrice = (value, units, sign, leg) => {
        const v = Number(value)
        if (value == null || !Number.isFinite(v)) return null
        if (units === 'price') return v
        if (units === 'relative_points') return haveEntry ? e + sign * dir * v / 100_000 : null
        // planProblems judges the stop's scale only; the target's is judged here.
        if (units == null && haveEntry && planProblems({ side: sideWord, entry: e, [leg]: v }).length === 0
          && Math.abs(v - e) / e <= PLAN_ABSURD_RISK_FRACTION) return v
        return null
      }
      recordTradePlan(db, tradeId, {
        accountId: acct, symbol: symbolName, side: sideWord, strategy, timeframe: parsed?.timeframe || null,
        entry: entry ?? null,
        sl: legPrice(it.sl, it.sl_units, -1, 'sl') ?? sl ?? null,
        tp: legPrice(it.tp, it.tp_units, +1, 'tp') ?? tp ?? null,
        source: 'reconciler_adopted_intent',
      })
    }
    return { intentId: tag, origin, strategy, riskEventId }
  } catch {
    return null
  }
}


/** The reconciler's generic stamp for a close it cannot attribute. */
export const GENERIC_BROKER_CLOSE = 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot'

/**
 * WHO closed this position, read from the ledgers the bot's own closers
 * write BEFORE the reconciler sees the position gone (fix-the-exits BA,
 * owner principle 4: every trade has a reason).
 *
 * The comment that used to sit on the close-detection loop claimed "a close
 * the bot performs stamps its own close_reason via markTradeClosed before
 * reconcile ever sees the position gone". Measured 18-09-2026 on …0949: of
 * 40 recent closes, 18 carried the generic stamp and 11 of those were bot
 * trades the keeper, the guardian, the ratchet, the trade guard or the
 * momentum book had closed — none of the five writes the trade row at send
 * time (and the book must not: exit_sent is the broker's acceptance, not
 * the fill). What they DO write is a position_events row (kind `close` /
 * `loss_cap_close`) or a momentum_book `exit_sent` row, so the attribution
 * lives here, at the one place that turns "gone at the broker" into a
 * close_reason, reading those two ledgers.
 *
 * `scale_out` is deliberately NOT a close: a partial take-profit leaves the
 * position open, and a later SL fill must not be blamed on the guard.
 *
 * Returns `<source>: <reason>` from the newest close event, `momentum_book:
 * <note>` from an exit_sent row, or null when neither ledger knows — the
 * caller then keeps the generic stamp, which is what it is: not attributed.
 */
export function attributeBrokerClose(db, { positionId = null, tradeId = null, accountId = null } = {}) {
  const pid = positionId != null ? normPosId(positionId) : null
  try {
    if (pid != null || tradeId != null) {
      const ev = db.prepare(
        `SELECT source, reason, kind FROM position_events
          WHERE kind IN ('close', 'loss_cap_close')
            AND ((? IS NOT NULL AND position_id = ?) OR (? IS NOT NULL AND trade_id = ?))
          ORDER BY id DESC LIMIT 1`
      ).get(pid, pid, tradeId, tradeId)
      if (ev) {
        const src = ev.source || 'bot'
        const why = ev.reason || ev.kind
        return `${src}: ${why}`
      }
    }
    if (pid != null) {
      const book = db.prepare(
        `SELECT note FROM momentum_book WHERE status = 'exit_sent' AND position_id = ?
            ${accountId != null ? 'AND account_id = ?' : ''}
          ORDER BY id DESC LIMIT 1`
      ).get(...(accountId != null ? [pid, String(accountId)] : [pid]))
      if (book) return `momentum_book: ${book.note || 'exit sent'}`
    }
    // Wave 2 (§K·8): a close on a row the BOOK holds with no journal entry is
    // the book's broker-side stop (its 3×ATR trail is amended at the broker,
    // so the fill leaves no event) — named as such, not "closed at the
    // broker (manual close …)". Matched on either key, exit_sent or open.
    if (pid != null || tradeId != null) {
      const held = db.prepare(
        `SELECT status, note FROM momentum_book
          WHERE status IN ('open', 'exit_sent')
            AND ((? IS NOT NULL AND position_id = ?) OR (? IS NOT NULL AND trade_id = ?))
            ${accountId != null ? 'AND account_id = ?' : ''}
          ORDER BY id DESC LIMIT 1`
      ).get(...[pid, pid, tradeId, tradeId, ...(accountId != null ? [String(accountId)] : [])])
      if (held) return held.status === 'exit_sent' ? `momentum_book: ${held.note || 'exit sent'}` : 'momentum_book: broker-side stop fill (3×ATR trail)'
    }
  } catch { /* attribution is best-effort; the generic stamp stays */ }
  return null
}


/**
 * Reconcile the agent's local DB against live broker positions/orders.
 *
 * - Detects externally-placed positions and imports them (source='external')
 * - Detects positions closed at the broker and marks them locally
 * - Detects MANUAL CHANGES to tracked positions (owner tampering in the
 *   cTrader app: reversed side, changed volume, hand-moved SL/TP) — alerts
 *   and adopts the broker truth so the monitor manages reality
 * - Stores pending orders snapshot for the frontend
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array} brokerPositions — from RECONCILE_RES, enriched with symbolName
 * @param {Array} brokerOrders — pending limit/stop orders from RECONCILE_RES
 * @param {(key: string, value: string) => void} setState
 * @param {{accountId?: string|number}} [opts] — M2: scope this pass to ONE
 *   account. The broker snapshot passed in is one account's truth, so every
 *   absence-implies-closed sweep below (closed detection, orphan sweep,
 *   orders-gone) must only judge THAT account's rows — otherwise account B's
 *   snapshot "closes" account A's perfectly-live positions. NULL-account
 *   legacy rows belong to the SELECTED account only (they predate stamping,
 *   which only ever happened while that account was the one trading).
 * @returns {{ newExternal: Array, closedDetected: Array, manualChanges: Array, pendingOrders: Array }}
 */
export function reconcilePositions(db, brokerPositions, brokerOrders, setState, opts = {}) {
  const selected = getState(db, 'ctrader_account_id') || null
  const acct = opts.accountId != null ? String(opts.accountId) : selected
  const includeNull = acct == null || acct === selected
  // SQL fragment + params scoping a table's rows to this pass's account.
  const scope = (col) => acct == null
    ? { sql: '', params: [] }
    : includeNull
      ? { sql: `AND (${col} = ? OR ${col} IS NULL)`, params: [acct] }
      : { sql: `AND ${col} = ?`, params: [acct] }

  const mpScope = scope('mp.account_id')
  // Position ids can overlap across broker accounts/hosts. Relinking,
  // closing and duplicate cleanup must share the snapshot's account scope.
  const tScope = scope('account_id')
  const knownRows = db.prepare(
    `SELECT mp.id, mp.symbol, mp.source, mp.side, mp.entry_price, mp.current_sl, mp.current_tp,
            mp.broker_volume_units, mp.broker_sl, mp.broker_tp, mp.trade_id, mp.be_moved,
            t.ctrader_position_id, t.volume AS tradeVolume, t.broker_sl_initial
     FROM monitored_positions mp
     LEFT JOIN trades t ON t.id = mp.trade_id
     WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL ${mpScope.sql}`
  ).all(...mpScope.params)

  // normPosId, never bare String: rows written before the pos-id repair
  // migration may carry "234698574.0" — a raw-string set would call the
  // broker's "234698574" unknown and re-adopt it as a duplicate.
  const knownIds = new Set(knownRows.map(r => normPosId(r.ctrader_position_id)))
  const knownById = new Map(knownRows.map(r => [normPosId(r.ctrader_position_id), r]))
  const brokerIds = new Set()

  const newExternal = []
  const manualChanges = []
  // Kept SEPARATE from manualChanges on purpose. manualChanges means "the
  // owner touched this at the broker" and drives an alert; a resync means
  // "our cache had gone stale and we corrected it", which is bookkeeping.
  // Filing one as the other would put a Telegram siren on our own drift.
  const ledgerSynced = []
  const relinked = []

  // Two-pass memory for the convergence rule below: `sl:<posId>` / `tp:<posId>`
  // → the disagreement signature we saw last time. Bounded by the number of
  // open positions, and entries are deleted the moment a row agrees again.
  // Read and write the SAME account namespace, independently of the caller's
  // state callback (primary is global; other callers wrap it per account).
  // Do not inherit the old global watch: its observations have no owner.
  const RESYNC_WATCH_KEY = acct == null ? 'ledger_resync_watch_json' : `acct:${acct}:ledger_resync_watch_json`
  let resyncWatch = {}
  try { resyncWatch = JSON.parse(getState(db, RESYNC_WATCH_KEY) || '{}') || {} } catch { resyncWatch = {} }

  // Price-scale-aware "did it really change" — null↔value counts as a change.
  const differs = (a, b) => {
    if (a == null && b == null) return false
    if (a == null || b == null) return true
    return Math.abs(Number(a) - Number(b)) > Math.max(1e-9, Math.abs(Number(b)) * 1e-6)
  }

  for (const bp of brokerPositions) {
    const posId = normPosId(bp.tradeData?.positionId ?? bp.positionId) ?? ''
    if (!posId) continue
    brokerIds.add(posId)

    if (knownIds.has(posId)) {
      // -----------------------------------------------------------------
      // TAMPER WATCH — the position is OURS and still open; compare the
      // broker's live shape against what we last saw / what we manage.
      // Bot-initiated changes don't trip this: bot amends update
      // current_sl/current_tp first (so the broker matches us), and bot
      // partial closes NULL the broker_volume_units baseline before the
      // next reconcile.
      // -----------------------------------------------------------------
      const row = knownById.get(posId)
      const bSide = (bp.tradeData?.tradeSide === 'BUY' || bp.tradeData?.tradeSide === 1) ? 'long' : 'short'
      const bVol = bp.tradeData?.volume ? bp.tradeData.volume / 100 : null
      const bSl = bp.stopLoss ?? null
      const bTp = bp.takeProfit ?? null
      const bPrice = bp.price ?? bp.tradeData?.openPrice ?? null
      const updates = {}

      // SELF-HEAL A MISSING ENTRY PRICE. `bPrice` is broker truth and has been
      // sitting right here on every pass all along, but it was only ever
      // applied when the SIDE reversed — a rare manual flip. A row that simply
      // never got an entry price (loop.js wrote the order ACK's fill price,
      // which can be absent) stayed null forever, and two separate downstream
      // calculations broke on it: the time cap could not be evaluated (#580),
      // and the SL/TP money column reported notional instead of risk (#581).
      //
      // Only ever fills a NULL. It never overwrites a recorded entry — the
      // stored price is the fill this system actually saw, and a later broker
      // snapshot of an averaged or partially-closed position is not a better
      // answer to "what did we get in at".
      if (row.entry_price == null && bPrice != null) {
        updates.entry_price = bPrice
      }

      if (row.side && bSide !== row.side) {
        manualChanges.push({ kind: 'reversed', symbol: row.symbol, positionId: posId, from: row.side, to: bSide })
        updates.side = bSide
        updates.entry_price = bPrice ?? row.entry_price
        updates.current_sl = bSl
        updates.current_tp = bTp
        updates.thesis_note = `MANUAL REVERSAL detected at broker (${row.side}→${bSide}) — monitor now manages the new direction on technicals`
      }
      if (row.broker_volume_units != null && bVol != null && differs(bVol, row.broker_volume_units)) {
        manualChanges.push({ kind: 'volume', symbol: row.symbol, positionId: posId, from: row.broker_volume_units, to: bVol })
        // A VOLUME THAT FELL IS A PARTIAL CLOSE (V3 B1 checker blocker).
        // loop.js PARTIAL_EXIT nulls this baseline first, so a fall seen here
        // was made by hand in cTrader or by a partial writer that does not
        // reset the baseline (the keeper, the trade guard, the momentum
        // partial manager — each also leaves its own evidence). Recorded as
        // indexed evidence for the full close (lib/deal-money.js
        // openedVolumeOnRecord): without it a manual partial left the later
        // FULL_EXIT with held = closed volume, writing ONE deal's money for the
        // whole position (#714's defect, by the manual route). Recorded HERE,
        // on every account's pass — loop.js's TAMPER alert is reached by the
        // primary pass only. A distinct kind: it moves no management state
        // (position-events.js) and names what was observed, not who did it.
        if (Number(bVol) < Number(row.broker_volume_units)) {
          recordPositionEvent(db, {
            accountId: acct, positionId: posId, tradeId: row.trade_id ?? null, symbol: row.symbol,
            kind: 'volume_reduced', fromValue: row.broker_volume_units, toValue: bVol, source: 'reconciler',
            reason: 'broker volume fell between reconcile passes (tamper watch): a partial close, writer not identified',
          })
        }
      }
      if (!updates.side) { // side flip already adopts SL/TP wholesale
        if (row.broker_sl != null && differs(bSl, row.broker_sl) && differs(bSl, row.current_sl)) {
          manualChanges.push({ kind: 'sl_moved', symbol: row.symbol, positionId: posId, from: row.broker_sl, to: bSl })
          updates.current_sl = bSl
        }
        if (row.broker_tp != null && differs(bTp, row.broker_tp) && differs(bTp, row.current_tp)) {
          manualChanges.push({ kind: 'tp_moved', symbol: row.symbol, positionId: posId, from: row.broker_tp, to: bTp })
          updates.current_tp = bTp
        }

        // -------------------------------------------------------------
        // LEDGER CONVERGENCE — adopt broker truth on a standing
        // DISAGREEMENT, not only on a broker-side CHANGE.
        //
        // The branch above reacts to an event: `differs(bSl, row.broker_sl)`
        // asks "did the broker's stop move since last pass?". So a ledger
        // that drifts out of step while the broker's stop then sits still
        // is never repaired — `bSl === row.broker_sl` on every subsequent
        // pass, no update fires, and `current_sl` stays wrong forever.
        //
        // That is not theoretical: it is the other half of the
        // POSITION_STOP_MISMATCH noise. naked-position-guard flags
        // `phantom` whenever our stop disagrees with the broker's by more
        // than 0.1%, and protection_audit runs every loop cycle — so one
        // stuck row emits a finding every few minutes indefinitely, while
        // the component that could fix it is structurally unable to.
        //
        // WHY IT TAKES TWO PASSES. Bot amends write current_sl and let the
        // broker catch up, so "ledger ahead of broker" is a NORMAL transient.
        // Reconcile runs at loop phase 0 while amends run later in the cycle
        // AND from the 3s fast-monitor ticker, so an amend genuinely can be
        // in flight when a snapshot is taken. Adopting the broker's value
        // there would revert a stop the bot had just tightened.
        //
        // So convergence requires the SAME disagreement — same ledger value,
        // same broker value — observed on two consecutive reconciles. An
        // in-flight amend resolves long before that (the next snapshot shows
        // the new stop, and the tamper-watch branch above adopts it); a
        // genuinely stale row reproduces the identical pair indefinitely.
        // Nothing is converged on first sighting, by construction.
        const sig = (a, b) => `${a == null ? '' : Number(a)}|${b == null ? '' : Number(b)}`
        if (!('current_sl' in updates) && differs(bSl, row.current_sl)) {
          const s = sig(row.current_sl, bSl)
          if (resyncWatch[`sl:${posId}`] === s) {
            ledgerSynced.push({
              kind: 'sl_resync', symbol: row.symbol, positionId: posId,
              from: row.current_sl, to: bSl,
            })
            updates.current_sl = bSl
            delete resyncWatch[`sl:${posId}`]
          } else {
            resyncWatch[`sl:${posId}`] = s
          }
        } else {
          delete resyncWatch[`sl:${posId}`]
        }
        if (!('current_tp' in updates) && differs(bTp, row.current_tp)) {
          const s = sig(row.current_tp, bTp)
          if (resyncWatch[`tp:${posId}`] === s) {
            ledgerSynced.push({
              kind: 'tp_resync', symbol: row.symbol, positionId: posId,
              from: row.current_tp, to: bTp,
            })
            updates.current_tp = bTp
            delete resyncWatch[`tp:${posId}`]
          } else {
            resyncWatch[`tp:${posId}`] = s
          }
        } else {
          delete resyncWatch[`tp:${posId}`]
        }
      }

      db.prepare(
        `UPDATE monitored_positions SET
           side = COALESCE(?, side),
           entry_price = COALESCE(?, entry_price),
           current_sl = CASE WHEN ? = 1 THEN ? ELSE current_sl END,
           current_tp = CASE WHEN ? = 1 THEN ? ELSE current_tp END,
           thesis = CASE WHEN ? IS NOT NULL THEN (COALESCE(thesis, '') || ' | ' || ?) ELSE thesis END,
           broker_volume_units = ?, broker_sl = ?, broker_tp = ?
         WHERE id = ?`
      ).run(
        updates.side ?? null,
        updates.entry_price ?? null,
        'current_sl' in updates ? 1 : 0, updates.current_sl ?? null,
        'current_tp' in updates ? 1 : 0, updates.current_tp ?? null,
        updates.thesis_note ?? null, updates.thesis_note ?? null,
        bVol, bSl, bTp,
        row.id,
      )

      // THE STOP AS THE BROKER FIRST HELD IT (02-09-2026). sl_price is the
      // proposal's stop; the broker re-anchors to the fill, so the stop that
      // actually existed differed on 5 of 5 day-one trades and realised R
      // read up to 2R off. Stamped ONCE, and only before any break-even move
      // — a trailed stop is not the risk taken at entry.
      if (row.trade_id && row.broker_sl_initial == null && Number(bSl) > 0 && !row.be_moved) {
        try {
          db.prepare(`UPDATE trades SET broker_sl_initial = ? WHERE id = ? AND broker_sl_initial IS NULL`).run(Number(bSl), row.trade_id)
        } catch { /* a forensics column must never fail the reconcile */ }
      }

      // SELF-HEAL the legacy units-in-lots-column bug: earlier adoptions wrote
      // broker UNITS into trades.volume (a lots column), so the aggregate margin
      // gate read a ~100,000× notional and vetoed all new trades. Using live
      // broker truth, rewrite trades.volume to the correct LOTS. Precise trigger
      // — only when the stored value equals the raw broker UNITS (the exact bug
      // signature) and that differs from the true lots (i.e. contractSize > 1),
      // or when it's missing. A correctly-sized lots row is never touched.
      const healUnits = bp?.tradeData?.volume ? bp.tradeData.volume / 100 : null
      const healLots = brokerVolumeToLots(bp, row.symbol, db)
      if (row.trade_id && healLots != null && healLots > 0 && healUnits != null) {
        const cur = Number(row.tradeVolume)
        const looksLikeUnits = cur > 0 && Math.abs(cur - healUnits) <= Math.max(1e-9, healUnits * 0.01)
        const needsHeal = (!(cur > 0) || looksLikeUnits) && Math.abs(cur - healLots) > healLots * 0.01
        if (needsHeal) {
          db.prepare(`UPDATE trades SET volume = ? WHERE id = ?`).run(healLots, row.trade_id)
        }
      }
      continue
    }

    // A broker position with no local active row is ADOPTED so the bot's
    // view matches the broker (owner saw 4 at the broker, 1 shown). Two
    // kinds:
    //  · ours-labelled but untracked → a bot fill whose local row was never
    //    written (the exec response lacked a positionId). Adopt as a BOT
    //    position (source from the label) and MANAGE it — previously this
    //    was `continue`, so those fills stayed invisible forever.
    //  · foreign label → a manual/external position: import observe-only.
    const label = bp.tradeData?.label || bp.label || ''
    const parsed = parseLabel(label)
    // A TICK FILL IS OURS EVEN THOUGH ITS LABEL SAYS NOTHING WE KNOW
    // (20-09-2026). The sidecar labels `tick:<profileHash>|||||||i<intentId>`;
    // field 0 matches no SOURCES code, so isOurs() is false and this fill —
    // sent by this system, off a permit this system reserved — landed as
    // `external`: observe-only, skipped by the fast monitor, the equity stop,
    // the session-open guard, the naked-position guard and exit-mark stamping.
    // Ownership is therefore read from the LEDGER (trade-labels.ownedByIntent):
    // the tag's entry_intents row, on THIS account, from an automatic producer.
    // Stamped `autopilot`, the row is indistinguishable from a bar entry to all
    // six source whitelists, with no edit to any of them.
    //
    // Cost bound: the label check is free and runs first; the query only
    // happens for a label that actually carries an `i…` tag.
    const labelOurs = isOurs(label)
    const intentTag = labelOurs ? null : labelIntentId(label)
    const byIntent = intentTag ? ownedByIntent(db, label, acct) : false
    const ours = labelOurs || byIntent
    const intentInfo = byIntent ? intentMeta(db, intentTag) : { producerId: null, state: null }
    const breach = byIntent && BREACH_STATES.has(String(intentInfo.state || ''))
    const adoptedSource = byIntent ? 'autopilot' : (labelOurs ? (parsed.source || 'autopilot') : 'external')
    const thesis = byIntent
      ? `Adopted bot position — intent ${intentTag} (${intentInfo.producerId || 'unknown producer'})${breach ? ` — PERMIT ${intentInfo.state}: fired past a withdrawn permit` : ''}; local row was missing`
      : ours
        ? `Adopted bot position — label ${adoptedSource}${parsed.strategy ? `/${parsed.strategy}` : ''} (reconciled; local row was missing)`
        : 'External position — reconciliation import'

    const side = bp.tradeData?.tradeSide === 'BUY' || bp.tradeData?.tradeSide === 1 ? 'long' : 'short'
    const entry = bp.tradeData?.openPrice ?? bp.price ?? null
    const sl = bp.stopLoss ?? null
    const tp = bp.takeProfit ?? null
    const symbolName = bp.symbolName || `ID:${bp.tradeData?.symbolId || '?'}`
    // Store LOTS (not raw broker units) so the risk/keeper stack reads it right.
    const volume = brokerVolumeToLots(bp, symbolName, db)
    const initialRisk = (entry && sl) ? Math.abs(entry - sl) : null

    // DUPLICATE-ADOPTION GUARD: we only reach here because no ACTIVE monitored
    // row maps to this posId — but a trade for it may STILL exist 'open' with a
    // merely-inactive monitored row (a manage cycle marked it closed while the
    // broker position lived on). Inserting a fresh trade every reconcile is what
    // ballooned openTrades (85→155 while the bot was stopped). If an open trade
    // for this posId already exists, RE-LINK its management instead of spawning
    // a second row.
    const existingOpen = db.prepare(
      `SELECT id FROM trades WHERE ctrader_position_id = ? AND status = 'open' ${tScope.sql} ORDER BY id DESC LIMIT 1`
    ).get(posId, ...tScope.params)
    if (existingOpen) {
      // reaching this branch at all means `trades` still says 'open' but no
      // ACTIVE monitored_positions row maps to this broker position — the
      // trade and its management have desynced. Two shapes, both worth
      // surfacing (this used to happen silently, fixed only by a log line):
      //   · a row exists but isn't 'active' — something closed it locally
      //     while the broker kept the position open (e.g. the LLM-monitor
      //     EXIT-without-broker-close bug, fixed 2026-07-22) — re-activate it.
      //   · no row exists at all — the bot's fill never got one written
      //     (exec response lacked a positionId) — create it fresh.
      const mp = db.prepare(
        `SELECT id, status FROM monitored_positions WHERE trade_id = ? ORDER BY (status='active') DESC, id DESC LIMIT 1`
      ).get(existingOpen.id)
      const desyncKind = mp ? 'reactivated_closed_row' : 'created_missing_row'
      if (mp) {
        db.prepare(`UPDATE monitored_positions SET status='active' WHERE id = ?`).run(mp.id)
      } else {
        db.prepare(`
          INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
            thesis, initial_risk, source, strategy, label_raw, account_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(symbolName, existingOpen.id, side, entry, sl, tp, thesis, initialRisk,
          adoptedSource, parsed.strategy || null, label || null, acct)
      }
      relinked.push({ symbol: symbolName, positionId: posId, tradeId: existingOpen.id, desyncKind })
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'RECONCILE_DESYNC', '/reconcile',
          JSON.stringify({
            symbol: symbolName, positionId: posId, tradeId: existingOpen.id, kind: desyncKind,
            detail: desyncKind === 'reactivated_closed_row'
              ? 'monitored_positions row was closed locally while the broker position was still open — re-activated to match broker truth'
              : 'trade was open with no monitored_positions row at all (fill never got one written) — created fresh',
          }).slice(0, 2000)
        )
      } catch { /* audit best-effort */ }
      continue
    }

    const inserted = db.transaction(() => {
      // account_id stamped on BOTH rows (the trades stamp was missing until
      // M2 — adopted trades landed with NULL account and leaned on the
      // backfill's selected-account assumption).
      const tradeInsert = db.prepare(`
        INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
          ctrader_position_id, source, label_raw, label_strategy, account_id, status,
          origin, origin_source)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, 'open', 'reconciler_adopted', 'write')
      `).run(symbolName, side === 'long' ? 'BUY' : 'SELL', entry, sl, tp, volume, posId,
        adoptedSource, label || null, parsed.strategy || null, acct)
      // ADOPTED, and it says so. `parsed.strategy` above is the label found on
      // the broker's position, not a decision this system made — recording it
      // is right, presenting it as strategy edge is not. Phase 6 of the
      // Verified Defect Repair prompt: "Reconciliation must not invent a
      // strategy."  
      const tradeId = tradeInsert.lastInsertRowid

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
          thesis, initial_risk, source, strategy, label_raw, account_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(symbolName, tradeId, side, entry, sl, tp, thesis, initialRisk,
        adoptedSource, parsed.strategy || null, label || null, acct)

      return tradeId
    })()

    // PR-E M4 (checker, 11-09-2026): an adopted position whose label carries
    // an INTENT TAG is a fill this system sent (the ledger row is the
    // decision) whose local trade row was lost. Stamp it as the bot trade
    // it is — origin by the intent's order type, strategy from the label,
    // the approval id as the nearest approved risk event on the same
    // account / symbol / side in the five minutes before the intent was
    // reserved (the gate runs before reserveEntry), and the plan from the
    // intent's own stop and target. Best-effort: a stamp that fails leaves
    // the row reconciler_adopted, which findUnreasonedTrades then lists as
    // adopted_ours_unreasoned rather than hiding.
    const stamped = ours ? stampAdoptedFromIntent(db, { tradeId: inserted, label, parsed, acct, symbolName, side, entry, sl, tp }) : null

    // The breach is journalled AFTER the row exists, so the log line names a
    // trade that can be looked up. It changes nothing about ownership.
    if (breach) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'FENCE_BREACH_ADOPTED', '/reconcile',
          JSON.stringify({
            intentId: intentTag, state: intentInfo.state, producerId: intentInfo.producerId,
            account: `…${String(acct ?? '').slice(-4)}`, symbol: symbolName, positionId: posId, tradeId: inserted,
            detail: 'a position is live at the broker against an intent that was not open — adopted so it is managed, recorded so the breach is not silent',
          }).slice(0, 2000)
        )
      } catch { /* audit best-effort — never fail a reconcile over a log row */ }
      console.warn(`[reconcile] FENCE BREACH adopted: intent ${intentTag} state ${intentInfo.state} account …${String(acct ?? '').slice(-4)} trade ${inserted}`)
    }

    newExternal.push({ symbol: symbolName, side, entry, positionId: posId, adopted: ours, source: adoptedSource, tradeId: inserted, ...(breach ? { fenceBreach: intentInfo.state } : {}), ...(stamped ? { stampedFromIntent: stamped } : {}) })
  }

  const closedDetected = []
  for (const row of knownRows) {
    if (!brokerIds.has(normPosId(row.ctrader_position_id))) {
      db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE id = ?`).run(row.id)
      // Say WHO closed it, or at least who didn't. The bot's own closers
      // (keeper, guardian, ratchet, loss cap, momentum book) close at the
      // broker and journal the act; the trade row is closed HERE, on the
      // next pass, when the position is gone — so this is where the journal
      // is read (attributeBrokerClose). No journal entry → it happened at
      // the broker (manual close in cTrader, or a broker-side SL/TP fill),
      // and the generic stamp says so; reclassifyBrokerCloses later upgrades
      // it to SL/TP once the exit price is known. Owner hit the blank version
      // live: a manual DOW.US short closed in under 5 minutes and the ledger
      // had nothing to say beyond the exit price ("it didn't say what happen").
      // ctrader_position_id, not a single trade id — could match more than one
      // 'open' row (the dedup sweep further down handles that garbage case).
      const openIds = db.prepare(
        `SELECT id FROM trades WHERE ctrader_position_id = ? AND status = 'open' ${tScope.sql}`
      ).all(normPosId(row.ctrader_position_id), ...tScope.params)
      for (const { id } of openIds) {
        const attributed = attributeBrokerClose(db, { positionId: row.ctrader_position_id, tradeId: id, accountId: acct })
        closeTradeRow(db, id, { closeReason: attributed || GENERIC_BROKER_CLOSE })
      }
      closedDetected.push({ symbol: row.symbol, positionId: row.ctrader_position_id, source: row.source })
    }
  }

  // ORPHAN SWEEP — the loop above only reaches trades linked to an ACTIVE
  // monitored_positions row. A trade left status='open' whose monitored row was
  // already closed (or never written) is invisible to it and lingers 'open'
  // forever. Live health showed 85 'open' trades vs 14 monitored positions —
  // ~71 phantom opens poisoning exposure caps, the duplicate-symbol veto, and
  // daily-loss math. Close any open trade whose broker position id is provably
  // NOT among the live broker positions. Trades still awaiting a fill
  // (ctrader_position_id IS NULL) are left untouched — they have no position to
  // be gone. Scoped to ids absent from brokerIds, so a live position is never
  // touched.
  // DEDUP existing garbage: prior re-adoption may have left several 'open'
  // trades sharing one broker positionId. Keep the newest per posId, close the
  // rest — the orphan sweep can't (their posId is still live at the broker).
  const dupsClosed = []
  let dedupError, dupPnlError
  try {
    const dups = db.prepare(
      `SELECT id, symbol, ctrader_position_id FROM trades
        WHERE status = 'open' AND ctrader_position_id IS NOT NULL ${tScope.sql}
          AND id NOT IN (
            SELECT MAX(id) FROM trades
             WHERE status = 'open' AND ctrader_position_id IS NOT NULL ${tScope.sql}
             GROUP BY ctrader_position_id
          )`
    ).all(...tScope.params, ...tScope.params)
    const closeDupMon = db.prepare(`UPDATE monitored_positions SET status='closed' WHERE trade_id = ? AND status='active'`)
    // Duplicates are marked REJECTED, not closed: a 'closed' dup row with
    // net_pnl NULL gets the SAME broker P&L stamped onto it by pnl-backfill
    // (it matches by ctrader_position_id), so one real loss was counted once
    // per duplicate row — the owner saw 4 identical USDIDR lesson cards,
    // -$487.76 each, reading as a ~$2k loss that never happened. 'rejected'
    // rows are excluded from every closed-trade stat and from backfill.
    const rejectDup = db.prepare(
      `UPDATE trades SET status='rejected', closed_at = datetime('now'),
              close_reason = 'duplicate reconcile adoption — superseded by the newest row for this position'
        WHERE id = ? AND status = 'open'`
    )
    const tx = db.transaction(() => {
      for (const d of dups) {
        rejectDup.run(d.id)
        closeDupMon.run(d.id)
        dupsClosed.push(d)
      }
    })
    tx()
  } catch (err) {
    // Best-effort still — but a sweep that threw must not return the same
    // empty `dupsClosed` as a sweep that found nothing. Reported once here
    // and surfaced by the loop's reconcile log.
    dedupError = err?.message || String(err)
    console.warn(`[reconciler] dedup sweep FAILED — ${dedupError}`)
  }

  // REPAIR historical duplicate-P&L garbage (idempotent): before the
  // 'rejected' change above, duplicate rows ended up status='closed' and
  // pnl-backfill stamped each with the SAME broker P&L — one real loss
  // counted N times in Performance. Any group of closed trades sharing one
  // ctrader_position_id with identical net_pnl keeps its ORIGINAL row (the
  // real adoption, MIN(id)) and rejects the rest, deleting their duplicate
  // postmortem/lesson cards. Partial closes are safe: the bot stamps those
  // on a single row, never as multiple rows per position id.
  const dupPnlRepaired = []
  try {
    const closedScope = scope('t.account_id')
    const olderScope = scope('o.account_id')
    const badRows = db.prepare(
      `SELECT t.id, t.symbol, t.ctrader_position_id FROM trades t
        WHERE t.status = 'closed' AND t.ctrader_position_id IS NOT NULL AND t.net_pnl IS NOT NULL ${closedScope.sql}
          AND t.id NOT IN (
            SELECT MIN(id) FROM trades
             WHERE status = 'closed' AND ctrader_position_id IS NOT NULL AND net_pnl IS NOT NULL ${tScope.sql}
             GROUP BY ctrader_position_id, net_pnl
          )
          AND EXISTS (
            SELECT 1 FROM trades o
             WHERE o.ctrader_position_id = t.ctrader_position_id
               AND o.net_pnl = t.net_pnl AND o.status = 'closed' AND o.id < t.id ${olderScope.sql}
          )`
    ).all(...closedScope.params, ...tScope.params, ...olderScope.params)
    const rejectRepair = db.prepare(
      `UPDATE trades SET status='rejected',
              close_reason = COALESCE(close_reason, '') || ' | repaired: duplicate row double-counting one broker P&L'
        WHERE id = ?`
    )
    const dropPm = db.prepare(`DELETE FROM trade_postmortems WHERE trade_id = ?`)
    const tx2 = db.transaction(() => {
      for (const r of badRows) {
        rejectRepair.run(r.id)
        try { dropPm.run(r.id) } catch { /* postmortems table may not exist yet */ }
        dupPnlRepaired.push(r)
      }
    })
    tx2()
    if (dupPnlRepaired.length > 0) {
      console.log(`[reconciler] repaired ${dupPnlRepaired.length} duplicate-P&L trade row(s): ${dupPnlRepaired.map(r => `${r.symbol}#${r.ctrader_position_id}`).join(', ')}`)
    }
  } catch (err) {
    dupPnlError = err?.message || String(err)
    console.warn(`[reconciler] duplicate-P&L repair FAILED — ${dupPnlError}`)
  }

  const orphansClosed = []
  const openWithPosId = db.prepare(
    `SELECT id, symbol, ctrader_position_id FROM trades
      WHERE status = 'open' AND ctrader_position_id IS NOT NULL ${tScope.sql}`
  ).all(...tScope.params)
  const closeOrphanMon = db.prepare(
    `UPDATE monitored_positions SET status = 'closed' WHERE trade_id = ? AND status = 'active'`
  )
  for (const t of openWithPosId) {
    if (brokerIds.has(String(t.ctrader_position_id))) continue // still live at the broker
    closeTradeRow(db, t.id, { closeReason: 'stale reconcile: position not open at the broker (orphaned open row, never reconciled)' })
    closeOrphanMon.run(t.id)
    orphansClosed.push({ tradeId: t.id, symbol: t.symbol, positionId: t.ctrader_position_id })
  }

  // Human-readable snapshot: the raw broker order carries NUMERIC enums
  // (tradeSide 1/2, orderType 2=LIMIT) and RELATIVE SL/TP distances in
  // 1/100000-price units — the UI showed "? … 2 @ 1.15477" (owner: "so
  // bare"). Decode everything here so every reader gets honest fields.
  const SIDE_STR = (v) => (v === 1 || v === 'BUY') ? 'BUY' : (v === 2 || v === 'SELL') ? 'SELL' : null
  const TYPE_STR = (v) => ({ 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LIMIT', 5: 'MARKET_RANGE' })[v] || (typeof v === 'string' ? v : 'ORDER')
  // Closing orders (closingOrder flag / bound positionId) are a live
  // position's extra TP/SL levels, not standalone pending entries — cTrader
  // stores the app's TP2/TP3 this way. Keep only true entry orders here.
  //
  // positionId ALONE is not that signal. The broker pre-assigns a positionId
  // to resting ENTRY orders too, and the cpp sidecar dumps RECONCILE_RES
  // verbatim — so on the cpp path every entry order arrived as
  // { positionId: >0, closingOrder: false } and this filter blanked the
  // snapshot, the broker_orders ledger and the UI's order sheet while the
  // broker held orders (measured 2026-08-26: 4 resting orders, snapshot []).
  // The ws path omits unset protobuf fields, which is the only reason
  // positionId ever worked as a proxy there: closingOrder is authoritative
  // when present; positionId is the fallback proxy only when it is not.
  const pendingOrders = (brokerOrders || [])
    .filter(o => !(o.closingOrder === true || (o.closingOrder == null && Number(o.positionId) > 0)))
    .map(o => {
      const side = SIDE_STR(o.tradeData?.tradeSide)
      const px = o.limitPrice ?? o.stopPrice ?? null
      const dir = side === 'SELL' ? -1 : 1
      const relSl = Number(o.relativeStopLoss)
      const relTp = Number(o.relativeTakeProfit)
      const round5 = (v) => Math.round(v * 100000) / 100000
      return {
        orderId: o.orderId ?? o.tradeData?.orderId,
        symbolName: o.symbolName || `ID:${o.tradeData?.symbolId || '?'}`,
        side,
        orderType: TYPE_STR(o.orderType),
        limitPrice: o.limitPrice ?? null,
        stopPrice: o.stopPrice ?? null,
        // The app places SL/TP on pending orders as RELATIVE distances;
        // absolute fields win when present.
        sl: o.stopLoss ?? (px != null && Number.isFinite(relSl) && relSl > 0 ? round5(px - dir * relSl / 100000) : null),
        tp: o.takeProfit ?? (px != null && Number.isFinite(relTp) && relTp > 0 ? round5(px + dir * relTp / 100000) : null),
        volumeUnits: o.tradeData?.volume ? o.tradeData.volume / 100 : null,
        volume: o.tradeData?.volume ? o.tradeData.volume / 100 : null, // legacy readers
        expiresAt: o.expirationTimestamp ? new Date(Number(o.expirationTimestamp)).toISOString() : null,
        updatedAt: o.utcLastUpdateTimestamp ? new Date(Number(o.utcLastUpdateTimestamp)).toISOString() : null,
        label: o.tradeData?.label || '',
        bot: String(o.tradeData?.label || '').includes('pending-fib'),
      }
    })

  setState('broker_pending_orders_json', JSON.stringify(pendingOrders))
  setState('last_reconcile_at', new Date().toISOString())

  // Durable ledger of the broker's resting entry orders. These fill regardless
  // of the bot's scan/autotrade switches (owner: "even if ... OFF, these
  // pending orders will execute"), so record each one and its lifecycle
  // (working → gone) so a fill is tracked and the history survives a restart.
  const ordersGone = syncBrokerOrders(db, pendingOrders, { accountId: acct, includeNull })

  // Upgrade any generic broker-close stamps whose exit price has since been
  // backfilled — cheap, idempotent, pure DB (see reclassifyBrokerCloses).
  const reclassified = reclassifyBrokerCloses(db)

  // Ours-labelled rows stuck as observe-only external (the pre-open label
  // gap) get their real source back — see repairMisfiledOwnPositions.
  const sourcesRepaired = repairMisfiledOwnPositions(db)

  // Drop watch entries for positions this pass no longer knows about — closed,
  // or belonging to an account this scoped pass did not cover (those keep
  // their own entries, which their own pass maintains).
  for (const k of Object.keys(resyncWatch)) {
    const pid = k.slice(3)
    if (brokerIds.has(pid) && !knownIds.has(pid)) delete resyncWatch[k]
    else if (!brokerIds.has(pid) && knownIds.has(pid)) delete resyncWatch[k]
  }
  try { setAgentState(db, RESYNC_WATCH_KEY, JSON.stringify(resyncWatch)) } catch { /* non-fatal */ }

  return {
    newExternal, closedDetected, manualChanges, ledgerSynced, pendingOrders, orphansClosed, ordersGone, relinked, dupsClosed, reclassified, sourcesRepaired,
    ...(dedupError ? { dedupError } : {}),
    ...(dupPnlError ? { dupPnlError } : {}),
  }
}

/**
 * Upgrade OPEN positions misfiled as `external` whose label says they are
 * OURS. The 09-08-2026 label split gave pre-open fills their own source
 * (PRE) for P&L attribution, but isOurs() was only taught it on 29-08 — so
 * every pre-open fill imported in between sits as observe-only external:
 * no trail, no caps, no management (measured: a bot 0016.HK fill at +2.35R
 * peak, stop untouched). Idempotent: once upgraded, rows no longer match.
 * Genuinely manual (MAN-labelled) and unlabelled positions never match —
 * isOurs is the single authority on what "ours" means.
 *
 * @returns {number} rows upgraded
 */
export function repairMisfiledOwnPositions(db) {
  let upgraded = 0
  try {
    // COST, STATED WHERE IT IS PAID (20-09-2026, checker round). The adoption
    // site's "only for a label that carries a tag" bound does NOT describe
    // this loop: here one `ownedByIntent` query runs per ACTIVE EXTERNAL row
    // carrying an i-tag, every pass, forever — including rows whose tag never
    // resolves to an intent and never will. Nine such rows today, so it is
    // nothing; it is written down because it grows with misfiled rows rather
    // than with tick fills, which is the opposite of what the name suggests.
    const rows = db.prepare(
      `SELECT mp.id, mp.trade_id, mp.label_raw, mp.account_id, mp.symbol, mp.side,
              mp.entry_price, mp.current_sl, mp.current_tp, t.broker_sl_initial
         FROM monitored_positions mp
         LEFT JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.source = 'external' AND mp.label_raw IS NOT NULL`
    ).all()
    for (const r of rows) {
      let src = null
      let byIntent = false
      if (isOurs(r.label_raw)) {
        src = parseLabel(r.label_raw).source || 'autopilot'
      } else {
        // The SAME defect by a different door (20-09-2026): a tick fill whose
        // label carries no source this module knows, adopted as `external`
        // before ownedByIntent existed. The intent tag must resolve on the
        // row's OWN account — a tag that names an intent on another account is
        // not evidence of anything, and upgrading on it would hand one
        // account's position to another's management.
        const tag = labelIntentId(r.label_raw)
        if (tag && r.account_id != null && ownedByIntent(db, r.label_raw, r.account_id)) {
          // Logged BEFORE the write: the log is what the inverse
          // (undoIntentUpgrades) is driven from, and a line written after a
          // write that then throws names nothing.
          console.log(`[reconcile] misfiled tick position upgraded: trade ${r.trade_id} intent ${tag} account …${String(r.account_id).slice(-4)}`)
          src = 'autopilot'
          byIntent = true
        }
      }
      if (!src) continue
      // ONE TRANSACTION. The pair used to be two loose writes, so a throw
      // between them left `monitored_positions` managed and `trades` still
      // external — two readings of one position disagreeing, which is this
      // repo's oldest failure shape.
      db.transaction(() => {
        db.prepare('UPDATE monitored_positions SET source = ? WHERE id = ?').run(src, r.id)
        if (r.trade_id != null) {
          db.prepare(`UPDATE trades SET source = ? WHERE id = ? AND source = 'external'`).run(src, r.trade_id)
        }
      })()
      // ATTRIBUTION, NOT JUST SCOPE (20-09-2026, checker round). Rescuing
      // `source` alone is what the healer did first, and it left exactly the
      // rows this function exists for — a tick fill adopted `external` BEFORE
      // the ownership fix — managed but unattributed: `strategy` NULL, so
      // strategy-attribution.js buckets it as unlabelled and alpha-decay and
      // strategy-insights count it against nothing; `origin` untouched; no
      // `trade_plans` row, so `planned_entry`/`planned_sl`/`risk_dist` are
      // absent and position_history's REQUIRED_FIELDS go unmet. The stamp ran
      // at the adoption site only, which is the one path these rows did not
      // take. Best-effort, exactly as at the adoption site.
      if (byIntent && r.trade_id != null) {
        // THE STOP AT ENTRY, NOT THE STOP NOW (20-09-2026, second checker
        // round). This passed `current_sl`, and the comment in the test called
        // it "the only bracket a healed row has" — both wrong, in the
        // direction that flatters the numbers. `current_sl` is LIVE: the
        // ledger-convergence block above adopts the broker's stop onto it, and
        // a misfiled tick row sitting as `external` was inside the profit
        // keeper's DEFAULT scope, whose ratchet amends the stop and writes it
        // back. So a row open long enough to ratchet once got `planned_sl` =
        // the ratcheted stop, `risk_dist` narrower than the risk actually
        // taken, and an OVERSTATED realised R on close — in position_history,
        // whose whole purpose is that figure.
        //
        // `trades.broker_sl_initial` is the stop as the broker first held it,
        // stamped once and only before any break-even move (see the block
        // above, which is source-agnostic and therefore ran for these rows
        // too). Fall back to `current_sl` only where it was never stamped:
        // a late plan is better than none, and it is the same figure this code
        // used before.
        stampAdoptedFromIntent(db, {
          tradeId: r.trade_id, label: r.label_raw, parsed: parseLabel(r.label_raw), acct: r.account_id,
          symbolName: r.symbol, side: r.side, entry: r.entry_price,
          sl: r.broker_sl_initial ?? r.current_sl, tp: r.current_tp,
        })
      }
      upgraded++
    }
  } catch { /* repair is best-effort; the next pass retries */ }
  return upgraded
}

/**
 * THE NAMED INVERSE of the intent-derived upgrade (20-09-2026).
 *
 * A revert of the code that introduced ownedByIntent does NOT undo its writes:
 * rows already upgraded stay `autopilot` and stay managed, with nothing in the
 * tree that knows why. So the undo ships with the change rather than being
 * improvised during an incident. Drive it from the trade ids in the
 * `[reconcile] misfiled tick position upgraded` log lines.
 *
 * Only rows whose ownership came from a tag are touched: an `isOurs` label
 * (AP/CP/PRE) is a different repair and is left alone, so running this can
 * never re-break the pre-open fix.
 *
 * SCOPE, NOT ATTRIBUTION (20-09-2026, checker round). This restores `source`
 * and therefore MANAGEMENT SCOPE — which guards and monitors see the row. It
 * deliberately does NOT undo what the healer's stamp wrote: `strategy`,
 * `origin`, `risk_event_id` and the `trade_plans` row survive. Those are facts
 * about how the position came to exist, read off the intent ledger; they were
 * true before this change and stay true after a revert. Un-writing them would
 * re-create the unattributed row, which is the defect, not the rollback.
 *
 * @param {object} db
 * @param {{tradeIds: Array<number|string>}} opts
 * @returns {{reverted: number, skipped: Array<{tradeId: any, why: string}>}}
 */
export function undoIntentUpgrades(db, { tradeIds = [] } = {}) {
  let reverted = 0
  const skipped = []
  for (const id of tradeIds || []) {
    try {
      const mp = db.prepare(
        `SELECT id, trade_id, label_raw, account_id FROM monitored_positions
          WHERE trade_id = ? ORDER BY id DESC LIMIT 1`
      ).get(id)
      if (!mp) { skipped.push({ tradeId: id, why: 'no monitored_positions row' }); continue }
      if (isOurs(mp.label_raw)) { skipped.push({ tradeId: id, why: 'label is ours — not an intent-derived upgrade' }); continue }
      if (!labelIntentId(mp.label_raw)) { skipped.push({ tradeId: id, why: 'label carries no intent tag' }); continue }
      // One transaction, and the trades write is guarded on the value the
      // healer wrote — mirroring the forward pair exactly, so the undo cannot
      // demote a row that something else has since re-sourced.
      db.transaction(() => {
        db.prepare(`UPDATE monitored_positions SET source = 'external' WHERE id = ?`).run(mp.id)
        db.prepare(`UPDATE trades SET source = 'external' WHERE id = ? AND source = 'autopilot'`).run(id)
      })()
      console.log(`[reconcile] intent upgrade REVERTED: trade ${id} account …${String(mp.account_id ?? '').slice(-4)}`)
      reverted++
    } catch (e) {
      skipped.push({ tradeId: id, why: String(e?.message || e) })
    }
  }
  return { reverted, skipped }
}

/**
 * Decode ONE raw broker order into honest fields WITHOUT the entry-order
 * filter above. Exists because the filtered snapshot can read empty while
 * the broker holds orders (measured 2026-08-26: RECONCILE_RES carried 4
 * resting orders on one account while broker_pending_orders_json stored []),
 * and cancelling an order needs its id — so there must be one read that
 * reports what the broker actually returned, identity fields included, and
 * filters nothing. Pure decode: no db, no state writes.
 */
export function decodeRawBrokerOrder(o) {
  const SIDE_STR = (v) => (v === 1 || v === 'BUY') ? 'BUY' : (v === 2 || v === 'SELL') ? 'SELL' : null
  const TYPE_STR = (v) => ({ 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LIMIT', 5: 'MARKET_RANGE' })[v] || (typeof v === 'string' ? v : 'ORDER')
  const td = o?.tradeData || {}
  return {
    orderId: o?.orderId ?? td.orderId ?? null,
    positionId: o?.positionId ?? null,
    closingOrder: o?.closingOrder ?? null,
    symbolId: td.symbolId ?? o?.symbolId ?? null,
    side: SIDE_STR(td.tradeSide),
    orderType: TYPE_STR(o?.orderType),
    limitPrice: o?.limitPrice ?? null,
    stopPrice: o?.stopPrice ?? null,
    volumeUnits: td.volume != null ? td.volume / 100 : null,
    label: td.label ?? o?.label ?? '',
    comment: td.comment ?? o?.comment ?? '',
    expiresAt: o?.expirationTimestamp ? new Date(Number(o.expirationTimestamp)).toISOString() : null,
    updatedAt: o?.utcLastUpdateTimestamp ? new Date(Number(o.utcLastUpdateTimestamp)).toISOString() : null,
  }
}

/**
 * CLOSE-CAUSE RECLASSIFICATION (owner: "Pipeline integrity = 0% —
 * investigate", 2026-07-27). At detection time a broker-side close is a
 * mystery — the reconciler can only stamp the generic "closed at the broker
 * (manual close or broker-side SL/TP fill)" sentence, and the Workflow Audit
 * page counts every such stamp as a PREMATURE manual close. But once
 * /actions/broker-history backfills the broker-true exit price, the cause is
 * usually inferable: an exit AT the stored SL/TP level is the bracket doing
 * its job, and an exit BEYOND the stop is a gap/slippage fill or a
 * margin-level liquidation — none of which are "premature manual closes".
 * Same 0.1%-of-price proximity tolerance perf-ledger's classifyOutcome
 * already uses, so the ledger and the stamped reason can never disagree.
 * Only rows still carrying the generic stamp are touched — a reason the bot
 * (or a human note) wrote is never overwritten. Truly manual closes keep the
 * generic sentence, which is now an honest residual instead of a catch-all.
 */
export function reclassifyBrokerCloses(db) {
  // The stop the broker actually held wins over the proposal's stop when it
  // is on record (02-09-2026) — the reclassifier judges against the level
  // that could have filled, not the one that was asked for.
  const rows = db.prepare(
    `SELECT id, side, exit_price, COALESCE(broker_sl_initial, sl_price) AS sl_price, tp_price FROM trades
     WHERE status = 'closed' AND exit_price IS NOT NULL
       AND (
         close_reason LIKE 'closed at the broker%'
         -- BACKFILL (2026-07-29). Rows already carrying the FALSE
         -- stopped-beyond-the-SL stamp, written before the null-SL bug above
         -- was fixed. Normally this function never overwrites a reason it did
         -- not write, but leaving these would leave the ledger asserting a
         -- stop existed on positions that ran naked. Narrowly scoped: only
         -- that exact stamp, and only where there is provably no stop.
         OR (sl_price IS NULL AND close_reason LIKE 'stopped beyond the SL%')
       )`
  ).all()
  const upd = db.prepare('UPDATE trades SET close_reason = ? WHERE id = ?')
  let n = 0
  // Rows stamped generic BEFORE the reconciler read the closers' journal
  // (fix-the-exits BA): the journal is retained 90 days, so the stamp is
  // upgraded to who closed it wherever an event exists. Judged before the
  // price match — a keeper close that landed near the target is still the
  // keeper's close. The generic rows carry no exit price requirement here.
  const generic = db.prepare(
    `SELECT id, ctrader_position_id, account_id FROM trades
      WHERE status = 'closed' AND close_reason LIKE 'closed at the broker%'
        AND (ctrader_position_id IS NOT NULL)`
  ).all()
  const attributedIds = new Set()
  for (const t of generic) {
    const who = attributeBrokerClose(db, { positionId: t.ctrader_position_id, tradeId: t.id, accountId: t.account_id })
    if (!who) continue
    upd.run(who, t.id); n++; attributedIds.add(t.id)
  }
  for (const t of rows) {
    if (attributedIds.has(t.id)) continue
    const exit = Number(t.exit_price)
    if (!Number.isFinite(exit)) continue
    const near = (p) => Number.isFinite(Number(p)) && Math.abs(exit - Number(p)) <= Math.abs(exit) * 0.001
    let reason = null
    if (near(t.tp_price)) {
      reason = 'take profit hit — broker-side TP fill (reclassified from the broker exit price)'
    } else if (near(t.sl_price)) {
      reason = 'stop loss hit — broker-side SL fill (reclassified from the broker exit price)'
    } else if (t.sl_price == null) {
      // NO STOP ON RECORD. This branch exists because the one below asserted
      // the opposite (owner report 2026-07-29, an ETHUSD short).
      //
      // `Number(null)` is 0, not NaN, and `Number.isFinite(0)` is true — so
      // the old test collapsed to `exit > 0` for every short, and stamped
      // "stopped beyond the SL" on positions that had no stop at all. It
      // reported the safety system working at exactly the moment it was
      // absent, which is the worst direction for that error to run. Longs
      // escaped by accident (`exit < 0` is never true).
      //
      // The same trap is already documented at loss-postmortem.js:192 — "a
      // missing TP must read as 'no goal', not 'goal 0'". It was guarded
      // there and missed here.
      reason = 'closed at the broker with NO STOP LOSS on record — this position was unprotected; cause of exit unknown (reclassified from the broker exit price)'
    } else {
      const sl = Number(t.sl_price)
      const long = String(t.side || '').toUpperCase() === 'BUY'
      if (Number.isFinite(sl) && sl > 0 && (long ? exit < sl : exit > sl)) {
        reason = 'stopped beyond the SL — gap/slippage through the stop or a margin-level liquidation (reclassified from the broker exit price)'
      }
    }
    if (reason) { upd.run(reason, t.id); n++ }
  }
  return n
}

/**
 * Upsert the current resting entry orders into the broker_orders ledger and
 * mark any previously-working order that's no longer present as 'gone' (it
 * either filled or was cancelled — deal history distinguishes, but either way
 * it's no longer resting). Returns the ids that transitioned working → gone
 * this pass, so the caller can log/act on likely fills. Best-effort: a DB hiccup
 * never blocks reconciliation.
 */
export function syncBrokerOrders(db, pendingOrders = [], opts = {}) {
  try {
    // M2 scoping: this snapshot is ONE account's book, so only that
    // account's 'working' rows may be judged gone by absence from it.
    const acct = opts.accountId != null ? String(opts.accountId) : null
    const includeNull = opts.includeNull !== false
    const goneScope = acct == null
      ? { sql: '', params: [] }
      : includeNull
        ? { sql: 'AND (account_id = ? OR account_id IS NULL)', params: [acct] }
        : { sql: 'AND account_id = ?', params: [acct] }

    const upsert = db.prepare(
      `INSERT INTO broker_orders
         (order_id, symbol, side, order_type, volume, limit_price, stop_price, sl, tp, label, is_bot, account_id, status, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', datetime('now'))
       ON CONFLICT(order_id) DO UPDATE SET
         symbol=excluded.symbol, side=excluded.side, order_type=excluded.order_type,
         volume=excluded.volume, limit_price=excluded.limit_price, stop_price=excluded.stop_price,
         sl=excluded.sl, tp=excluded.tp, label=excluded.label, is_bot=excluded.is_bot,
         account_id=COALESCE(excluded.account_id, account_id),
         status='working', last_seen=datetime('now'), gone_at=NULL`
    )
    const presentIds = []
    const tx = db.transaction(() => {
      for (const o of pendingOrders) {
        const id = String(o.orderId ?? '')
        if (!id) continue
        presentIds.push(id)
        upsert.run(
          id, o.symbolName || null, o.side || null, o.orderType || null,
          o.volume ?? o.volumeUnits ?? null, o.limitPrice ?? null, o.stopPrice ?? null,
          o.sl ?? null, o.tp ?? null, o.label || null, isOurs(o.label) ? 1 : 0, acct,
        )
      }
    })
    tx()

    // Anything still 'working' but not in this snapshot has left the book.
    const wasWorking = db.prepare(`SELECT order_id FROM broker_orders WHERE status = 'working' ${goneScope.sql}`)
      .all(...goneScope.params).map(r => String(r.order_id))
    const presentSet = new Set(presentIds)
    const gone = wasWorking.filter(id => !presentSet.has(id))
    if (gone.length) {
      const mark = db.prepare(`UPDATE broker_orders SET status='gone', gone_at=datetime('now') WHERE order_id = ? AND status='working'`)
      const tx2 = db.transaction(() => { for (const id of gone) mark.run(id) })
      tx2()
    }
    return gone
  } catch {
    return []
  }
}
