// ---------------------------------------------------------------------------
// agent/services/broker-history-import.js — import cTrader's own deal history
// into the broker_deals table.
//
// Owner (2026-07-25): "read historical trades" — panel first, then this. The
// DB only knows the trades the bot itself placed and successfully recorded.
// Anything else the account ever did is invisible to us: fills from before
// the DB existed, manual trades taken in cTrader, and anything lost when a
// submission wrote at the broker but the process died before persistTrade.
//
// WHY NOT INSERT INTO `trades`
// perf-ledger, edge-health, the metrics snapshot and the lessons tuner all
// count every closed trades row that has a net_pnl, and NONE of them filter
// on source (verified: the only source filters in the codebase are in
// loss-guardian, profit-keeper, session-open-guard and label work). Writing imported rows there would
// silently move the win rate, profit factor, strategy attribution and the
// lessons decay keys, and the owner would have no way to tell that a stat
// changed because of an import rather than because of trading. So broker
// truth lands in its own table, joined to a local row by position id where
// one exists. Feeding imported rows into the performance numbers is a
// separate, deliberate decision that needs the owner's word.
//
// Idempotent: deal_id is the broker's own primary key and the write is an
// INSERT .. ON CONFLICT DO UPDATE, so re-importing an overlapping window
// refreshes rather than duplicates. Nothing is ever fabricated — a field the
// broker does not give us stays NULL (notably opened_at, when the position's
// opening deal falls outside the requested window).
// ---------------------------------------------------------------------------

import { stampRealisedAudit } from './trade-consistency.js'
import { pageDeals } from '../lib/deal-paging.js'
import { brokerDealLinkIdentities } from './broker-deal-link-identity.js'
import { normPosId } from '../lib/pos-id.js'

const SIDE_NAME = { 1: 'BUY', 2: 'SELL' }

function log(...args) {
  console.log('[broker-import]', ...args)
}

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19))
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100)

/**
 * Page the broker's deal list across a window.
 *
 * THIS USED TO TRUNCATE IN SILENCE. It walked week by week — cTrader's window
 * cap — but never read `hasMore`, which is the RESPONSE cap (wsGetDeals sends
 * maxRows 500). A week with more than 500 deals came back short, with no
 * error and no flag, and the import then reported a clean pass over a partial
 * record. The walk now lives in lib/deal-paging.js and follows both limits.
 *
 * Kept returning a bare array so the existing callers and tests are unchanged;
 * `fetchDealsPaged` below is the same walk with the completeness reported,
 * and is what anything making a judgement about the data should call.
 */
export async function fetchDeals(getDeals, fromMs, toMs) {
  return (await pageDeals(getDeals, fromMs, toMs)).deals
}

/** The same walk, with `complete` — see lib/deal-paging.js. */
export async function fetchDealsPaged(getDeals, fromMs, toMs, opts) {
  return pageDeals(getDeals, fromMs, toMs, opts)
}

/**
 * Shape raw deals into broker_deals rows.
 *
 * A position produces at least two deals: one opening, one (or more) closing.
 * Only closing deals carry closePositionDetail and therefore realised P&L, so
 * those become the rows; the matching opening deal, when it is inside the
 * window, supplies opened_at and nothing else.
 *
 * @param {Array} deals raw DEAL_LIST_RES deals
 * @param {Record<number, {symbolName?: string, lotSize?: number}>} symMeta
 * @param {string|number|null} accountId
 */
