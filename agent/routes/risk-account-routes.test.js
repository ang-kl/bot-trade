// node --test agent/routes/risk-account-routes.test.js
//
// PER-ACCOUNT RISK CONFIG, end to end.
//
// The overlay machinery already existed — loadRiskConfig(db, accountId) merges
// `acct:<id>:risk_config_json` over the global config, and POST
// /actions/risk-config has taken an accountId since it was built. What did not
// exist was any way to SEE it: GET /state/risk-full ignored the account
// entirely, so the Risk page read and wrote the global config while sitting
// under a header naming one account. The limits on screen were not necessarily
// the limits that account traded under, and nothing said so.
//
// These pin the read side, and in particular the distinction the UI depends
// on: "differs from the default" and "this account overrides the global" are
// different facts, and collapsing them is how an operator edits the wrong one.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const riskFull = (s, acct) =>
  fetch(s.url(`/state/risk-full${acct ? `?account=${acct}` : ''}`)).then(r => r.json())

const setRisk = (s, body) => fetch(s.url('/actions/risk-config'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('with no overlay, an account reads exactly the global config', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })
    const g = await riskFull(s)
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 2)
    assert.deepEqual(a.risk.effective, g.risk.effective)
    assert.deepEqual(a.risk.overlayKeys, [], 'nothing is overridden for this account')
    assert.equal(a.risk.scopedTo, '5203012')
  } finally { s.close() }
})

test('an overlay changes ONLY that account, and names what it changed', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })                       // global
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 }) // elevated

    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 5)
    assert.deepEqual(a.risk.overlayKeys, ['perTradeRiskPct'])
    // The global value the overlay stands on, so the page can show what
    // clearing it would restore.
    assert.equal(a.risk.global.perTradeRiskPct, 2)

    // Every other account, and the global config, are untouched.
    assert.equal((await riskFull(s, '5306502')).risk.effective.perTradeRiskPct, 2)
    assert.equal((await riskFull(s)).risk.effective.perTradeRiskPct, 2)
  } finally { s.close() }
})

test('an untouched knob keeps FOLLOWING the global config, it is not frozen', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2, maxOpenPositions: 5 })
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    // Later the global cap moves. The account overrode risk %, not the cap,
    // so the cap must move with it — otherwise saving one field would
    // silently pin every other field at whatever it happened to read that day.
    await setRisk(s, { maxOpenPositions: 9 })
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.maxOpenPositions, 9, 'must follow the global change')
    assert.equal(a.risk.effective.perTradeRiskPct, 5, 'and keep its own override')
  } finally { s.close() }
})

test('reset clears the overlay and the account follows global again', async () => {
  const s = await server()
  try {
    await setRisk(s, { perTradeRiskPct: 2 })
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    assert.equal((await riskFull(s, '5203012')).risk.effective.perTradeRiskPct, 5)

    await setRisk(s, { accountId: '5203012', reset: true })
    const a = await riskFull(s, '5203012')
    assert.equal(a.risk.effective.perTradeRiskPct, 2)
    assert.deepEqual(a.risk.overlayKeys, [])
  } finally { s.close() }
})

test('the global read is unchanged — scopedTo null, no overlay fields', async () => {
  const s = await server()
  try {
    await setRisk(s, { accountId: '5203012', perTradeRiskPct: 5 })
    const g = await riskFull(s)
    assert.equal(g.risk.scopedTo, null)
    assert.deepEqual(g.risk.overlayKeys, [])
    assert.equal(g.risk.global, null, 'nothing to compare against when this IS the global config')
    // An account overlay must never leak into the global answer.
    assert.notEqual(g.risk.effective.perTradeRiskPct, 5)
  } finally { s.close() }
})

test('balance and leverage follow the same scope as the limits', async () => {
  const s = await server()
  try {
    // Sizing is balance × risk%. Showing one account's limits beside another's
    // balance would make every derived lot figure on the page wrong.
    s.db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('acct:5203012:account_balance_usd', '51004')").run()
    s.db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('acct:5067353:account_balance_usd', '1431')").run()
    assert.equal((await riskFull(s, '5203012')).account.balance, 51004)
    assert.equal((await riskFull(s, '5067353')).account.balance, 1431)
    assert.equal((await riskFull(s, '5203012')).account.accountId, '5203012')
  } finally { s.close() }
})
