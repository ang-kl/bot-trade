// ---------------------------------------------------------------------------
// agent/services/family-edge.js — closed-trade edge PER STRATEGY FAMILY, in
// the three numbers the 07-09 first principles judge a system by: profit
// factor, tail share (closes beyond +2R) and max drawdown. Wave 3 of
// docs/first-principles-audit-2026-09-19.md §K (item 10).
//
// WHY FAMILIES AND WHY THESE THREE. Principle 2 (exit asymmetry sets
// expectancy, not entry accuracy) says a win-rate bar measures the wrong
// thing: a trend system is RIGHT to lose small often if the winners run.
// The goal table used to hold a 69% win-rate goal on the trail rule and the
// go-live/arm bars carried 68%/60%; those are gone in this wave. What
// replaces them is judged per family because the families trade at
// different horizons and the momentum family is judged only at its
// pre-registered checkpoint, not on a rolling window.
//
// R IS THE RISK TAKEN AT ENTRY. `realised_rr` is the column stamped at close
// against the broker's first stop (trade-consistency.js); rows written
// before that migration, or broker-side closes with no stop on record, fall
// back to the same function and are counted as `undecidable` when it cannot
// answer — never dropped silently, never guessed. A family whose closes are
// mostly undecidable reports that share so a PF built on the decidable
// subset reads as what it is.
//
// DRAWDOWN is peak-to-trough on the cumulative R curve of the family's
// closes in chronological order (and in USD on net P&L beside it). The
// order is the close order, so two closes in the same second keep the
// DB's order — a tie that cannot move the number by more than one trade.
//
// TWO PROFIT FACTORS, EACH LABELLED (V3 Q4b / PR-B1; owner decision D1 "win
// factor = profit factor, in R"). `profitFactor` stays the money PF
// (usd-net-v0): the goal table's family bar reads it, and moving that bar to
// R is the owner's decision (H-P6-7), not this report's. `profitFactorR`
// (r-net-v1, pf-metrics.js — the /state/basis-performance definition) sits
// beside it with its unscored closes counted by reason (`rUnscorable`,
// `rUnscorableBy`). avgR, the tail share and the R drawdown stay on GROSS R
// (realised_rr), unchanged. `metrics` on the report names all three.
// ---------------------------------------------------------------------------

import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { familyOf, STRATEGY_FAMILIES } from './strategies.js'
import { realisedRR } from './trade-consistency.js'
import { basisOfTrade, intentMaps } from './trade-basis.js'
import { netRof, summarizeR, PF_METRICS } from './pf-metrics.js'

/** Closes beyond this many R count toward the tail share. */
export const TAIL_R = 2

function closedAtMs(r) {
  if (r.closed_at_ms != null && Number.isFinite(Number(r.closed_at_ms))) return Number(r.closed_at_ms)
  const t = Date.parse(String(r.closed_at || '').replace(' ', 'T') + (String(r.closed_at || '').endsWith('Z') ? '' : 'Z'))
  return Number.isFinite(t) ? t : null
}

function emptyStats() {
  return {
    closes: 0, decidable: 0, undecidable: 0, wins: 0, losses: 0,
    grossWinUsd: 0, grossLossUsd: 0, netUsd: 0,
    sumR: 0, tail: 0,
    maxDrawdownR: 0, maxDrawdownUsd: 0,
    rNet: [],
  }
}

/**
 * Fold one closed trade into a family's running stats. `r` may be null
 * (undecidable): the money still counts, the R-based figures do not.
 */
function fold(st, pnl, r, curve, rNet = null) {
  st.closes += 1
  if (rNet) st.rNet.push(rNet)
  st.netUsd += pnl
  if (pnl > 0) { st.wins += 1; st.grossWinUsd += pnl } else if (pnl < 0) { st.losses += 1; st.grossLossUsd += -pnl }
  curve.usd += pnl
  if (curve.usd > curve.peakUsd) curve.peakUsd = curve.usd
  const ddUsd = curve.peakUsd - curve.usd
  if (ddUsd > st.maxDrawdownUsd) st.maxDrawdownUsd = ddUsd
  if (r == null || !Number.isFinite(r)) { st.undecidable += 1; return }
  st.decidable += 1
  st.sumR += r
  if (r > TAIL_R) st.tail += 1
  curve.r += r
  if (curve.r > curve.peakR) curve.peakR = curve.r
  const ddR = curve.peakR - curve.r
  if (ddR > st.maxDrawdownR) st.maxDrawdownR = ddR
}

function finalize(st) {
  // A family with wins and NO losses has no finite PF. Infinity does not
  // survive res.json (it becomes null — the same value as "no PF
  // computable"), so the report says null + lossless:true and the verdict
  // treats lossless as the PF target met.
  const lossless = st.grossLossUsd === 0 && st.grossWinUsd > 0
  const pf = st.grossLossUsd > 0 ? st.grossWinUsd / st.grossLossUsd : null
  const rn = summarizeR(st.rNet)
  return {
    closes: st.closes,
    decidable: st.decidable,
    undecidable: st.undecidable,
    wins: st.wins,
    losses: st.losses,
    netUsd: Number(st.netUsd.toFixed(2)),
    profitFactor: pf == null ? null : Number(pf.toFixed(2)),
    lossless,
    avgR: st.decidable > 0 ? Number((st.sumR / st.decidable).toFixed(3)) : null,
    tailShare: st.decidable > 0 ? st.tail / st.decidable : null,
    tailSharePct: st.decidable > 0 ? Number((100 * st.tail / st.decidable).toFixed(1)) : null,
    tailCloses: st.tail,
    maxDrawdownR: st.decidable > 0 ? Number(st.maxDrawdownR.toFixed(2)) : null,
    maxDrawdownUsd: Number(st.maxDrawdownUsd.toFixed(2)),
    profitFactorR: rn.profitFactor,
    rLossless: rn.lossless,
    rScored: rn.scored,
    rUnscorable: rn.unscorable,
    rUnscorableBy: rn.unscorableBy,
  }
}

