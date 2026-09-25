// WEB-9 (8,989-A row 11): GET /state/data-feed — the Data-feed card's
// measured latency, stored fees/swap and quote freshness.
//
// The card's daily stop is NOT served here. WEB-9 first added a second
// daily-loss reader (`dailyCapEnforced` on /state/risk-full); at the WEB-2
// merge it was retired for the account-overview `dailyStop` reading the
// account cards already print (services/daily-stop-reading.js, pinned by
// daily-stop-reading.test.js: the tier, the floor, parity with the gate's own
// verdict and its block). One figure from one source — owner principle 6.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { fxDayOpenMs } from '../services/risk.js'

async function server(t) {
  const db = initDB(':memory:')
  const app = express()
  app.use('/state', stateRouter(db))
  const http = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  t.after(() => new Promise(resolve => http.close(() => { db.close(); resolve() })))
  const url = (p) => `http://127.0.0.1:${http.address().port}/state${p}`
  return { db, get: (p) => fetch(url(p)).then(r => r.json()) }
}

const verify = (db, id, currency) => setState(db, `acct:${id}:deposit_currency_evidence_json`, JSON.stringify({
  accountId: id, host: 'demo.ctraderapi.com', depositAssetId: '15', currency, receivedAt: 1, source: 'broker_asset_list',
}))

test('data-feed serves latency with coverage, per-currency fees, quote freshness and the broker-day open', async t => {
  const { db, get } = await server(t)
  verify(db, '11', 'USD')
  const ins = db.prepare(`INSERT INTO trades (symbol, status, account_id, closed_at, entry_latency_ms, commission, swap, net_pnl)
    VALUES ('EURUSD', 'closed', ?, ?, ?, ?, ?, 1)`)
  ins.run('11', '2026-09-20T10:00:00Z', 120, -3, -1)
  ins.run('11', '2026-09-20T11:00:00Z', null, -4, null)
  ins.run('22', '2026-09-20T12:00:00Z', 999, -50, -5)
  const at = new Date(Date.now() - 3_000).toISOString()
  setState(db, 'fast_monitor_pass_json', JSON.stringify({ at, tick: { quotes10m: { fromSidecar: 2, fromBroker: 5, stale: 1, passes: 3, sidecarSharePct: 28.6 } } }))

  const before = Date.now()
  const r = await get('/data-feed?account=11')
  assert.equal(r.accountId, '11')
  assert.equal(r.execution.window.closes, 2, 'account 22 is not in account 11\'s window')
  assert.equal(r.execution.latency.measured, 1)
  assert.equal(r.execution.latency.of, 2)
  assert.equal(r.execution.latency.p50Ms, 120)
  assert.deepEqual(r.execution.costs.map(b => [b.currency, b.commission, b.swap]), [['USD', -7, -1]])
  assert.equal(r.quotes.status, 'measured')
  assert.ok(r.quotes.ageMs >= 3_000 && r.quotes.ageMs < 60_000)
  assert.equal(r.brokerDayOpenMs, fxDayOpenMs(r.asOfMs), 'the gate\'s own FX-day anchor')
  assert.ok(r.asOfMs >= before)
  assert.ok(r.notMeasured.some(n => n.key === 'feed_latency'))

  const all = await get('/data-feed?account=all')
  assert.equal(all.accountId, 'all')
  assert.equal(all.execution.window.closes, 3)
  const unverified = all.execution.costs.find(b => b.currency == null)
  assert.deepEqual(unverified.accounts, ['22'], 'an account with no verified currency is never folded into USD')
})

test('risk-full carries no second daily-loss reader for the card: the daily stop is the account-overview reading', async t => {
  const { db, get } = await server(t)
  setState(db, 'acct:46:account_balance_usd', '30004.36')
  const r = await get('/risk-full?account=46')
  assert.equal(Object.hasOwn(r, 'dailyCapEnforced'), false, 'the retired WEB-9 reader is not served')
})
