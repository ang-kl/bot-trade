// node --test agent/services/edge-watchdog.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { runEdgeWatchdog, strategyRollingEdge } from './edge-watchdog.js'

// Insert n closed trades for a strategy with the given per-trade pnls.
function seed(db, strategy, pnls) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at)
     VALUES ('EURUSD','BUY','closed',?,?,?)`
  )
  pnls.forEach((p, i) => ins.run(strategy, p, `2026-07-10 ${String(i % 24).padStart(2, '0')}:00:00`))
}

const arm = (db, keys) => setState(db, 'enabled_strategies_json', JSON.stringify(keys))
const isArmed = (db, key) => JSON.parse(getState(db, 'enabled_strategies_json') || '[]').includes(key)

test('rollingEdge: honest expectancy/PF, excludes NULL net_pnl', () => {
  const db = initDB(':memory:')
  seed(db, 'rsi_meanrev', [10, -5, 4])
  // a NULL (un-backfilled) close must not be read as a loss
  db.prepare(`INSERT INTO trades (symbol,side,status,label_strategy,net_pnl,closed_at) VALUES ('EURUSD','BUY','closed','rsi_meanrev',NULL,'2026-07-10 05:00:00')`).run()
  const e = strategyRollingEdge(db, 'rsi_meanrev', 20)
  assert.equal(e.trades, 3)
  assert.equal(e.net, 9)
  assert.equal(e.expectancy, 3)
  assert.equal(e.profitFactor, Math.round((14 / 5) * 100) / 100)
})

test('disarms an armed strategy with clearly-negative edge over a full window', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  // 16 trades, mostly losers → expectancy < 0 and PF < 0.95.
  seed(db, 'rsi_meanrev', [5, -8, -7, 4, -9, -6, 3, -8, -7, 2, -9, -6, 4, -8, -7, 3])
  const notes = []
  const r = runEdgeWatchdog(db, { notify: (m) => notes.push(m) })
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].strategy, 'rsi_meanrev')
  assert.equal(isArmed(db, 'rsi_meanrev'), false, 'strategy disarmed')
  assert.ok(notes[0].includes('EDGE WATCHDOG'))
})

test('leaves a profitable armed strategy alone', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, (_, i) => (i % 3 === 0 ? -4 : 6)))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0)
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('does not judge on too few trades', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', [-9, -8, -7, -6]) // clearly losing but only 4 trades
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0)
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('spares a breakeven-but-noisy strategy (expectancy just under 0, PF ≥ floor)', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  // 8 wins of +10, 8 losses of -10.2 → expectancy -0.1, PF ≈ 0.98 (> 0.95 floor).
  seed(db, 'rsi_meanrev', [...Array(8).fill(10), ...Array(8).fill(-10.2)])
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0, 'PF above floor → not disarmed')
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('acts once per newest trade (no re-disarm every cycle)', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const first = runEdgeWatchdog(db, {})
  assert.equal(first.actions.length, 1)
  const second = runEdgeWatchdog(db, {})
  assert.equal(second.actions.length, 0, 'deduped on newest trade id')
})

test('off switch fully disables enforcement', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  setState(db, 'edge_watchdog_json', JSON.stringify({ on: false }))
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.skipped, 'off')
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})
