// node --test agent/routes/perf-ledger-route.test.js
//
// GET /state/perf-ledger?account=<id> carries the daily-loss fraction THAT
// account trades under (its overlay over the global), so the Performance
// card's daily stop is the account's own balance × its own limit. Before
// 11-09-2026 the page applied the global limit to every card.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('43002148', 1, 1, 'active', '1251442')
  setState(db, 'risk_config_json', JSON.stringify({ dailyLossPct: 0.03 }))
  setState(db, 'acct:43002148:risk_config_json', JSON.stringify({ dailyLossPct: 0.01 }))
  setState(db, 'account_balance_usd', '45837.59')
  setState(db, 'acct:46130058:account_balance_usd', '45837.59')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('the ledger reply names each account\'s own daily-loss fraction and its own balance, and the unstamped live account reads null', async () => {
  const s = await server()
  try {
    const demo = await fetch(s.url('/state/perf-ledger?account=46130058')).then(r => r.json())
    assert.equal(demo.dailyLossPct, 0.03); assert.equal(demo.dailyLossScope, 'global', 'no overlay: the global limit, labelled so')
    assert.equal(demo.balance, 45837.59); assert.equal(demo.balanceSource, 'scoped')
    const live = await fetch(s.url('/state/perf-ledger?account=43002148')).then(r => r.json())
    assert.equal(live.dailyLossPct, 0.01, 'the account overlay, not the global')
    assert.equal(live.balance, null, 'never the connected account\'s balance'); assert.equal(live.balanceSource, null)
    const all = await fetch(s.url('/state/perf-ledger')).then(r => r.json())
    assert.equal(all.dailyLossPct, 0.03); assert.equal(all.dailyLossScope, 'global'); assert.equal(all.balanceSource, 'global')
    assert.equal(live.dailyLossScope, 'account', 'the overlay names the limit')
  } finally { s.close() }
})

test('a daily-loss setting of null means the check is OFF and comes back null, never a 0% stop (independent checker, 11-09-2026)', async () => {
  const s = await server()
  try {
    setState(s.db, 'acct:43002148:risk_config_json', JSON.stringify({ dailyLossPct: null }))
    const live = await fetch(s.url('/state/perf-ledger?account=43002148')).then(r => r.json())
    assert.equal(live.dailyLossPct, null); assert.equal(live.dailyLossScope, 'account')
    setState(s.db, 'risk_config_json', JSON.stringify({ dailyLossPct: null }))
    const demo = await fetch(s.url('/state/perf-ledger?account=46130058')).then(r => r.json())
    assert.equal(demo.dailyLossPct, null)
    const unknown = await fetch(s.url('/state/perf-ledger?account=99999999')).then(r => r.json())
    assert.equal(unknown.balance, null); assert.equal(unknown.dailyLossScope, 'global', 'an unknown id is not an account scope')
  } finally { s.close() }
})
