// ---------------------------------------------------------------------------
// agent/services/correlation.js — correlation-cluster exposure.
//
// Owner (repeatedly): "did you check pair and correlation?" The existing
// currency-exposure gate only catches instruments that SHARE a currency leg
// (EURUSD + GBPUSD both touch USD). It's blind to instruments that move
// together WITHOUT a shared code — XAUUSD vs USDJPY (gold/dollar), WTI vs
// Brent (crude), US30/NAS100/US500 (US equity beta). Stacking three "long
// risk-on" positions across those is one concentrated bet wearing three
// tickers, and nothing flagged it.
//
// v1 is a CURATED cluster map, not a live-computed correlation matrix. The
// well-known macro clusters are stable and documented; a rolling matrix is
// noisier and needs a data pipeline (a fair follow-up if the owner wants it).
// Each cluster gives every member a signed beta: +1 moves WITH the cluster's
// canonical "risk-on / cluster-up" direction, -1 moves against it. Net
// cluster exposure sums (beta × position direction) across held + proposed
// positions; a proposal that pushes any cluster's |net| beyond the cap is
// vetoed with the specific cluster and the members already loading it.
// ---------------------------------------------------------------------------

// dir: +1 long / -1 short. beta: the instrument's sign within the cluster.
// A long on a +beta member and a short on a -beta member both ADD the same
// directional cluster risk (they're the same underlying bet).
export const CORRELATION_CLUSTERS = [
  {
    key: 'usd_strength',
    label: 'USD strength',
    // + = benefits from a STRONGER dollar. Major USD-quote FX: a long
    // USDJPY and a short EURUSD are the same "long USD" bet.
    members: { USDJPY: +1, USDCHF: +1, USDCAD: +1, EURUSD: -1, GBPUSD: -1, AUDUSD: -1, NZDUSD: -1, XAUUSD: -1 },
  },
  {
    key: 'us_equity',
    label: 'US equity beta',
    members: { US30: +1, US500: +1, NAS100: +1, US100: +1, USTEC: +1, SPX500: +1, JPN225: +1 },
  },
  {
    key: 'crude',
    label: 'Crude oil',
    members: { WTI: +1, BRENT: +1, SPOTCRUDE: +1, USOIL: +1, UKOIL: +1 },
  },
  {
    key: 'risk_fx',
    label: 'Risk-on FX (commodity/carry)',
    members: { AUDUSD: +1, NZDUSD: +1, AUDJPY: +1, GBPJPY: +1, USDJPY: -1 },
  },
]

const dirOf = (side) => (side === 'short' || side === 'SELL' || side === 'sell') ? -1 : 1
const up = (s) => String(s || '').toUpperCase()

/**
 * Net signed exposure per cluster across held positions plus an optional
 * proposal. Only clusters the proposal actually touches are worth vetoing
 * on, but we compute all for the checks payload / diagnostics.
 *
 * @returns {Record<string, { net:number, members:Array<{symbol,side,contribution}> }>}
 */
export function clusterExposure(positions, proposal) {
  const out = {}
  const consider = [...(positions || [])]
  if (proposal) consider.push({ symbol: proposal.symbol, side: proposal.side, _proposed: true })
  for (const cluster of CORRELATION_CLUSTERS) {
    let net = 0
    const members = []
    for (const p of consider) {
      const beta = cluster.members[up(p.symbol)]
      if (!beta) continue
      const contribution = beta * dirOf(p.side)
      net += contribution
      members.push({ symbol: up(p.symbol), side: p.side, contribution, proposed: !!p._proposed })
    }
    if (members.length) out[cluster.key] = { label: cluster.label, net, members }
  }
  return out
}

/**
 * Would `proposal` push a correlation cluster's net directional exposure past
 * `maxClusterExposure`? Returns the offending cluster (with the members
 * already loading it, excluding the proposal itself) or null.
 *
 * Only fires when the proposal ADDS to an already-loaded cluster in the same
 * direction — a proposal that HEDGES (nets toward zero) is never vetoed.
 */
export function correlationVeto(positions, proposal, maxClusterExposure) {
  if (!proposal || !(maxClusterExposure > 0)) return null
  const withProp = clusterExposure(positions, proposal)
  const withoutProp = clusterExposure(positions, null)
  for (const [key, ex] of Object.entries(withProp)) {
    // Only the clusters the proposal is part of can be pushed by it.
    const propMember = ex.members.find(m => m.proposed)
    if (!propMember) continue
    const before = withoutProp[key]?.net ?? 0
    // Adds in the same direction AND breaches the cap.
    const addsRisk = Math.sign(propMember.contribution) === Math.sign(before) || before === 0
    if (Math.abs(ex.net) > maxClusterExposure && addsRisk) {
      const others = ex.members
        .filter(m => !m.proposed)
        .map(m => `${m.symbol} ${m.contribution > 0 ? '+' : '−'}`)
      return { cluster: key, label: ex.label, net: ex.net, cap: maxClusterExposure, others }
    }
  }
  return null
}
