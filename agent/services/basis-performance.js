// ---------------------------------------------------------------------------
// agent/services/basis-performance.js — closed-trade performance PER ACCOUNT
// and PER ENTRY BASIS, on ONE frozen metric definition (plan P1 and decisions
// D1–D3, docs/dual-environment-plan-2026-09-25.md).
//
//   D1  "win factor" is the profit factor, in R.
//   D2  win rate is REPORTED with its Wilson interval — never a pass/fail bar.
//   D3  one versioned definition, stamped on every report (METRIC_DEFINITION);
//       a closed window [fromMs, toMs) is fixed in advance and its figures
//       never change when later trades land (basis-performance.test.js pins
//       both).
//
// Read-only. It changes no trading behaviour, threshold, cap or target.
//
// R HERE IS NET R. realised_rr (trade-consistency.js realisedRR) is the price
// move over the broker's first stop: GROSS, costs excluded. The definition
// here is win = net R > 0, so a trade that won on price and lost after
// commission is a loss. netR = rr × net_pnl / gross_pnl, applied only when
// the money and the prices agree on the sign (pnl_price_mismatch ≠ 1 AND
// sign(rr) = sign(gross_pnl)); otherwise the row keeps gross rr and is
// counted `grossOnly` — named, never hidden. This differs from
// /state/family-edge (gross R, money PF) and from tradedTickEvidence (gross
// R), so reconcile against those on close COUNTS and netUsd, not on R.
//
// UNDER THE SAMPLE MINIMUM a derived figure is {status:'insufficient'}, not a
// number (owner principle 6). The minimum is the owner-held
// traded.minTrades (agent/config/tick-validation.json, read through
// loadThresholds, never copied); a null minimum is 'thresholds_unset' and
// publishes no derived figure at all.
// ---------------------------------------------------------------------------

import { portfolioStats } from './tick-shadow.js'
import { wilsonInterval } from '../lib/tick-replay-sim.js'
import { loadThresholds } from './tick-validation.js'
import { realisedRR } from './trade-consistency.js'
import { closedAtMs } from './family-edge.js'
import { basisOfTrade, intentMaps } from './trade-basis.js'

export { basisOfTrade }

/**
 * THE definition every figure in this report is computed under. Frozen and
 * versioned: a change to any field is a new id, and the test pins this
 * object exactly so an edit without a new id is red (D3).
 */
export const METRIC_DEFINITION = Object.freeze({
  id: 'r-net-v1',
  unit: 'R of the stop the broker first held (broker_sl_initial, else sl_price)',
  netR: 'realised_rr × net_pnl / gross_pnl when the signs agree; else gross realised_rr, counted grossOnly',
  win: 'net R > 0',
  loss: 'net R < 0 (0 R is neither)',
  profitFactor: 'gross winning R / gross losing R; null with no losing trade',
  payoff: '(gross winning R / wins) / (gross losing R / losses); null with no wins or no losses',
  winRate: 'wins / trades, with the Wilson 95 % interval (z = 1.96)',
  expectancy: 'mean net R; lower bounds = 5th percentile of 1000 bootstrap means (seed 7) and of circular moving blocks',
  order: 'close order (closed_at_ms, else closed_at), then id',
  window: '[fromMs, toMs) on the close stamp',
  sampleMinimum: 'traded.minTrades from agent/config/tick-validation.json',
})

const insufficient = (status, trades, needed) => ({ status, trades, needed })

function netRof(r) {
  const stamped = r.realised_rr != null && Number.isFinite(Number(r.realised_rr)) ? Number(r.realised_rr) : null
  const rr = stamped ?? realisedRR(r)
  if (rr == null || !Number.isFinite(rr)) return { netR: null, rBasis: null }
  const net = r.net_pnl == null ? NaN : Number(r.net_pnl)
  const gross = r.gross_pnl == null ? NaN : Number(r.gross_pnl)
  const signsAgree = Math.sign(rr) === Math.sign(gross)
  if (Number.isFinite(net) && Number.isFinite(gross) && gross !== 0 && rr !== 0 && Number(r.pnl_price_mismatch) !== 1 && signsAgree) {
    return { netR: rr * net / gross, rBasis: 'net' }
  }
  return { netR: rr, rBasis: 'gross' }
}

/**
 * Closed trades with their basis and net R, in close order.
 *
 * @param {object} db
 * @param {{accountId?: string|null, fromMs?: number|null, toMs?: number|null}} [opts]
 */
export function closedTradesWithBasis(db, { accountId = null, fromMs = null, toMs = null } = {}) {
  const where = ["status = 'closed'"]
  const params = []
  const bound = (op, ms) => {
    where.push(`((closed_at_ms IS NOT NULL AND closed_at_ms ${op} ?) OR (closed_at_ms IS NULL AND REPLACE(closed_at, 'T', ' ') ${op} ?))`)
    params.push(Number(ms), new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19))
  }
  if (fromMs != null) bound('>=', fromMs)
  if (toMs != null) bound('<', toMs)
  if (accountId != null) { where.push('account_id = ?'); params.push(String(accountId)) }
  let rows = []
  try {
    rows = db.prepare(
      `SELECT id, account_id, side, entry_price, exit_price, sl_price, broker_sl_initial,
              gross_pnl, net_pnl, realised_rr, pnl_price_mismatch, label_raw, source,
              closed_at, closed_at_ms, ctrader_position_id
         FROM trades WHERE ${where.join(' AND ')}`,
    ).all(...params)
  } catch { rows = [] }
  const { byPos, byId } = intentMaps(db)
  const out = rows.map(r => {
    const b = basisOfTrade(r, byPos, byId)
    const { netR, rBasis } = netRof(r)
    return { ...r, ...b, netR, rBasis, closedAtMs: closedAtMs(r) }
  })
  out.sort((a, b) => ((a.closedAtMs ?? -Infinity) - (b.closedAtMs ?? -Infinity)) || (a.id - b.id))
  return out
}

