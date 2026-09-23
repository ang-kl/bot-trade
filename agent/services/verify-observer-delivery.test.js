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
test('corrupt journal fails closed; full capacity retains transitions while permitting outbox recovery', async t => {
  const path = await fixture(t); await writeFile(path, '{broken')
  let attempts = 0, at = 1800000000000
  const send = async () => { attempts++; throw new Error('offline') }
  await assert.rejects(createObserverDelivery({ path, enabled: true, send })(bad))
  const pending = Array.from({ length: 128 }, (_, i) => ({ id: String(i), kind: 'failure', attempts: 1, nextAttemptAt: 0 }))
  const content = JSON.stringify({ schemaVersion: 1, sequence: 128, active: null, pending })
  await writeFile(path, content)
  assert.equal(attempts, 0, 'a corrupt journal never sends')
  const blocked = await createObserverDelivery({ path, enabled: true, send, now: () => at })(bad)
  assert.equal(blocked.state, 'delivery_failed'); assert.equal(blocked.capacityBlocked, true)
  let state = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(state.pending.map(e => e.id), pending.map(e => e.id))
  assert.equal(state.sequence, 128); assert.equal(state.active, null)
  assert.equal(state.pending[0].attempts, 2); assert.equal(attempts, 1)
  at += 5000
  const sent = []
  const resumed = createObserverDelivery({ path, enabled: true, now: () => at, send: async e => { sent.push(e); return { messageId: sent.length } } })
  assert.equal((await resumed(bad)).accepted, true)
  state = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(state.pending.length, 128); assert.equal(state.pending.at(-1).kind, 'failure')
  assert.equal(state.sequence, 129); assert.equal(state.active, state.pending.at(-1).incidentId)
  for (let i = 0; i < 128; i++) assert.equal((await resumed(bad)).accepted, true)
  assert.equal((await resumed(bad)).state, 'idle')
  assert.deepEqual(sent.slice(0,128).map(e => e.id), pending.map(e => e.id))
  assert.equal(new Set(sent.map(e => e.id)).size, 129)
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
