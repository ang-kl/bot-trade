import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { independentProtectionView, makeIndependentProtectionPoll, startIndependentProtection } from './independent-protection.js'
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
  let sessions = []; const connects = []; const reports = []; let offline = false, refuse = false
  const poll = makeIndependentProtectionPoll(db, { env: { VERIFY_URL: 'https://verifier.test', EXEC_SECRET: 'fixture' }, log: line => reports.push(line),
    fetchImpl: async (url, options) => {
      if (offline) throw new Error('offline')
      if (url.endsWith('/connect')) {
        if (refuse) return { ok: false, status: 502 }
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
  offline = false; refuse = true; sessions = []; await poll()
  assert.match(independentProtectionView(db, '22').summary, /HTTP 502/, 'a missing row still reports its host authorisation failure')
  assert.ok(reports.some(line => line.includes('missing TP1')))
  assert.ok(reports.some(line => line.includes('HTTP 502')))
  assert.ok(reports.every(line => !line.includes('fixture')), 'credentials never enter the audit summary')
})


test('an unconfigured independent checker reports the missing configuration instead of staying silent', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const previous = process.env.VERIFY_URL; delete process.env.VERIFY_URL
  t.after(() => { if (previous === undefined) delete process.env.VERIFY_URL; else process.env.VERIFY_URL = previous })
  const stop = startIndependentProtection(db)
  stop()
  assert.match(independentProtectionView(db, '22').summary, /not configured: VERIFY_URL/)
})

// № 10,448 (02-10-2026): cpp-verify's per-account position lists are the
// independent source; a Node row open on A whose position the verifier holds
// under B is misplaced. 30-09 07:46:42Z: …0058: 5 open, …9908: 4 open while
// Node had just adopted …9908's four as …0058's.
import { misplacedRows } from './independent-protection.js'
test('misplaced rows: a row open on one account whose position the verifier lists under another is named; absent-everywhere is not', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const ins = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id) VALUES (?, 'BUY', 100, 0.1, ?, 'autopilot', ?, datetime('now'), ?)`)
  ins.run('V.US', '241760418', 'open', '46130058')      // phantom: …9908's position on …0058
  ins.run('V.US', '241760418', 'open', '46979908')      // the real row
  ins.run('JNJ.US', '240732676', 'open', '46130058')    // rightly placed
  ins.run('KO.US', '999', 'open', '46130058')           // absent from every list: not named
  ins.run('XOM.US', '242533301', 'closed', '46130058')  // closed rows are not judged
  const status = { accounts: [
    { accountId: '46130058', ok: true, positions: [{ positionId: '240732676' }] },
    { accountId: '46979908', ok: true, positions: [{ positionId: '241760418' }, { positionId: '242533301' }] },
  ] }
  const out = misplacedRows(db, status)
  assert.deepEqual(out.map(m => [m.accountId, m.symbol, m.positionId, m.heldBy]), [['46130058', 'V.US', '241760418', '46979908']])
  assert.deepEqual(misplacedRows(db, { accounts: [{ accountId: '46130058', ok: false, positions: [] }] }), [], 'a failed reading judges nothing')
  // The view carries it: the account is not ok while a misplaced row stands.
  const now = 1_000_000
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [{ accountId: '46130058', ok: true, source: 'broker_reconcile', checkedAtMs: now, openCount: 1, missingSl: 0, missingTp: 0 }], misplaced: out }))
  const v = independentProtectionView(db, '46130058', now)
  assert.equal(v.ok, false)
  assert.match(v.summary, /MISPLACED.*V\.US 241760418 held by …9908/)
})
