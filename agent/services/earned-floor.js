// ---------------------------------------------------------------------------
// agent/services/earned-floor.js — PR-C: a strategy EARNS a floor below
// HARD_MIN_RR by measurement, never by declaration.
//
// Owner order 2026-08-31 ("go PR-C"), in the staged form put to him with the
// outcome answer (№ 7,079): demo-only first, at reduced per-trade risk, with
// a pre-registered 30-close verdict before any live widening.
//
// HARD_MIN_RR's own comment has named this fix since the 3.0 floor shipped:
// "a strategy claiming it deserves a lower floor has to show a win rate that
// earns one … the honest long-term fix is the plan's own dynamic expectancy
// test (E = W × rr − (1 − W)), gated on a per-strategy rolling win rate".
// This module is that test. The blanket floor stays for everything that has
// not earned its way under it: a strategy with no measured record, a thin
// sample, or a win rate that does not pay at the proposed ratio all keep
// getting the 3.0 veto exactly as before.
//
// Scope is fail-closed on both axes: with demoOnly on (the default), an
// account the registry cannot identify is NEVER in scope — same contract as
// managed-exit.js, for the same reason (an unattributable row must not be
// governed by the more permissive rule).
// ---------------------------------------------------------------------------

// docs/one-simple-system.md P5 marked the 3R floor "re-derivation needed —
// NOT VERIFIABLE YET"; this module is that re-derivation, delivered under the
// staged terms recorded there (P5a).
import { getState } from '../db.js'
import { strategyRollingEdge } from './edge-watchdog.js'

/**
 * The R:R band the floor is measured over (owner order, 02-09-2026). W used
 * to be measured on the strategy's whole rolling window — trades taken at
 * ≥3R under the blanket floor — and applied to justify <3R entries. It is
 * now measured over the ADMITTED band only: closes whose planned bracket
 * was under HARD_MIN_RR. Numerically equal to risk.js's HARD_MIN_RR and
 * pinned to it by test; not imported because risk.js imports this module.
 */
export const EARNED_FLOOR_RR_BAND = 3.0

export const EARNED_FLOOR_DEFAULTS = {
  on: true,        // owner order 31-08-2026: "go PR-C"
  demoOnly: true,  // stage 1 of the rollout — live only after the verdict
  riskScale: 0.5,  // admitted-below-3R entries risk HALF the per-trade budget
  window: 30,      // rolling closed-trade window the win rate is measured on
  minSample: 15,   // never earn a floor on a handful of trades
  minE: 0.15,      // expectancy in R the measured W must clear at the rr
  // PRIOR ADMISSION (owner order 02-09-2026 18:50 SGT: "let the prior admit
  // on demo at half risk"). When the live sub-floor sample is under
  // minSample, the strategy's live W is shrunk toward its last-sweep
  // backtest W with k phantom trades and the same expectancy test is applied
  // to W'. DEMO ACCOUNTS ONLY, whatever demoOnly says, at priorRiskScale of
  // the per-trade budget. A measured sample at or above minSample is judged
  // as before; the prior never overrides a measured verdict.
  priorAdmit: true,
  priorRiskScale: 0.5,
}

