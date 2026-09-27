import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { reconcile, pushSidecarSession, invalidateSidecarSession, setExecGuard } from './exec-engine.js'

const creds = (over = {}) => ({ ready: true, host: 'demo.ctraderapi.com', clientId: 'fixture',
  clientSecret: 'fixture', accessToken: 'fixture-token', accountId: '11', accountIds: ['11', '22', '33'], ...over })
function transport(t, onConnect = async () => {}) {
  const seen = [], keys = ['EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE']
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  Object.assign(process.env, { EXEC_ENGINE: 'cpp', EXEC_URL: 'http://fixture', EXEC_URL_DEMO: 'http://demo', EXEC_URL_LIVE: 'http://live' })
  invalidateSidecarSession()
  t.after(() => { invalidateSidecarSession(); for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (url.endsWith('/connect')) { const row = { url, body: JSON.parse(opts.body) }; seen.push(row); await onConnect(row, seen.length) }
    return { ok: true, status: 200, text: async () => '{"positions":[]}' }
  })
  return seen
}
test('concurrent callers sharing a roster send one connect, regardless of roster ordering', async t => {
  const seen = transport(t, () => turn())
  await Promise.all([reconcile(creds()), reconcile(creds({ accountId: '22', accountIds: ['22', '33', '11'] })), reconcile(creds({ accountId: '33', accountIds: ['33'] }))])
  assert.equal(seen.length, 1)
})
test('a forced resend during an in-flight connect is not swallowed or overwritten by its old memo', { timeout: 5000 }, async t => {
  let release
  const seen = transport(t, (_row, n) => n === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve())
  const first = reconcile(creds())
  while (!release) await turn()
  const forced = pushSidecarSession(creds())
  await turn()
  assert.equal(seen.length, 1, 'the forced push waits for this gateway only')
  release()
  await Promise.all([first, forced])
  assert.equal(seen.length, 2, 'the force causes a new connect after the old one')
  await reconcile(creds())
  assert.equal(seen.length, 2, 'the successful new session is then memoised')
})
test('queued account additions retain the earlier roster, and a new token still reconnects', async t => {
  const seen = transport(t, () => turn())
  await Promise.all([reconcile(creds({ accountIds: ['11'] })), reconcile(creds({ accountId: '22', accountIds: ['22'] }))])
  assert.deepEqual(seen.map(r => r.body.accountIds), [['11'], ['22', '11']])
  await reconcile(creds({ accessToken: 'rotated-fixture' }))
  assert.equal(seen.length, 3)
  assert.equal(seen[2].body.accessToken, 'rotated-fixture')
})
test('different gateway sessions progress independently', { timeout: 5000 }, async t => {
  const releases = []
  const seen = transport(t, () => new Promise(resolve => releases.push(resolve)))
  const calls = [reconcile(creds()), reconcile(creds({ host: 'live.ctraderapi.com' }))]
  while (releases.length < 2) await turn()
  assert.equal(new Set(seen.map(r => r.url)).size, 2)
  releases.forEach(resolve => resolve())
  await Promise.all(calls)
})
test('failed forced connect does not poison the queue or become a successful belief', async t => {
  const seen = transport(t, (_row, n) => { if (n === 1) throw new Error('fixture_connect_failed') })
  await assert.rejects(pushSidecarSession(creds()), /fixture_connect_failed/)
  await pushSidecarSession(creds())
  await reconcile(creds())
  assert.equal(seen.length, 2)
})
test('equivalent concurrent callers share a failed connect; a later call can retry', { timeout: 5000 }, async t => {
  const failure = new Error('fixture_connect_timeout')
  let failing = true
  const seen = transport(t, async () => { await turn(); if (failing) throw failure })
  const result = await Promise.allSettled([
    setExecGuard(creds(), {}),
    setExecGuard(creds({ accountId: '22', accountIds: ['33', '11', '22'] }), {}),
    setExecGuard(creds({ accountId: '33' }), {}),
  ])
  assert.equal(seen.length, 1, 'waiting callers do not each spend another connection timeout')
  assert.ok(result.every(r => r.status === 'rejected' && r.reason === failure))
  failing = false
  await setExecGuard(creds(), {})
  assert.equal(seen.length, 2, 'settled failure is not cached')
  await setExecGuard(creds(), {})
  assert.equal(seen.length, 2, 'successful retry is memoised')
})
test('a forced resend queues a fresh attempt after a shared failed connection', { timeout: 5000 }, async t => {
  let release
  const failure = new Error('fixture_connect_timeout')
  const seen = transport(t, (_row, n) => n === 1
    ? new Promise((_resolve, reject) => { release = () => reject(failure) }) : Promise.resolve())
  const callers = Promise.allSettled([setExecGuard(creds(), {}), setExecGuard(creds(), {})])
  while (!release) await turn()
  const forced = pushSidecarSession(creds())
  await turn()
  assert.equal(seen.length, 1)
  release()
  const result = await callers
  assert.ok(result.every(r => r.status === 'rejected' && r.reason === failure))
  assert.equal(await forced, true)
  assert.equal(seen.length, 2, 'force is a separate attempt, never satisfied by the shared failure')
  await setExecGuard(creds(), {})
  assert.equal(seen.length, 2)
})
