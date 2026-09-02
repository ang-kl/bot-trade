// node --test agent/services/broker-history-import.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('filling a broker-side close\'s exit price stamps its realised R and consistency verdict', () => {
  // The production shape, measured 02-09-2026 on trade 1418 (NATGAS): the
  // reconciler closed the row with NO exit price (a broker-side close), so
  // closeTradeRow stamped realised_rr NULL — correctly. The money arrived,
  // then THIS step filled exit_price from the broker deal and stamped
  // nothing, so the row held entry, exit, stop and money and no R, for life.
  // Ten of twelve bot closes looked exactly like this; each one's exit_price
  // equalled the deal's close_price to the digit.
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO trades (id, symbol, side, entry_price, exit_price, sl_price, net_pnl, status, realised_rr, pnl_price_mismatch)
     VALUES (1418, 'NATGAS', 'BUY', 2.933, NULL, 2.9144642857142857, -498.4, 'closed', NULL, 0)`,
  ).run()
  deal(db, { dealId: 239675091, tid: 1418, entry: 2.933, close: 2.919 })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 1)
  const row = db.prepare('SELECT exit_price, realised_rr, pnl_price_mismatch FROM trades WHERE id = 1418').get()
  assert.equal(row.exit_price, 2.919)
  assert.ok(Number.isFinite(row.realised_rr) && row.realised_rr < 0, `R must be stamped from the filled price, got ${row.realised_rr}`)
  assert.equal(Math.round(row.realised_rr * 1000) / 1000, Math.round(((2.919 - 2.933) / (2.933 - 2.9144642857142857)) * 1000) / 1000)
  assert.equal(row.pnl_price_mismatch, 0, 'a loss on a losing move agrees with itself')

  // And a correction that flips the sign of the move re-judges the verdict:
  // the EURX case with money present now lands as consistent, not flagged.
  db.prepare(
    `INSERT INTO trades (id, symbol, side, entry_price, exit_price, sl_price, net_pnl, status, pnl_price_mismatch)
     VALUES (1233, 'EURX', 'BUY', 1076.3, 1076.4, 1070, -2535.41, 'closed', 1)`,
  ).run()
  deal(db, { dealId: 236717915, tid: 1233, entry: 1077.4, close: 1076.4 })
  reconcileTradePricesToBroker(db)
  const fixed = db.prepare('SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = 1233').get()
  assert.equal(fixed.pnl_price_mismatch, 0, 'once the entry is the broker\'s, money and prices agree')
  assert.ok(fixed.realised_rr < 0)
})

test('a matched deal pointing at no trade row is ignored, not an error', () => {
  const db = initDB(':memory:')
  deal(db, { dealId: 90, tid: 4242, entry: 1, close: 2 })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 0)
  assert.equal(out.examined, 0)
})

test('the repair is reachable from the loop, not only the manual route', () => {
  // importBrokerHistory is called ONLY from a manual POST route (verified:
  // agent/routes/actions.js is its sole caller). A repair that lived solely
  // there would be a repair that never runs — the exact shape of defect this
  // fix exists to remove. So the loop calls it directly.
  //
  // NOT via pnl-backfill, which is also on the loop and already writes
  // broker_deals: that service fills a NULL price and repairs a FLAGGED row
  // but never overwrites a present, unflagged one ("filling a NULL is broker
  // truth; overwriting a value is a different claim" — pnl-backfill.test.js).
  // This IS that different claim, and hanging it there broke those two tests,
  // correctly. It belongs in the open as its own step.
  //
  // Pinned here because the wiring is invisible in the module under test and
  // a refactor would drop it silently.
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.match(loop, /reconcileTradePricesToBroker\(db\)/,
    'the loop must invoke the correction, or it only ever runs by hand')

  const backfill = readFileSync(new URL('./pnl-backfill.js', import.meta.url), 'utf8')
  assert.doesNotMatch(backfill, /reconcileTradePricesToBroker/,
    'pnl-backfill promises not to overwrite a present price — keep this out of it')
})

// ---------------------------------------------------------------------------
// 02-09-2026 (codebase audit). The two HTTP writers that used to sit outside
// the shared audit stamp, now pure functions over the db.
// ---------------------------------------------------------------------------

import { applyBrokerHistoryMoney, judgeTradesAgainstDeals } from './broker-history-import.js'

test('applyBrokerHistoryMoney fills a NULL net_pnl only, on this account or an unstamped row, and re-stamps R', () => {
  const db = initDB(':memory:')
  const ins = (id, acct, net, exit) => db.prepare(
    `INSERT INTO trades (id, symbol, side, status, ctrader_position_id, account_id, entry_price, exit_price, sl_price, net_pnl)
     VALUES (?, 'NATGAS', 'BUY', 'closed', ?, ?, 2.933, ?, 2.9144642857142857, ?)`,
  ).run(id, String(id), acct, exit, net)
  ins(1, '47790949', null, null)        // this account, money missing → filled, exit filled, R stamped
  ins(2, '47790949', -100, 2.9)         // this account, money present → untouched
  ins(3, '46130058', null, null)        // ANOTHER account → untouched
  ins(4, null, null, null)              // no account stamp → claimed and filled
  const agg = (net, close) => ({ net, gross: net, last: { closePrice: close, closedAt: Date.parse('2026-09-01T20:06:33Z') } })
  const by = new Map([['1', agg(-498.4, 2.919)], ['2', agg(999, 2.5)], ['3', agg(-7, 2.9)], ['4', agg(-12.5, 2.92)]])
  const out = applyBrokerHistoryMoney(db, by, { accountId: '47790949' })
  assert.equal(out.backfilled, 2)
  const row = (id) => db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
  assert.equal(row(1).net_pnl, -498.4); assert.equal(row(1).exit_price, 2.919); assert.ok(row(1).realised_rr < 0)
  assert.equal(row(2).net_pnl, -100, 'a stamped value is broker-true already — never overwritten'); assert.equal(row(2).exit_price, 2.9)
  assert.equal(row(3).net_pnl, null, 'another account\'s row is not this account\'s to fill')
  assert.equal(row(4).net_pnl, -12.5); assert.equal(row(4).account_id, '47790949', 'attribute-on-match')
  assert.ok(row(4).realised_rr < 0)
})

test('judgeTradesAgainstDeals rejects only in-flight rows, reports an unmatched open row, and stamps a repaired entry', () => {
  const db = initDB(':memory:')
  const ins = (id, status, entry, posId) => db.prepare(
    `INSERT INTO trades (id, symbol, side, status, ctrader_position_id, entry_price, exit_price, sl_price, net_pnl, opened_at)
     VALUES (?, 'EURUSD', 'BUY', ?, ?, ?, 1.11, 1.09, 50, '2026-09-01 10:00:00')`,
  ).run(id, status, posId, entry)
  ins(1, 'closed', null, '900')      // matched by position id, entry missing → repaired + stamped
  ins(2, 'submitting', 1.1, null)    // no deal → rejected
  ins(3, 'open', 1.1, null)          // no deal → REPORTED, never rewritten
  ins(4, 'closed', 1.1, '901')       // matched → confirmed
  const deals = [
    { dealId: 'd1', positionId: '900', symbolId: 1, executionPrice: 1.1, executionTimestamp: Date.parse('2026-09-01T10:00:05Z') },
    { dealId: 'd2', positionId: '901', symbolId: 1, executionPrice: 1.1, executionTimestamp: Date.parse('2026-09-01T09:00:00Z') },
  ]
  // symbolMap deliberately EMPTY so time-window matching cannot rescue rows 2/3.
  const out = judgeTradesAgainstDeals(db, { rows: db.prepare('SELECT * FROM trades ORDER BY id').all(), deals, symbolMap: {} })
  assert.deepEqual({ confirmed: out.confirmed, repaired: out.repaired, rejected: out.rejected, unmatchedOpen: out.unmatchedOpen }, { confirmed: 1, repaired: 1, rejected: 1, unmatchedOpen: 1 })
  const row = (id) => db.prepare('SELECT * FROM trades WHERE id = ?').get(id)
  assert.equal(row(1).entry_price, 1.1); assert.ok(row(1).realised_rr > 0, 'a filled entry re-stamps R')
  assert.equal(row(2).status, 'rejected')
  assert.equal(row(3).status, 'open', 'a missing deal is a gap in the fetch, not proof of no position')
  assert.equal(out.details.find(d => d.id === 3).result, 'unmatched_open')
})

test('reconcileTradePricesToBroker fills slippage from the proposal and the broker fill, adverse-positive, NULL only', () => {
  const db = initDB(':memory:')
  const ins = (id, side, proposal, entry, slip) => db.prepare(
    `INSERT INTO trades (id, symbol, side, entry_price, exit_price, status, proposal_entry_price, slippage_price)
     VALUES (?, 'NATGAS', ?, ?, 2.919, 'closed', ?, ?)`,
  ).run(id, side, entry, proposal, slip)
  ins(1, 'BUY', 2.927, 2.933, null)   // already corrected before this existed — prices unchanged, slippage still fills
  ins(2, 'SELL', 2.927, null, null)   // entry NULL, proposal present
  ins(3, 'BUY', 2.927, 2.933, 0.001)  // stamped at dispatch — never overwritten
  ins(4, 'BUY', null, 2.933, null)    // no proposal on record (pre-column row) — stays NULL
  for (const [id, entry] of [[1, 2.933], [2, 2.920], [3, 2.933], [4, 2.933]]) deal(db, { dealId: 100 + id, tid: id, entry, close: 2.919 })
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.slippageFilled, 2)
  const slip = (id) => db.prepare('SELECT slippage_price FROM trades WHERE id = ?').get(id).slippage_price
  assert.equal(Math.round(slip(1) * 1e6) / 1e6, 0.006, 'BUY filled above the proposal — adverse, positive')
  assert.equal(Math.round(slip(2) * 1e6) / 1e6, 0.007, 'SELL filled below the proposal — adverse, positive')
  assert.equal(slip(3), 0.001)
  assert.equal(slip(4), null)
  assert.equal(reconcileTradePricesToBroker(db).slippageFilled, 0, 'idempotent')
})

// ---------------------------------------------------------------------------
// SILENT FAILURE, STAMPED (CLAUDE.md failure mode #3: a repair that reports
// `corrected: 0` because its transaction threw is indistinguishable from one
// that found nothing to fix). The throw is forced with a trigger so the test
// exercises the real transaction path, not a mocked one.
// ---------------------------------------------------------------------------
test('a thrown transaction is REPORTED in the result, not swallowed as corrected:0', () => {
  const db = initDB(':memory:')
  seed(db, { id: 1300, entry: 1076.3, exit: 1076.4 })
  deal(db, { dealId: 3001, tid: 1300, entry: 1077.4, close: 1076.4 })
  db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF entry_price ON trades
           BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.corrected, 0, 'the write did not land')
  assert.match(String(out.error), /simulated write failure/,
    'a result with corrected:0 and no error field reads as "nothing to fix" — it must carry the error')
})

test('the loop stamps the reconcile error durably and clears it on success', () => {
  // Source pin, comments stripped: the call site is the only place that can
  // turn `error` into a durable, visible record.
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const start = loop.indexOf('reconcileTradePricesToBroker(db)')
  assert.ok(start > 0)
  const slice = loop.slice(start, start + 1500).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(slice, /fix\.error/, 'the loop must read the error field the repair now returns')
  assert.match(slice, /setState\(db, 'price_reconcile_last_error_json'/, 'the error must be stamped where a route can read it')
  assert.match(slice, /setState\(db, 'price_reconcile_last_error_json', null\)/, 'a success must clear a stale error')
})

test('multi-deal entry: a lots-weighted entry and exit are written when every deal carries lots', () => {
  // Partial fill: 0.1 lot at 5.1 and 0.3 lot at 5.3 → entry 5.25; closes
  // 0.1 at 5.5 and 0.3 at 5.7 → exit 5.65. Weighted, not averaged: a plain
  // mean (5.2 / 5.6) would be wrong by the size asymmetry.
  const db = initDB(':memory:')
  seed(db, { id: 800, entry: 5.0, exit: 5.5 })
  const ins = db.prepare(
    `INSERT INTO broker_deals (deal_id, position_id, symbol, side, lots, entry_price, close_price, net_pnl, matched_trade_id)
     VALUES (?, ?, 'EURX', 'BUY', ?, ?, ?, 1, 800)`,
  )
  ins.run('11', '11', 0.1, 5.1, 5.5)
  ins.run('12', '12', 0.3, 5.3, 5.7)
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.skippedMultiDeal, 0, 'lots are present, so nothing is skipped')
  assert.equal(out.mergedMultiDeal, 1)
  assert.equal(out.corrected, 1)
  const t = db.prepare('SELECT entry_price, exit_price FROM trades WHERE id = 800').get()
  assert.ok(Math.abs(t.entry_price - 5.25) < 1e-9, `entry ${t.entry_price} should be the lots-weighted 5.25`)
  assert.ok(Math.abs(t.exit_price - 5.65) < 1e-9, `exit ${t.exit_price} should be the lots-weighted 5.65`)
})

test('multi-deal entry: ONE deal without lots keeps the whole trade skipped', () => {
  const db = initDB(':memory:')
  seed(db, { id: 801, entry: 5.0, exit: 5.5 })
  const ins = db.prepare(
    `INSERT INTO broker_deals (deal_id, position_id, symbol, side, lots, entry_price, close_price, net_pnl, matched_trade_id)
     VALUES (?, ?, 'EURX', 'BUY', ?, ?, ?, 1, 801)`,
  )
  ins.run('21', '21', 0.1, 5.1, 5.5)
  ins.run('22', '22', null, 5.3, 5.7)
  const out = reconcileTradePricesToBroker(db)
  assert.equal(out.skippedMultiDeal, 1)
  assert.equal(out.mergedMultiDeal, 0)
  assert.equal(out.corrected, 0)
  assert.equal(db.prepare('SELECT entry_price FROM trades WHERE id = 801').get().entry_price, 5.0)
})
