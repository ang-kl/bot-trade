// ---------------------------------------------------------------------------
// agent/services/closed-market-limits.js — resting LIMIT orders for setups
// that fire while the symbol's market is CLOSED (weekend FX/metals, off-hours
// stocks/indices) or on a slow higher timeframe.
//
// Owner decision (Option A + on by default): when a signal is deferred for a
// closed market, place a REAL broker limit order at the setup's entry — locked
// in, visible on the desk, filling automatically the instant price trades
// there — INSTEAD of the invisible internal re-fire queue. One order per
// symbol, carrying the setup's SL/TP, expiring so a stale idea never sits
// forever. The limit order is the single source of the fill (no double-fill).
//
// Every order goes through the SAME risk gate as a market order (sizing, R:R,
// exposure, daily-loss), so a closed-market limit can never bypass risk. The
// label is autopilot-sourced, so when it fills the reconciler adopts the
// position and the normal monitor manages it.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { encodeLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { tradePrice } from './alert-format.js'
import { getActiveSessions } from '../lib/sessions.js'
import { expiryMsFor } from './pending-signals.js'
import { stopTriggerField } from '../lib/order-protection.js'

export const DEFAULT_CLOSED_MARKET_LIMITS = {
  on: true, // owner: on by default — closed-market setups get locked in
}

export function loadClosedMarketLimitsConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'closed_market_limits_json') || 'null')
    return { ...DEFAULT_CLOSED_MARKET_LIMITS, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_CLOSED_MARKET_LIMITS }
  }
}

/**
 * Build the cTrader LIMIT order payload. Pure/testable — the price is snapped
 * to the symbol's digits (raw levels carry float noise the broker rejects) and
 * SL/TP ride as relative point distances, same as the market-order path.
 */
export function buildLimitPayload({ accountId, symbolId, side, volume, entry, sl, tp, digits, expiresAtMs, label, relativePoints, riskCfg = null }) {
  const slDistance = sl != null && entry != null ? Math.abs(entry - sl) : null
  const tpDistance = tp != null && entry != null ? Math.abs(tp - entry) : null
  return {
    ctidTraderAccountId: parseInt(accountId),
    symbolId: parseInt(symbolId),
    orderType: 'LIMIT',
    tradeSide: side,
    volume,
    limitPrice: tradePrice(entry, digits),
    ...(slDistance ? { relativeStopLoss: relativePoints(slDistance, digits) } : {}),
    ...(tpDistance ? { relativeTakeProfit: relativePoints(tpDistance, digits) } : {}),
    ...stopTriggerField(riskCfg),
    expirationTimestamp: expiresAtMs,
    label,
    comment: 'pending-closed',
  }
}

/**
 * Retire stale closed-market-limit rows independently of a fresh signal ever
 * recurring on that symbol (owner: "pending order lapse more than a day" —
 * traced to a real gap). Before this, a `pending-closed` row's ONLY exit was
 * placeClosedMarketLimit() re-running for that EXACT symbol and finding its
 * own expiry passed; pending-orders.js's fib sweep explicitly excludes these
 * rows (see its comment), and the general reconciler's syncBrokerOrders()
 * only updates the separate broker_orders table, never writes back to
 * pending_orders. So a row whose order was rejected, cancelled, or expired at
 * the broker — or whose placeOrder call never even returned an order_id —
 * could sit "working" forever if that symbol just didn't signal again.
 *
 * broker_orders is the live-broker snapshot (refreshed every reconcile), so
 * this is a pure DB-only reconciliation against it — no network call of its
 * own. It is NOT authoritative by absence: see the `!broker` branch.
 *
 * @returns {{ stillWorking:number, filled:number, expired:number, unknown:number }}
 *   `unknown` is the subset of stillWorking held open because the broker had
 *   nothing to say about them — worth watching, never a reason to retire a row.
 */
