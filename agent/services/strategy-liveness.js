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

import { STRATEGY_REGISTRY } from './strategies.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { armedTradeKeys } from './stage-matrix.js'
import { LAST_ANALYZED_KEY } from './analyze-fair-share.js'
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

  // PER-ACCOUNT SCOPING, and it is deliberately PARTIAL — the funnel's four
  // stages do not all belong to an account.
  //
  //   signals   scans rows. Account-INDEPENDENT by design (plan M1: scans and
  //             analyses are market observations and stay NULL). One scan
  //             serves every account, so "this account's signals" is not a
  //             quantity that exists. It stays global, and `signalsScope`
  //             says so in the payload rather than letting a scoped-looking
  //             number imply otherwise.
  //   decisions decision_log — per account.
  //   opened    trades — per account.
  //   closed    trades — per account.
  //
  // Reporting the whole funnel as scoped would be the more comfortable lie:
  // it would make the first stage look like it had been filtered when nothing
  // filtered it.
  const acct = opts.accountId != null && opts.accountId !== '' && opts.accountId !== 'all'
    ? String(opts.accountId)
    : null
  const acctScope = acct ? 'AND (account_id = ? OR account_id IS NULL)' : ''
  const acctParams = acct ? [acct] : []

  // ARMED IS PER ACCOUNT, and this used to read the global key.
  //
  // Owner, 05-08-2026, on an iPhone screenshot of this card: "keeps disarmed
  // and i cannot see which account is disarmed". Both halves had one cause.
  // The trade column that actually gates order placement is per-account
  // (stage-matrix's acct:<id>:enabled_strategies_json overlay), and both demo
  // accounts had fib_confluence TRADE-armed at the time. This badge was
  // reading the GLOBAL list, so it reported "Not armed" about a scope the card
  // never showed — and there was no account to name because the number was not
  // about an account.
  const armedKeys = armedTradeKeys(db, getState, acct)

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
     WHERE strategy IS NOT NULL AND ${AT_LEAST('created_at')} ${acctScope}
     GROUP BY strategy`, [since, ...acctParams])

  // label_strategy is the reconciled attribution; strategy is what the signal
  // claimed. strategyAttrSql() prefers the reconciled one but treats 'other'
  // as ABSENT rather than as an answer — a plain COALESCE let the string
  // 'other' (what a strategy with no broker-label code round-trips to) hide a
  // real key sitting in the next column.
  const opened = countBy(db, `
    SELECT ${strategyAttrSql()} AS strategy,
           COUNT(*) AS n, MAX(opened_at) AS last_at
      FROM trades
     WHERE ${AT_LEAST('opened_at')} ${acctScope}
     GROUP BY ${strategyAttrSql()}`, [since, ...acctParams])

  const closed = countBy(db, `
    SELECT ${strategyAttrSql()} AS strategy, COUNT(*) AS n
      FROM trades
     WHERE status = 'closed' AND closed_at IS NOT NULL AND ${AT_LEAST('closed_at')} ${acctScope}
     GROUP BY ${strategyAttrSql()}`, [since, ...acctParams])

  let totalScans = 0
  for (const row of scans.values()) totalScans += Number(row.n || 0)
  // Enough scanning has happened for an absence to be evidence.
  const verdictable = totalScans >= MIN_SCANS_FOR_VERDICT

  // WHICH GATE STOPPED IT — the card used to say "check the gates that stopped
  // it" and leave the reader to go and check. Measured 05-08-2026: five armed
  // strategies had 3,668 signals and ZERO decisions, because the analyze phase
  // takes three symbols per cycle ranked by a conviction score that is 9-or-10
  // on everything, so the same three strategies won every tie. Nothing vetoed
  // the other five; they were never asked. That is not "check the gates" — it
  // is a specific, nameable answer, and the card can give it.
  let lastAnalyzed = {}
  try { lastAnalyzed = JSON.parse(getState(db, LAST_ANALYZED_KEY) || '{}') || {} } catch { lastAnalyzed = {} }
  const analyzedAt = (key) => {
    const raw = lastAnalyzed?.[key]
    return raw == null || raw === '' ? null : String(raw)
  }

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
      // ZERO decisions is a different failure from "vetoed at the gate", and
      // conflating them is what made this unreadable: one means the risk gate
      // refused it, the other means the risk gate never saw it.
      note = Number(d?.n || 0) === 0
        ? (analyzedAt(key) == null
          ? 'never given an analyze slot — it signals, but the three slots per cycle always went to another strategy, so nothing has ever evaluated it'
          : 'signals reached NO gate in this window — the analyze slots went elsewhere; last slot ' + analyzedAt(key))
        : 'producing signals but none reached an order — check the gates that stopped it'
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
      // null means NEVER, not "unknown" — the loudest case, kept distinct.
      lastAnalyzedAt: analyzedAt(key),
      verdict,
      note,
    }
  })

  // Worst first: silent armed strategies are the finding, everything else is
  // context. Within a verdict, fewer signals first.
  const rank = { silent: 0, signalling_not_trading: 1, unknown: 2, trading: 3, idle_unarmed: 4 }
  strategies.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.signals - b.signals))

  return {
    windowDays,
    since,
    accountId: acct,
    // Named per stage so a reader can never mistake a global number for a
    // scoped one.
    scope: acct
      ? { signals: 'all accounts (scans are market observations)', decisions: acct, opened: acct, closed: acct, armed: acct }
      : { signals: 'all accounts', decisions: 'all accounts', opened: 'all accounts', closed: 'all accounts', armed: 'global default' },
    // Whose arming the ARMED/OFF badge is reporting. Without this the card can
    // show "Not armed" and leave the reader with no way to know what it is
    // "not armed" ON — which is exactly the question the owner asked from a
    // phone, where the account switcher is not on screen beside the badge.
    armedScope: acct ?? 'global default',
    totalScans,
    verdictable,
    strategies,
  }
}

/** The one-line answer: which armed strategies produced nothing at all. */
export function silentStrategies(db, opts = {}) {
  return strategyLiveness(db, opts).strategies.filter(s => s.verdict === 'silent')
}
