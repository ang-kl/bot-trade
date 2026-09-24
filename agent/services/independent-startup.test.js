import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { makeIndependentProtectionPoll, independentProtectionView } from './independent-protection.js'

const configuredContexts = new WeakSet()

function fixture(t, patch = {}) {
  const db = initDB(':memory:'); t.after(() => db.close())
  if (!configuredContexts.has(t)) for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const old = process.env[key]; process.env[key] = 'fixture'
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  configuredContexts.add(t)
  setState(db, 'ctrader_access_token', 'fixture-token')
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(11,0)').run()
  const host = 'demo.ctraderapi.com', at = Date.now()
  const row = { accountId: '11', host, ok: true, source: 'broker_reconcile', checkedAtMs: at,
    openCount: 2, missingSl: 0, missingTp: 0, ...patch }
  let status = { source: 'cpp-verify', accounts: [row], sessions: [{ host, open: true, accounts: ['11'] }] }
  let connects = 0
  const options = { now: () => at, env: { VERIFY_URL: 'https://verifier.test', EXEC_SECRET: 'fixture' }, log: () => {},
    fetchImpl: async (url, init) => {
      if (url.endsWith('/connect')) {
        connects++
        const input = JSON.parse(init.body)
        status = { source: 'cpp-verify', accounts: [], sessions: [{ host, open: true, accounts: input.accountIds }] }
        return { ok: true, json: async () => ({ accounts: input.accountIds.map(accountId => ({ accountId, authorized: true })) }) }
      }
      if (url.endsWith('/watchdog-status')) return { ok: true, json: async () => ({ schemaVersion: 1 }) }
      return { ok: true, json: async () => status }
    } }
  return { db, at, row, poll: () => makeIndependentProtectionPoll(db, options), connects: () => connects,
    status: next => { status = next }, initial: status }
}

test('a Node-only restart reuses exact fresh independent coverage without reconnect or timestamp reset', async t => {
  const f = fixture(t)
  await f.poll()()
  await f.poll()()
  assert.equal(f.connects(), 0)
  const reading = independentProtectionView(f.db, '11', f.at)
  assert.equal(reading.ok, true)
  assert.equal(reading.checkedAtMs, f.row.checkedAtMs)
  assert.equal(reading.openCount, 2)
})

test('fresh readings of missing protection remain visible rather than provoking a session reset', async t => {
  const f = fixture(t, { missingTp: 1 })
  await f.poll()()
  assert.equal(f.connects(), 0)
  assert.equal(independentProtectionView(f.db, '11', f.at).missingTp, 1)
})

test('stale, absent, foreign, future and malformed evidence cannot justify first-poll reuse', async t => {
  for (const patch of [{ checkedAtMs: 0 }, { checkedAtMs: Date.now() - 181000 },
    { checkedAtMs: Date.now() + 100000 }, { accountId: '22' }, { host: 'live.ctraderapi.com' },
    { source: 'local_cache' }, { ok: false }, { error: 'read failed' }, { openCount: null },
    { missingSl: 3 }, { missingTp: -1 }]) {
    const f = fixture(t, patch)
    await f.poll()()
    assert.equal(f.connects(), 1, JSON.stringify(patch))
  }
  for (const session of [[], [{ host: 'demo.ctraderapi.com', open: false, accounts: ['11'] }],
    [{ host: 'demo.ctraderapi.com', open: true, accounts: ['11','22'] }]]) {
    const f = fixture(t)
    f.status({ ...f.initial, sessions: session })
    await f.poll()()
    assert.equal(f.connects(), 1)
  }
})

test('a credential or roster change and verifier restart still reconnect', async t => {
  const f = fixture(t), poll = f.poll()
  await poll()
  assert.equal(f.connects(), 0)
  setState(f.db, 'ctrader_access_token', 'fixture-rotated')
  await poll()
  assert.equal(f.connects(), 1)
  f.db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(12,0)').run()
  await poll()
  assert.equal(f.connects(), 2)
  f.status({ source: 'cpp-verify', accounts: [], sessions: [] })
  await poll()
  assert.equal(f.connects(), 3)
})
