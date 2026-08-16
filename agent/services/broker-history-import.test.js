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

// ---------------------------------------------------------------------------
// Fill-price reconciliation (owner, 2026-08-16: "fix the P&L contradiction")
//
// 26.9% of closed trades had a price move whose sign disagreed with net_pnl.
// Measured against the broker's own ledger (98.3% self-consistent), the money
// was right and the ENTRY PRICE was wrong: `trades` kept the price the bot
// intended, broker_deals had the price it actually filled at, and nothing
// wrote the truth back. The errors are only 0.1–0.2% — but the recorded move
// is (close − entry), so any true move smaller than the slippage points the
// wrong way. These tests pin the repair and, more importantly, its limits.
// ---------------------------------------------------------------------------

import { reconcileTradePricesToBroker } from './broker-history-import.js'

function seed(db, { id, entry, exit, status = 'closed' }) {
  db.prepare(
    `INSERT INTO trades (id, symbol, side, entry_price, exit_price, status) VALUES (?, 'EURX', 'BUY', ?, ?, ?)`,
  ).run(id, entry, exit, status)
}
function deal(db, { dealId, tid, entry, close }) {
  db.prepare(
    `INSERT INTO broker_deals (deal_id, position_id, symbol, side, entry_price, close_price, net_pnl, matched_trade_id)
     VALUES (?, ?, 'EURX', 'BUY', ?, ?, -2535.41, ?)`,
  ).run(String(dealId), String(dealId), entry, close, tid)
}

test('the real EURX case: a sign-flipping entry error is corrected', () => {
  // Recorded 1076.3 → 1076.4 reads as +0.1 (a gain) while net_pnl says
  // -2535.41. The broker filled at 1077.4, which is a 1.0 LOSS and agrees.
  const db = initDB(':memory:')
  seed(db, { id: 1233, entry: 1076.3, exit: 1076.4 })
  deal(db, { dealId: 236717915, tid: 1233, entry: 1077.4, close: 1076.4 })

  const before = db.prepare('SELECT * FROM trades WHERE id = 1233').get()
  assert.ok(before.exit_price - before.entry_price > 0, 'before: reads as a gain')

  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 1)

  const after = db.prepare('SELECT * FROM trades WHERE id = 1233').get()
  assert.equal(after.entry_price, 1077.4)
  assert.ok(after.exit_price - after.entry_price < 0, 'after: reads as the loss net_pnl always said it was')
})

test('OPEN positions are left alone — their entry feeds live R', () => {
  // Rewriting entry_price mid-flight would move initial_risk and every
  // currentR under the trail, the ratchet and the loss cap at once. Open rows
  // get corrected when they close, which is when the deal arrives anyway.
  const db = initDB(':memory:')
  seed(db, { id: 900, entry: 100, exit: null, status: 'open' })
  deal(db, { dealId: 9001, tid: 900, entry: 101, close: null })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 0)
  assert.equal(out.examined, 0, 'an open row is not even examined')
  assert.equal(db.prepare('SELECT entry_price FROM trades WHERE id = 900').get().entry_price, 100)
})

test('a trade matched to SEVERAL deals is skipped, not averaged', () => {
  // Partial fill / scale-out: "the" fill price is a volume-weighted question
  // this function has no volumes to answer. Guessing an average would be the
  // same class of defect as the one being fixed.
  const db = initDB(':memory:')
  seed(db, { id: 677, entry: 5.0, exit: 5.5 })
  deal(db, { dealId: 1, tid: 677, entry: 5.1, close: 5.5 })
  deal(db, { dealId: 2, tid: 677, entry: 5.3, close: 5.5 })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.skippedMultiDeal, 1)
  assert.equal(out.corrected, 0)
  assert.equal(db.prepare('SELECT entry_price FROM trades WHERE id = 677').get().entry_price, 5.0)
})

test('a missing broker price never blanks a real one', () => {
  // A narrower import window can leave entry_price NULL on the deal. Writing
  // that through would destroy the only price we have.
  const db = initDB(':memory:')
  seed(db, { id: 5, entry: 2.87, exit: 2.90 })
  deal(db, { dealId: 50, tid: 5, entry: null, close: null })
  reconcileTradePricesToBroker(db)
  const row = db.prepare('SELECT * FROM trades WHERE id = 5').get()
  assert.equal(row.entry_price, 2.87)
  assert.equal(row.exit_price, 2.90)

  // Zero is "no answer" too, not a price.
  const db2 = initDB(':memory:')
  seed(db2, { id: 6, entry: 2.87, exit: 2.90 })
  deal(db2, { dealId: 60, tid: 6, entry: 0, close: 0 })
  reconcileTradePricesToBroker(db2)
  assert.equal(db2.prepare('SELECT entry_price FROM trades WHERE id = 6').get().entry_price, 2.87)
})

test('net_pnl is never touched — it was the field that was right', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO trades (id, symbol, side, entry_price, exit_price, net_pnl, status)
     VALUES (7, 'EURX', 'BUY', 1076.3, 1076.4, -2535.41, 'closed')`,
  ).run()
  deal(db, { dealId: 70, tid: 7, entry: 1077.4, close: 1076.4 })
  reconcileTradePricesToBroker(db)
  assert.equal(db.prepare('SELECT net_pnl FROM trades WHERE id = 7').get().net_pnl, -2535.41)
})

test('running twice changes nothing the second time', () => {
  const db = initDB(':memory:')
  seed(db, { id: 8, entry: 1076.3, exit: 1076.4 })
  deal(db, { dealId: 80, tid: 8, entry: 1077.4, close: 1076.4 })
  assert.equal(reconcileTradePricesToBroker(db).corrected, 1)
  const second = reconcileTradePricesToBroker(db)
  assert.equal(second.corrected, 0)
  assert.equal(second.unchanged, 1)
})

test('a matched deal pointing at no trade row is ignored, not an error', () => {
  const db = initDB(':memory:')
  deal(db, { dealId: 90, tid: 4242, entry: 1, close: 2 })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 0)
  assert.equal(out.examined, 0)
})
