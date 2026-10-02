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
  monitorOnePosition,
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
    stampPositionExitMarks: db.prepare(
      'UPDATE monitored_positions SET time_cap_trail_at = COALESCE(time_cap_trail_at, ?), bank_partial_at = COALESCE(bank_partial_at, ?) WHERE id = ?'
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

// fix-the-exits BB (18-09-2026): the SLOW monitor's HOLD path writes the cap's
// hold stamp too — the end-to-end case in exit-asymmetry.test.js goes through
// the fast monitor, and a stamp written on one path and not the other would
// re-decide the cap on every slow pass (the mutation that removed this call
// left every other test green).
test('monitorOnePosition stamps a HOLD the time cap decided (stop already past breakeven) so it is not re-decided', async () => {
  const db = mkDb()
  const s = mkStmts(db)
  const id = db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, strategy, time_cap_at, created_at)
    VALUES ('EURUSD', 'BUY', 1.1000, 1.1025, NULL, 'x', 0.0050, 'autopilot', 'active', 'fib_618_fade', ?, datetime('now', '-20 hours'))
  `).run(new Date(Date.now() - 3 * 3_600_000).toISOString()).lastInsertRowid
  const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
  await monitorOnePosition(db, s, pos, 1.1050, null, () => true) // +1R, stop at +0.5R already; LLM skipped
  const row = db.prepare('SELECT status, last_check_action, last_check_reasoning, time_cap_trail_at FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(row.status, 'active')
  assert.equal(row.last_check_action, 'HOLD')
  assert.match(row.last_check_reasoning, /time_cap_held/)
  assert.ok(row.time_cap_trail_at, 'the slow monitor stamps the hold in the DB')
})

// ---------------------------------------------------------------------------
// The timeframe Chandelier pass reads bars under the ACCOUNT'S symbol id
// (02-10-2026, № 10,473·B·1). The monitored row carries no symbol id; before
// this the pass asked the bar cache for '' and never had an ATR.
// ---------------------------------------------------------------------------
import { storeBars } from './services/mae-chandelier-observe.js'
import { setState, getState } from './db.js'

test('timeframe Chandelier pass resolves the symbol id from the map and reads a tightening level', async () => {
  const db = mkDb()
  const s = { ...mkStmts(db), selectBrokerContext: { get: () => ({}) } }
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 7 }))
  // 40 hourly bars climbing to 1.1200 with a 0.0010 range → ATR ≈ 0.0010,
  // since-entry level ≈ 1.1200 − 0.0030 = 1.1170: above the 1.1010 stop,
  // below the 1.1200 price.
  const bars = Array.from({ length: 40 }, (_, i) => { const c = 1.1000 + i * 0.0005; return { h: c + 0.0005, l: c - 0.0005, c } })
  storeBars('EURUSD', bars)
  const id = db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, strategy, created_at)
    VALUES ('EURUSD', 'BUY', 1.1000, 1.1010, NULL, 'x', 0.0050, 'autopilot', 'active', 'fib_618_fade', datetime('now', '-2 hours'))
  `).run().lastInsertRowid
  const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(pos.symbol_id, undefined, 'the fixture row carries no symbol id — that is the defect')
  await monitorOnePosition(db, s, pos, 1.1200, null, () => true)
  await new Promise(r => setTimeout(r, 50)) // recordObserve is fire-and-forget
  const state = JSON.parse(getState(db, 'mae_chandelier_observe_json') || '{}')
  const reading = state.positions?.[String(id)]
  assert.ok(reading, 'the pass records the row')
  assert.equal(reading.pass, 'timeframe')
  assert.equal(reading.symbolId, '7', 'the id came from the map')
  assert.ok(reading.atr > 0, `an ATR from the mapped bars, got ${reading.atr}`)
  assert.equal(reading.mayAmend, true, 'the level tightens the stop')
  assert.ok(reading.chandelierSinceEntry > 1.1010 && reading.chandelierSinceEntry < 1.1200)
})