export function shapeDeals(deals, symMeta = {}, accountId = null) {
  // Earliest execution per position = its open, when we can see it.
  const openMsByPosition = new Map()
  for (const d of deals) {
    if (d.closePositionDetail) continue
    const pid = d.positionId != null ? String(d.positionId) : null
    if (!pid || d.executionTimestamp == null) continue
    const prev = openMsByPosition.get(pid)
    if (prev == null || d.executionTimestamp < prev) openMsByPosition.set(pid, d.executionTimestamp)
  }

  const rows = []
  for (const d of deals) {
    const cpd = d.closePositionDetail
    if (!cpd) continue
    const meta = symMeta[d.symbolId] || {}
    const money = (v) => (v == null ? null : v / Math.pow(10, cpd.moneyDigits ?? 2))
    const gross = money(cpd.grossProfit)
    const swap = money(cpd.swap)
    const commission = money(cpd.commission)
    // The deal's tradeSide is the CLOSING side — the position was the other
    // way round. Same inversion /actions/broker-history applies.
    const closeSide = SIDE_NAME[d.tradeSide] || String(d.tradeSide ?? '')
    const side = closeSide === 'BUY' ? 'SELL' : closeSide === 'SELL' ? 'BUY' : (closeSide || null)
    const pid = d.positionId != null ? String(d.positionId) : null
    rows.push({
      deal_id: String(d.dealId),
      position_id: pid,
      account_id: accountId != null ? String(accountId) : null,
      symbol: meta.symbolName ? String(meta.symbolName).toUpperCase() : (d.symbolId != null ? `#${d.symbolId}` : null),
      side,
      lots: meta.lotSize ? Math.round((d.volume / meta.lotSize) * 100) / 100 : null,
      entry_price: cpd.entryPrice ?? null,
      close_price: d.executionPrice ?? null,
      opened_at: pid ? iso(openMsByPosition.get(pid) ?? null) : null,
      closed_at: iso(d.executionTimestamp ?? null),
      gross_pnl: r2(gross),
      swap: r2(swap),
      commission: r2(commission),
      net_pnl: r2((gross || 0) + (swap || 0) + (commission || 0)),
    })
  }
  return rows
}