/** Load config from agent_state 'earned_floor_json'; junk degrades to defaults. */
export function loadEarnedFloor(db) {
  try {
    const p = JSON.parse(getState(db, 'earned_floor_json') || 'null')
    if (p && typeof p === 'object') {
      const num = (v, dflt, lo, hi) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
      }
      return {
        on: p.on !== false,
        demoOnly: p.demoOnly !== false,
        riskScale: num(p.riskScale, EARNED_FLOOR_DEFAULTS.riskScale, 0.05, 1),
        window: Math.round(num(p.window, EARNED_FLOOR_DEFAULTS.window, 5, 200)),
        minSample: Math.round(num(p.minSample, EARNED_FLOOR_DEFAULTS.minSample, 5, 200)),
        minE: num(p.minE, EARNED_FLOOR_DEFAULTS.minE, 0, 2),
        priorAdmit: p.priorAdmit !== false,
        priorRiskScale: num(p.priorRiskScale, EARNED_FLOOR_DEFAULTS.priorRiskScale, 0.05, 1),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...EARNED_FLOOR_DEFAULTS }
}

/**
 * May THIS proposal trade below HARD_MIN_RR on its strategy's measured record?
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{strategy: string|null, rr: number, accountId: string|null}} p
 * @returns {{ok: boolean, reason: string|null, winRate: number|null,
 *            trades: number, e: number|null, riskScale: number|null}}
 */
export function earnedFloorVerdict(db, { strategy, rr, accountId }) {
  const no = (reason, extra = {}) =>
    ({ ok: false, reason, winRate: null, trades: 0, e: null, riskScale: null, ...extra })
  const cfg = loadEarnedFloor(db)
  if (!cfg.on) return no('off')
  if (!strategy) return no('unlabelled_proposal')
  if (!Number.isFinite(Number(rr)) || Number(rr) <= 0) return no('no_rr')

  // Registry check UNCONDITIONAL, fail-closed (managed-exit precedent — and
  // the same hole it closed there: the first draft put this inside the
  // demoOnly branch, so widening the scope to live would have widened it to
  // accounts nobody can name. Caught by the stage-2 test before it shipped.)
  let row = null
  try {
    row = accountId != null
      ? db.prepare('SELECT is_live FROM accounts WHERE account_id = ?').get(String(accountId))
      : null
  } catch { row = null }
  if (!row) return no('unattributable_account')
  if (cfg.demoOnly && Number(row.is_live) !== 0) return no('live_scope')

  // Per-account, sub-floor band: the gate acts on THIS account, so the record
  // is this account's (plus unscoped legacy rows), and only its closes that
  // were planned under the floor — the population the verdict admits.
  const edge = strategyRollingEdge(db, strategy, cfg.window, {
    accountId: String(accountId), rrBand: { below: EARNED_FLOOR_RR_BAND },
  })
  if (edge.trades < cfg.minSample) {
    // THE PRIOR PATH (owner order 02-09-2026). The measured path needs
    // minSample closes under 3R that the gate itself refuses to produce —
    // 7 of 30 in two days, measured that morning. With a thin sample the
    // verdict is taken on W' = (n·W_live + k·W_bt)/(n + k), demo accounts
    // only, at priorRiskScale. Every admit is stamped `via: 'prior'` so the
    // cohort report can split the two populations. No sweep prior for the
    // strategy → the thin-sample refusal exactly as before.
    if (cfg.priorAdmit && Number(row.is_live) === 0) {
      const prior = strategyPriorFor(db, strategy)
      if (prior) {
        const n = edge.trades
        const wLive = n > 0 && Number.isFinite(Number(edge.winRate)) ? Number(edge.winRate) : null
        const shrunk = wLive != null ? (n * wLive + EARNED_FLOOR_PRIOR_TRADES * prior.winRatePct) / (n + EARNED_FLOOR_PRIOR_TRADES) : prior.winRatePct
        const Wp = shrunk / 100
        if (Number.isFinite(Wp) && Wp > 0 && Wp < 1) {
          const ep = Math.round((Wp * rr - (1 - Wp)) * 1000) / 1000
          const winRatePct = Math.round(shrunk * 10) / 10
          const detail = { via: 'prior', prior: { winRatePct: prior.winRatePct, trades: prior.trades, k: EARNED_FLOOR_PRIOR_TRADES, liveWinRatePct: wLive, liveTrades: n } }
          if (ep <= cfg.minE) {
            return no(
              `prior expectancy ${ep}R at shrunk ${winRatePct}% (${n} live closes toward backtest ${prior.winRatePct}%) ≤ ${cfg.minE}R`,
              { winRate: winRatePct, trades: n, e: ep, ...detail },
            )
          }
          return {
            ok: true, reason: null, winRate: winRatePct, trades: n, e: ep,
            riskScale: Math.min(cfg.riskScale, cfg.priorRiskScale), ...detail,
          }
        }
      }
    }
    return no(`thin_sample ${edge.trades}<${cfg.minSample}`, { trades: edge.trades })
  }
  const W = Number(edge.winRate) / 100
  if (!Number.isFinite(W) || W <= 0 || W >= 1) {
    return no(`unusable_win_rate ${edge.winRate}`, { trades: edge.trades })
  }
  const e = Math.round((W * rr - (1 - W)) * 1000) / 1000
  if (e <= cfg.minE) {
    return no(
      `expectancy ${e}R at measured ${edge.winRate}% win over ${edge.trades} closes ≤ ${cfg.minE}R`,
      { winRate: edge.winRate, trades: edge.trades, e },
    )
  }
  return { ok: true, reason: null, winRate: edge.winRate, trades: edge.trades, e, riskScale: cfg.riskScale, via: 'measured' }
}

/** One strategy's last-sweep backtest prior, from the aggregate the sweep writes (#821). Null when absent. */
function strategyPriorFor(db, strategy) {
  try {
    const p = JSON.parse(getState(db, 'autopilot_strategy_prior_json') || 'null')
    const v = p && typeof p === 'object' ? p[strategy] : null
    const trades = Number(v?.trades) || 0
    const wr = v?.winRatePct == null ? NaN : Number(v.winRatePct)
    return trades > 0 && Number.isFinite(wr) ? { winRatePct: wr, trades, combos: Number(v?.combos) || 0 } : null
  } catch { return null }
}

// The PRE-REGISTERED VERDICT, fixed before the first admitted trade so the
// target cannot drift toward whatever the data later shows: after 30 closed
// trades of the admitted population, PF ≥ 1.5 keeps the gate (and earns the
// live-scope conversation); under it, the owner turns earned_floor_json.on
// off and the blanket floor resumes. Not enforced in code — enforcing a
// judgement call is how a guard ends up firing on noise — but REPORTED here
// so the checkpoint is a number anyone can read, not a promise.
export const EARNED_FLOOR_VERDICT_TARGET = { closes: 30, minPf: 1.5 }

/**
 * Phantom trades the backtest prior is worth against a strategy's live
 * sub-floor record. Numerically equal to strategy-autopilot.js's
 * SHRINK_PRIOR_TRADES and pinned to it by test; not imported, to keep this
 * module's import graph (risk.js → here) free of the autopilot's.
 */
export const EARNED_FLOOR_PRIOR_TRADES = 20

/** R:R ratios the prior's expectancy is reported at — the targets the registry strategies actually propose. */
export const EARNED_FLOOR_PRIOR_RR = [1.5, 2, 2.5]

/**
 * REPORT ONLY (owner order, 02-09-2026: "build the earned floor prior as
 * report"). The floor's verdict above waits for `minSample` live closes under
 * 3R, but the gate refuses the trades that would produce them — measured
 * 02-09: 500 gate decisions, 0 approvals, 7 of 30 cohort closes in two days.
 * This reports what the verdict WOULD read if each strategy's live sub-floor
 * win rate were shrunk toward its backtest win rate with the same k=20
 * phantom trades the autopilot's arm bar now uses:
 *
 *   W' = (n·W_live + k·W_bt) / (n + k),   E(rr) = W'·rr − (1 − W')
 *
 * `wouldAdmit[rr]` is E(rr) > minE. NOTHING READS THIS: earnedFloorVerdict
 * above is unchanged and the gate still needs a measured sample. Turning it
 * into an actuator is a separate, owner-approved change.
 *
 * Backtest side: the last autopilot sweep's verdicts (agent_state
 * `autopilot_last_verdicts_json`), trade-weighted per strategy over verdicts
 * with trades. Live side: strategyRollingEdge over the admitted band, pooled
 * and per in-scope account (demo accounts while demoOnly).
 */
export function earnedFloorPriorReport(db, { k = EARNED_FLOOR_PRIOR_TRADES } = {}) {
  const cfg = loadEarnedFloor(db)
  const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)
  const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null)
  const sweepMs = Number(getState(db, 'autopilot_last_run_ms'))
  // Backtest side. FIRST the compact per-strategy aggregate the sweep writes
  // (autopilot_strategy_prior_json, #821); the full verdict list is stored
  // sliced at 200,000 characters and a 1,872-verdict sweep overruns it, so
  // parsing it yields nothing — which is exactly what the first deployed read
  // of this report returned (02-09-2026 12:49 SGT: verdicts 0, every strategy
  // "no prior"). The verdict list stays as the fallback for a DB that has a
  // sweep but predates the aggregate key.
  let bt = {}
  let source = null
  try {
    const p = JSON.parse(getState(db, 'autopilot_strategy_prior_json') || 'null')
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) {
        const trades = Number(v?.trades) || 0, wr = Number(v?.winRatePct)
        if (trades > 0 && Number.isFinite(wr)) bt[k] = { trades, wrWeighted: wr * trades, combos: Number(v?.combos) || 0 }
      }
      if (Object.keys(bt).length) source = 'autopilot_strategy_prior_json'
    }
  } catch { bt = {} }
  let verdicts = []
  if (!source) {
    try { verdicts = JSON.parse(getState(db, 'autopilot_last_verdicts_json') || '[]') } catch { verdicts = [] }
    if (!Array.isArray(verdicts)) verdicts = []
    for (const v of verdicts) {
      const n = Number(v?.trades) || 0
      const wr = v?.winRate == null ? NaN : Number(v.winRate) // Number(null) is 0, not "unknown"
      if (!v?.strategy || n <= 0 || !Number.isFinite(wr)) continue
      const b = bt[v.strategy] || (bt[v.strategy] = { trades: 0, wrWeighted: 0, combos: 0 })
      b.trades += n; b.wrWeighted += wr * n; b.combos++
    }
    if (Object.keys(bt).length) source = 'autopilot_last_verdicts_json'
  }
  let accounts = []
  try {
    accounts = db.prepare(`SELECT account_id, is_live FROM accounts WHERE enabled = 1 ORDER BY account_id`).all()
      .filter(a => !cfg.demoOnly || Number(a.is_live) === 0)
      .map(a => String(a.account_id))
  } catch { accounts = [] }
  const strategies = [...new Set([...Object.keys(bt), ...(() => {
    try { return db.prepare(`SELECT DISTINCT label_strategy s FROM trades WHERE label_strategy IS NOT NULL`).all().map(r => r.s) } catch { return [] }
  })()])].sort()
  const scopeOf = (strategy, accountId) => {
    const edge = strategyRollingEdge(db, strategy, cfg.window, { accountId, rrBand: { below: EARNED_FLOOR_RR_BAND } })
    const n = edge.trades
    const wLive = Number.isFinite(Number(edge.winRate)) ? Number(edge.winRate) : null
    const b = bt[strategy]
    const wBt = b ? b.wrWeighted / b.trades : null
    let shrunk = null
    if (wBt != null) shrunk = n > 0 && wLive != null ? (n * wLive + k * wBt) / (n + k) : wBt
    const W = shrunk != null ? shrunk / 100 : null
    const e = {}, wouldAdmit = {}
    for (const rr of EARNED_FLOOR_PRIOR_RR) {
      const ev = W != null ? W * rr - (1 - W) : null
      e[rr] = r3(ev); wouldAdmit[rr] = ev != null ? ev > cfg.minE : null
    }
    return { live: { trades: n, winRatePct: r1(wLive) }, shrunkWinRatePct: r1(shrunk), expectancyR: e, wouldAdmit }
  }
  const rows = {}
  for (const s of strategies) {
    rows[s] = {
      backtest: bt[s] ? { winRatePct: r1(bt[s].wrWeighted / bt[s].trades), trades: bt[s].trades, combos: bt[s].combos } : null,
      pooled: scopeOf(s, null),
      byAccount: Object.fromEntries(accounts.map(a => [a, scopeOf(s, a)])),
    }
  }
  return {
    reportOnly: true,
    k,
    minE: cfg.minE,
    rr: [...EARNED_FLOOR_PRIOR_RR],
    sweepAt: Number.isFinite(sweepMs) && sweepMs > 0 ? new Date(sweepMs).toISOString() : null,
    source,
    strategiesWithPrior: Object.keys(bt).length,
    accounts,
    strategies: rows,
  }
}

