// node --test agent/services/broker-history-import.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { fetchDeals, shapeDeals, persistDeals, importBrokerHistory } from './broker-history-import.js'

const WEEK = 7 * 24 * 3_600_000
const NOW = Date.parse('2026-07-25T00:00:00Z')

// closePositionDetail is what marks a CLOSING deal; opening deals have none.
function closingDeal({ dealId, positionId, symbolId = 1, side = 2, volume = 10_000, ms, entry = 1.1, exit = 1.12, gross = 200, swap = -5, commission = -3 }) {
  return {
    dealId, positionId, symbolId, tradeSide: side, volume, executionTimestamp: ms,
    executionPrice: exit,
    closePositionDetail: { entryPrice: entry, grossProfit: gross, swap, commission, moneyDigits: 2 },
  }
}
function openingDeal({ dealId, positionId, symbolId = 1, ms, price = 1.1 }) {
  return { dealId, positionId, symbolId, tradeSide: 1, volume: 10_000, executionTimestamp: ms, executionPrice: price }
}
const SYM = { 1: { symbolName: 'EURUSD', lotSize: 100_000 } }

test('fetchDeals pages the window a week at a time', async () => {
  const asked = []
  const getDeals = async (t0, t1) => { asked.push([t0, t1]); return { deal: [] } }
  await fetchDeals(getDeals, NOW - 3 * WEEK, NOW)
  assert.equal(asked.length, 3)
  assert.equal(asked[0][0], NOW - 3 * WEEK)
  assert.equal(asked[2][1], NOW) // last chunk is clamped to `to`, never past it
})

test('shapeDeals keeps only closing deals, inverts the side, and sums net P&L', () => {
  const rows = shapeDeals([
    openingDeal({ dealId: 1, positionId: 900, ms: NOW - 7_200_000 }),
    closingDeal({ dealId: 2, positionId: 900, ms: NOW - 3_600_000 }),
  ], SYM, '47790949')
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.deal_id, '2')
  assert.equal(r.position_id, '900')
  assert.equal(r.account_id, '47790949')
  assert.equal(r.symbol, 'EURUSD')
  // The closing deal was a SELL (2), so the POSITION was a BUY.
  assert.equal(r.side, 'BUY')
  assert.equal(r.lots, 0.1)
  assert.equal(r.net_pnl, 1.92) // (200 - 5 - 3) / 100
  assert.equal(r.entry_price, 1.1)
  assert.equal(r.close_price, 1.12)
  // opened_at comes from the position's OPENING deal, not invented.
  assert.equal(r.opened_at, '2026-07-24 22:00:00')
  assert.equal(r.closed_at, '2026-07-24 23:00:00')
})

test('opened_at stays NULL when the opening deal is outside the window', () => {
  const rows = shapeDeals([closingDeal({ dealId: 5, positionId: 901, ms: NOW })], SYM)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].opened_at, null) // never guessed from the close
})

test('an unknown symbol id still produces a stable key, not a crash', () => {
  const rows = shapeDeals([closingDeal({ dealId: 6, positionId: 902, symbolId: 4242, ms: NOW })], {})
  assert.equal(rows[0].symbol, '#4242')
  assert.equal(rows[0].lots, null) // no lotSize to divide by — NULL, not a guess
})

test('persistDeals links a deal to the local trade that placed it', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO trades (symbol, side, status, opened_at, ctrader_position_id) VALUES ('EURUSD','BUY','closed',datetime('now'),'900')").run()
  const localId = db.prepare("SELECT id FROM trades WHERE ctrader_position_id = '900'").get().id
  const out = persistDeals(db, shapeDeals([
    closingDeal({ dealId: 2, positionId: 900, ms: NOW }),
    closingDeal({ dealId: 3, positionId: 999, ms: NOW }), // no local row
  ], SYM))
  assert.equal(out.inserted, 2)
  assert.equal(out.matchedToLocalTrades, 1)
  assert.equal(out.unmatched, 1)
  assert.equal(db.prepare("SELECT matched_trade_id FROM broker_deals WHERE deal_id = '2'").get().matched_trade_id, localId)
  assert.equal(db.prepare("SELECT matched_trade_id FROM broker_deals WHERE deal_id = '3'").get().matched_trade_id, null)
})