/** Upsert shaped rows, linking only an unambiguous account+position identity. */
export function persistDeals(db, rows) {
  const identities = brokerDealLinkIdentities(db, rows)
  const localByIdentity = new Map()
  const pids = [...new Set([...identities.values()].map(identity => identity.positionId))]
  if (pids.length) {
    // Position IDs are broker identities only inside their account/server
    // context. Never let a row from another account win a Map overwrite, and
    // never choose arbitrarily when the local ledger itself contains duplicate
    // account+position rows. Production 24-09-2026 exposed exactly that shape.
    //
    // V3 B1: identity rows are the ones that can hold a position. A rejected
    // or cancelled row does not — production 25-09 had 42 of the 44 unmatched
    // positions on …0058 as closed + rejected pairs whose deals agree with the
    // ledger, left unlinked so the price reconciler skipped them. And both
    // text forms of an id are matched ('234698574' and the float-formatted
    // '234698574.0' some old rows still carry) as plain values, not with a
    // CAST, so idx_trades_position_id keeps serving the lookup.
    for (let i = 0; i < pids.length; i += 250) {
      const slice = pids.slice(i, i + 250)
      const forms = slice.flatMap(pid => [pid, `${pid}.0`])
      const placeholders = forms.map(() => '?').join(',')
      const grouped = new Map()
      for (const t of db.prepare(
        `SELECT id, account_id, ctrader_position_id FROM trades WHERE ctrader_position_id IN (${placeholders})
          AND status NOT IN ('rejected','cancelled')`,
      ).all(...forms)) {
        const key = `${t.account_id ?? ''}:${normPosId(t.ctrader_position_id)}`
        const list = grouped.get(key) || []
        list.push(t.id); grouped.set(key, list)
      }
      for (const [key, ids] of grouped) if (ids.length === 1) localByIdentity.set(key, ids[0])
    }
  }
  const localIdFor = (r) => {
    const identity = identities.get(r)
    return identity ? localByIdentity.get(`${identity.accountId}:${normPosId(identity.positionId)}`) ?? null : null
  }

  const up = db.prepare(`
    INSERT INTO broker_deals (
      deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price,
      opened_at, closed_at, gross_pnl, swap, commission, net_pnl, matched_trade_id
    ) VALUES (
      @deal_id, @position_id, @account_id, @symbol, @side, @lots, @entry_price, @close_price,
      @opened_at, @closed_at, @gross_pnl, @swap, @commission, @net_pnl, @matched_trade_id
    )
    ON CONFLICT(deal_id) DO UPDATE SET
      -- V3 B1 (PR-1(g), LIFECYCLE-SPEC W10 / CLS-06): a re-read that LACKS a
      -- field keeps the stored one. The loop's receipts carry no lot size and
      -- the boot statement seed no gross/swap split; each used to erase what
      -- the other had stored (683 deals lost their split on 25-09). A named
      -- symbol is kept over the '#<symbolId>' fallback. A value the re-read
      -- DOES carry still refreshes the row: the broker is the source.
      symbol = CASE WHEN excluded.symbol IS NULL
                      OR (excluded.symbol LIKE '#%' AND broker_deals.symbol IS NOT NULL AND broker_deals.symbol NOT LIKE '#%')
                    THEN broker_deals.symbol ELSE excluded.symbol END,
      side = COALESCE(excluded.side, broker_deals.side),
      lots = COALESCE(excluded.lots, broker_deals.lots),
      entry_price = COALESCE(excluded.entry_price, broker_deals.entry_price),
      close_price = COALESCE(excluded.close_price, broker_deals.close_price),
      -- Never overwrite a known open time with a NULL from a narrower window.
      opened_at = COALESCE(excluded.opened_at, broker_deals.opened_at),
      closed_at = COALESCE(excluded.closed_at, broker_deals.closed_at),
      gross_pnl = COALESCE(excluded.gross_pnl, broker_deals.gross_pnl),
      swap = COALESCE(excluded.swap, broker_deals.swap),
      commission = COALESCE(excluded.commission, broker_deals.commission),
      net_pnl = COALESCE(excluded.net_pnl, broker_deals.net_pnl),
      -- Null is a failed identity proof, not a missing update. Keeping an old
      -- link would contradict the unmatched receipt and allow the downstream
      -- price reconciler to keep using an arbitrary local trade.
      matched_trade_id = excluded.matched_trade_id,
      imported_at = datetime('now')
  `)
  const before = db.prepare('SELECT COUNT(*) AS c FROM broker_deals').get().c
  const write = db.transaction(() => {
    for (const r of rows) {
      up.run({ ...r, matched_trade_id: localIdFor(r) })
    }
  })
  write()
  const after = db.prepare('SELECT COUNT(*) AS c FROM broker_deals').get().c
  const matched = rows.filter(r => localIdFor(r) != null).length
  return {
    seen: rows.length,
    inserted: after - before,
    updated: rows.length - (after - before),
    matchedToLocalTrades: matched,
    // The interesting number: broker fills the bot has no record of.
    unmatched: rows.length - matched,
  }
}

