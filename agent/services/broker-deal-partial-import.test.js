import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { persistDeals } from './broker-history-import.js'
import { brokerDealLinkIdentities } from './broker-deal-link-identity.js'

function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  return db
}
function trade(db, account = '11', position = '900') {
  return Number(db.prepare(`INSERT INTO trades
    (account_id,ctrader_position_id,symbol,side,status,net_pnl,gross_pnl,swap,commission)
    VALUES (?,?,'TEST','BUY','closed',7,10,-1,-2)`).run(account, position).lastInsertRowid)
}
const deal = (extra = {}) => ({ deal_id: '200', position_id: '900', account_id: '11',
  symbol: 'TEST', side: 'BUY', lots: 0.1, entry_price: 100, close_price: 110,
  opened_at: '2026-01-01 00:00:00', closed_at: '2026-01-02 00:00:00',
  net_pnl: 7, gross_pnl: 10, swap: -1, commission: -2, ...extra })
const stored = db => db.prepare("SELECT * FROM broker_deals WHERE deal_id='200'").get()
const ledger = db => db.prepare('SELECT * FROM trades ORDER BY id').all()
function unchangedAmounts(before, after) {
  for (const field of ['net_pnl', 'gross_pnl', 'swap', 'commission']) assert.equal(after[field], before[field])
}

test('partial statement replay revalidates the retained same-account position and preserves a valid link', t => {
  const db = fixture(t), id = trade(db)
  trade(db, '22')
  persistDeals(db, [deal()])
  const before = stored(db), tradesBefore = ledger(db)
  const partial = deal({ position_id: null, opened_at: null })
  for (let i = 0; i < 2; i++) {
    const out = persistDeals(db, [partial]), after = stored(db)
    assert.equal(out.matchedToLocalTrades, 1)
    assert.equal(out.unmatched, 0)
    assert.equal(out.inserted, 0)
    assert.equal(after.matched_trade_id, id)
    assert.equal(after.position_id, '900')
    assert.equal(after.account_id, '11')
    assert.equal(after.opened_at, before.opened_at)
    unchangedAmounts(before, after)
  }
  assert.deepEqual(ledger(db), tradesBefore)
})

test('partial replay must clear an old link when the retained identity has become ambiguous', t => {
  const db = fixture(t)
  trade(db)
  persistDeals(db, [deal()])
  trade(db)
  const before = stored(db), tradesBefore = ledger(db)
  const out = persistDeals(db, [deal({ position_id: null })]), after = stored(db)
  assert.equal(out.matchedToLocalTrades, 0)
  assert.equal(out.unmatched, 1)
  assert.equal(after.matched_trade_id, null)
  unchangedAmounts(before, after)
  assert.deepEqual(ledger(db), tradesBefore)
})

test('a partial row without retained position evidence stays unmatched', t => {
  const db = fixture(t)
  trade(db)
  const before = ledger(db)
  const out = persistDeals(db, [deal({ position_id: null })])
  assert.equal(out.unmatched, 1)
  assert.equal(stored(db).matched_trade_id, null)
  assert.equal(stored(db).position_id, null)
  assert.deepEqual(ledger(db), before)
})

test('incoming conflicting identity cannot replace a stored deal identity or relink to another local trade', t => {
  for (const override of [{ position_id: '901' }, { account_id: '22' }]) {
    const db = fixture(t)
    trade(db)
    trade(db, '11', '901')
    trade(db, '22')
    persistDeals(db, [deal()])
    const before = stored(db), tradesBefore = ledger(db)
    const out = persistDeals(db, [deal(override)]), after = stored(db)
    assert.equal(out.unmatched, 1)
    assert.equal(out.matchedToLocalTrades, 0)
    assert.equal(after.matched_trade_id, null)
    assert.equal(after.account_id, before.account_id)
    assert.equal(after.position_id, before.position_id)
    unchangedAmounts(before, after)
    assert.deepEqual(ledger(db), tradesBefore)
  }
})

test('a full row then a partial copy in the same batch use the first inserted identity', t => {
  const db = fixture(t), id = trade(db)
  const before = ledger(db)
  const out = persistDeals(db, [deal(), deal({ position_id: null })])
  assert.equal(out.seen, 2)
  assert.equal(out.inserted, 1)
  assert.equal(out.updated, 1)
  assert.equal(out.matchedToLocalTrades, 2)
  assert.equal(stored(db).matched_trade_id, id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM broker_deals').get().n, 1)
  assert.deepEqual(ledger(db), before)
})

test('identity lookup batches retained rows and never writes to either table', t => {
  const db = fixture(t), rows = []
  for (let i = 1; i <= 501; i++) {
    rows.push(deal({ deal_id: String(i), position_id: String(i) }))
  }
  persistDeals(db, rows)
  const before = db.prepare('SELECT * FROM broker_deals ORDER BY deal_id').all()
  const partial = rows.map(row => ({ ...row, position_id: null }))
  const identities = brokerDealLinkIdentities(db, partial)
  assert.equal(identities.size, 501)
  for (let i = 0; i < partial.length; i++) {
    assert.deepEqual(identities.get(partial[i]), { accountId: '11', positionId: String(i + 1) })
  }
  assert.deepEqual(db.prepare('SELECT * FROM broker_deals ORDER BY deal_id').all(), before)
  assert.equal(ledger(db).length, 0)
})