/** One account × basis group's figures, gated on the sample minimum. */
export function basisStats(rows, minTrades) {
  const scored = rows.filter(r => r.netR != null && Number.isFinite(r.netR))
  const st = portfolioStats(scored.map(r => ({ net_r: r.netR, exit_ms: r.closedAtMs, reason: 'closed', symbol_id: null })))
  const basisSources = {}
  for (const r of rows) basisSources[r.basisSource] = (basisSources[r.basisSource] || 0) + 1
  let netUsd = 0
  for (const r of rows) { const p = Number(r.net_pnl); if (Number.isFinite(p)) netUsd += p }
  const counts = {
    trades: st.trades, wins: st.wins, losses: st.losses, netR: st.netR,
    unscorable: rows.length - scored.length,
    grossOnly: scored.filter(r => r.rBasis === 'gross').length,
    closes: rows.length, netUsd: +netUsd.toFixed(2),
    maxDrawdownR: st.maxDrawdownR,
    basisSources,
    firstCloseAt: st.firstExitAt, lastCloseAt: st.lastExitAt,
  }
  const gate = minTrades == null ? insufficient('thresholds_unset', st.trades, null)
    : st.trades < minTrades ? insufficient('insufficient', st.trades, minTrades) : null
  if (gate) {
    return { ...counts, winRate: gate, profitFactor: gate, payoff: gate, expectancyR: gate, expectancyLowerR: gate, blockExpectancyLowerR: gate }
  }
  const payoff = st.wins > 0 && st.losses > 0 && st.grossLossR > 0
    ? +((st.grossWinR / st.wins) / (st.grossLossR / st.losses)).toFixed(3) : null
  return {
    ...counts,
    winRate: { ...wilsonInterval(st.wins, st.trades), method: 'wilson-95' },
    profitFactor: st.profitFactor,
    payoff,
    expectancyR: st.avgR,
    expectancyLowerR: st.expectancyLowerR,
    blockExpectancyLowerR: st.blockExpectancy?.lowerR ?? null,
  }
}

/**
 * GET /state/basis-performance: per account, per basis.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string|null} [opts.accountId]   one account (null = every account)
 * @param {number} [opts.days=90]          rolling window; 0 = all time
 * @param {number|null} [opts.fromMs]      closed window start (overrides days)
 * @param {number|null} [opts.toMs]        closed window end, exclusive
 * @param {number} [opts.now=Date.now()]
 * @param {object} [opts.thresholds]       loadThresholds() shape (tests inject)
 * @param {string|URL} [opts.thresholdsFile]
 */
export function basisPerformanceReport(db, { accountId = null, days = 90, fromMs = null, toMs = null, now = Date.now(), thresholds = null, thresholdsFile = undefined } = {}) {
  const th = thresholds ?? loadThresholds(thresholdsFile ? { file: thresholdsFile } : undefined)
  const minTrades = th?.traded?.minTrades ?? null
  const from = fromMs != null ? Number(fromMs) : (days > 0 ? now - days * 86_400_000 : null)
  const to = toMs != null ? Number(toMs) : null
  const rows = closedTradesWithBasis(db, { accountId, fromMs: from, toMs: to })
  const groups = new Map()
  for (const r of rows) {
    const a = r.account_id == null ? 'unstamped' : String(r.account_id)
    if (!groups.has(a)) groups.set(a, new Map())
    const g = groups.get(a)
    if (!g.has(r.basis)) g.set(r.basis, [])
    g.get(r.basis).push(r)
  }
  const accounts = [...groups.keys()].sort().map(a => {
    const byBasis = {}
    let closes = 0
    for (const [basis, list] of [...groups.get(a).entries()].sort(([x], [y]) => x.localeCompare(y))) {
      byBasis[basis] = basisStats(list, minTrades)
      closes += list.length
    }
    return { accountId: a, closes, byBasis }
  })
  const sumBasis = accounts.reduce((s, a) => s + Object.values(a.byBasis).reduce((t, b) => t + b.trades + b.unscorable, 0), 0)
  return {
    at: new Date(now).toISOString(),
    metricDefinition: METRIC_DEFINITION.id,
    definition: METRIC_DEFINITION,
    window: { fromMs: from, toMs: to, from: from != null ? new Date(from).toISOString() : null, to: to != null ? new Date(to).toISOString() : null, closed: to != null },
    accountId: accountId != null ? String(accountId) : null,
    sampleMinimum: { trades: minTrades, source: 'agent/config/tick-validation.json traded.minTrades' },
    closedTrades: rows.length,
    reconciled: sumBasis === rows.length,
    accounts,
    note: 'Net R, win = net R > 0 (r-net-v1). /state/family-edge uses gross R and money PF, and tradedTickEvidence gross R: reconcile on close counts and netUsd, not R. Under the sample minimum a derived figure reads insufficient, never a number. A tick row stays empty until the first closed tick trade exists; it fills from the entry ledger (entry_intents basis) or the tick: label.',
  }
}
