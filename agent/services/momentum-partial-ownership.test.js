import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'

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

// T1 (V3 P0-1a): the reader now takes the plan's price digits, because the
// three rows' entries are written by different arithmetic and are compared in
// ticks. Every call below passes digits 2 deliberately; with no digits no
// price can be compared, so nothing is owned.
test('partial ownership joins account, position and trade with the sole paused book owner', t => {
  const db = fixture(t)
  assert.deepEqual(readPartialOwnership(db, 'A', 7, '123', 2), {
    accountId: 'A', tradeId: 7, positionId: '123', entry: 100, initialRisk: 10,
    side: 'BUY', status: 'open', owner: 'momentum_book', guardActive: false,
  })
  assert.equal(readPartialOwnership(db, 'B', 7, '123', 2), null)
  assert.equal(readPartialOwnership(db, 'A', 7, '124', 2), null)
  for (const digits of [undefined, null, 6, 2.5]) assert.equal(readPartialOwnership(db, 'A', 7, '123', digits), null, String(digits))
})

test('fill-anchored rows a few ulps apart are one owner in ticks; a tick apart is not', t => {
  for (const [trade, book, monitor, owned] of [
    // The neighbouring doubles of 265.91 on either side.
    [265.91, 265.9100000000001, 265.90999999999997, true],
    [265.91, 265.92, 265.91, false],
    [265.91, 265.91, 265.9, false],
  ]) {
    const db = fixture(t)
    db.prepare('UPDATE trades SET entry_price=?').run(trade)
    db.prepare('UPDATE momentum_book SET entry_price=?').run(book)
    db.prepare('UPDATE monitored_positions SET entry_price=?').run(monitor)
    if (owned) assert.ok(book !== trade && monitor !== trade, 'the fixture must differ as floats to test anything')
    assert.equal(readPartialOwnership(db, 'A', 7, '123', 2) != null, owned, `${trade}/${book}/${monitor}`)
  }
})

test('the shared ownership rule compares entry and initial risk in the plan\'s ticks', () => {
  const plan = { side: 'BUY', entry: 265.91, initialRisk: 18.099999999999994, digits: 2 }
  const owner = { accountId: 'A', tradeId: 7, positionId: '123', status: 'open', owner: 'momentum_book',
    guardActive: false, side: 'BUY', entry: 265.91, initialRisk: 18.100000000000023 }
  const scope = { accountId: 'A', tradeId: 7, positionId: '123', plan }
  assert.notEqual(owner.initialRisk, plan.initialRisk)
  assert.equal(ownershipMatchesPlan(owner, scope), true)
  for (const patch of [{ initialRisk: 18.11 }, { entry: 265.92 }, { side: 'SELL' }, { guardActive: true },
    { owner: 'fast_monitor' }, { status: 'closed' }, { accountId: 'B' }, { tradeId: 8 }, { positionId: '124' }]) {
    assert.equal(ownershipMatchesPlan({ ...owner, ...patch }, scope), false, JSON.stringify(patch))
  }
  assert.equal(ownershipMatchesPlan(null, scope), false)
  assert.equal(ownershipMatchesPlan(owner, { ...scope, plan: { ...plan, digits: undefined } }), false)
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
    assert.equal(readPartialOwnership(db, 'A', 7, '123', 2), null, sql)
  }
})
