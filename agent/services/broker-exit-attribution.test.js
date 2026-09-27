import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { attributeBrokerClose, reclassifyBrokerCloses, GENERIC_BROKER_CLOSE } from './reconciler.js'
import { captureCloseDeals, collectCloseAttribution, classifyClosingOrder, LEGACY_BOOK_STOP } from './broker-exit-attribution.js'

const expected = { accountId: '11', dealId: '33', orderId: '44', positionId: '22', symbolId: '55',
  tradeSide: 2, filledVolume: 100, executionPrice: 518.16, entryPrice: 493.16, executionTimestamp: 1790354856221 }
const response = () => ({ ctidTraderAccountId: '11', order: { orderId: '44', positionId: '22', closingOrder: true,
  orderStatus: 2, orderType: 4, tradeData: { symbolId: '55', tradeSide: 2 }, stopPrice: 476.6, limitPrice: 518 },
deal: [{ dealId: '33', orderId: '44', positionId: '22', symbolId: '55', dealStatus: 2, tradeSide: 2,
  filledVolume: 100, executionPrice: 518.16, executionTimestamp: expected.executionTimestamp,
  closePositionDetail: { entryPrice: 493.16, closedVolume: 100 } }] })

test('an open momentum book row cannot prove a trailing-stop exit', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const id = db.prepare(`INSERT INTO trades(symbol, side, account_id, ctrader_position_id, entry_price, status)
    VALUES ('MSFT.US', 'BUY', '11', '22', 493.16, 'closed')`).run().lastInsertRowid
  db.prepare(`INSERT INTO momentum_book(trade_id, account_id, symbol, position_id, status, entered_at)
    VALUES (?, '11', 'MSFT.US', '22', 'open', datetime('now'))`).run(id)
  assert.equal(attributeBrokerClose(db, { tradeId: id, accountId: '11', positionId: '22' }), null)
})

test('a position-id collision does not borrow another account close event', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const id = db.prepare(`INSERT INTO trades(symbol, side, account_id, ctrader_position_id, status)
    VALUES ('MSFT.US', 'BUY', '11', '22', 'closed')`).run().lastInsertRowid
  db.prepare(`INSERT INTO position_events(account_id, position_id, symbol, kind, source, reason)
    VALUES ('99', '22', 'MSFT.US', 'close', 'profit_keeper', 'other account')`).run()
  assert.equal(attributeBrokerClose(db, { tradeId: id, accountId: '11', positionId: '22' }), null)
  assert.equal(attributeBrokerClose(db, { tradeId: id, positionId: '22' }), null,
    'an unknown account must not match a different ledger trade through its position id')
  db.prepare(`INSERT INTO momentum_book(account_id, symbol, position_id, status, entered_at, note)
    VALUES ('99', 'MSFT.US', '22', 'exit_sent', datetime('now'), 'rank exit')`).run()
  assert.equal(attributeBrokerClose(db, { tradeId: id, positionId: '22' }), null)
})

test('broker TP, moved SL, short SL and market orders remain distinct', () => {
  assert.equal(classifyClosingOrder(response(), expected).cause, 'take_profit')
  const sl = response(); sl.deal[0].executionPrice = 475
  assert.equal(classifyClosingOrder(sl, { ...expected, executionPrice: 475 }).cause, 'stop_loss')
  const short = response(); short.order.tradeData.tradeSide = 1; short.deal[0].tradeSide = 1
  short.order.stopPrice = 510; short.order.limitPrice = 450
  assert.equal(classifyClosingOrder(short, { ...expected, tradeSide: 1 }).cause, 'stop_loss')
  const market = response(); market.order.orderType = 1
  assert.equal(classifyClosingOrder(market, expected).cause, 'market', 'a market fill near TP is not a TP fill')
  const between = response(); between.deal[0].executionPrice = 500
  assert.equal(classifyClosingOrder(between, { ...expected, executionPrice: 500 }).cause, 'broker_close')
})

