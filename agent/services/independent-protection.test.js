import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { independentProtectionView, makeIndependentProtectionPoll } from './independent-protection.js'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'

test('independent readings expire and failures cannot inherit a healthy result', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const now = 1_000_000
  const row = { accountId: '22', ok: true, source: 'broker_reconcile', checkedAtMs: now, openCount: 2, missingSl: 0, missingTp: 1 }
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [row] }))
  assert.equal(independentProtectionView(db, '22', now).ok, true)
  assert.match(independentProtectionView(db, '22', now).summary, /1 missing TP1/)
  assert.equal(independentProtectionView(db, '11', now).ok, false)
  assert.equal(independentProtectionView(db, '22', now + 180_001).ok, false)
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [row], error: 'unreachable' }))
  assert.equal(independentProtectionView(db, '22', now).ok, false)
  assert.equal(credsForRegisteredAccount(db, 'unknown'), null)
})

test('provisions all registered accounts, keeps hosts separate, reconnects after verifier restart', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const old = process.env[key]; process.env[key] = 'fixture'
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old })
  }
  setState(db, 'ctrader_access_token', 'fixture-token')
  upsertAccount(db, { accountId: '11', isLive: false })
  upsertAccount(db, { accountId: '12', isLive: false })
  upsertAccount(db, { accountId: '22', isLive: true })
  let sessions = []; const connects = []; let offline = false
  const poll = makeIndependentProtectionPoll(db, { env: { VERIFY_URL: 'https://verifier.test', EXEC_SECRET: 'fixture' },
    fetchImpl: async (url, options) => {
      if (offline) throw new Error('offline')
      if (url.endsWith('/connect')) {
        const b = JSON.parse(options.body); connects.push(b)
        assert.equal(b.purpose, 'protection')
        sessions = sessions.filter(s => s.host !== b.host)
        sessions.push({ host: b.host, open: true, accounts: b.accountIds })
        return { ok: true, json: async () => ({ accounts: b.accountIds.map(accountId => ({ accountId, authorized: true })) }) }
      }
      return { ok: true, json: async () => ({ source: 'cpp-verify', sessions,
        accounts: sessions.flatMap(s => s.accounts.map(accountId => ({ accountId, host: s.host, ok: true, source: 'broker_reconcile', checkedAtMs: Date.now(), openCount: 0, missingSl: 0, missingTp: 0 }))) }) }
    } })
  await poll(); await poll()
  assert.equal(connects.length, 2)
  assert.deepEqual(connects.find(c => c.host.startsWith('demo.')).accountIds, ['11', '12'])
  assert.deepEqual(connects.find(c => c.host.startsWith('live.')).accountIds, ['22'])
  assert.equal(independentProtectionView(db, '22').ok, true)
  sessions = []; await poll()
  assert.equal(connects.length, 4)
  offline = true; await poll()
  assert.equal(independentProtectionView(db, '22').ok, false)
})