export function reconcileStaleClosedMarketLimits(db, { nowMs = Date.now() } = {}) {
  const rows = db.prepare(
    `SELECT * FROM pending_orders WHERE status = 'working' AND note = 'pending-closed'`
  ).all()

  let stillWorking = 0, filled = 0, expired = 0, unknown = 0
  const markFilled = db.prepare(`UPDATE pending_orders SET status = 'filled', note = ? WHERE id = ?`)
  const markExpired = db.prepare(`UPDATE pending_orders SET status = 'expired', note = ? WHERE id = ?`)

  for (const row of rows) {
    if (row.order_id) {
      const broker = db.prepare(`SELECT status FROM broker_orders WHERE order_id = ?`).get(String(row.order_id))
      if (broker?.status === 'working') { stillWorking++; continue } // genuinely still resting — leave it

      // ABSENCE IS NOT EVIDENCE OF DEATH. This used to fall straight through
      // to the expire branch when broker_orders had NO row at all for the
      // order id — and there are ordinary reasons for that: the account it
      // belongs to has not been reconciled yet this run, its reconcile
      // returned no order list, or the order was placed seconds ago and the
      // first sync has not landed. broker_orders is per-account
      // (syncBrokerOrders scopes gone-detection by account_id), so a row for
      // account A is simply not there when the sweep runs after account B.
      //
      // Reading that as "gone at broker" retired thirteen LIVE resting DOW.US
      // limits on 04-08-2026, which freed the idempotency check above to place
      // a fourteenth, and a fifteenth. The orders never left the book; only our
      // record of them did. An unknown order stays working and is settled by
      // its own expiry, exactly like an order that never returned an id.
      if (!broker) {
        if (row.expires_at && new Date(row.expires_at).getTime() < nowMs) {
          markExpired.run('pending-closed: no broker record and own expiry passed', row.id)
          expired++
        } else {
          unknown++
          stillWorking++
        }
        continue
      }

      // The broker HAS a record and it is not 'working' — filled, rejected,
      // cancelled or expired there. Best-effort check for an adopted trade on
      // the same symbol and ACCOUNT opened since this order was placed;
      // otherwise it never filled. (Unscoped, this credited a fill on one
      // account to a resting order on another.)
      const adopted = db.prepare(
        `SELECT id FROM trades
          WHERE symbol = ? AND opened_at >= ?
            AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
          ORDER BY opened_at ASC LIMIT 1`
      ).get(row.symbol, row.placed_at || '1970-01-01', row.account_id ?? null, row.account_id ?? null)
      if (adopted) {
        markFilled.run('pending-closed: adopted as trade', row.id)
        // §70.9 LINEAGE (05-08-2026). This is the ONE moment the system knows
        // which approval produced which position on this path — the reconciler
        // adopts the fill with no idea an order preceded it, and the approval
        // id sits on the pending row we are about to retire. Stamping it here
        // is the difference between a trade that can name its authorisation
        // and one that cannot.
        //
        // Measured before this: 62 fib_confluence and 26 fib_618_fade opens in
        // seven days, every one with risk_event_id NULL, while their pending
        // rows carried ids 97150-97729.
        //
        // COALESCE, never overwrite: if the trade already carries an id, a
        // more direct writer put it there and knows better than this heuristic.
        if (row.risk_event_id != null) {
          try {
            db.prepare(
              `UPDATE trades SET risk_event_id = COALESCE(risk_event_id, ?) WHERE id = ?`
            ).run(row.risk_event_id, adopted.id)
          } catch { /* lineage is provenance, never a reason to fail the sweep */ }
        }
        filled++
      } else {
        markExpired.run('pending-closed: gone at broker, no fill adopted', row.id)
        expired++
      }
      continue
    }
    // Never got an order_id back at all (placeOrder response gap, or the
    // call itself never truly succeeded) — only give up once its OWN
    // expiry has passed; too early to judge otherwise.
    if (row.expires_at && new Date(row.expires_at).getTime() < nowMs) {
      markExpired.run('pending-closed: no broker order_id and expiry passed', row.id)
      expired++
    } else {
      stillWorking++
    }
  }
  return { stillWorking, filled, expired, unknown }
}

