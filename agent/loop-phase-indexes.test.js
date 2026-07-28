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
import os from 'node:os'
import path from 'node:path'

import { initDB } from './db.js'

const STRATEGIES = ['rsi2', 'fib', 'ema', 'brk', 'cup', 'inv_cup', 'fibc', 'vwap', 'mr', 'trend', 'don']

// One seeded DB shared by the plan tests — building it is the expensive part.
const db = (() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idxplan-')), 'agent.db')
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

test('every loop sub-phase stamps its own loop_phase — no silent windows', () => {
  const src = fs.readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
  // The blocks that used to inherit the 'monitoring N positions' label.
  for (const name of [
    'adaptive breaker',
    'edge watchdog',
    'equity stop',
    'performance breaker',
    'quant',
    'housekeeping',
  ]) {
    assert.ok(src.includes(`phase('${name}')`), `sub-phase '${name}' does not name itself`)
  }
  // And the breakdown must be persisted, or naming them buys nothing.
  assert.ok(src.includes("setState(db, 'loop_phase_ms_json'"), 'phase timings never persisted')
})