// ---------------------------------------------------------------------------
// FILL-PRICE RECONCILIATION (owner, 2026-08-16: "fix the P&L contradiction")
//
// THE SYMPTOM. /state/trade-consistency reported 104 of 387 decidable closed
// trades (26.9%) whose price move and net P&L have opposite signs — e.g.
// "#1233 EURX BUY 1076.3→1076.4 (move +0.1) but net -2535.41". A profitable
// move booked as a loss reads as corrupt money, and it made every P&L-derived
// number in the system unusable: profit factor, avgWin/avgLoss, net.
//
// WHAT IT ACTUALLY IS. Measured against the broker's own ledger, which is
// 98.3% self-consistent (9 contradictions in 531 decidable deals):
//
//   trades vs broker_deals, 276 matched pairs — entry_price differs on 184,
//   exit differs on 26, net_pnl differs on 2 (and both of those are one trade
//   matched to TWO deals, where 11.94 + 7.80 = 19.74 exactly — correct
//   aggregation, not a mismatch).
//
// So the MONEY IS RIGHT and the ENTRY PRICE IS WRONG. persistDeals already
// stores the broker's true fill price in broker_deals and links it by
// position id — it just never wrote it back to `trades`, which keeps the
// price the bot INTENDED to fill at, forever.
//
// WHY THAT FLIPS SIGNS. The errors are small: ratios of 0.998–1.002, i.e. the
// ordinary 0.1–0.2% of spread and slippage between intent and fill. But the
// sign of the recorded move is (close − entry), so whenever the true move is
// SMALLER than the slippage, the recorded move points the wrong way. EURX
// filled at 1077.4 and closed at 1076.4 — a 1.0 loss — but was recorded as
// entering at 1076.3, turning it into a +0.1 "gain". A 0.1% error in one
// field, and a quarter of the ledger appears to contradict itself.
//
// THE FIX is one write: where a broker deal is matched to a CLOSED trade,
// correct that trade's entry and exit price to the broker's fill.
//
// CLOSED ONLY, deliberately. An open position's entry_price feeds initial_risk
// and every currentR the manager computes; rewriting it mid-flight would move
// the R of a live position under the trail, the ratchet and the loss cap at
// once. Open rows are corrected when they close, which is when the deal
// arrives anyway.
//
// net_pnl is NEVER touched — it already agrees with the broker, and it is the
// broker's number rather than ours to compute.
// ---------------------------------------------------------------------------

/** Usable price: a real, positive number. Zero and NULL are "no answer". */
const usablePrice = (v) => Number.isFinite(v) && v > 0

// POST /actions/broker-history no longer writes money (V3 B1, PR-1(f)). Its
// writer, applyBrokerHistoryMoney, filled every unpriced closed row of a
// position from an unpaged week walk, claimed rows with no account, had no
// lifetime check and filled rows still flagged pnl_unresolvable. Realised
// money now comes only from pnl-backfill.js, which needs one whole, unique
// broker lifecycle. The Desk route is display-only.

/**
 * The judgement behind POST /actions/reconcile-trades, pulled out of the
 * route for the same reason. Rules (codebase audit 02-09-2026):
 *   - `rows` must already be scoped to the account whose `deals` these are —
 *     the route used to select every account's trades and then reject any
 *     row the SELECTED account's deals could not vouch for, which is how an
 *     open trade on another account could be marked rejected;
 *   - only an IN-FLIGHT row ('submitting'/'unconfirmed') with no deal is
 *     rejected, and only when `complete` is true — the deal walk finished
 *     (V3 B1; a partial walk proves nothing about a missing fill). An 'open' row with no deal in the window is REPORTED as
 *     unmatched, never rewritten: a missing deal is a gap in the fetch, not
 *     proof there is no position;
 *   - an entry price filled from the deal re-stamps R and the verdict.
 */