/**
 * Place (or refresh) a resting limit order for a signal deferred because its
 * market is closed. Returns a small status object; never throws.
 *
 * @param {object} creds - { host, clientId, clientSecret, accessToken, accountId }
 * @param {object} synth - the signal (entry/sl/tp1/tp2/strategy/timeframe/…)
 */
export async function placeClosedMarketLimit(db, creds, symbol, synth, opts = {}) {
  const cfg = loadClosedMarketLimitsConfig(db)
  if (!cfg.on) return { skipped: 'off' }
  if (synth?.entry == null) return { skipped: 'no_entry' }

  const risk = opts.risk ?? await import('./risk.js')
  const sizing = opts.sizing ?? await import('../lib/lot-sizing.js')
  const exec = opts.exec ?? await import('../lib/exec-engine.js')
  const notify = opts.notify ?? (() => {})
  const nowMs = opts.now ?? Date.now()

  // Retire our own working rows whose broker expiry has passed, so idempotency
  // below doesn't wrongly treat an expired order as still resting.
  db.prepare(
    `UPDATE pending_orders SET status = 'expired'
     WHERE note = 'pending-closed' AND status = 'working'
       AND expires_at IS NOT NULL AND expires_at < ?`
  ).run(new Date(nowMs).toISOString())

  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}
  const symbolId = symbolMap[symbol.toUpperCase()]
  if (!symbolId) return { skipped: 'symbol_unknown' }

  // Idempotency FIRST (before any WS call): if a limit already rests at
  // essentially this entry, leave it — this runs every loop while the market
  // is closed and must not cancel/replace (and re-pay sizing) each cycle.
  //
  // SCOPED TO THIS ACCOUNT. The rows below are also the set the cancel loop
  // further down feeds to exec.cancelOrder(creds, …), so an unscoped read
  // would let a pass authorised for one account cancel another account's
  // resting order with the wrong credentials. NULL-account rows are legacy
  // (written before this function stamped the column) and are still claimed,
  // which keeps them cancellable instead of orphaning them forever.
  const acctKey = creds?.accountId != null ? String(creds.accountId) : null
  const working = db.prepare(
    `SELECT order_id, level FROM pending_orders
      WHERE symbol = ? AND status = 'working' AND note = 'pending-closed'
        AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
  ).all(symbol, acctKey, acctKey)
  const tol = Math.abs(synth.entry) * 1e-4
  const alreadyResting = working.find(r => r.level != null && Math.abs(r.level - synth.entry) <= tol)
  if (alreadyResting) return { skipped: 'already_working', orderId: alreadyResting.order_id }

  // TOTAL resting-order cap, shared with the pending-fib path (owner-approved
  // build 2, 2026-07-27): every resting order is exposure the moment it
  // fills — 82 of them helped drive a margin call. Counted across BOTH bot
  // placement paths; PENDING_MAX_TOTAL overrides the default 20.
  const maxTotal = Math.max(1, Number(process.env.PENDING_MAX_TOTAL || 20))
  const totalWorking = db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working'`).get()?.n || 0
  if (totalWorking >= maxTotal) return { skipped: 'pending_cap', totalWorking, maxTotal }

  // SAME risk gate as a market order — a resting limit can't bypass risk.
  const proposal = {
    symbol, side,
    entry: synth.entry ?? null, sl: synth.sl ?? null,
    tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
    requestedVolume: opts.requestedVolume ?? null,
    strategy: synth.strategy || null,
    conviction: synth.overall_conviction ?? null,
    source: 'closed_market_limit',
    // A resting limit can't bypass risk — and it can't be gated against a
    // different account than the one whose creds place it either.
    accountId: creds?.accountId ?? null,
  }
  const riskCfg = risk.loadRiskConfig(db, creds?.accountId ?? null)
  const riskResult = risk.evaluateTrade(db, proposal, riskCfg)
  const riskEventId = risk.persistRiskEvent(db, proposal, riskResult) // §70.9 lineage
  if (!riskResult.approved) return { skipped: 'risk_veto', reason: riskResult.veto_reason }

  const volLots = riskResult.adjusted_volume
  let sized, digits = 5
  try {
    const meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
    digits = meta.digits ?? 5
    sized = sizing.lotsToVolume(volLots, meta)
    if (sized.belowMin) {
      risk.persistPostApprovalVeto(db, proposal, `below_min_volume: ${volLots} lots`)
      return { skipped: 'below_min_volume' }
    }
  } catch (err) {
    return { skipped: 'sizing_failed', reason: err.message }
  }

  // The level moved (fresher zone) — cancel the stale working order(s) for this
  // symbol before resting a new one, so there's never more than one.
  for (const row of working) {
    if (row.order_id == null) continue
    try { await exec.cancelOrder(creds, { orderId: row.order_id }) } catch { /* already gone */ }
    db.prepare(`UPDATE pending_orders SET status = 'cancelled' WHERE order_id = ?`).run(row.order_id)
  }

  const label = encodeLabel({
    // `preopen`, not `autopilot` — see SOURCES in lib/trade-labels.js. The
    // strategy field is left exactly as the setup computed it, so this splits
    // the record by HOW the entry was placed without corrupting WHAT signalled
    // it: donchian_breakout stays donchian_breakout, and the pre-open slice of
    // it becomes separable rather than blended into the intraday numbers the
    // go-live gate reads.
    source: 'preopen',
    version: LABEL_VERSION,
    strategy: synth.strategy || 'other',
    conviction: convictionBucket(synth.overall_conviction),
    session: getActiveSessions()[0]?.label || 'Off',
    timeframe: synth.timeframe || null,
    regime: null,
  })
  const expiresAtMs = nowMs + expiryMsFor(synth.timeframe)
  const payload = buildLimitPayload({
    accountId: creds.accountId, symbolId, side, volume: sized.volume,
    entry: synth.entry, sl: synth.sl, tp: synth.tp1, digits, expiresAtMs, label,
    relativePoints: sizing.relativePoints ?? ((d, dg) => Math.round(d * Math.pow(10, dg))),
    riskCfg,
  })

  try {
    const ev = await exec.placeOrder(creds, payload)
    const orderId = ev?.order?.orderId ?? ev?.orderId ?? null
    // account_id is NOT optional. The column has existed since the M1
    // multi-account migration and this writer never filled it, so every row it
    // ever wrote was unattributed — which is why the staleness sweep below
    // judged one account's live resting order against another account's broker
    // book and retired it as "gone", and why the idempotency read above then
    // found nothing working and placed a replacement. Thirteen times on
    // DOW.US, 04-08-2026, 10:41 to 12:03.
    db.prepare(`
      INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, strategy, risk_event_id, account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', 'pending-closed', ?, ?, ?)
    `).run(
      symbol, synth.timeframe || null, orderId != null ? String(orderId) : null,
      side === 'BUY' ? 1 : -1, synth.entry ?? null, synth.sl ?? null, synth.tp1 ?? null,
      volLots, new Date(expiresAtMs).toISOString(), synth.strategy || null, riskEventId ?? null,
      acctKey,
    )
    try {
      const { recordSubmitted } = await import('./opportunity-disposition.js')
      recordSubmitted(db, riskEventId)     // §70.8 verdict -> submit
    } catch { /* provenance never blocks a placement */ }
    risk.persistRiskEvent(db, proposal, {
      approved: true, veto_reason: null,
      checks: { closed_market_limit_placed: true, orderId, limitPrice: payload.limitPrice, expiresAt: new Date(expiresAtMs).toISOString() },
    })
    notify(`⏳ Closed-market LIMIT placed: ${symbol} ${synth.timeframe || ''} ${side} @ ${payload.limitPrice}, SL ${synth.sl}, TP ${synth.tp1} — fills at open`)
    return { placed: true, orderId, limitPrice: payload.limitPrice, expiresAt: new Date(expiresAtMs).toISOString() }
  } catch (err) {
    risk.persistPostApprovalVeto(db, proposal, `closed_market_limit_failed: ${err.message}`)
    return { skipped: 'place_failed', reason: err.message }
  }
}
