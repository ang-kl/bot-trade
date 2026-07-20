// node --test agent/services/journal.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { buildDailyJournal, journalText } from './journal.js'

test('buildDailyJournal: trades, net, win rate, gate pressure for ONE day', () => {
  const db = initDB(':memory:')
  const insT = db.prepare(`INSERT INTO trades (symbol, side, net_pnl, status, label_strategy, closed_at) VALUES (?, 'BUY', ?, 'closed', 'fib_618_fade', ?)`)
  insT.run('NATGAS', 236.5, '2026-07-19 10:00:00')
  insT.run('EURUSD', -56.57, '2026-07-19 14:00:00')
  insT.run('GBPUSD', 10, '2026-07-20 09:00:00') // other day — excluded
  const insR = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at) VALUES ('EURUSD', 'BUY', ?, ?, ?)`)
  insR.run(1, null, '2026-07-19 10:00:00')
  insR.run(0, 'market_closed: weekend', '2026-07-19 11:00:00')
  insR.run(0, 'market_closed: weekend', '2026-07-19 12:00:00')
  insR.run(0, 'sl_too_tight 0.03%<0.15%', '2026-07-19 13:00:00')

  const j = buildDailyJournal(db, '2026-07-19')
  assert.equal(j.trades, 2)
  assert.equal(j.net, 179.93)
  assert.equal(j.winRate, 50)
  assert.equal(j.best.symbol, 'NATGAS')
  assert.equal(j.worst.symbol, 'EURUSD')
  assert.equal(j.approved, 1)
  assert.equal(j.vetoed, 3)
  assert.deepEqual(j.topVetoes[0], { reason: 'market_closed', count: 2 })

  const text = journalText(j)
  assert.match(text, /📒 Journal 2026-07-19/)
  assert.match(text, /2 closed · net \+\$179\.93 · 50% wins/)
  assert.match(text, /market closed ×2/)
})

test('empty day journals honestly', () => {
  const db = initDB(':memory:')
  const j = buildDailyJournal(db, '2026-07-19')
  assert.equal(j.trades, 0)
  assert.match(journalText(j), /No closed trades/)
})
