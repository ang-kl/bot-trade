// node --test agent/monitor-phase-concurrency.test.js
//
// D4 (docs/d4-loop-block-fix-plan.md): the monitor phase and weekend-watch
// phase used to await one LLM call per position, serially — with enough
// open positions this blocked the whole loop for 60-120s+. Both phases now
// run in bounded-concurrency chunks of MONITOR_CONCURRENCY. These tests
// guard the batching itself (every position still gets processed, one
// failure doesn't stop its siblings) and the concurrency width.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
import {
  MONITOR_CONCURRENCY,
  runMonitorPhase,
  runWeekendWatchPhase,
} from './loop.js'

function mkDb() {
  return initDB(':memory:')
}

function insertPosition(db, { symbol, source = 'external', side = 'long' }) {
  const id = db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status)
    VALUES (?, ?, 100, 99, 110, 'x', 1, ?, 'active')
  `).run(symbol, side, source).lastInsertRowid
  return db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
}

// Minimal prepared-statement shape monitorOnePosition/monitorOneWeekendPosition
// need from `s` — real loop.js builds this from db.js, but the phase helpers
// only ever call .run() on these two.
function mkStmts(db) {
  return {
    updatePositionMetrics: db.prepare(
      'UPDATE monitored_positions SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ? WHERE id = ?'
    ),
    updatePositionCheck: db.prepare(
      'UPDATE monitored_positions SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ? WHERE id = ?'
    ),
  }
}

test('MONITOR_CONCURRENCY is 4, mirroring held-prices.js', () => {
  assert.equal(MONITOR_CONCURRENCY, 4)
})

test('runMonitorPhase processes every position across multiple chunks', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  // 10 positions, > 2x MONITOR_CONCURRENCY, all external so monitorOnePosition
  // takes the cheap observe-only HOLD branch (no LLM/client involved).
  const positions = Array.from({ length: 10 }, (_, i) => insertPosition(db, { symbol: `SYM${i}` }))

  await runMonitorPhase(db, s, positions, () => 100, null)

  const rows = db.prepare("SELECT symbol, last_check_action FROM monitored_positions").all()
  assert.equal(rows.length, 10)
  assert.ok(rows.every(r => r.last_check_action === 'HOLD'), 'every position was visited, not just the first chunk')
})

test('runMonitorPhase isolates a per-position failure — siblings in the same chunk still complete', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const good = [
    insertPosition(db, { symbol: 'GOOD1' }),
    insertPosition(db, { symbol: 'GOOD2' }),
    insertPosition(db, { symbol: 'GOOD3' }),
  ]
  // An unbindable `id` (an object, not a number/string) makes the very first
  // statement inside monitorOnePosition — s.updatePositionMetrics.run — throw
  // synchronously. Since that throw happens inside monitorOnePosition's own
  // async body (not in the currentPriceOf callback), runMonitorPhase's
  // per-item .catch() must still isolate it from its chunk-mates.
  const bad = { ...insertPosition(db, { symbol: 'BAD' }), id: {} }
  const positions = [...good, bad]
  await runMonitorPhase(db, s, positions, () => 100, null)

  const goodRows = db.prepare(
    "SELECT last_check_action FROM monitored_positions WHERE symbol != 'BAD'"
  ).all()
  assert.ok(goodRows.every(r => r.last_check_action === 'HOLD'), 'good positions in the same chunk as the failure still got processed')

  const badRow = db.prepare("SELECT last_check_action FROM monitored_positions WHERE symbol = 'BAD'").get()
  assert.equal(badRow.last_check_action, null, 'the failing position never got to persist a check')
})

test('runWeekendWatchPhase processes every position across multiple chunks', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const positions = Array.from({ length: 6 }, (_, i) => insertPosition(db, { symbol: `WK${i}` }))

  const fakeResponse = {
    content: [{ type: 'text', text: JSON.stringify({ thesis_status: 'intact', gap_risk: 'low', action: 'HOLD', reasoning: 'quiet weekend', watch_events: [] }) }],
    usage: { output_tokens: 5 },
  }
  const client = { messages: { stream: async () => ({ finalMessage: async () => fakeResponse }) } }

  await runWeekendWatchPhase(db, s, positions, client)

  const rows = db.prepare("SELECT symbol, last_check_action FROM monitored_positions").all()
  assert.equal(rows.length, 6)
  assert.ok(rows.every(r => r.last_check_action === 'WEEKEND:HOLD'), 'every weekend position was visited')
})

test('runWeekendWatchPhase isolates a per-position failure — siblings still complete', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const good = insertPosition(db, { symbol: 'WKGOOD' })
  // runWeekendPositionCheck catches its own API errors and returns a default
  // HOLD (weekend-watch.js's own outer try/catch) — so the realistic failure
  // this phase's per-item .catch() needs to isolate is a downstream one, e.g.
  // s.updatePositionCheck.run throwing on a bad bind value.
  const bad = { ...insertPosition(db, { symbol: 'WKBAD' }), id: {} }

  const fakeResponse = {
    content: [{ type: 'text', text: JSON.stringify({ thesis_status: 'intact', gap_risk: 'low', action: 'HOLD', reasoning: 'ok', watch_events: [] }) }],
    usage: { output_tokens: 5 },
  }
  const client = { messages: { stream: async () => ({ finalMessage: async () => fakeResponse }) } }

  await runWeekendWatchPhase(db, s, [good, bad], client)

  const goodRow = db.prepare("SELECT last_check_action FROM monitored_positions WHERE symbol = 'WKGOOD'").get()
  assert.equal(goodRow.last_check_action, 'WEEKEND:HOLD')
  const badRow = db.prepare("SELECT last_check_action FROM monitored_positions WHERE symbol = 'WKBAD'").get()
  assert.equal(badRow.last_check_action, null, 'the failing weekend check never persisted an action')
})
