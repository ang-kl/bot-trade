import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObserverDelivery, sendObserverTelegram } from './verify-observer-delivery.js'
const bad = { ok: false, state: 'probe_unavailable' }, good = { ok: true, state: 'probe_progress_observed' }
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'verify-observer-')); t.after(() => rm(directory, { recursive: true, force: true })); return join(directory, 'outbox.json') }
test('muted means no disk or delivery; failed sends survive restart, deduplicate and recover in order', async t => {
  const path = await fixture(t); let at = 1800000000000, attempts = 0
  const options = { path, enabled: true, now: () => at, send: async () => { attempts++; throw new Error('offline') } }
  assert.equal((await createObserverDelivery({ ...options, enabled: false })(bad)).state, 'muted')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  const first = await createObserverDelivery(options)(bad); assert.equal(first.state, 'delivery_failed')
  assert.equal((await createObserverDelivery(options)(bad)).state, 'retry_wait'); assert.equal(attempts, 1)
  at += 3000
  const delivered = []
  const resumed = createObserverDelivery({ ...options, send: async e => { delivered.push(e); return { messageId: delivered.length } } })
  assert.equal((await resumed(good)).accepted, true)
  assert.equal((await resumed(good)).accepted, true)
  assert.deepEqual(delivered.map(e => e.kind), ['failure', 'recovery'])
  assert.equal(delivered[0].id, first.eventId); assert.equal(delivered[0].incidentId, delivered[1].incidentId)
  assert.equal((await resumed(good)).state, 'idle'); assert.equal(JSON.parse(await readFile(path)).pending.length, 0)
})
test('corrupt journal fails closed; capacity refuses without dropping pending incident records', async t => {
  const path = await fixture(t); await writeFile(path, '{broken')
  const send = async () => { throw new Error('must not send') }
  await assert.rejects(createObserverDelivery({ path, enabled: true, send })(bad))
  const pending = Array.from({ length: 128 }, (_, i) => ({ id: String(i), kind: 'failure', attempts: 1, nextAttemptAt: 0 }))
  const content = JSON.stringify({ schemaVersion: 1, sequence: 128, active: null, pending })
  await writeFile(path, content)
  await assert.rejects(createObserverDelivery({ path, enabled: true, send })(bad), /capacity/)
  assert.equal(await readFile(path, 'utf8'), content)
})
test('Telegram acceptance requires bounded affirmative API receipt; no redirect or broker payload', async () => {
  const event = { id: '1', incidentId: '1', kind: 'failure', reason: 'probe_unavailable', observedAt: 1800000000000 }
  const options = { token: '123:fixture', chatId: '456', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bot123:fixture/sendMessage'); assert.equal(init.redirect, 'error')
    assert.equal(JSON.parse(init.body).chat_id, '456'); return new Response('{"ok":true,"result":{"message_id":7}}')
  } }
  assert.deepEqual(await sendObserverTelegram(event, options), { messageId: 7 })
  await assert.rejects(sendObserverTelegram(event, { ...options, fetchImpl: async () => new Response('{"ok":false}') }), /not_accepted/)
  await assert.rejects(sendObserverTelegram(event, { ...options, fetchImpl: async () => new Response('x'.repeat(16385)) }), /bound/)
})
