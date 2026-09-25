// WEB-9 (8,989-A row 11): GET /state/data-feed and /state/risk-full's
// `dailyCapEnforced` — the daily cap the GATE enforces, not the configured
// base % and not the display-balance figure `dailyPacing` reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { accountPregateVerdict, resetAccountPregate } from '../services/account-pregate.js'
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

test('dailyCapEnforced reports the tier % the gate enforces where dailyPacing names the flat cap', async t => {
  const { db, get } = await server(t)
  // Defaults: dailyLossPct 3 %, flat 300, floor 200, tiers 3 % / 4 % at 10,000.
  // The gate sizes off the STORED account balance (getAccountBalance).
  setState(db, 'acct:46:account_balance_usd', '30004.36')
  const r = await get('/risk-full?account=46')
  const e = r.dailyCapEnforced
  assert.equal(e.status, 'computed')
  assert.equal(e.accountId, '46')
  assert.equal(e.gateBalanceUsd, 30004.36)
  assert.equal(e.binding, 'pct')
  assert.equal(e.tierPct, 0.04)
  assert.ok(Math.abs(e.capUsd - 1200.1744) < 1e-6, `4 % of 30,004.36, got ${e.capUsd}`)
  assert.equal(e.usdInForce, null, 'the tier rule takes the flat cap out of force')
  assert.equal(e.blocked, false)
  // The display figure this item replaces on the card: no floor or tier knobs.
  assert.notEqual(r.dailyPacing.capUsd, e.capUsd)
})

test('dailyCapEnforced reports the floor when the % figure is below it', async t => {
  const { db, get } = await server(t)
  setState(db, 'acct:42:account_balance_usd', '56.3')
  const e = (await get('/risk-full?account=42')).dailyCapEnforced
  assert.equal(e.binding, 'floor')
  assert.equal(e.capUsd, 200)
  assert.equal(e.floorBinding, true)
})

test('dailyCapEnforced agrees with the account pre-gate: the same loss blocks both', async t => {
  const { db, get } = await server(t)
  setState(db, 'acct:47:account_balance_usd', '30004.36')
  resetAccountPregate()
  // A close inside the current FX day, deeper than the 4 % tier cap (1,200.17).
  const closedAt = new Date(fxDayOpenMs(Date.now()) + 1_000).toISOString()
  db.prepare(`INSERT INTO trades (symbol, status, account_id, closed_at, net_pnl) VALUES ('EURUSD', 'closed', '47', ?, -1300)`).run(closedAt)
  const e = (await get('/risk-full?account=47')).dailyCapEnforced
  const gate = accountPregateVerdict(db, '47')
  assert.equal(gate.ok, false)
  assert.equal(gate.guard, 'daily_loss_limit_hit')
  assert.equal(e.blocked, true)
  assert.equal(e.guard, gate.guard)
  assert.equal(e.reason, gate.reason)
  assert.equal(e.remainingUsd, 0)
  assert.equal(e.todayPnlUsd, -1300)
})

test('dailyCapEnforced is unavailable, not invented, when no account is named or selected', async t => {
  const { get } = await server(t)
  const e = (await get('/risk-full')).dailyCapEnforced
  assert.equal(e.status, 'unavailable')
  assert.equal(e.capUsd, undefined)
})
