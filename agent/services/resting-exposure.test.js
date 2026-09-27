import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { restingExposure } from './resting-exposure.js'
import { countedPositionsWithTickFires, maxPositionsVerdict, portfolioMarginStatus, DEFAULT_RISK_CONFIG } from './risk.js'

test('OD-15 counts each resting entry once across both tables, keeps manual orders, and isolates accounts', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const pending = db.prepare("INSERT INTO pending_orders(symbol,account_id,order_id,dir,level,volume,status) VALUES('EURUSD',?,?,1,1.1,0.1,'working')")
  pending.run('11', '101'); pending.run('11', '102'); pending.run('22', '201')
  const broker = db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,order_type,volume,limit_price,status) VALUES(?,?,'EURUSD','BUY','LIMIT',10000,1.1,'working')")
  broker.run('101', '11'); broker.run('103', '11'); broker.run('201', '22')
  assert.equal(restingExposure(db, '11').length, 3)
  assert.equal(restingExposure(db, '22').length, 1)
  assert.equal(restingExposure(db, '33').length, 0)
  const counted = countedPositionsWithTickFires(db, '11').counted
  assert.equal(counted.length, 3)
  assert.equal(maxPositionsVerdict(counted, { maxOpenPositions: 3 }).block, true)
  assert.equal(maxPositionsVerdict(counted, { maxOpenPositions: 4 }).block, false)
  db.prepare("UPDATE pending_orders SET status='cancelled' WHERE order_id='102'").run()
  db.prepare("UPDATE broker_orders SET status='gone' WHERE order_id='103'").run()
  assert.equal(restingExposure(db, '11').length, 1)
})

test('OD-15 reserves margin in addition to the account snapshot, with correct lot/unit conversion and no duplicate charge', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'acct:11:broker_snapshot_cache_json', JSON.stringify({ account: { accountId: '11', currency: 'USD', health: { usedMargin: 100 } }, fetchedAt: new Date().toISOString() }))
  db.prepare("INSERT INTO pending_orders(symbol,account_id,order_id,dir,level,volume,status) VALUES('EURUSD','11','101',1,1.1,0.1,'working')").run()
  const read = () => portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { accountId: '11', balance: 1000, leverage: 100 })
  const local = read()
  assert.equal(Math.round(local.restingMargin), 110)
  assert.equal(Math.round(local.usedMargin), 210)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,limit_price,status) VALUES('101','11','EURUSD','BUY',10000,1.1,'working')").run()
  assert.equal(read().restingMargin, local.restingMargin)
  assert.equal(read().headroom, local.headroom)
  db.prepare("INSERT INTO pending_orders(symbol,account_id,dir,level,volume,status) VALUES('EURUSD','22',1,1.1,10,'working')").run()
  assert.equal(read().usedMargin, local.usedMargin)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,status) VALUES('103','11','EURUSD','BUY',10000,'working')").run()
  assert.deepEqual(read().restingUnpriced, ['103'])
  assert.equal(read().headroom, 0)
})
