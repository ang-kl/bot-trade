// node --test agent/services/journal.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { buildDailyJournal, journalText, journalHtml, vetoLine, vetoRate } from './journal.js'

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

test('journalHtml: self-contained page with webapp links, no green ink', async () => {
  const { journalHtml, buildDailyJournal } = await import('./journal.js')
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, net_pnl, status, closed_at) VALUES ('NATGAS', 'BUY', 50, 'closed', '2026-07-19 10:00:00')`).run()
  const html = journalHtml(buildDailyJournal(db, '2026-07-19'), 'https://example.app')
  assert.match(html, /Journal — 2026-07-19/)
  assert.match(html, /https:\/\/example\.app\/tune/)
  assert.match(html, /https:\/\/example\.app\/trade/)
  assert.match(html, /\+\$50\.00/)
  // Colour discipline: every hex in the page must be from the app palette
  // (blue up / red down / slate neutrals) — owner is red/G colour-blind.
  const allowed = new Set(['#2563eb', '#dc2626', '#0f172a', '#f4f6fb', '#fff', '#64748b', '#94a3b8'])
  for (const hex of html.match(/#[0-9a-f]{3,6}/gi) || []) {
    assert.ok(allowed.has(hex.toLowerCase()), `unexpected colour ${hex}`)
  }
})

test('empty day journals honestly', () => {
  const db = initDB(':memory:')
  const j = buildDailyJournal(db, '2026-07-19')
  assert.equal(j.trades, 0)
  assert.match(journalText(j), /No closed trades/)
})

test('PR-C: the report prints vetoes: N (M distinct, rate R%) — repeats summed, rows counted', () => {
  const db = initDB(':memory:')
  const day = '2026-09-11'
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at, repeat_count) VALUES (?,?,?,?,?,?)`)
  ins.run('EURUSD', 'BUY', 0, 'max_positions=5/5', `${day}T01:00:00.000Z`, 7)
  ins.run('GBPUSD', 'BUY', 0, 'bad_rr 1.20<3', `${day}T02:00:00.000Z`, 1)
  ins.run('XAUUSD', 'BUY', 1, null, `${day}T03:00:00.000Z`, 1)
  const j = buildDailyJournal(db, day)
  assert.equal(j.approved, 1)
  assert.equal(j.vetoed, 8)
  assert.equal(j.vetoedDistinct, 2)
  assert.equal(j.vetoRate, 88.9)
  assert.deepEqual(j.topVetoes[0], { reason: 'max_positions=5/5', count: 7 })
  assert.equal(vetoLine(j), 'vetoes: 8 (2 distinct, rate 88.9%)')
  assert.match(journalText(j), /Gate: 1 approved · vetoes: 8 \(2 distinct, rate 88\.9%\)/)
  assert.match(journalHtml(j), /1 approved · vetoes: 8 \(2 distinct, rate 88\.9%\)/)
  assert.equal(vetoRate(0, 0), null)
})

test('PR-E: the journal prints the reasons invariant and counts the day\'s broker-made closes apart', async () => {
  const { recordTradePlan } = await import('./trade-plans.js')
  const db = initDB(':memory:')
  const day = '2026-09-10'
  // an attributed bot close with every reason on record
  const ok = db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, net_pnl, status, opened_at, closed_at, close_reason, origin, strategy, risk_event_id)
                         VALUES ('EURUSD','BUY',1.1,1.095,1.11,1000,25,'closed','2026-09-10 08:00:00','2026-09-10 10:00:00','take_profit','bot_market_dispatch','donchian_breakout',9)`).run().lastInsertRowid
  recordTradePlan(db, ok, { symbol: 'EURUSD', side: 'BUY', strategy: 'donchian_breakout', entry: 1.1, sl: 1.095, tp: 1.11 })
  db.prepare(`UPDATE trade_plans SET scored_at = '2026-09-10T10:01:00Z' WHERE trade_id = ?`).run(ok)
  let j = buildDailyJournal(db, day)
  assert.equal(j.reasonViolations, 0); assert.equal(j.closedByBroker, 0)
  assert.match(journalText(j), /reasons: 0 violation\(s\) · closedByBroker: 0/)
  // two closes the bot did not make, one of them a bot trade with no strategy
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, net_pnl, status, opened_at, closed_at, close_reason, origin)
              VALUES ('GBPUSD','SELL',1.3,-10,'closed','2026-09-10 08:00:00','2026-09-10 11:00:00','closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot','reconciler_adopted')`).run()
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, net_pnl, status, opened_at, closed_at, close_reason, origin)
              VALUES ('USDJPY','BUY',150,-5,'closed','2026-09-10 08:00:00','2026-09-10 12:00:00','already_closed','bot_pending_fill')`).run()
  j = buildDailyJournal(db, day)
  assert.equal(j.closedByBroker, 2)
  assert.equal(j.reasonViolations, 3, 'the bot row with no strategy, no plan and no approval id')
  const text = journalText(j)
  assert.match(text, /reasons: 3 violation\(s\) · closedByBroker: 2/)
  const { journalHtml } = await import('./journal.js')
  assert.match(journalHtml(j, 'https://example.app'), /3 violation\(s\) · closed by broker 2/)
})
