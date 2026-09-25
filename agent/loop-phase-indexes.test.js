// Proves the 2026-07-28 profiling fixes are real, not decorative.
//
// Two distinct claims are pinned here:
//
// 1. The indexes are actually USED by the queries they were added for. A
//    CREATE INDEX the planner ignores is worse than none — it costs write
//    throughput and buys nothing while looking like the problem was solved.
//
//    IMPORTANT: these plans are checked against a SEEDED, ANALYZE-d database.
//    On an empty table SQLite has no stats and picks by heuristics, which
//    produced a different (and misleading) plan for the breaker query during
//    development — it looked like the new index was being ignored when in fact
//    the empty table was the problem. Planner assertions are only meaningful
//    with representative data.
//
// 2. Every sub-phase of the loop names itself. The bug this replaces was a
//    diagnostic one: loop_phase said "monitoring N positions" for a window
//    that also contained four breakers, the QUANT block and the retention
//    DELETEs, so every read-stall report blamed the wrong code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync } from './test-support/temp-dir.js'
import os from 'node:os'
import path from 'node:path'

import { initDB } from './db.js'

const STRATEGIES = ['rsi2', 'fib', 'ema', 'brk', 'cup', 'inv_cup', 'fibc', 'vwap', 'mr', 'trend', 'don']

// One seeded DB shared by the plan tests — building it is the expensive part.
const db = (() => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'idxplan-')), 'agent.db')
  const d = initDB(file)
  const ins = d.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, opened_at, ctrader_position_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  d.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      ins.run(
        'EURUSD', i % 2 ? 'buy' : 'sell', i % 9 ? 'closed' : 'open', STRATEGIES[i % 11],
        (i % 7) - 3, `2026-0${1 + (i % 6)}-1${i % 9} 10:00:00`, '2026-01-01 00:00:00', String(100000 + i),
      )
    }
  })()
  const si = d.prepare('INSERT INTO scans (symbol, scanned_at) VALUES (?,?)')
  d.transaction(() => {
    for (let i = 0; i < 8000; i++) si.run(`SYM${i % 200}`, `2026-0${1 + (i % 6)}-1${i % 9} 10:00:00`)
  })()
  d.exec('ANALYZE')
  return d
})()

const planFor = (sql, ...params) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(' | ')

