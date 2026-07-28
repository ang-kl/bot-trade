// strategy-liveness — is each armed strategy actually alive?
//
// Why this exists (2026-07-28). Cup & Handle was armed, `defaultOn`, scored
// well in backtests, and was STRUCTURALLY unable to produce a signal: it needs
// 210 bars and the scan fetched 150, so it returned null at its length guard
// before any pattern logic ran. On both engines. Nothing detected it, because
// "this strategy is broken" and "this strategy saw no setup today" look
// identical from outside — both are an absence.
//
// That is the defect class this module exists to close. It does not add any new
// data collection; every number here is already being written. What was missing
// was the question: for each armed strategy, does the funnel actually flow?
//
//   scans → the strategy produced a signal at all
//   decisions → it reached the gates (and what stopped it)
//   trades → it opened a position
//   closed → it finished one
//
// A stage that is zero while the stage above it is non-zero is a specific,
// findable problem. A strategy armed for days with zero at the FIRST stage is
// the Cup & Handle case: it is not being outvoted or vetoed, it is not running.
//
// Deliberately NOT a strategy-quality judgement. Nothing here says a strategy is
// good or bad — profit-factor and expectancy already live in the edge watchdog
// and performance breaker. This answers the prior question those cannot: is it
// even in the game.

import { enabledStrategies, STRATEGY_REGISTRY } from './strategies.js'
import { getState } from '../db.js'

/** Rolling window, in days, used when the caller does not specify one. */
export const DEFAULT_WINDOW_DAYS = 7

/**
 * A strategy is only judged SILENT once the window contains enough loop
 * activity for silence to mean something. Without this, a freshly-deployed
 * container (loop_count 1) would report every strategy as dead.
 */
export const MIN_SCANS_FOR_VERDICT = 50

/**
 * @typedef {Object} StrategyLiveness
 * @property {string} key
 * @property {string} name
 * @property {boolean} armed
 * @property {number} signals   — scan rows attributed to this strategy
 * @property {number} decisions — decision_log rows (any stage)
 * @property {number} vetoes    — decision_log rows that stopped it
 * @property {number} opened    — trades opened
 * @property {number} closed    — trades closed
 * @property {string|null} lastSignalAt
 * @property {string|null} lastTradeAt
 * @property {'trading'|'signalling_not_trading'|'silent'|'idle_unarmed'|'unknown'} verdict
 * @property {string} note — plain-language reading of the verdict
 */

const cutoffIso = (windowDays, nowMs) =>
  new Date(nowMs - windowDays * 86_400_000).toISOString()

/**
 * Timestamps are stored in two shapes in this database — ISO with a 'T'
 * (new Date().toISOString()) and SQL with a space (datetime('now')). Comparing
 * a 'T' cutoff against space-form rows silently matches nothing, which in a
 * liveness report would manufacture exactly the false "dead strategy" alarm
 * this module exists to avoid. Normalise both sides.
 */
const AT_LEAST = (col) => `REPLACE(${col}, 'T', ' ') >= REPLACE(?, 'T', ' ')`

function countBy(db, sql, params, keyCol = 'strategy') {
  const out = new Map()
  try {
    for (const row of db.prepare(sql).all(...params)) {
      const k = row[keyCol]
      if (k) out.set(k, row)
    }
  } catch { /* table missing on an old DB — treated as no data, not as zero */ }
  return out
}

/**
 * Build the liveness report.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowDays?: number, nowMs?: number }} [opts]
 * @returns {{ windowDays: number, since: string, totalScans: number, verdictable: boolean, strategies: StrategyLiveness[] }}
 */
export function strategyLiveness(db, opts = {}) {
  const windowDays = Number(opts.windowDays) > 0 ? Number(opts.windowDays) : DEFAULT_WINDOW_DAYS
  const nowMs = opts.nowMs ?? Date.now()
  const since = cutoffIso(windowDays, nowMs)

  const armedKeys = new Set(enabledStrategies(db, getState).map(s => s.key))

  const scans = countBy(db, `
    SELECT strategy, COUNT(*) AS n, MAX(scanned_at) AS last_at
      FROM scans
     WHERE strategy IS NOT NULL AND ${AT_LEAST('scanned_at')}
     GROUP BY strategy`, [since])

  const decisions = countBy(db, `
    SELECT strategy,
           COUNT(*) AS n,
           SUM(CASE WHEN decision IN ('skip','veto') THEN 1 ELSE 0 END) AS stopped
      FROM decision_log
     WHERE strategy IS NOT NULL AND ${AT_LEAST('created_at')}
     GROUP BY strategy`, [since])

  // label_strategy is the reconciled attribution; strategy is what the signal
  // claimed. COALESCE matches how perf-ledger and the breakers read it.
  const opened = countBy(db, `
    SELECT COALESCE(label_strategy, strategy) AS strategy,
           COUNT(*) AS n, MAX(opened_at) AS last_at
      FROM trades
     WHERE ${AT_LEAST('opened_at')}
     GROUP BY COALESCE(label_strategy, strategy)`, [since])

  const closed = countBy(db, `
    SELECT COALESCE(label_strategy, strategy) AS strategy, COUNT(*) AS n
      FROM trades
     WHERE status = 'closed' AND closed_at IS NOT NULL AND ${AT_LEAST('closed_at')}
     GROUP BY COALESCE(label_strategy, strategy)`, [since])

  let totalScans = 0
  for (const row of scans.values()) totalScans += Number(row.n || 0)
  // Enough scanning has happened for an absence to be evidence.
  const verdictable = totalScans >= MIN_SCANS_FOR_VERDICT

  const strategies = STRATEGY_REGISTRY.map(({ key, name }) => {
    const armed = armedKeys.has(key)
    const s = scans.get(key)
    const d = decisions.get(key)
    const o = opened.get(key)
    const c = closed.get(key)

    const signals = Number(s?.n || 0)
    const openedN = Number(o?.n || 0)

    let verdict = 'unknown'
    let note = 'not enough scan activity in this window to judge'
    if (!armed) {
      verdict = 'idle_unarmed'
      note = 'not armed — absence here is expected'
    } else if (!verdictable) {
      verdict = 'unknown'
    } else if (openedN > 0) {
      verdict = 'trading'
      note = 'producing signals and opening positions'
    } else if (signals > 0) {
      verdict = 'signalling_not_trading'
      note = 'producing signals but none reached an order — check the gates that stopped it'
    } else {
      verdict = 'silent'
      note = 'armed but produced NO signal in this window — a quiet market, or a code path that cannot run'
    }

    return {
      key,
      name,
      armed,
      signals,
      decisions: Number(d?.n || 0),
      vetoes: Number(d?.stopped || 0),
      opened: openedN,
      closed: Number(c?.n || 0),
      lastSignalAt: s?.last_at || null,
      lastTradeAt: o?.last_at || null,
      verdict,
      note,
    }
  })

  // Worst first: silent armed strategies are the finding, everything else is
  // context. Within a verdict, fewer signals first.
  const rank = { silent: 0, signalling_not_trading: 1, unknown: 2, trading: 3, idle_unarmed: 4 }
  strategies.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.signals - b.signals))

  return { windowDays, since, totalScans, verdictable, strategies }
}

/** The one-line answer: which armed strategies produced nothing at all. */
export function silentStrategies(db, opts = {}) {
  return strategyLiveness(db, opts).strategies.filter(s => s.verdict === 'silent')
}