/**
 * Per-family closed-trade edge over a window.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.days=90]         window length; 0 or null = all time
 * @param {number} [opts.now=Date.now()]
 * @param {string|null} [opts.accountId]  scope to one account (null = all)
 * @param {string|null} [opts.since]      ISO lower bound overriding `days`
 * @returns {{at:string, since:string|null, accountId:string|null,
 *            families:Object<string, ReturnType<typeof finalize>>,
 *            byBasis:{tick: ReturnType<typeof finalize>},
 *            unattributed:number}}
 */
export function familyEdgeReport(db, { days = 90, now = Date.now(), accountId = null, since = null } = {}) {
  const sinceIso = since
    ? new Date(since).toISOString()
    : (days > 0 ? new Date(now - days * 86400_000).toISOString() : null)
  const where = ['status = \'closed\'', 'net_pnl IS NOT NULL']
  const params = []
  if (sinceIso) {
    // Window on whichever close stamp the row carries: the ms column when
    // set, else the text column (both formats compare after the REPLACE).
    where.push('((closed_at_ms IS NOT NULL AND closed_at_ms >= ?) OR (closed_at_ms IS NULL AND REPLACE(closed_at, \'T\', \' \') >= ?))')
    params.push(Date.parse(sinceIso), sinceIso.replace('T', ' ').slice(0, 19))
  }
  if (accountId != null) { where.push('account_id = ?'); params.push(String(accountId)) }
  const rows = db.prepare(
    `SELECT id, account_id, side, entry_price, exit_price, sl_price, broker_sl_initial, net_pnl,
            gross_pnl, pnl_price_mismatch, exit_price_suspect,
            closed_at, closed_at_ms, realised_rr, label_raw, source, ctrader_position_id,
            ${strategyAttrSql()} AS strat
       FROM trades
      WHERE ${where.join(' AND ')}
      ORDER BY id`,
  ).all(...params)
  // CLOSE ORDER IN JS, not in SQL: a row with closed_at_ms NULL (pre-
  // migration or history-backfilled) sorted by COALESCE(closed_at_ms, 0)
  // lands before every stamped row whatever its closed_at, and the drawdown
  // curve is order-dependent (checker, Wave 3). The helper reads either
  // stamp.
  rows.sort((a, b) => ((closedAtMs(a) ?? -Infinity) - (closedAtMs(b) ?? -Infinity)) || (a.id - b.id))

  const stats = Object.fromEntries(STRATEGY_FAMILIES.map(f => [f, emptyStats()]))
  const curves = Object.fromEntries(STRATEGY_FAMILIES.map(f => [f, { r: 0, peakR: 0, usd: 0, peakUsd: 0 }]))
  // Plan P1 (25-09-2026): a TICK entry is counted by its basis, not its
  // strategy — a tick fill's label carries none (trade-labels.js), so under
  // familyOf alone every one landed in `unattributed`. It is reported in its
  // OWN block beside `families` (byBasis.tick), never as a family key:
  // familyOf / STRATEGY_FAMILIES also drive managed-exit.js, account-horizon.js
  // and exit-chain.js, and the goal table and daily report iterate families.
  const { byPos, byId } = intentMaps(db)
  const tickStats = emptyStats(), tickCurve = { r: 0, peakR: 0, usd: 0, peakUsd: 0 }
  let unattributed = 0
  for (const r of rows) {
    const rr = r.realised_rr != null && Number.isFinite(Number(r.realised_rr)) ? Number(r.realised_rr) : realisedRR(r)
    const rNet = netRof(r)
    if (basisOfTrade(r, byPos, byId).basis === 'tick') { fold(tickStats, Number(r.net_pnl) || 0, rr, tickCurve, rNet); continue }
    const fam = r.strat ? familyOf(r.strat) : null
    if (!fam || !stats[fam]) { unattributed += 1; continue }
    fold(stats[fam], Number(r.net_pnl) || 0, rr, curves[fam], rNet)
  }
  const families = Object.fromEntries(STRATEGY_FAMILIES.map(f => [f, finalize(stats[f])]))
  return {
    at: new Date(now).toISOString(),
    since: sinceIso,
    accountId: accountId != null ? String(accountId) : null,
    families,
    byBasis: { tick: finalize(tickStats) },
    unattributed,
    metrics: { ...PF_METRICS, avgR: 'r-gross (realised_rr)', tailShare: 'r-gross (realised_rr)', maxDrawdownR: 'r-gross (realised_rr)' },
    note: `R is realised_rr (the broker's first stop) or its recomputation; closes it cannot answer for are counted undecidable, not guessed. Tail share = closes beyond +${TAIL_R}R over decidable closes. Drawdown is peak-to-trough on the cumulative R curve (and USD on net P&L) in close order. profitFactor is money (usd-net-v0, what the family bar reads); profitFactorR is net R (r-net-v1) over rScored closes, reported beside it and read by no bar.`,
  }
}

export { closedAtMs }