test('the breaker query uses idx_trades_strategy_closed instead of scanning trades', () => {
  // The exact shape adaptive-breaker.js and edge-watchdog.js run, once per
  // enabled strategy, every cycle — 22 of these per loop before the index.
  const plan = planFor(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND label_strategy = ?
      ORDER BY closed_at DESC, id DESC LIMIT 12`,
    'rsi2',
  )
  assert.match(plan, /idx_trades_strategy_closed/, plan)
  assert.doesNotMatch(plan, /SCAN trades(?! USING)/, plan)
})

test("performance-breaker's status-only read uses an index", () => {
  const plan = planFor(
    `SELECT net_pnl FROM trades WHERE status = 'closed' AND net_pnl IS NOT NULL ORDER BY closed_at DESC`,
  )
  assert.match(plan, /idx_trades_status_closed/, plan)
})

test('the equity stop still full-scans — documented, deliberate, and not the stall', () => {
  // Asserting the KNOWN state rather than a hoped-for one. REPLACE() on the
  // column is unindexable and status='closed' matches most of the table, so no
  // index helps. The predicate stays because two writers store two timestamp
  // formats and rewriting it is a live-money correctness change. If someone
  // later makes this indexable, this test failing is the right prompt to
  // update the note in db.js rather than a regression.
  const plan = planFor(
    `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
      WHERE status = 'closed' AND REPLACE(closed_at, 'T', ' ') >= ?`,
    '2026-07-27 21:00:00',
  )
  assert.match(plan, /SCAN trades/, plan)
})

test("reconciler's position-id dedupe no longer full-scans trades", () => {
  const plan = planFor('SELECT id FROM trades WHERE ctrader_position_id = ?', '100001')
  assert.match(plan, /idx_trades_position_id/, plan)
})

test('the retention DELETEs seek on time instead of walking whole tables', () => {
  assert.match(planFor('DELETE FROM scans WHERE scanned_at < ?', 'x'), /idx_scans_at/)
  assert.match(planFor('DELETE FROM signals WHERE recorded_at < ?', 'x'), /idx_signals_at/)
  assert.match(planFor('DELETE FROM regimes WHERE computed_at < ?', 'x'), /idx_regimes_at/)
})

test("QUANT's symbol sweep never touches the scans table itself", () => {
  // Either time index or the symbol covering index is fine here — what matters
  // is that it is index-only, with no row lookups against a 30-day scans table.
  const plan = planFor('SELECT DISTINCT symbol FROM scans WHERE scanned_at > ?', '2026-05-01')
  assert.match(plan, /COVERING INDEX/, plan)
})

test('the every-3s fast-monitor read of active positions uses an index', () => {
  const plan = planFor("SELECT id FROM monitored_positions WHERE status = 'active'")
  assert.match(plan, /idx_monitored_status|idx_monitored_source/, plan)
})

// loop.js with its comments removed. The naming checks below read SOURCE — the
// established last resort, because runLoop has no injection point — and a
// source check that also reads comments passes on the explanation of a call
// that is not there (CLAUDE.md failure mode #2): loop.js carries a comment
// "The launch is recorded by phase();" beside the autopilot block. `//` after a
// ':' (a URL inside a string) is kept.
function loopCode() {
  const src = fs.readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.ok(code.includes('async function runLoop(db)') && code.length > src.length * 0.4, 'comment stripping ate the code this test reads')
  return code
}

/** Index of `needle` in `code`, asserting it is there exactly where named. */
function at(code, needle) {
  const i = code.indexOf(needle)
  assert.ok(i >= 0, `\`${needle}\` is not in loop.js code (comments stripped)`)
  return i
}

test('every loop sub-phase stamps its own loop_phase — no silent windows', () => {
  const code = loopCode()
  // The blocks that used to inherit the 'monitoring N positions' label, and
  // (V3 M1) the three post-scan steps whose time used to land in whichever
  // phase ran before them — the #1079 first loop's 63,914 ms post-scan bucket.
  for (const name of [
    'adaptive breaker',
    'edge watchdog',
    'equity stop',
    'performance breaker',
    'quant',
    'housekeeping',
    'fx legs refresh',
    'trade account backfill',
    'decision audit',
  ]) {
    assert.ok(code.includes(`phase('${name}')`), `sub-phase '${name}' does not name itself`)
  }
  // And the breakdown must be persisted, or naming them buys nothing.
  assert.ok(code.includes("setState(db, 'loop_phase_ms_json'"), 'phase timings never persisted')
})

test('V3 M1: each new phase stamp sits IMMEDIATELY BEFORE the work it names — a misplaced stamp mislabels the time', () => {
  const code = loopCode()
  const pending = at(code, "phase('pending signals')")
  const fx = at(code, "phase('fx legs refresh')")
  const fxCall = at(code, 'refreshFxLegs(db,')
  const backfill = at(code, "phase('trade account backfill')")
  const backfillCall = at(code, 'backfillTradeAccounts(db)')
  const audit = at(code, "phase('decision audit')")
  const auditCall = at(code, 'readDecisionAudit(db,')
  const autopilot = at(code, "phase('autopilot')")
  assert.ok(pending < fx && fx < fxCall, "phase('fx legs refresh') must come after pending signals and before refreshFxLegs(")
  assert.ok(fxCall < backfill && backfill < backfillCall, "phase('trade account backfill') must come after the FX legs and before backfillTradeAccounts(")
  assert.ok(backfillCall < audit && audit < auditCall, "phase('decision audit') must come after the backfill and before readDecisionAudit(")
  assert.ok(auditCall < autopilot, 'the audit bucket must close at the autopilot phase')
  // and the lag tap hears every phase boundary by its stable key
  assert.ok(/const phase = \(name, key = name\) => \{[\s\S]*?markLagPhase\(key\)[\s\S]*?\n {2}\}/.test(code), 'phase() must name the phase to the lag tap')
})

test('V3 M1: the first-protection stamps are wired where the protection runs, and the loop end feeds the boot record', () => {
  // runLoop has no injection point; the stamps are behaviourally tested in
  // services/runtime-record.test.js, and THIS pins that loop.js calls them in
  // the right blocks — a refactor that drops a call site would otherwise
  // leave a boot record reading "never evaluated" forever (failure mode #4).
  const code = loopCode()
  const monitorCall = at(code, 'await runMonitorPhase(db, s, activePositions')
  const slow = at(code, "stampFirst('slowMonitor'")
  const ab = at(code, "phase('adaptive breaker')")
  const abStamp = at(code, "stampFirst('adaptiveBreaker', { ok: true")
  const abFail = at(code, "stampFirst('adaptiveBreaker', { ok: false")
  const ew = at(code, "phase('edge watchdog')")
  const es = at(code, "phase('equity stop')")
  const esStamp = at(code, "stampFirst('equityStop', { ok: true")
  const esFail = at(code, "stampFirst('equityStop', { ok: false")
  const pb = at(code, "phase('performance breaker')")
  const pbStamp = at(code, "stampFirst('performanceBreaker', { ok: true")
  const pbFail = at(code, "stampFirst('performanceBreaker', { ok: false")
  const quant = at(code, "phase('quant')")
  assert.ok(monitorCall < slow && slow < ab, 'slowMonitor is stamped after the slow-monitor pass')
  assert.ok(ab < abStamp && abStamp < abFail && abFail < ew, 'adaptiveBreaker is stamped inside its own block')
  assert.ok(es < esStamp && esStamp < esFail && esFail < pb, 'equityStop is stamped inside its own block')
  assert.ok(pb < pbStamp && pbStamp < pbFail && pbFail < quant, 'performanceBreaker is stamped inside its own block')
  const close = at(code, 'const cyclePhaseMs = closePhases()')
  const end = at(code, 'noteLoopEnd({ startedAtMs: start, ms: elapsed, phaseMs: cyclePhaseMs')
  assert.ok(close < end, 'the loop end is recorded with the cycle\'s own phase breakdown')
  assert.ok(code.includes('noteLoopEnd({ startedAtMs: start, ms: Date.now() - start, phaseMs: erroredPhaseMs, ok: false })'), 'a cycle that died is still recorded')
})
