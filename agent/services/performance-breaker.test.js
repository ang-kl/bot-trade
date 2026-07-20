// node --test agent/services/performance-breaker.test.js
//
// Performance breaker: the "all hands on deck" checkpoint. Equity stop
// catches a bad DAY, adaptive breaker catches a bad STREAK on one strategy;
// this catches a structurally bad EDGE (rolling profit factor) that never
// strings 3 losses in a row. Alert-first — auto-disarm is opt-in.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { rollingStats, runPerformanceBreaker, loadPerformanceBreakerConfig, DEFAULT_PERFORMANCE_BREAKER } from './performance-breaker.js'

function closeTrade(db, pnl, minutesAgo = 0) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, opened_at, closed_at)
     VALUES ('EURUSD', 'BUY', 'closed', ?, datetime('now', ?), datetime('now', ?))`
  ).run(pnl, `-${minutesAgo + 30} minutes`, `-${minutesAgo} minutes`)
}

test('defaults: alert armed, auto-disarm off, sane clamps', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadPerformanceBreakerConfig(db), DEFAULT_PERFORMANCE_BREAKER)
})

test('rollingStats: profit factor, expectancy, win rate over the last N closed trades', () => {
  const db = initDB(':memory:')
  // 1 win of +89, 3 losses of -150 each — matches the owner's live numbers
  // in shape: 25% win rate, PF well under 1.
  closeTrade(db, +89, 40)
  closeTrade(db, -150, 30)
  closeTrade(db, -150, 20)
  closeTrade(db, -150, 10)
  const s = rollingStats(db, 20)
  assert.equal(s.trades, 4)
  assert.equal(s.winRate, 25)
  assert.ok(Math.abs(s.profitFactor - 89 / 450) < 0.01) // profitFactor is rounded to 2dp
  assert.equal(s.net, 89 - 450)
})

test('runPerformanceBreaker: fires once the sample is big enough and PF is below the floor', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 3; i++) closeTrade(db, +50, 200 - i * 5) // a few early wins
  for (let i = 0; i < 12; i++) closeTrade(db, -100, 100 - i * 5) // then a long bleed
  // 15 trades, 3 wins/12 losses: PF = 150/1200 = 0.125 — well under the 0.8 floor.
  const notes = []
  const out = runPerformanceBreaker(db, { notify: (t) => notes.push(t) })
  assert.equal(out.triggered, true)
  assert.equal(out.autoDisarmed, false) // default off
  assert.match(notes[0], /ALL HANDS ON DECK/)
  assert.match(notes[0], /Autotrade left running/)
  assert.equal(getState(db, 'autotrade_enabled'), 'false') // untouched — same as its seeded default
})

test('runPerformanceBreaker: does not fire below minTrades even with a terrible PF', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 2; i++) closeTrade(db, -100, 10 - i * 5)
  const out = runPerformanceBreaker(db)
  assert.equal(out.skipped, 'insufficient_sample')
})

test('runPerformanceBreaker: does not fire when PF is at/above the floor', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 10; i++) closeTrade(db, +100, 200 - i * 5)
  for (let i = 0; i < 10; i++) closeTrade(db, -50, 100 - i * 5)
  const out = runPerformanceBreaker(db)
  assert.equal(out.skipped, 'above_threshold')
})

test('runPerformanceBreaker: acts once per newest-trade-id — a new bad trade re-triggers, nothing else does', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 3; i++) closeTrade(db, +50, 200 - i * 5)
  for (let i = 0; i < 12; i++) closeTrade(db, -100, 100 - i * 5)
  const first = runPerformanceBreaker(db, { notify: () => {} })
  assert.equal(first.triggered, true)
  const again = runPerformanceBreaker(db, { notify: () => {} })
  assert.equal(again.skipped, 'already_alerted')
  closeTrade(db, -100, 0) // a fresh loss moves newestId
  const third = runPerformanceBreaker(db, { notify: () => {} })
  assert.equal(third.triggered, true)
})

test('runPerformanceBreaker: autoDisarm actually disarms autotrade when armed', () => {
  const db = initDB(':memory:')
  db.prepare(`UPDATE agent_state SET value = 'true' WHERE key = 'autotrade_enabled'`).run()
  db.prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES ('autotrade_enabled', 'true')`).run()
  db.prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES ('performance_breaker_json', ?)`)
    .run(JSON.stringify({ ...DEFAULT_PERFORMANCE_BREAKER, autoDisarm: true }))
  for (let i = 0; i < 3; i++) closeTrade(db, +50, 200 - i * 5)
  for (let i = 0; i < 12; i++) closeTrade(db, -100, 100 - i * 5)
  const notes = []
  const out = runPerformanceBreaker(db, { notify: (t) => notes.push(t) })
  assert.equal(out.autoDisarmed, true)
  assert.equal(getState(db, 'autotrade_enabled'), 'false')
  assert.match(notes[0], /Autotrade DISARMED/)
})

test('runPerformanceBreaker: off entirely when the toggle is off', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES ('performance_breaker_json', ?)`)
    .run(JSON.stringify({ ...DEFAULT_PERFORMANCE_BREAKER, on: false }))
  for (let i = 0; i < 12; i++) closeTrade(db, -100, 100 - i * 5)
  const out = runPerformanceBreaker(db, { notify: () => { throw new Error('must not notify') } })
  assert.equal(out.skipped, 'off')
})
