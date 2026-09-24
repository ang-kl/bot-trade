import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { readPartialOwnership } from './momentum-partial-ownership.js'

function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  db.prepare(`INSERT INTO trades(id,symbol,side,entry_price,sl_price,status,ctrader_position_id,
    account_id,label_strategy,origin,risk_event_id) VALUES(7,'ETHUSD','BUY',100,90,'open','123','A','tsmom_long','bot_market_dispatch',1)`).run()
  db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,paused,account_id,strategy)
    VALUES('ETHUSD',7,'long',100,10,1,'A','tsmom_long')`).run()
  db.prepare(`INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,entered_at)
    VALUES(7,'A','ETHUSD','123','long',100,95,'2026-09-24T15:00:00Z')`).run()
  return db
}

test('partial ownership joins account, position and trade with the sole paused book owner', t => {
  const db = fixture(t)
  assert.deepEqual(readPartialOwnership(db, 'A', 7, '123'), {
    accountId: 'A', tradeId: 7, positionId: '123', entry: 100, initialRisk: 10,
    side: 'BUY', status: 'open', owner: 'momentum_book', guardActive: false,
  })
  assert.equal(readPartialOwnership(db, 'B', 7, '123'), null)
  assert.equal(readPartialOwnership(db, 'A', 7, '124'), null)
})

test('adoption, foreign or ambiguous rows and competing management never acquire ownership', t => {
  for (const sql of [
    "UPDATE trades SET origin='reconciler_adopted'", "UPDATE trades SET status='closed'",
    "UPDATE trades SET risk_event_id=NULL", "UPDATE trades SET label_strategy='rsi2_reversion'",
    "UPDATE momentum_book SET status='exit_sent'", "UPDATE momentum_book SET account_id='B'",
    "UPDATE momentum_book SET position_id='124'", "UPDATE monitored_positions SET account_id='B'",
    "UPDATE monitored_positions SET paused=0", "UPDATE monitored_positions SET guard_json='{}'",
    "UPDATE monitored_positions SET scaled_out=1", "UPDATE monitored_positions SET bank_partial_at='2026-09-24'",
    "UPDATE monitored_positions SET entry_price=101", "UPDATE monitored_positions SET side='short'",
    `INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,entered_at)
      SELECT trade_id,account_id,symbol,position_id,side,entry_price,stop,entered_at FROM momentum_book`,
    `INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,paused,account_id,strategy)
      SELECT symbol,trade_id,side,entry_price,initial_risk,paused,account_id,strategy FROM monitored_positions`,
  ]) {
    const db = fixture(t)
    db.exec(sql)
    assert.equal(readPartialOwnership(db, 'A', 7, '123'), null, sql)
  }
})
