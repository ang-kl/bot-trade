import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import { getAutopilotAccounts } from '../loop.js'
import { effectivePhases } from '../services/account-phases.js'
import { setPhaseFlag } from '../services/phase-audit.js'
import actionsRouter from './actions.js'

const SELECTED = '110058', PREVIOUS = '119908'
const IDS = [SELECTED, PREVIOUS, '139009', '139010', '139011', '110059', '110060']

async function fixture(t, mixed) {
  const db = initDB(':memory:')
  const token = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_access_token', 'fixture-access-token')
  setState(db, 'ctrader_account_id', PREVIOUS)
  setState(db, 'ctrader_is_live', 'false')
  const insert = db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,params) VALUES (?,?,1,?,?)')
  for (const id of IDS) {
    const mode = mixed && id === '139010' ? 'manage_only' : mixed && id === '139011' ? 'paused' : 'active'
    insert.run(id, id.startsWith('13') ? 1 : 0, mode,
      JSON.stringify({ autopilot: !(mixed && id === '110059'), scanWhileManageOnly: false, fixtureLimit: 5 }))
    for (const phase of ['scan', 'analyze']) {
      setPhaseFlag(db, `acct:${id}:${phase}_enabled`, 'true', { actor: 'owner-ui' })
    }
  }
  for (const phase of ['scan', 'analyze', 'autotrade']) {
    setPhaseFlag(db, `${phase}_enabled`, 'true', { actor: 'owner-ui' })
  }
  // The production failure: raw registry rows were read as a.accountId,
  // producing seven false roles with the literal id "undefined".
  setState(db, 'ctrader_account_roles_json', JSON.stringify([
    { accountId: PREVIOUS, isLive: false, autopilot: true },
    ...IDS.map(id => ({ accountId: 'undefined', isLive: id.startsWith('13'), autopilot: false })),
  ]))
  const brokerReads = []
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, {
    wsGetSymbolsList: async (host, _client, _secret, _token, accountId) => {
      brokerReads.push({ kind: 'symbols', host, accountId })
      return { symbol: [{ symbolName: 'EURUSD', symbolId: 1 }] }
    },
    wsGetTrader: async (host, _client, _secret, _token, accountId) => {
      brokerReads.push({ kind: 'trader', host, accountId })
      return { balance: 100000, moneyDigits: 2, leverageInCents: 10000 }
    },
  }))
  const server = app.listen(0)
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close() })
  const select = async accountId => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/actions/ctrader-select-account`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ accountId, isLive: false, traderLogin: `fixture-${accountId}` }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.accountId, accountId)
    assert.equal(getState(db, 'ctrader_account_id'), accountId)
  }
  return { db, select, brokerReads }
}

for (const mixed of [false, true]) {
  test(`account selection preserves a valid complete roster and existing dispatch${mixed ? ' with non-entering accounts' : ''}`, async t => {
    const { db, select, brokerReads } = await fixture(t, mixed)
    const policyRows = () => db.prepare('SELECT account_id,is_live,enabled,mode,params FROM accounts ORDER BY account_id').all()
    const phases = () => IDS.map(id => ({ id, ...effectivePhases(db, id) }))
    const flags = () => db.prepare("SELECT key,value FROM agent_state WHERE key IN ('scan_enabled','analyze_enabled','autotrade_enabled') OR key GLOB 'acct:*:*_enabled' ORDER BY key").all()
    const before = { rows: policyRows(), phases: phases(), flags: flags() }
    const expectedEntries = mixed ? [SELECTED, PREVIOUS, '139009', '110060'].sort() : [...IDS].sort()
    const dispatch = () => getAutopilotAccounts(db).map(a => String(a.accountId)).sort()
    assert.deepEqual(dispatch(), expectedEntries)

    for (const accountId of [SELECTED, PREVIOUS]) {
      await select(accountId)
      const roles = JSON.parse(getState(db, 'ctrader_account_roles_json'))
      assert.equal(roles.length, IDS.length, 'selection must not add a duplicate selected role')
      assert.deepEqual(roles.map(a => a.accountId).sort(), [...IDS].sort())
      assert.equal(new Set(roles.map(a => a.accountId)).size, IDS.length)
      for (const role of roles) {
        assert.match(role.accountId, /^[1-9]\d*$/)
        assert.equal(role.isLive, role.accountId.startsWith('13'))
        assert.equal(role.autopilot, expectedEntries.includes(role.accountId), role.accountId)
      }
      assert.deepEqual(dispatch(), expectedEntries, 'selection must not change who may be dispatched')
      assert.deepEqual(policyRows(), before.rows, 'enabled, mode and account parameters stay unchanged')
      assert.deepEqual(phases(), before.phases)
      assert.deepEqual(flags(), before.flags)
    }
    assert.deepEqual(brokerReads, [SELECTED, PREVIOUS].flatMap(accountId => [
      { kind: 'symbols', host: 'demo.ctraderapi.com', accountId },
      { kind: 'trader', host: 'demo.ctraderapi.com', accountId },
    ]))
  })
}