test('re-importing the same window updates instead of duplicating', () => {
  const db = initDB(':memory:')
  const deals = [closingDeal({ dealId: 2, positionId: 900, ms: NOW, gross: 200 })]
  persistDeals(db, shapeDeals(deals, SYM))
  const second = persistDeals(db, shapeDeals([closingDeal({ dealId: 2, positionId: 900, ms: NOW, gross: 500 })], SYM))
  assert.equal(second.inserted, 0)
  assert.equal(second.updated, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM broker_deals').get().c, 1)
  assert.equal(db.prepare("SELECT net_pnl FROM broker_deals WHERE deal_id = '2'").get().net_pnl, 4.92)
})

test('a narrower re-import never overwrites a known opened_at with NULL', () => {
  const db = initDB(':memory:')
  persistDeals(db, shapeDeals([
    openingDeal({ dealId: 1, positionId: 900, ms: NOW - 7_200_000 }),
    closingDeal({ dealId: 2, positionId: 900, ms: NOW }),
  ], SYM))
  persistDeals(db, shapeDeals([closingDeal({ dealId: 2, positionId: 900, ms: NOW })], SYM))
  assert.equal(db.prepare("SELECT opened_at FROM broker_deals WHERE deal_id = '2'").get().opened_at, '2026-07-24 22:00:00')
})

test('importBrokerHistory never writes to the trades table', async () => {
  const db = initDB(':memory:')
  const before = db.prepare('SELECT COUNT(*) AS c FROM trades').get().c
  const out = await importBrokerHistory(db, {
    days: 7, nowMs: NOW,
    deps: {
      accountId: '47790949',
      getDeals: async () => ({ deal: [closingDeal({ dealId: 2, positionId: 900, ms: NOW - 3_600_000 })] }),
      getSymbolMeta: async () => SYM,
    },
  })
  assert.equal(out.inserted, 1)
  assert.equal(out.unmatched, 1)
  // The whole point of the separate table: performance stats read `trades`.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM trades').get().c, before)
})

test('a symbol-metadata failure degrades to #id instead of aborting the import', async () => {
  const db = initDB(':memory:')
  const out = await importBrokerHistory(db, {
    days: 7, nowMs: NOW,
    deps: {
      getDeals: async () => ({ deal: [closingDeal({ dealId: 9, positionId: 910, ms: NOW - 60_000 })] }),
      getSymbolMeta: async () => { throw new Error('symbol lookup down') },
    },
  })
  assert.equal(out.inserted, 1)
  assert.equal(db.prepare("SELECT symbol FROM broker_deals WHERE deal_id = '9'").get().symbol, '#1')
})

test('imported fills with no local trade row join the cluster analysis', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  // One bot entry, one untracked broker fill on the same symbol minutes later.
  db.prepare(`
    INSERT INTO trades (symbol, side, volume, status, opened_at, ctrader_position_id, source, account_id)
    VALUES ('XAUUSD','BUY',0.1,'open',datetime('now','-20 minutes'),'700','autopilot','47790949')
  `).run()
  db.prepare(`
    INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, opened_at, closed_at, net_pnl)
    VALUES ('55','701','47790949','XAUUSD','BUY',0.1,datetime('now','-15 minutes'),datetime('now'),-42.5)
  `).run()
  const { worst } = findSameSymbolClusters(db)
  assert.equal(worst.count, 2)
  assert.equal(worst.importedLegs, 1)
  assert.deepEqual(worst.paths.sort(), ['autopilot', 'broker-import'])
  assert.equal(worst.crossPath, true)
  assert.deepEqual(worst.positionIds.sort(), ['700', '701'])
})

test('a matched imported deal is not double-counted as its own leg', async () => {
  const { findSameSymbolClusters } = await import('./trade-integrity.js')
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (symbol, side, volume, status, opened_at, ctrader_position_id, source, account_id)
    VALUES ('US500','BUY',0.1,'closed',datetime('now','-10 minutes'),'800','autopilot','47790949')
  `).run()
  const tid = db.prepare("SELECT id FROM trades WHERE ctrader_position_id = '800'").get().id
  db.prepare(`
    INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, opened_at, closed_at, net_pnl, matched_trade_id)
    VALUES ('60','800','47790949','US500','BUY',0.1,datetime('now','-10 minutes'),datetime('now'),12.0, ?)
  `).run(tid)
  const { clusters } = findSameSymbolClusters(db)
  assert.equal(clusters.length, 0) // one real trade, not a pair
})
