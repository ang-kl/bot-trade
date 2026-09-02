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
  return { ok: true, reason: null, winRate: edge.winRate, trades: edge.trades, e, riskScale: cfg.riskScale }
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
 * The admitted cohort, measured. A trade belongs to the cohort iff its
 * approving risk event carries the earned_floor stamp — lineage via
 * trades.risk_event_id, so the cohort is exactly the population the gate
 * admitted below HARD_MIN_RR, nothing inferred.
 */
export function earnedFloorReport(db) {
  const config = loadEarnedFloor(db)
  let admitted = 0
  let admitEvents = 0
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
    closedCohort: closed,
    verdict: closed.trades >= EARNED_FLOOR_VERDICT_TARGET.closes
      ? (closed.profitFactor === null || closed.profitFactor >= EARNED_FLOOR_VERDICT_TARGET.minPf ? 'pass' : 'fail')
      : `pending ${closed.trades}/${EARNED_FLOOR_VERDICT_TARGET.closes} closes`,
  }
}