/**
 * The admitted cohort, measured. A trade belongs to the cohort iff its
 * approving risk event carries the earned_floor stamp — lineage via
 * trades.risk_event_id, so the cohort is exactly the population the gate
 * admitted below HARD_MIN_RR, nothing inferred.
 */
/** Closes → {closed, wins, winRate, profitFactor, net}; profitFactor null = no losses yet, 0 = nothing won. */
function cohortStats(rows) {
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(rows.filter(r => Number(r.net_pnl) < 0).reduce((s, r) => s + Number(r.net_pnl), 0))
  return {
    closed: rows.length,
    wins: wins.length,
    winRate: rows.length ? Math.round((wins.length / rows.length) * 1000) / 10 : null,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    net: Math.round(rows.reduce((s, r) => s + Number(r.net_pnl), 0) * 100) / 100,
  }
}

export function earnedFloorReport(db) {
  const config = loadEarnedFloor(db)
  let admitted = 0
  let admitEvents = 0
  let viaPrior = { admittedApprovals: 0, closed: 0, wins: 0, winRate: null, profitFactor: null, net: 0 }
  let byAccount = {}
  let closed = { trades: 0, wins: 0, winRate: null, profitFactor: null, net: 0 }
  try {
    // DISTINCT OPPORTUNITIES, not approval events. The scanner re-evaluates
    // the same setup every cycle and the spread gate's retry loop re-approves
    // it each time — measured 01-09-2026 evening: XPTUSD/NAS100 retries
    // inflated a raw COUNT(*) from 23 to 39 in ~2 hours while the distinct
    // setups barely moved (the exact unit error opportunity-identity.js was
    // built to fix). COALESCE keeps unkeyed pre-migration rows counted
    // one-per-row rather than collapsed into one. The raw event count stays
    // beside it under its own name so neither unit is silently the other.
    const counts = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(opportunity_key, 'row:' || id)) AS distinct_n,
              COUNT(*) AS events
         FROM risk_events
        WHERE approved = 1 AND checks_json LIKE '%"earned_floor"%'`
    ).get() || {}
    admitted = counts.distinct_n || 0
    admitEvents = counts.events || 0
    // The prior population, split out (owner order 02-09-2026): how many of
    // the admits were judged on the shrunk prior rather than a measured
    // sample, and how those have closed so far.
    try {
      const pc = db.prepare(
        `SELECT COUNT(DISTINCT COALESCE(opportunity_key, 'row:' || id)) AS distinct_n
           FROM risk_events WHERE approved = 1 AND checks_json LIKE '%"via":"prior"%'`
      ).get() || {}
      const prows = db.prepare(
        `SELECT t.net_pnl FROM trades t JOIN risk_events r ON r.id = t.risk_event_id
          WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL AND r.approved = 1 AND r.checks_json LIKE '%"via":"prior"%'`
      ).all()
      viaPrior = { admittedApprovals: pc.distinct_n || 0, ...cohortStats(prows) }
    } catch { /* leave the split empty */ }
    // PER ACCOUNT (02-09-2026 plan, part 1). The pooled cohort above is the
    // pre-registered verdict; the widening decision is read per demo account,
    // so the same join is grouped by trades.account_id. Legacy rows with a
    // NULL account land in 'unscoped' — counted, never silently dropped.
    try {
      const arows = db.prepare(
        `SELECT t.net_pnl, t.account_id, (r.checks_json LIKE '%"via":"prior"%') AS via_prior
           FROM trades t JOIN risk_events r ON r.id = t.risk_event_id
          WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL AND r.approved = 1 AND r.checks_json LIKE '%"earned_floor"%'`
      ).all()
      const groups = {}
      for (const r of arows) {
        const k = r.account_id == null || r.account_id === '' ? 'unscoped' : String(r.account_id)
        const g = groups[k] || (groups[k] = { all: [], prior: [] })
        g.all.push(r); if (r.via_prior) g.prior.push(r)
      }
      byAccount = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, { ...cohortStats(g.all), viaPrior: cohortStats(g.prior) }]))
    } catch { /* leave the split empty */ }
    const rows = db.prepare(
      `SELECT t.net_pnl FROM trades t
         JOIN risk_events r ON r.id = t.risk_event_id
        WHERE t.status = 'closed' AND t.net_pnl IS NOT NULL
          AND r.approved = 1 AND r.checks_json LIKE '%"earned_floor"%'`
    ).all()
    const wins = rows.filter(r => Number(r.net_pnl) > 0)
    const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
    const grossLoss = Math.abs(rows.filter(r => Number(r.net_pnl) < 0).reduce((s, r) => s + Number(r.net_pnl), 0))
    closed = {
      trades: rows.length,
      wins: wins.length,
      winRate: rows.length ? Math.round((wins.length / rows.length) * 1000) / 10 : null,
      profitFactor: grossLoss > 0
        ? Math.round((grossWin / grossLoss) * 100) / 100
        : (grossWin > 0 ? null : 0), // null = no losses yet (∞), 0 = nothing won
      net: Math.round(rows.reduce((s, r) => s + Number(r.net_pnl), 0) * 100) / 100,
    }
  } catch { /* tables absent on first boot — zeros stand */ }
  return {
    config,
    target: { ...EARNED_FLOOR_VERDICT_TARGET },
    admittedApprovals: admitted,
    admitEvents,
    viaPrior,
    byAccount,
    closedCohort: closed,
    verdict: closed.trades >= EARNED_FLOOR_VERDICT_TARGET.closes
      ? (closed.profitFactor === null || closed.profitFactor >= EARNED_FLOOR_VERDICT_TARGET.minPf ? 'pass' : 'fail')
      : `pending ${closed.trades}/${EARNED_FLOOR_VERDICT_TARGET.closes} closes`,
    // Report only — see earnedFloorPriorReport. Never fatal.
    prior: (() => { try { return earnedFloorPriorReport(db) } catch { return null } })(),
  }
}
