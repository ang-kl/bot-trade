// Codex · №11,888 · 2026-10-07; codex-footprint: reversal-lifecycle-guard.
// Actual shared readers and money-writer boundaries; disposable DB, no broker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { lifecycleBalance, verifiedPositionHistory, POSITION_HISTORY_REFUSED } from './position-deal-history.js'
import { backfillClosedPnl, resetBackfillPacing } from '../services/pnl-backfill.js'

const NOW = Date.parse('2026-10-07T10:00:00Z'), ACCOUNT = '47790949', POSITION = '700'
const open = (id, at, filled = 1400) => ({ dealId: id, positionId: 700, symbolId: 10, dealStatus: 2,
  volume: filled, filledVolume: filled, executionPrice: 100, executionTimestamp: NOW - at })
const close = (id, at, filled = 1400, closed = filled, money = {}) => ({
  ...open(id, at, filled), executionPrice: 101,
  closePositionDetail: { entryPrice: 100, grossProfit: 300, swap: -10, commission: -20,
    moneyDigits: 2, closedVolume: closed, ...money },
})
const response = deals => ({ ctidTraderAccountId: ACCOUNT, hasMore: false, deal: deals })
const read = deals => verifiedPositionHistory(response(deals), { accountId: ACCOUNT, positionId: POSITION, now: NOW })
const reversal = () => [open(1, 120_000), close(2, 60_000, 2800, 1400)]
const repeated = () => [open(1, 240_000), close(2, 180_000), open(3, 120_000), close(4, 60_000)]

function fixture(t) {
  const db = initDB(':memory:')
  resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(ACCOUNT)
  setState(db, 'ctrader_account_id', ACCOUNT)
  db.prepare(`INSERT INTO trades
    (account_id,symbol,side,status,ctrader_position_id,opened_at,closed_at,entry_price,sl_price,volume,close_reason)
    VALUES (?,'X','BUY','closed',?,?,?,100,90,1,'stale reconcile: position not open at the broker')`)
    .run(ACCOUNT, POSITION, new Date(NOW - 300_000).toISOString(), new Date(NOW - 30_000).toISOString())
  return db
}
const facts = db => db.prepare('SELECT id,status,entry_price,exit_price,volume,net_pnl,gross_pnl,swap,commission FROM trades ORDER BY id').all()
const creds = { host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture',
  accessToken: 'fixture', accountId: ACCOUNT }
const options = { strictAccount: true, accountId: ACCOUNT, now: NOW }

test('a mixed reversal cannot certify a whole close while its filled residual opens', () => {
  const balance = lifecycleBalance(reversal(), POSITION)
  assert.equal(balance.balanced, false)
  assert.equal(balance.finalCloseMs, null)
  assert.match(balance.reason, /filled volume/)
})

test('closing filled-volume evidence must be present, integral, positive and equal to the closed leg', () => {
  for (const filled of [undefined, null, '', ' ', false, true, 0, -1, 1.5, 700, 2800]) {
    const deals = [open(1, 120_000), { ...close(2, 60_000), filledVolume: filled }]
    const balance = lifecycleBalance(deals, POSITION)
    assert.equal(balance.balanced, false, String(filled))
    assert.equal(balance.finalCloseMs, null)
  }
})

test('the exact reader rejects two completed episodes under one broker position ID', () => {
  assert.equal(lifecycleBalance(repeated(), POSITION).balanced, false)
  assert.throws(() => read(repeated()), error => error.code === POSITION_HISTORY_REFUSED
    && /deals after the lifecycle closed/.test(error.message))
})

test('actual window settlement defers a residual reversal and preserves money, exit and size', async t => {
  const db = fixture(t), before = facts(db), deals = reversal()
  const out = await backfillClosedPnl(db, creds, { ...options,
    getDeals: async (from, to) => response(deals.filter(d => d.executionTimestamp >= from && d.executionTimestamp < to)) })
  assert.equal(out.backfilled, 0)
  assert.deepEqual(out.deferredPositions, [POSITION])
  assert.deepEqual(facts(db), before)
})

test('actual exact-position settlement refuses repeated episodes before changing ledger facts', async t => {
  const db = fixture(t), before = facts(db)
  await assert.rejects(backfillClosedPnl(db, creds, { ...options, positionId: POSITION,
    getPositionDeals: async () => response(repeated()) }), error => error.code === POSITION_HISTORY_REFUSED)
  assert.deepEqual(facts(db), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM broker_deals').get().n, 0)
})

test('sent volume may exceed actual fill; pure partial closes still form one valid lifecycle', () => {
  const deals = [{ ...open(1, 180_000), volume: 2800 },
    { ...close(2, 120_000, 700), volume: 1400 },
    { ...close(3, 60_000, 700), volume: 1400 }]
  const out = read(deals)
  assert.equal(out.complete, true)
  assert.equal(out.lifecycle.balanced, true)
  assert.equal(out.lifecycle.opened, 1400)
  assert.equal(out.lifecycle.closed, 1400)
})

test('a valid one-lifecycle settlement keeps the existing signed native-cost calculation', async t => {
  const db = fixture(t)
  const deals = [open(1, 180_000), close(2, 120_000, 700, 700, { grossProfit: 400 }),
    close(3, 60_000, 700, 700, { grossProfit: -100, swap: -5, commission: -10 })]
  const out = await backfillClosedPnl(db, creds, { ...options, positionId: POSITION,
    getPositionDeals: async () => response(deals) })
  assert.equal(out.backfilled, 1)
  const result = facts(db)[0]
  assert.equal(result.gross_pnl, 3)
  assert.equal(result.swap, -0.15)
  assert.equal(result.commission, -0.3)
  assert.equal(result.net_pnl, 2.55)
})

test('empty and still-open responses preserve their distinct existing classifications', () => {
  assert.equal(read([]).complete, true)
  assert.equal(read([]).lifecycle.balanced, false)
  assert.throws(() => read([open(1, 120_000), close(2, 60_000, 700)]),
    error => error.code === POSITION_HISTORY_REFUSED && error.openAtBroker === true)
})

