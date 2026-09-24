import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { persistDeals, reconcileTradePricesToBroker } from './broker-history-import.js'

// Synthetic local fixtures only. No account credentials or broker calls.
function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  return db
}
function localTrade(db, { account = '11', position = '900', net = 7 } = {}) {
  return Number(db.prepare(`INSERT INTO trades
    (account_id,ctrader_position_id,symbol,side,status,entry_price,exit_price,
     volume,opened_at,closed_at,net_pnl,gross_pnl,swap,commission)
    VALUES (?,?,'TEST','BUY','closed',1000,1001,99,
      '2026-01-01 00:00:00','2026-01-02 00:00:00',?,10,-1,-2)`)
    .run(account, position, net).lastInsertRowid)
}
const deal = (overrides = {}) => ({
  deal_id: '200', position_id: '900', account_id: '11', symbol: 'TEST', side: 'BUY',
  lots: 0.1, entry_price: 100, close_price: 110,
  opened_at: '2026-01-01 00:00:00', closed_at: '2026-01-02 00:00:00',
  gross_pnl: 10, swap: -1, commission: -2, net_pnl: 7, ...overrides,
})
const trades = db => db.prepare('SELECT * FROM trades ORDER BY id').all()
const money = db => db.prepare(`SELECT deal_id,gross_pnl,net_pnl,swap,commission
  FROM broker_deals ORDER BY deal_id`).all()
const link = (db, id = '200') => db.prepare('SELECT matched_trade_id FROM broker_deals WHERE deal_id=?').get(id).matched_trade_id
function unmatched(report) {
  assert.equal(report.seen, 1)
  assert.equal(report.inserted, 0)
  assert.equal(report.updated, 1)
  assert.equal(report.matchedToLocalTrades, 0)
  assert.equal(report.unmatched, 1)
}

test('re-import clears an existing link when its account+position becomes ambiguous', t => {
  const db = fixture(t), first = localTrade(db)
  persistDeals(db, [deal()])
  assert.equal(link(db), first)
  localTrade(db, { net: -9 })
  const ledgerBefore = trades(db), moneyBefore = money(db)

  unmatched(persistDeals(db, [deal()]))
  assert.equal(link(db), null, 'unmatched must describe the stored row, not only the response')
  assert.deepEqual(money(db), moneyBefore)
  assert.deepEqual(trades(db), ledgerBefore, 'identity refresh must not alter or delete either trade')

  // This is the real downstream consumer of matched_trade_id. A stale link
  // would change prices, volume and close time on one arbitrarily chosen row.
  const reconciled = reconcileTradePricesToBroker(db)
  assert.equal(reconciled.error, undefined)
  assert.equal(reconciled.examined, 0)
  assert.equal(reconciled.corrected, 0)
  assert.equal(reconciled.volumesCorrected, 0)
  assert.equal(reconciled.closeTimesCorrected, 0)
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
})

test('re-import clears a legacy foreign-account link without moving any money', t => {
  const db = fixture(t)
  localTrade(db, { account: '22' })
  persistDeals(db, [deal({ account_id: '22' })])
  assert.notEqual(link(db), null)
  // Model a legacy wrong-account link already present before the new check.
  db.prepare("UPDATE broker_deals SET account_id='11' WHERE deal_id='200'").run()
  const ledgerBefore = trades(db), moneyBefore = money(db)
  unmatched(persistDeals(db, [deal()]))
  assert.equal(link(db), null)
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
})

test('an unscoped re-import cannot retain an old apparently valid link', t => {
  const db = fixture(t)
  localTrade(db)
  persistDeals(db, [deal()])
  const ledgerBefore = trades(db), moneyBefore = money(db)
  unmatched(persistDeals(db, [deal({ account_id: null })]))
  assert.equal(link(db), null)
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
  assert.equal(db.prepare("SELECT account_id FROM broker_deals WHERE deal_id='200'").get().account_id, '11')
})

test('a refreshed unique link stays valid, even with the same position id on another account', t => {
  const db = fixture(t), expected = localTrade(db)
  localTrade(db, { account: '22', net: -9 })
  persistDeals(db, [deal()])
  const ledgerBefore = trades(db), moneyBefore = money(db)
  for (let i = 0; i < 2; i++) {
    const report = persistDeals(db, [deal()])
    assert.equal(report.inserted, 0)
    assert.equal(report.matchedToLocalTrades, 1)
    assert.equal(report.unmatched, 0)
    assert.equal(link(db), expected)
  }
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM broker_deals').get().n, 1)
})

test('repeated refusal is idempotent and does not discard broker open-time evidence', t => {
  const db = fixture(t)
  localTrade(db)
  persistDeals(db, [deal()])
  localTrade(db, { net: 0 })
  const ledgerBefore = trades(db), moneyBefore = money(db)
  for (let i = 0; i < 2; i++) {
    unmatched(persistDeals(db, [deal({ opened_at: null })]))
    assert.equal(link(db), null)
  }
  assert.equal(db.prepare("SELECT opened_at FROM broker_deals WHERE deal_id='200'").get().opened_at, '2026-01-01 00:00:00')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM broker_deals').get().n, 1)
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
})

test('a cleared link can resolve again only after the local identity is unique', t => {
  const db = fixture(t), first = localTrade(db)
  persistDeals(db, [deal()])
  const duplicate = localTrade(db)
  unmatched(persistDeals(db, [deal()]))
  assert.equal(link(db), null)
  // Simulate a separately authorised identity resolution in this fixture;
  // production correction code itself never deletes or edits trades.
  db.prepare('DELETE FROM trades WHERE id=?').run(duplicate)
  const ledgerBefore = trades(db), moneyBefore = money(db)
  const report = persistDeals(db, [deal()])
  assert.equal(report.matchedToLocalTrades, 1)
  assert.equal(report.unmatched, 0)
  assert.equal(link(db), first)
  assert.deepEqual(trades(db), ledgerBefore)
  assert.deepEqual(money(db), moneyBefore)
})
