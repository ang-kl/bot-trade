import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { refreshCtraderToken } from './ctrader-auth.js'

function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'ctrader_access_token', 'fixture-before')
  setState(db, 'ctrader_refresh_token', 'fixture-refresh-before')
  const keys = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'ALLOW_STAGING_TRADING']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.CTRADER_CLIENT_ID = 'fixture-client'
  process.env.CTRADER_CLIENT_SECRET = 'fixture-secret'
  delete process.env.RAILWAY_ENVIRONMENT_ID
  delete process.env.RAILWAY_ENVIRONMENT_NAME
  delete process.env.ALLOW_STAGING_TRADING
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })
  return db
}

test('concurrent refresh callers share one exchange and the same persisted pair', async t => {
  const db = fixture(t)
  let requests = 0
  const releases = []
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Promise(resolve => { releases.push(() => resolve({ json: async () => ({ accessToken: 'fixture-after', refreshToken: 'fixture-refresh-after' }) })) })
  })
  const first = refreshCtraderToken(db)
  const second = refreshCtraderToken(db)
  releases.forEach(release => release())
  assert.deepEqual(await Promise.all([first, second]), ['fixture-after', 'fixture-after'])
  assert.equal(requests, 1, 'one stored grant must not be exchanged concurrently')
  assert.equal(getState(db, 'ctrader_access_token'), 'fixture-after')
  assert.equal(getState(db, 'ctrader_refresh_token'), 'fixture-refresh-after')
})

test('a failed shared exchange preserves stored credentials and permits one later retry', async t => {
  const db = fixture(t)
  let requests = 0, failing = true
  const releases = []
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    if (failing) return new Promise(resolve => { releases.push(() => resolve({ json: async () => ({ errorCode: 'fixture_refused' }) })) })
    return { json: async () => ({ accessToken: 'fixture-retry', refreshToken: 'fixture-refresh-retry' }) }
  })
  const callers = Promise.allSettled([refreshCtraderToken(db), refreshCtraderToken(db)])
  releases.forEach(release => release())
  const result = await callers
  assert.equal(requests, 1, 'all concurrent callers share the one failed exchange')
  assert.ok(result.every(r => r.status === 'rejected' && /fixture_refused/.test(r.reason.message)))
  assert.equal(getState(db, 'ctrader_access_token'), 'fixture-before')
  assert.equal(getState(db, 'ctrader_refresh_token'), 'fixture-refresh-before')
  failing = false
  assert.equal(await refreshCtraderToken(db), 'fixture-retry')
  assert.equal(requests, 2)
})

test('staging disarm still rejects before any exchange or persistence', async t => {
  const db = fixture(t)
  process.env.RAILWAY_ENVIRONMENT_NAME = 'staging'
  t.mock.method(globalThis, 'fetch', async () => assert.fail('staging must never refresh'))
  await assert.rejects(refreshCtraderToken(db), /token refresh disabled/)
  assert.equal(getState(db, 'ctrader_access_token'), 'fixture-before')
  assert.equal(getState(db, 'ctrader_refresh_token'), 'fixture-refresh-before')
})
