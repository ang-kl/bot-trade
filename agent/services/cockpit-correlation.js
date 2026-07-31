// ---------------------------------------------------------------------------
// cockpit-correlation.js — PHASE 6 of the cockpit live-wiring prompt:
// correlation and portfolio context, from the SAME sources the risk gate
// already trades with.
//
// Two layers, combined per the prompt:
//   - the LIVE pairwise matrix (services/correlation-matrix.js), stored in
//     agent_state.correlation_matrix_data as {builtAt, timeframe, lookback,
//     symbols, m: {A:{B:r}}} — read via loadStoredMatrix, coefficients from
//     payload.m (NOT payload.matrix: that field has never existed on the
//     stored payload, a shape bug cluster-conviction still carries);
//   - the CURATED clusters (services/correlation.js CORRELATION_CLUSTERS),
//     the signed ±1 beta lists the gate's cluster cap runs on.
//
// Effective correlation uses the exact expression the live veto enforces
// (correlation-matrix.js liveCorrelationVeto): eff = r × dir(this side) ×
// dir(held side). eff ≥ threshold means the held position STACKS onto this
// one (same effective direction — they win and lose together); eff ≤
// −threshold means it HEDGES; between the two it is independent at this
// threshold.
//
// Honesty rules, verbatim from the prompt: "Missing/stale/insufficient
// matrix means UNKNOWN or limited, never zero traffic or fabricated
// agreement." A stale matrix still shows its coefficients — they are real
// measurements, just old — but the block SAYS stale and the age rides along.
// A symbol the matrix never measured yields coefficient null, not 0 (0 is a
// claim of independence; null is an admission of ignorance).
//
// Account scoping: held positions come from THIS account only (the M1
// NULL-belongs-to-all convention, same predicate the risk gate uses at
// risk.js:757-767) — another account's book must never paint this cockpit's
// traffic. Note /state/correlation still has the unscoped query; this module
// deliberately does not share it.
// ---------------------------------------------------------------------------
import { loadStoredMatrix, loadCorrelationMatrixConfig } from './correlation-matrix.js'
import { clusterExposure } from './correlation.js'
import { netExposure, loadRiskConfig } from './risk.js'

const dirOf = (side) => {
  const s = String(side || '').toLowerCase()
  return s === 'short' || s === 'sell' ? -1 : 1
}

/**
 * Build the contract's correlation block for one position.
 *
 * @param {object} db better-sqlite3 handle
 * @param {{id: number, symbol: string, side: string|null}} row the cockpit's
 *        monitored_positions row
 * @param {string|null} accountId the cockpit account (row account, else the
 *        explicit request scope) — held positions are scoped to it
 * @param {number} nowMs
 */
export function buildCorrelation(db, row, accountId, nowMs = Date.now()) {
  const cfg = loadCorrelationMatrixConfig(db)
  const payload = loadStoredMatrix(db)
  const riskCfg = (() => { try { return loadRiskConfig(db) } catch { return {} } })()

  // Held positions on THIS account, excluding the cockpit position itself.
  const acct = accountId == null ? null : String(accountId)
  const held = db.prepare(
    `SELECT mp.id, mp.symbol, mp.side FROM monitored_positions mp
      WHERE mp.status = 'active' AND mp.id != ?
        AND (mp.account_id = ? OR mp.account_id IS NULL OR ? IS NULL)
      ORDER BY mp.id ASC`
  ).all(row.id, acct, acct)

  const builtAt = payload?.builtAt ?? null
  const ageMs = builtAt != null && Number.isFinite(Date.parse(builtAt))
    ? Math.max(0, nowMs - Date.parse(builtAt))
    : null
  const stale = ageMs != null && ageMs > cfg.maxAgeMin * 60_000
  const symMeasured = !!payload?.m?.[row.symbol]

  // Coefficient lookup — null (unknown) when either symbol was never
  // measured. The matrix is symmetric by construction; read both ways so a
  // half-written payload cannot hide a real value.
  const coeff = (a, b) => {
    const r = payload?.m?.[a]?.[b] ?? payload?.m?.[b]?.[a]
    return Number.isFinite(r) ? r : null
  }

  const myDir = dirOf(row.side)
  const related = held.map(h => {
    if (h.symbol === row.symbol) {
      // The same instrument again IS the stack, whatever the matrix says.
      const same = dirOf(h.side) === myDir
      return { symbol: h.symbol, side: h.side ?? null, coefficient: 1, effective: same ? 1 : -1, relation: same ? 'stacked' : 'hedged', sameSymbol: true }
    }
    const r = coeff(row.symbol, h.symbol)
    if (r == null) {
      return { symbol: h.symbol, side: h.side ?? null, coefficient: null, effective: null, relation: 'unknown' }
    }
    const eff = Number((r * myDir * dirOf(h.side)).toFixed(2))
    const relation = eff >= cfg.threshold ? 'stacked' : eff <= -cfg.threshold ? 'hedged' : 'independent'
    return { symbol: h.symbol, side: h.side ?? null, coefficient: Number(r.toFixed(2)), effective: eff, relation }
  })

  // Curated clusters this position + the held book touch, with the gate's cap.
  const proposal = { symbol: row.symbol, side: row.side }
  let clusters = []
  try {
    const exp = clusterExposure(held, proposal)
    clusters = Object.entries(exp).map(([key, c]) => ({
      key,
      label: c.label,
      net: c.net,
      cap: riskCfg.maxClusterExposure ?? null,
      members: c.members,
      source: 'curated CORRELATION_CLUSTERS + held positions (this account)',
    }))
  } catch { clusters = [] }

  // Currency legs across the held book INCLUDING this position — the same
  // netExposure the risk gate's §8 check runs.
  let portfolioExposure = []
  try {
    const net = netExposure(held, proposal)
    portfolioExposure = Object.entries(net)
      .filter(([, v]) => v !== 0)
      .map(([currency, netV]) => ({ currency, net: netV, cap: riskCfg.maxCurrencyExposure ?? null }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  } catch { portfolioExposure = [] }

  // Status, in the prompt's own vocabulary:
  //   unknown — no matrix at all (never fabricated agreement)
  //   limited — a matrix exists but never measured THIS symbol
  //   stale   — measurements exist but are past cfg.maxAgeMin
  //   live    — fresh measurements covering this symbol
  // Curated clusters and currency legs are configuration + positions, not
  // measurements — they are honest under every status and returned always.
  const status = payload == null ? 'unknown' : !symMeasured ? 'limited' : stale ? 'stale' : 'live'

  const stacked = related.filter(r => r.relation === 'stacked').length
  const hedged = related.filter(r => r.relation === 'hedged').length

  return {
    timeframe: payload?.timeframe ?? null,
    lookback: payload?.lookback ?? null,
    builtAt,
    ageMs,
    threshold: cfg.threshold,
    status,
    ...(status === 'unknown' ? { detail: 'no correlation matrix has been built yet — coefficients unknown, not zero' } : {}),
    ...(status === 'limited' ? { detail: `the stored matrix (${(payload.symbols || []).length} symbols) has no measurements for ${row.symbol}` } : {}),
    ...(status === 'stale' ? { detail: `matrix built ${builtAt} — older than the ${cfg.maxAgeMin}-minute freshness bound; coefficients shown are real but old` } : {}),
    related,
    clusters,
    portfolioExposure,
    summary: { held: held.length, stacked, hedged },
    source: 'agent_state.correlation_matrix_data + curated clusters + this account\'s open positions',
  }
}
