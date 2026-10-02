// node --test agent/routes/stop-policy-route.test.js — POST /actions/stop-policy
// (the policy and its kill switch) and GET /state/stop-policy (the policy as
// running plus the first live evidence), 02-10-2026.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import {
  POLICY_KEY, setStopPolicy, getStopPolicy, loadStopPolicy, applyStopPolicyToAmend,
  noteAmendOutcome, resetStopPolicyStats,
} from '../lib/stop-policy.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}
const post = (s, body) => fetch(s.url('/actions/stop-policy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test.beforeEach(() => { setStopPolicy(null); resetStopPolicyStats() })
test.after(() => { setStopPolicy(null); resetStopPolicyStats() })

test('GET /state/stop-policy: the default is the owner order, with the wire value and the trail-config block', async () => {
  const s = await server()
  try {
    const body = await fetch(s.url('/state/stop-policy')).then(r => r.json())
    assert.deepEqual(body.policy, { enabled: true, triggerMethod: 'OPPOSITE', trailing: 'on_lock', encoding: 'number' })
    assert.equal(body.stored, null)
    assert.deepEqual(body.wire, { trigger: 2, encoding: 'number' })
    assert.deepEqual(body.trailConfig, { stopLossTriggerMethod: 2, trailing: 'on_lock' })
    assert.equal(body.counts.amends, 0)
    assert.deepEqual(body.recent, [])
  } finally { s.close() }
})

test('POST /actions/stop-policy: validates every field loudly, stores nothing on a bad value', async () => {
  const s = await server()
  try {
    const r = await post(s, { enabled: 'false', trailing: 'always', triggerMethod: 'SIDEWAYS', encoding: 'hex' })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.error, 'invalid_value')
    assert.deepEqual(body.fields.sort(), ['enabled', 'encoding', 'trailing', 'triggerMethod'])
    assert.equal(getState(s.db, POLICY_KEY), null, 'nothing stored on a refused patch')
    assert.equal(getStopPolicy().enabled, true)
  } finally { s.close() }
})

test('POST /actions/stop-policy: the kill switch turns the stamping off with no redeploy, and it survives a reboot', async () => {
  const s = await server()
  try {
    const r = await post(s, { enabled: false })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.equal(body.effective.enabled, false)
    assert.deepEqual(JSON.parse(getState(s.db, POLICY_KEY)), { enabled: false })
    // what the chokepoint sees
    assert.deepEqual(applyStopPolicyToAmend({ positionId: 1, stopLoss: 5, takeProfit: 6 }, getStopPolicy()), { positionId: 1, stopLoss: 5, takeProfit: 6 })
    // what the sidecar is told
    const view = await fetch(s.url('/state/stop-policy')).then(r2 => r2.json())
    assert.equal(view.trailConfig, null, 'an absent block clears the TrailEngine policy (full replace)')
    // reboot: the stored kill switch holds from the first amend
    setStopPolicy(null)
    assert.equal(getStopPolicy().enabled, true)
    loadStopPolicy(s.db, getState)
    assert.equal(getStopPolicy().enabled, false)
    assert.ok(s.db.prepare(`SELECT 1 FROM action_log WHERE method = 'STOP_POLICY'`).get(), 'the change is in the audit log')
  } finally { s.close() }
})

test('POST /actions/stop-policy: patches merge onto the stored record and read back through the normaliser', async () => {
  const s = await server()
  try {
    await post(s, { trailing: 'off' })
    const r = await post(s, { triggerMethod: 'double_opposite', encoding: 'name' })
    const body = await r.json()
    assert.deepEqual(body.effective, { enabled: true, triggerMethod: 'DOUBLE_OPPOSITE', trailing: 'off', encoding: 'name' })
    assert.deepEqual(body.stored, { trailing: 'off', triggerMethod: 'DOUBLE_OPPOSITE', encoding: 'name' }, 'the first patch is kept, not rebuilt away')
    const fields = applyStopPolicyToAmend({ positionId: 1, stopLoss: 101, stopContext: { side: 'BUY', entry: 100 } }, getStopPolicy())
    assert.equal(fields.stopLossTriggerMethod, 'DOUBLE_OPPOSITE')
    assert.equal('trailingStopLoss' in fields, false, 'trailing off: never requested')
  } finally { s.close() }
})

test('GET /state/stop-policy: counts and the recent ring show what the amends carried and how the broker answered', async () => {
  const s = await server()
  try {
    noteAmendOutcome({ args: { ctidTraderAccountId: 46130058, positionId: 9, stopLoss: 101, stopLossTriggerMethod: 2, trailingStopLoss: true, ratchetOnly: true }, result: { policy: { applied: true, readback: 'confirmed', refused: null, skipped: null } } })
    noteAmendOutcome({ args: { ctidTraderAccountId: 46130058, positionId: 10, stopLoss: 99, stopLossTriggerMethod: 2, ratchetOnly: true }, result: { unchanged: true, policy: { applied: false, readback: 'unreadable', refused: null, skipped: null } } })
    noteAmendOutcome({ args: { ctidTraderAccountId: 46130058, positionId: 11, stopLoss: 98, stopLossTriggerMethod: 2 }, result: { policy: { applied: false, readback: 'unverified', refused: { errorCode: 'INVALID_REQUEST' }, skipped: null } } })
    noteAmendOutcome({ args: { ctidTraderAccountId: 46130058, positionId: 12, stopLoss: 97, stopLossTriggerMethod: 2 }, error: new Error('TRADING_BAD_STOPS') })
    const body = await fetch(s.url('/state/stop-policy')).then(r => r.json())
    assert.equal(body.counts.amends, 4)
    assert.equal(body.counts.withTrigger, 4)
    assert.equal(body.counts.withTrailing, 1)
    assert.equal(body.counts.ratchet, 2)
    assert.equal(body.counts.unchanged, 1)
    assert.equal(body.counts.applied, 1)
    assert.equal(body.counts.refused, 1)
    assert.equal(body.counts.errors, 1)
    assert.deepEqual(body.counts.readback, { confirmed: 1, mismatch: 0, unreadable: 1, unverified: 1, none: 0 })
    assert.equal(body.recent.length, 4)
    assert.equal(body.recent[0].positionId, 12, 'newest first')
    assert.equal(body.recent[0].error, 'TRADING_BAD_STOPS')
    assert.equal(body.recent[0].accountId, '…0058', 'accounts by their last four digits')
  } finally { s.close() }
})