export function judgeTradesAgainstDeals(db, { rows, deals, symbolMap = {}, complete = false }) {
  const toMs = (v) => Date.parse(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z')
  const upEntry = db.prepare('UPDATE trades SET entry_price = ? WHERE id = ?')
  const upStatus = db.prepare(
    `UPDATE trades SET status = 'rejected', close_reason = 'no broker fill (reconciled)'
      WHERE id = ? AND status IN ('submitting', 'unconfirmed')`,
  )
  const details = []
  let confirmed = 0, repaired = 0, rejected = 0, unmatchedOpen = 0, unmatchedInFlight = 0
  for (const r of rows) {
    const symbolId = symbolMap[String(r.symbol).toUpperCase()]
    const t = toMs(r.opened_at)
    const match = (deals || []).find(d =>
      (r.ctrader_position_id && String(d.positionId) === String(r.ctrader_position_id)) ||
      (String(d.symbolId) === String(symbolId) && Math.abs((d.executionTimestamp || 0) - t) < 15 * 60_000))
    if (match) {
      const px = match.executionPrice ?? null
      const wasNull = r.entry_price == null
      if (wasNull && px != null) { upEntry.run(px, r.id); stampRealisedAudit(db, r.id); repaired++ } else confirmed++
      details.push({ id: r.id, symbol: r.symbol, result: wasNull ? 'repaired' : 'confirmed', dealId: match.dealId ?? null, positionId: match.positionId ?? null, executionPrice: px })
    } else if ((r.status === 'submitting' || r.status === 'unconfirmed') && complete !== true) {
      // V3 B1 (PR-1(f)): "no deal" is evidence only from a walk that FINISHED.
      // A truncated or unpaged deal list can miss the fill, and a rejection
      // made from it would erase a live position from the ledger.
      unmatchedInFlight++
      details.push({ id: r.id, symbol: r.symbol, result: 'unmatched_in_flight', note: 'no deal in an INCOMPLETE deal walk — not rejected; re-run when the broker history can be read in full' })
    } else if (r.status === 'submitting' || r.status === 'unconfirmed') {
      const c = upStatus.run(r.id)
      if (c.changes) { rejected++; details.push({ id: r.id, symbol: r.symbol, result: 'rejected', note: 'no matching deal at the broker' }) }
    } else if (r.status === 'open') {
      unmatchedOpen++
      details.push({ id: r.id, symbol: r.symbol, result: 'unmatched_open', note: 'open row with no deal in the fetched window — left as is; check the broker before writing it off' })
    }
  }
  return { confirmed, repaired, rejected, unmatchedOpen, unmatchedInFlight, complete: complete === true, details }
}

/**
 * Correct closed trades' fill prices from the matched broker deals.
 *
 * Runs over ALL matched deals, not just the ones in this import window, so a
 * single run repairs the existing record rather than only new rows.
 *
 * `error` is set (and the counts left at what landed — nothing, since the
 * write is one transaction) when the pass threw. Before this a thrown
 * transaction returned `{corrected: 0}` identical to a clean pass over a
 * record that already agreed — CLAUDE.md failure mode #3, a guard whose
 * failure reads as health.
 *
 * @returns {{examined:number, corrected:number, skippedMultiDeal:number, mergedMultiDeal:number, unchanged:number, error?:string}}
 */
export function reconcileTradePricesToBroker(db) {
  const out = { examined: 0, corrected: 0, skippedMultiDeal: 0, mergedMultiDeal: 0, unchanged: 0 }
  let deals = []
  try {
    deals = db.prepare(
      `SELECT matched_trade_id AS tid, lots, entry_price, close_price, closed_at
         FROM broker_deals
        WHERE matched_trade_id IS NOT NULL`,
    ).all()
  } catch (e) { out.error = e.message; return out }

  // A trade matched to SEVERAL deals is a partial fill or a scale-out, where
  // "the" fill price is a volume-weighted question. Where every deal in the
  // group carries `lots`, the answer is computable and written (a
  // lots-weighted entry, and a lots-weighted exit when every deal has one).
  // Where any deal lacks lots the group is counted and skipped rather than
  // guessed at — a plain average would be the same class of defect as the
  // one being fixed.
  const byTrade = new Map()
  for (const d of deals) {
    const k = Number(d.tid)
    if (!byTrade.has(k)) byTrade.set(k, [])
    byTrade.get(k).push(d)
  }

  const read = db.prepare(
    `SELECT id, side, entry_price, exit_price, status, slippage_price, proposal_entry_price,
            volume, opened_at, closed_at_ms FROM trades WHERE id = ?`,
  )
  const write = db.prepare(
    `UPDATE trades SET entry_price = ?, exit_price = ? WHERE id = ?`,
  )
  // KEEPER-TRUTH FIX (18-09-2026): the broker's fill TIME and fill VOLUME are
  // written back the same way its fill prices are. `closed_at_ms` was
  // stamped when the reconciler noticed the position gone (16–350 s late on
  // the records cpp-verify disputed) and `volume` is the lot size the risk
  // stack requested (612.13 against a 612 fill). The closing deal's
  // executionTimestamp and its lots are the truth; hold_duration_ms follows
  // the corrected close. Closed rows only, like the prices.
  const writeCloseMs = db.prepare(`UPDATE trades SET closed_at_ms = ?, hold_duration_ms = ? WHERE id = ?`)
  const writeVolume = db.prepare(`UPDATE trades SET volume = ? WHERE id = ?`)
  const openedMsOf = (t) => {
    const raw = t.opened_at
    if (!raw) return null
    const iso = /T/.test(String(raw)) ? String(raw) : String(raw).replace(' ', 'T') + 'Z'
    const v = Date.parse(iso)
    return Number.isFinite(v) ? v : null
  }
  // The group's close: the LAST closing deal's time, only when every deal
  // carries one — a group half inside the import window is not a close time.
  const groupClosedMs = (group) => {
    let max = null
    for (const d of group) {
      const v = Date.parse(String(d.closed_at || ''))
      if (!Number.isFinite(v)) return null
      max = max == null ? v : Math.max(max, v)
    }
    return max
  }
  const groupLots = (group) => {
    let sum = 0
    for (const d of group) {
      const lots = Number(d.lots)
      if (!(Number.isFinite(lots) && lots > 0)) return null
      sum += lots
    }
    return sum > 0 ? sum : null
  }
  out.closeTimesCorrected = 0
  out.volumesCorrected = 0
  // SLIPPAGE, AFTER THE FACT (02-09-2026). The dispatch stamps slippage only
  // when the ACK carries an executionPrice, which the sidecar rarely returns
  // — NULL on 100 of 100 rows — while the intended entry now survives in
  // proposal_entry_price and the true fill arrives here. Signed
  // adverse-positive, the dispatch's own convention. Fills only a NULL.
  const writeSlip = db.prepare(
    `UPDATE trades SET slippage_price = ? WHERE id = ? AND slippage_price IS NULL`,
  )
  const slipOf = (t, fill) => {
    const p = Number(t.proposal_entry_price)
    if (!(usablePrice(p) && usablePrice(fill))) return null
    const side = String(t.side || '').toUpperCase()
    if (side !== 'BUY' && side !== 'SELL') return null
    return side === 'BUY' ? fill - p : p - fill
  }
  out.slippageFilled = 0

  // Lots-weighted entry (and exit) across a multi-deal group, or null when
  // any deal lacks lots or an entry price — the caller then skips the group.
  const weightedFill = (group) => {
    let lotsSum = 0, entryAcc = 0, exitAcc = 0, exitLots = 0
    for (const d of group) {
      const lots = Number(d.lots)
      if (!(Number.isFinite(lots) && lots > 0) || !usablePrice(d.entry_price)) return null
      lotsSum += lots
      entryAcc += d.entry_price * lots
      if (usablePrice(d.close_price)) { exitAcc += d.close_price * lots; exitLots += lots }
    }
    if (!(lotsSum > 0)) return null
    return {
      entry_price: entryAcc / lotsSum,
      // Every deal must have closed for the exit to be a whole-position number;
      // otherwise leave it null and the existing fallback keeps the row's own.
      close_price: exitLots === lotsSum ? exitAcc / lotsSum : null,
    }
  }

  const run = db.transaction(() => {
    for (const [tid, group] of byTrade) {
      const t = read.get(tid)
      if (!t) continue
      if (t.status !== 'closed' && t.status !== 'rejected') continue // open rows: see header
      out.examined++
      let d = group[0]
      if (group.length > 1) {
        d = weightedFill(group)
        if (!d) { out.skippedMultiDeal++; continue }
        out.mergedMultiDeal++
      }
      // Keep whatever we already have when the broker gives no usable price —
      // a NULL from a narrower import window must never blank a real fill.
      const entry = usablePrice(d.entry_price) ? d.entry_price : t.entry_price
      const exit = usablePrice(d.close_price) ? d.close_price : t.exit_price
      // Slippage is computable whenever the broker's fill is known, whether
      // or not the prices themselves need correcting — a row corrected before
      // this existed still gains its number.
      if (t.slippage_price == null && usablePrice(d.entry_price)) {
        const s = slipOf(t, d.entry_price)
        if (s != null) { writeSlip.run(s, tid); out.slippageFilled++ }
      }
      const same = (a, b) =>
        (a == null && b == null) ||
        (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-6))
      // Fill time and fill volume, independent of whether the prices moved.
      // The time is written only when it differs by more than a second (the
      // keeper's own resolution) — a row already stamped from the broker is
      // left alone; the volume only when it differs at all.
      const cms = groupClosedMs(group)
      if (cms != null && (t.closed_at_ms == null || Math.abs(Number(t.closed_at_ms) - cms) > 1000)) {
        const o = openedMsOf(t)
        writeCloseMs.run(cms, o != null ? cms - o : null, tid)
        out.closeTimesCorrected++
      }
      const lots = groupLots(group)
      if (lots != null && !same(lots, Number(t.volume))) {
        writeVolume.run(lots, tid)
        out.volumesCorrected++
      }
      if (same(entry, t.entry_price) && same(exit, t.exit_price)) { out.unchanged++; continue }
      write.run(entry, exit, tid)
      out.corrected++
      // The prices just changed, so the R and the self-consistency verdict
      // computed from them are stale — or, for a row that had no exit until
      // this write, were never computed at all. This writer used to skip the
      // stamp, and because it runs every cycle it usually beat pnl-backfill
      // to a broker-side close's exit price: the row got its price and never
      // its R (10 of 12 bot closes, measured 02-09-2026).
      stampRealisedAudit(db, tid)
    }
  })
  // A repair pass must never take the import down — but it must SAY it
  // failed. The transaction rolled back, so every count above is what did
  // not land; `error` is what distinguishes that from a clean pass.
  try { run() } catch (e) { out.error = e.message }
  return out
}