test('wrong account, position, symbol, order, side, volume, timestamp, entry or rejected deal cannot supply attribution', () => {
  const mutations = [r => { r.ctidTraderAccountId = '99' }, r => { r.order.positionId = '99' },
    r => { r.order.orderId = '99' }, r => { r.order.tradeData.symbolId = '99' },
    r => { r.order.closingOrder = false }, r => { r.deal[0].tradeSide = 1 },
    r => { r.deal[0].filledVolume = 50 }, r => { r.deal[0].executionTimestamp++ },
    r => { r.deal[0].closePositionDetail.entryPrice++ }, r => { r.deal[0].dealStatus = 5 },
    r => { r.deal = {} }]
  for (const mutate of mutations) { const r = response(); mutate(r); assert.equal(classifyClosingOrder(r, expected).ok, false) }
})

test('bounded collection repairs the false book label, persists provenance and never changes money or risk', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const id = db.prepare(`INSERT INTO trades(symbol, side, account_id, ctrader_position_id, entry_price,
    exit_price, status, close_reason, net_pnl, sl_price, tp_price) VALUES ('MSFT.US','BUY','11','22',493.16,
    518.16,'closed',?,249.50,463.47,518)`).run(LEGACY_BOOK_STOP).lastInsertRowid
  db.prepare(`INSERT INTO broker_deals(deal_id,position_id,account_id,matched_trade_id,closed_at)
    VALUES ('33','22','11',?,'2026-09-25 16:47:36')`).run(id)
  const before = db.prepare('SELECT net_pnl, sl_price, tp_price, entry_price, exit_price FROM trades WHERE id=?').get(id)
  assert.equal(captureCloseDeals(db, '11', response().deal, 1000), 1)
  assert.equal(captureCloseDeals(db, '11', response().deal, 1000), 0)
  let calls = 0
  assert.equal((await collectCloseAttribution(db, { accountId: '11', now: 1000,
    getOrderDetails: async oid => { calls++; assert.equal(oid,'44'); return response() } })).state, 'verified')
  assert.equal(calls, 1)
  assert.equal(reclassifyBrokerCloses(db), 1)
  assert.match(db.prepare('SELECT close_reason FROM trades WHERE id=?').get(id).close_reason, /^take profit hit.*inferred/)
  assert.deepEqual(db.prepare('SELECT net_pnl, sl_price, tp_price, entry_price, exit_price FROM trades WHERE id=?').get(id), before)
  assert.equal(reclassifyBrokerCloses(db), 0)
  db.prepare('UPDATE trades SET close_reason = ? WHERE id = ?').run('Owner note: close for cash needs', id)
  assert.equal(reclassifyBrokerCloses(db), 0, 'an explicit owner note survives; broker evidence stays separately auditable')
  assert.equal((await collectCloseAttribution(db, { accountId: '11', now: 2000, getOrderDetails: async () => { throw Error('must not read') } })).state, 'no_candidate')
})

test('late or failed order reads remain pending and a retry is paced', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare(`INSERT INTO trades(symbol,side,account_id,ctrader_position_id,status)
    VALUES ('MSFT.US','BUY','11','22','closed')`).run()
  captureCloseDeals(db,'11',response().deal,1000)
  let current = true
  const result = await collectCloseAttribution(db,{accountId:'11',now:1000,isCurrent:()=>current,
    getOrderDetails: async()=>{current=false;return response()}})
  assert.equal(result.state,'deadline_elapsed')
  assert.equal(db.prepare('SELECT state FROM broker_close_attribution').get().state,'pending')
  assert.equal((await collectCloseAttribution(db,{accountId:'11',now:2000,getOrderDetails:async()=>response()})).state,'no_candidate')
})

test('a new close near TP cannot be labelled a TP before its closing order is read', t => {
  const db=initDB(':memory:');t.after(()=>db.close())
  const id=db.prepare(`INSERT INTO trades(symbol,side,entry_price,exit_price,sl_price,tp_price,status,close_reason)
    VALUES ('MSFT.US','BUY',493.16,518.16,476.6,518,'closed',?)`).run(GENERIC_BROKER_CLOSE).lastInsertRowid
  assert.equal(reclassifyBrokerCloses(db),0)
  assert.equal(db.prepare('SELECT close_reason FROM trades WHERE id=?').get(id).close_reason,GENERIC_BROKER_CLOSE)
})
