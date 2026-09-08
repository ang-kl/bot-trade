// node --test agent/services/account-horizon.test.js
//
// §7,437·B·6 (owner, 08-09-2026): one horizon per account, enforced before
// analysis and again per account in the fan-out. Nothing declared admits
// everything; an unknown family or timeframe is not a verdict.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import express from 'express'
import { initDB, getState } from '../db.js'
import { horizonOfTimeframe, horizonAdmits, setAccountHorizon, loadAccountHorizon, anyAccountAdmits, normalizeHorizon, HORIZON_KEY } from './account-horizon.js'
import stateRouter from '../routes/state.js'
import actionsRouter from '../routes/actions.js'

test('horizonOfTimeframe: up to 1h intraday, up to 1d swing, beyond position, unreadable null', () => {
  assert.equal(horizonOfTimeframe('5m'), 'intraday'); assert.equal(horizonOfTimeframe('1h'), 'intraday')
  assert.equal(horizonOfTimeframe('4h'), 'swing'); assert.equal(horizonOfTimeframe('1d'), 'swing')
  assert.equal(horizonOfTimeframe('1w'), 'position'); assert.equal(horizonOfTimeframe('3d'), 'position')
  assert.equal(horizonOfTimeframe('nonsense'), null); assert.equal(horizonOfTimeframe(null), null)
})

test('horizonAdmits: nothing declared admits all; horizon and family each refuse by name; unknowns admit', () => {
  assert.equal(horizonAdmits({}, { timeframe: '5m', strategy: 'rsi2_reversion' }).ok, true)
  const swing = { horizon: 'swing', families: [] }
  assert.equal(horizonAdmits(swing, { timeframe: '4h', strategy: 'donchian_breakout' }).ok, true)
  const r = horizonAdmits(swing, { timeframe: '15m', strategy: 'rsi2_reversion' })
  assert.equal(r.ok, false); assert.match(r.reason, /15m is a intraday bar; this account trades swing/)
  const mom = { horizon: 'position', families: ['momentum'] }
  assert.equal(horizonAdmits(mom, { timeframe: '1w', strategy: 'tsmom_long' }).ok, true)
  const f = horizonAdmits(mom, { timeframe: '1w', strategy: 'donchian_breakout' })
  assert.equal(f.ok, false); assert.match(f.reason, /family breakout \(donchian_breakout\) is outside/)
  assert.equal(horizonAdmits(mom, { timeframe: '1w', strategy: 'no_such_strategy' }).ok, true, 'an unknown family is not a verdict')
  assert.equal(horizonAdmits(swing, { timeframe: null, strategy: 'donchian_breakout' }).ok, true, 'an unreadable timeframe is not a verdict')
  assert.deepEqual(normalizeHorizon({ horizon: 'weekly', families: ['momentum', 'bogus', 'momentum'] }), { horizon: null, families: ['momentum'] })
})

test('setAccountHorizon merges over what is stored; anyAccountAdmits asks every account', () => {
  const db = initDB(':memory:')
  assert.deepEqual(setAccountHorizon(db, 'A', { horizon: 'intraday' }), { horizon: 'intraday', families: [] })
  assert.deepEqual(setAccountHorizon(db, 'A', { families: ['mean_reversion'] }), { horizon: 'intraday', families: ['mean_reversion'] }, 'the horizon survives a families-only patch')
  assert.deepEqual(setAccountHorizon(db, 'A', { horizon: null }), { horizon: null, families: ['mean_reversion'] }, 'null clears the horizon only')
  assert.equal(JSON.parse(getState(db, HORIZON_KEY('A'))).families[0], 'mean_reversion')
  setAccountHorizon(db, 'B', { horizon: 'position', families: ['momentum'] })
  const v = anyAccountAdmits(db, ['A', 'B'], { timeframe: '5m', strategy: 'rsi2_reversion' })
  assert.equal(v.ok, true, 'A takes mean reversion'); assert.equal(v.refusedBy.length, 1); assert.equal(v.refusedBy[0].accountId, 'B')
  const none = anyAccountAdmits(db, ['A', 'B'], { timeframe: '4h', strategy: 'donchian_breakout' })
  assert.equal(none.ok, false); assert.equal(none.refusedBy.length, 2)
  assert.equal(anyAccountAdmits(db, [], { timeframe: '4h', strategy: 'donchian_breakout' }).ok, true, 'no accounts to ask admits')
  assert.deepEqual(loadAccountHorizon(db, 'Z'), { horizon: null, families: [] })
})

test('routes: GET/POST /actions/account-horizon and GET /state/account-horizons', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('A','1',0,1,'active')`).run()
  const app = express(); app.use(express.json()); app.use('/state', stateRouter(db)); app.use('/actions', actionsRouter(db))
  const s = await new Promise(r => { const x = app.listen(0, () => r(x)) })
  const url = (p) => `http://127.0.0.1:${s.address().port}${p}`
  const post = (body) => fetch(url('/actions/account-horizon'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    let r = await (await post({ accountId: 'A', horizon: 'swing' })).json()
    assert.equal(r.ok, true); assert.equal(r.horizon, 'swing')
    r = await (await post({ accountId: 'A', families: ['breakout', 'trend'] })).json()
    assert.equal(r.horizon, 'swing', 'a families-only POST keeps the stored horizon'); assert.deepEqual(r.families, ['breakout', 'trend'])
    const bad = await post({ accountId: 'A', horizon: 'monthly' })
    assert.equal(bad.status, 400)
    const g = await fetch(url('/state/account-horizons')).then(x => x.json())
    assert.equal(g.accounts[0].accountId, 'A'); assert.equal(g.accounts[0].horizon, 'swing')
    const a = await fetch(url('/actions/account-horizon')).then(x => x.json())
    assert.equal(a.ok, true); assert.equal(a.accounts[0].families.length, 2)
  } finally { s.close() }
})

test('wiring pin: the loop filters candidates before the analysis slots and skips per account in the fan-out', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /afterHorizon = beforeHorizon\.filter\(sym => \{[\s\S]{0,500}?anyAccountAdmits\(db, horizonAccounts, \{ timeframe: sc\.timeframe, strategy: sc\.strategy \}\)\.ok/, 'the pre-analysis filter asks every armed account')
  assert.match(loop, /stage: 'horizon', decision: 'skip'/, 'a dropped candidate leaves a decision row')
  assert.match(loop, /const pool = afterHorizon\s+let hotToAnalyze = pool\.slice\(0, 3\)/, 'the analysis slots are handed the filtered list, with no fallback to the unfiltered one')
  assert.match(loop, /const hz = horizonAdmits\(loadAccountHorizon\(db, acct\.accountId\), \{ timeframe: synth\.timeframe, strategy: synth\.strategy \}\)\s+if \(!hz\.ok\) \{[\s\S]{0,600}?stage: 'account_horizon'[\s\S]{0,200}?continue\s+\}/, 'the per-account gate, with its decision row')
})