/**
 * Import `days` of broker deal history.
 *
 * @param {object} db
 * @param {{days?: number, nowMs?: number, deps: {getDeals: Function, getSymbolMeta?: Function, accountId?: string|number}}} opts
 */
export async function importBrokerHistory(db, { days = 30, nowMs = Date.now(), deps } = {}) {
  if (!deps?.getDeals) throw new Error('importBrokerHistory needs deps.getDeals')
  const span = Math.min(190, Math.max(1, Number(days) || 30))
  const from = nowMs - span * 24 * 3_600_000
  const pull = await fetchDealsPaged(deps.getDeals, from, nowMs)
  const deals = pull.deals
  const symbolIds = [...new Set(deals.map(d => d.symbolId).filter(v => v != null))]
  let symMeta = {}
  if (symbolIds.length && deps.getSymbolMeta) {
    // Symbol names are cosmetic here — a failure leaves '#<id>', which is
    // still a stable key, rather than aborting the whole import.
    try { symMeta = await deps.getSymbolMeta(symbolIds) } catch (e) { log('symbol metadata failed:', e.message) }
  }
  const rows = shapeDeals(deals, symMeta, deps.accountId ?? null)
  const result = persistDeals(db, rows)
  // Correct the local rows' fill prices from the broker's, now that this
  // window's deals are linked. See the header above reconcileTradePricesToBroker.
  const priceFix = reconcileTradePricesToBroker(db)
  // An incomplete pull is SAID, not swallowed. The rows that did arrive are
  // still worth keeping — they are the broker's own — but a caller reading
  // this as "30 days of history" when it is part of 30 days would draw
  // conclusions from a gap it cannot see.
  const truncation = pull.complete ? '' : ` — PULL INCOMPLETE (${pull.reason}), this is PART of the window`
  log(`${span}d: ${deals.length} deals → ${result.seen} closes · ${result.inserted} new · ${result.unmatched} with no local trade row · ${priceFix.corrected} fill prices corrected${truncation}`)
  return { days: span, from: iso(from), to: iso(nowMs), deals: deals.length, complete: pull.complete, pages: pull.pages, ...(pull.complete ? {} : { truncatedReason: pull.reason }), ...result, priceFix }
}
