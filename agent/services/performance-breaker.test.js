// node --test agent/services/performance-breaker.test.js
//
// Performance breaker: the "all hands on deck" checkpoint. Equity stop
// catches a bad DAY, adaptive breaker catches a bad STREAK on one strategy;
// this catches a structurally bad EDGE (rolling profit factor) that never
// strings 3 losses in a row. Alert-first — auto-disarm is opt-in.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { rollingStats, runPerformanceBreaker, loadPerformanceBreakerConfig, DEFAULT_PERFORMANCE_BREAKER, migrateAutoDisarmOff } from './performance-breaker.js'

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
  // Explicitly alert-only (default is now autoDisarm ON since PF hit 0.15).
  db.prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES ('performance_breaker_json', ?)`)
    .run(JSON.stringify({ ...DEFAULT_PERFORMANCE_BREAKER, autoDisarm: false }))
  for (let i = 0; i < 3; i++) closeTrade(db, +50, 200 - i * 5) // a few early wins
  for (let i = 0; i < 12; i++) closeTrade(db, -100, 100 - i * 5) // then a long bleed
  // 15 trades, 3 wins/12 losses: PF = 150/1200 = 0.125 — well under the 0.8 floor.
  const notes = []
  const out = runPerformanceBreaker(db, { notify: (t) => notes.push(t) })
  assert.equal(out.triggered, true)
  assert.equal(out.autoDisarmed, false) // explicitly alert-only here
  assert.match(notes[0], /ALL HANDS ON DECK/)
  assert.match(notes[0], /Autotrade left running/)
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

// ---------------------------------------------------------------------------
// The stored-config gap that made the owner's instruction a no-op.
//
// 2026-07-30: the owner said "autoDisarm - leave it OFF". #509 flipped
// DEFAULT_PERFORMANCE_BREAKER.autoDisarm to false — but
// loadPerformanceBreakerConfig only falls back to the default when the key is
// ABSENT, so an instance that stored `true` when they armed it on 2026-07-20
// kept auto-disarming. This breaker writes the MASTER autotrade flag, which is
// an absolute veto over every per-account switch, and on that day the owner's
// desk had autotrade off on every account with the master written false.
// ---------------------------------------------------------------------------

test('a STORED autoDisarm:true still wins over the new default — this is the gap', () => {
  const db = initDB(':memory:')
  setState(db, 'performance_breaker_json', JSON.stringify({ autoDisarm: true, pfThreshold: 0.8 }))
  assert.equal(DEFAULT_PERFORMANCE_BREAKER.autoDisarm, false, 'the default is off')
  assert.equal(loadPerformanceBreakerConfig(db).autoDisarm, true,
    'and yet the stored value wins — which is why changing the default alone did nothing')
})

test('the migration strips the stored key so the default applies, and preserves everything else', () => {
  const db = initDB(':memory:')
  setState(db, 'performance_breaker_json', JSON.stringify({
    autoDisarm: true, on: true, window: 30, minTrades: 20, pfThreshold: 0.9,
  }))
  const r = migrateAutoDisarmOff(db)
  assert.equal(r.migrated, true)
  assert.equal(r.was, true)

  const cfg = loadPerformanceBreakerConfig(db)
  assert.equal(cfg.autoDisarm, false, 'the owner instruction now actually takes effect')
  // Every other tuned field survives — this repairs one key, it does not reset
  // the breaker.
  assert.equal(cfg.window, 30)
  assert.equal(cfg.minTrades, 20)
  assert.equal(cfg.pfThreshold, 0.9)
  assert.equal(cfg.on, true)
  // And the stored JSON genuinely no longer carries the key.
  assert.equal(JSON.parse(getState(db, 'performance_breaker_json')).autoDisarm, undefined)
})

test('the migration runs exactly once, so a later deliberate re-arm is never undone', () => {
  const db = initDB(':memory:')
  setState(db, 'performance_breaker_json', JSON.stringify({ autoDisarm: true }))
  assert.equal(migrateAutoDisarmOff(db).migrated, true)

  // The owner re-arms it on purpose afterwards.
  setState(db, 'performance_breaker_json', JSON.stringify({ autoDisarm: true }))
  const second = migrateAutoDisarmOff(db)
  assert.equal(second.migrated, false)
  assert.match(second.reason, /already run/)
  assert.equal(loadPerformanceBreakerConfig(db).autoDisarm, true, 'their choice stands')
})

test('the migration is a no-op when there is nothing stored, or nothing to strip', () => {
  const empty = initDB(':memory:')
  assert.equal(migrateAutoDisarmOff(empty).migrated, false)

  const noKey = initDB(':memory:')
  setState(noKey, 'performance_breaker_json', JSON.stringify({ pfThreshold: 0.7 }))
  const r = migrateAutoDisarmOff(noKey)
  assert.equal(r.migrated, false)
  assert.match(r.reason, /no stored autoDisarm/)
  assert.equal(loadPerformanceBreakerConfig(noKey).pfThreshold, 0.7, 'untouched')

  const corrupt = initDB(':memory:')
  setState(corrupt, 'performance_breaker_json', '{not json')
  assert.equal(migrateAutoDisarmOff(corrupt).migrated, false)
})

test('the migration is audited, so the change is not a mystery later', () => {
  const db = initDB(':memory:')
  setState(db, 'performance_breaker_json', JSON.stringify({ autoDisarm: true }))
  migrateAutoDisarmOff(db)
  const rows = db.prepare(`SELECT * FROM action_log WHERE method = 'PB_AUTODISARM_OFF'`).all()
  assert.equal(rows.length, 1)
  const body = JSON.parse(rows[0].body)
  assert.equal(body.was, true)
  assert.equal(body.now, false)
})
