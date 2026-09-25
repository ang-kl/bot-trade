// ---------------------------------------------------------------------------
// agent/services/pf-metrics.js — the two profit-factor metrics every bar-side
// figure is labelled with (V3 Q4b / PR-B1; owner decisions D1–D3,
// docs/dual-environment-plan-2026-09-25.md).
//
//   r-net-v1    PF in R (D1). Net R per close exactly as
//               /state/basis-performance defines it (METRIC_DEFINITION in
//               basis-performance.js). `netRof` moved here verbatim from
//               that module so the report, the evidence record and the
//               family edge read ONE function, not three copies.
//   usd-net-v0  PF in money: Σ winning net_pnl / |Σ losing net_pnl|. It is
//               what the evidence gate, the strategy verdicts and the family
//               bar have always judged, and still the ONLY figure they judge.
//               "v0" because D1 decided R; it stays, labelled, beside the R
//               figure until the owner moves a gate (H-P6-7).
//
// Pure: no database, no clock. Nothing here gates anything.
// ---------------------------------------------------------------------------

import { realisedRR } from './trade-consistency.js'

/** The id of basis-performance.js METRIC_DEFINITION (a test pins them equal). */
export const R_NET_METRIC_ID = 'r-net-v1'

/** The money metric, frozen and versioned like r-net-v1 (a test pins it). */
export const USD_NET_METRIC = Object.freeze({
  id: 'usd-net-v0',
  unit: "net_pnl as stored, in the account's own currency (summed as stored, never converted)",
  win: 'net_pnl > 0',
  loss: 'net_pnl < 0 (0 is neither)',
  profitFactor: 'Σ winning net_pnl / |Σ losing net_pnl|, 2 dp; null with no losing close; 0 with no close',
})

/** Which metric each profit-factor field is computed under. */
export const PF_METRICS = Object.freeze({ profitFactor: USD_NET_METRIC.id, profitFactorR: R_NET_METRIC_ID })

/**
 * Net R of one closed trade under r-net-v1, or the reason it is not scored.
 * Moved verbatim from basis-performance.js (PR #1086); see METRIC_DEFINITION
 * there for the rule.
 *
 * @returns {{netR: number|null, rBasis: 'net'|'gross'|null, unscorableAs: 'noR'|'scratchCost'|'suspectExit'|null}}
 */
export function netRof(r) {
  if (Number(r.exit_price_suspect) === 1) return { netR: null, rBasis: null, unscorableAs: 'suspectExit' }
  const stamped = r.realised_rr != null && Number.isFinite(Number(r.realised_rr)) ? Number(r.realised_rr) : null
  const rr = stamped ?? realisedRR(r)
  if (rr == null || !Number.isFinite(rr)) return { netR: null, rBasis: null, unscorableAs: 'noR' }
  const net = r.net_pnl == null ? NaN : Number(r.net_pnl)
  const gross = r.gross_pnl == null ? NaN : Number(r.gross_pnl)
  if (rr === 0 && Number.isFinite(net) && net !== 0) return { netR: null, rBasis: null, unscorableAs: 'scratchCost' }
  const signsAgree = Math.sign(rr) === Math.sign(gross)
  if (Number.isFinite(net) && Number.isFinite(gross) && gross !== 0 && rr !== 0 && Number(r.pnl_price_mismatch) !== 1 && signsAgree) {
    return { netR: rr * net / gross, rBasis: 'net', unscorableAs: null }
  }
  return { netR: rr, rBasis: 'gross', unscorableAs: null }
}

/**
 * r-net-v1 over a set of closes: each item carries `netR` (null = not
 * scored) and `unscorableAs`. The arithmetic of tick-shadow.js
 * portfolioStats (PF to 3 dp, null with no losing trade) without its
 * bootstrap, so a caller on the dispatch path pays nothing for it; a test
 * pins the two equal. Unscored closes are counted by reason, never dropped.
 */
export function summarizeR(items) {
  let grossWin = 0, grossLoss = 0, net = 0, wins = 0, losses = 0, scored = 0
  const unscorableBy = { noR: 0, scratchCost: 0, suspectExit: 0 }
  for (const it of items || []) {
    const r = it?.netR
    if (r == null || !Number.isFinite(Number(r))) {
      const why = it?.unscorableAs && it.unscorableAs in unscorableBy ? it.unscorableAs : 'noR'
      unscorableBy[why] += 1
      continue
    }
    const x = Number(r)
    scored += 1
    net += x
    if (x > 0) { grossWin += x; wins += 1 } else if (x < 0) { grossLoss += -x; losses += 1 }
  }
  return {
    scored,
    unscorable: unscorableBy.noR + unscorableBy.scratchCost + unscorableBy.suspectExit,
    unscorableBy,
    wins, losses,
    grossWinR: +grossWin.toFixed(4), grossLossR: +grossLoss.toFixed(4), netR: +net.toFixed(4),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : null,
    lossless: grossLoss === 0 && grossWin > 0,
  }
}

/**
 * usd-net-v0 over a list of net_pnl values — the evidence gate's arithmetic
 * (evidence-gate.js evidenceRecord), moved here so the qualification report
 * computes the gate's own number rather than a look-alike.
 */
export function summarizeUsd(pnls) {
  const pnl = (pnls || []).map(Number).filter(Number.isFinite)
  const wins = pnl.filter(x => x > 0)
  const gw = wins.reduce((a, b) => a + b, 0)
  const gl = Math.abs(pnl.filter(x => x < 0).reduce((a, b) => a + b, 0))
  return {
    closes: pnl.length,
    wins: wins.length,
    losses: pnl.filter(x => x < 0).length,
    grossWinUsd: Math.round(gw * 100) / 100,
    grossLossUsd: Math.round(gl * 100) / 100,
    winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null,
    profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : (pnl.length ? null : 0),
    net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100,
  }
}
