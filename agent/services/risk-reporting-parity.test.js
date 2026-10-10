// Codex · №12,876 · 2026-10-10; codex-footprint: risk-reporting-parity.
// Real routes/controller/engine/SQLite. Broker facts are controlled fixtures;
// no broker calls, gate replacement or configured-risk changes in production.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { loadRiskConfig, getAccountBalance, dailyLossVerdict } from './risk.js'
import { sizingBalanceUsd } from './account-currency.js'
import { recordDepositCurrency, recordAccountMoney } from './account-money.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { riskSizingBalance, riskMarginUsd } from '../../src/lib/risk-reporting-money.js'
import { accountInputDraft, editAccountInput, accountInputPatch } from '../../src/lib/account-input-draft.js'
import { dailyCapState } from '../../src/lib/daily-cap-state.js'

const tiered = { dailyLossPct: 0.02, dailyLossLimit: 150, dailyLossFloorUsd: 400,
  dailyLossTierAtUsd: 10000, dailyLossTierSmallPct: 0.03, dailyLossTierLargePct: 0.04,
  perTradeRiskPct: 0.01, perTradeRiskUsd: null }
async function fixture(t) {
  const db = initDB(':memory:')
  const app = express().use('/state', stateRouter(db))
  const http = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => http.close(() => { db.close(); resolve() })))
  return { db, read: async path => {
    invalidateStateCache()
    const response = await fetch(`http://127.0.0.1:${http.address().port}/state/${path}`)
    assert.equal(response.status, 200)
    return response.json()
  } }
}
function account(db, id, currency, balance, patch = {}) {
  db.prepare('INSERT OR IGNORE INTO accounts(account_id,is_live,enabled,mode) VALUES (?,0,1,\'active\')').run(id)
  setState(db, `acct:${id}:account_balance_usd`, String(balance))
  setState(db, `acct:${id}:risk_config_json`, JSON.stringify({ ...tiered, ...patch }))
  recordDepositCurrency(db, { accountId: id, host: 'demo.ctraderapi.com', depositAssetId: '1', currency })
  recordAccountMoney(db, { accountId: id, host: 'demo.ctraderapi.com', trader: { depositAssetId: '1', ctidTraderAccountId: id }, balance })
  setState(db, `acct:${id}:broker_snapshot_cache_json`, JSON.stringify({ fetchedAt: new Date().toISOString(),
    account: { accountId: id, currency, isLive: false,
      health: { balance, usedMargin: 200, freeMargin: balance - 200, equity: balance, marginLevelPct: balance / 2 } } }))
}
function fx(db, ageMs = 0) {
  setState(db, 'fx_rates_json', JSON.stringify({ USDSGD: { p: 1.25, t: Date.now() - ageMs } }))
}
function close(db, id, pnl, daysAgo = 1) {
  db.prepare(`INSERT INTO trades(symbol,side,status,entry_price,net_pnl,opened_at,closed_at,account_id)
    VALUES ('EURUSD','BUY','closed',1.1,?,datetime('now','-2 days'),datetime('now',?),?)`)
    .run(pnl, `-${daysAgo} days`, id)
}
function engine(db, id, now = Date.now()) {
  const config = loadRiskConfig(db, id)
  const money = sizingBalanceUsd(db, id, { balance: getAccountBalance(db, id), now })
  return { money, verdict: dailyLossVerdict(db, config, id, { balance: money.balanceUsd, money, nowMs: now }) }
}
function state(db) {
  return { state: db.prepare('SELECT * FROM agent_state ORDER BY key').all(),
    trades: db.prepare('SELECT * FROM trades ORDER BY id').all(),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY account_id').all() }
}

test('P2: actual configuration-proposal route uses the converted engine floor, not native balance × base pct', async t => {
  const { db, read } = await fixture(t)
  account(db, '43097342', 'SGD', 3000); fx(db)
  for (let i = 0; i < 30; i++) close(db, '43097342', -80)
  const now = Date.now(), before = state(db), gateBefore = engine(db, '43097342', now)
  const p = (await read('config-proposals')).accounts.find(a => a.accountId === '43097342')
  assert.equal(p.proposals.some(x => x.rule.startsWith('daily_cap_')), false,
    'USD400 floor covers these SGD80/USD64 losses and USD24 permitted risk')
  assert.equal(p.dailyPacing.capUsd, gateBefore.verdict.pacing.capUsd)
  assert.equal(p.dailyPacing.capUsd, 400)
  assert.equal(p.dailyPacing.binding, 'floor')
  assert.equal(p.econ.winRate, 0)
  assert.deepEqual(engine(db, '43097342', now), gateBefore)
  assert.deepEqual(state(db), before, 'report never changes the gate or stored inputs/history')
})

test('P2: actual risk-full route reports native SGD money and distinct validated USD sizing', async t => {
  const { db, read } = await fixture(t)
  account(db, '43097342', 'SGD', 3000); account(db, '46130058', 'USD', 40000); fx(db)
  setState(db, 'ctrader_account_id', '46130058')
  const r = await read('risk-full?account=43097342')
  assert.equal(r.account.balance, 3000)
  assert.equal(r.account.currency, 'SGD')
  assert.equal(r.account.balanceUsd, 2400)
  assert.equal(r.account.balanceSource, 'broker')
  assert.equal(r.account.brokerSnapshot.status, 'fresh')
  assert.equal(r.margin.currency, 'SGD')
  assert.equal(r.margin.usedMargin, 200)
  assert.equal(r.margin.accountId, '43097342')
  assert.equal(r.account.fx.rate, 0.8)
  const draft = accountInputDraft(r.account)
  assert.equal(draft.balance, 3000)
  assert.equal(riskSizingBalance(draft, r.account), 2400)
  assert.equal(riskMarginUsd(r.margin, r.account).usedMargin, 160)
  assert.deepEqual(accountInputPatch(editAccountInput(draft, 'balance', 3100)), { accountId: '43097342', balance: 3100 }, 'the USD preview never enters the native write payload')
  assert.equal(riskSizingBalance({ ...draft, accountId: '46130058' }, r.account), null)
  assert.equal(riskMarginUsd({ ...r.margin, accountId: '46130058' }, r.account), null)
  const other = await read('risk-full?account=46130058')
  assert.equal(other.account.balance, 40000)
  assert.equal(other.account.balanceUsd, 40000)
  assert.equal(other.account.currency, 'USD')
})

test('P2: actual daily-pacing route equals the engine cap, converted spend, floor and tier', async t => {
  const { db, read } = await fixture(t)
  account(db, '43097342', 'SGD', 3000); fx(db); close(db, '43097342', -125, 0)
  const expected = engine(db, '43097342'), before = state(db)
  const p = (await read('risk-full?account=43097342')).dailyPacing
  for (const k of ['capUsd','binding','pctCapUsd','usdInForce','floorUsd','floorBinding','tierPct','remainingUsd','tradesLeft']) {
    assert.equal(p[k], expected.verdict.pacing[k], k)
  }
  assert.equal(p.spentUsd, 100)
  assert.equal(p.balance, 2400)
  assert.equal(p.currency, 'USD')
  const draft = accountInputDraft((await read('risk-full?account=43097342')).account)
  assert.equal(dailyCapState(loadRiskConfig(db, '43097342'), riskSizingBalance(draft, (await read('risk-full?account=43097342')).account)).capUsd, p.capUsd)
  assert.deepEqual(state(db), before)
})

test('P2: flat, percent, both, tiers, floor and uncapped are the actual engine contracts', async t => {
  const { db, read } = await fixture(t)
  const cases = [
    { dailyLossFloorUsd: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossLimit: 150 },
    { dailyLossFloorUsd: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossLimit: null },
    { dailyLossFloorUsd: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossLimit: 800 },
    { dailyLossFloorUsd: null, dailyLossLimit: 150 },
    { dailyLossPct: 0, dailyLossLimit: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null },
  ]
  for (let i = 0; i < cases.length; i++) {
    const id = String(500 + i); account(db, id, 'USD', 40000, cases[i])
    const expected = engine(db, id).verdict.pacing, p = (await read(`risk-full?account=${id}`)).dailyPacing
    assert.equal(p.capUsd, expected.capUsd, id)
    assert.equal(p.binding, expected.binding, id)
    assert.equal(p.floorBinding, expected.floorBinding, id)
    assert.equal(p.tierPct, expected.tierPct, id)
    assert.equal(p.uncapped, expected.uncapped, id)
  }
})

test('P2: unavailable or stale FX preserves native money, withholds USD reporting and monetary advice', async t => {
  const { db, read } = await fixture(t)
  account(db, '43097342', 'SGD', 3000)
  for (let i = 0; i < 30; i++) close(db, '43097342', -100)
  for (const age of [null, 27 * 3600000]) {
    if (age != null) fx(db, age)
    const before = state(db), expected = engine(db, '43097342')
    assert.equal(expected.verdict.guard, 'fx_rate_unavailable')
    const r = await read('risk-full?account=43097342')
    assert.equal(r.account.balance, 3000)
    assert.equal(r.account.balanceUsd, null)
    assert.equal(r.margin.currency, 'SGD')
    assert.equal(riskSizingBalance(accountInputDraft(r.account), r.account), null)
    assert.equal(riskMarginUsd(r.margin, r.account), null)
    assert.equal(r.dailyPacing.capUsd, null)
    assert.equal(r.dailyPacing.spentUsd, null)
    assert.equal(r.dailyPacing.reason, 'fx_rate_unavailable')
    assert.equal(r.dailyPacing.nativePacing.currency, 'SGD')
    assert.equal(r.dailyPacing.nativePacing.capUsd, expected.verdict.pacing.capUsd)
    const p = (await read('config-proposals')).accounts.find(a => a.accountId === '43097342')
    assert.equal(p.proposals.some(x => x.rule.startsWith('daily_cap_')), false)
    assert.equal(p.monetaryAssessment.reason, 'fx_rate_unavailable')
    assert.deepEqual(state(db), before)
  }
})

test('P2: foreign snapshot never supplies native money; unattributed economics cannot support money advice', async t => {
  const { db, read } = await fixture(t)
  account(db, '43097342', 'SGD', 3000); account(db, '46130058', 'USD', 40000); fx(db)
  const foreign = db.prepare('SELECT value FROM agent_state WHERE key=?').get('acct:46130058:broker_snapshot_cache_json').value
  setState(db, 'acct:43097342:broker_snapshot_cache_json', foreign)
  const r = await read('risk-full?account=43097342')
  assert.equal(r.account.brokerSnapshot.reason, 'account_mismatch')
  assert.notEqual(r.account.balance, 40000)
  assert.equal(r.margin, null)
  for (let i = 0; i < 30; i++) close(db, '43097342', -500)
  close(db, null, -50000)
  const p = (await read('config-proposals')).accounts.find(a => a.accountId === '43097342')
  assert.equal(p.proposals.some(x => x.rule.startsWith('daily_cap_')), false)
  assert.equal(p.monetaryAssessment.reason, 'unattributed_economics')
  assert.equal(p.econ.trades, 31, 'unchanged economics population and win-rate calculation')
})


test('P2: real proposals target the binding floor/tier/flat and respect absolute per-trade risk', async t => {
  const { db, read } = await fixture(t)
  const cases = [
    [{ dailyLossFloorUsd: 50 }, 'dailyLossFloorUsd', 400],
    [{ dailyLossFloorUsd: null }, 'dailyLossTierSmallPct', 0.4],
    [{ dailyLossFloorUsd: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossPct: null, dailyLossLimit: 50 }, 'dailyLossLimit', 400],
    [{ dailyLossFloorUsd: null, dailyLossTierSmallPct: null, dailyLossTierLargePct: null, dailyLossPct: 0.05, dailyLossLimit: 50 }, 'dailyLossPct', null],
  ]
  for (let i = 0; i < cases.length; i++) {
    const id = String(600 + i), [patch, setting, proposed] = cases[i]
    account(db, id, 'USD', 1000, patch)
    for (let n = 0; n < 30; n++) close(db, id, -100)
    const report = (await read('config-proposals')).accounts.find(a => a.accountId === id)
    const advice = report.proposals.find(p => p.rule === 'daily_cap_smaller_than_one_loss')
    assert.equal(advice.setting, setting)
    assert.equal(advice.proposed, proposed)
    assert.equal(advice.contract.capUsd, engine(db, id).verdict.pacing.capUsd)
  }
  account(db, '604', 'USD', 40000, { dailyLossFloorUsd: null, perTradeRiskPct: 0.001, perTradeRiskUsd: 500 })
  for (let n = 0; n < 30; n++) close(db, '604', -20)
  const report = (await read('config-proposals')).accounts.find(a => a.accountId === '604')
  const advice = report.proposals.find(p => p.rule === 'daily_cap_vs_permitted_risk')
  assert.equal(advice.setting, 'dailyLossTierLargePct')
  assert.equal(advice.proposed, 0.063)
  assert.match(advice.why, /USD 500.00/)
})
