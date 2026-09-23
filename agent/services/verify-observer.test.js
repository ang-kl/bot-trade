import test from 'node:test'
import assert from 'node:assert/strict'
import { observeVerifier } from './verify-observer.js'
const now = 1800000000000
test('outer observer distinguishes fresh HTTP from completed probe progress, including when every target is down', async () => {
  const body = { schemaVersion: 1, enabled: true, durable: true, observedAtMs: now,
    services: Object.fromEntries(['node', 'cpp-exec', 'cpp-acct'].map(k => [k, { attemptedAtMs: now - 1000, reachable: false }])) }
  const opts = { url: 'https://verifier.test/watchdog', secret: 'fixture', now: () => now,
    fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response(JSON.stringify(body)) } }
  assert.equal((await observeVerifier(opts)).ok, true)
  body.services.node.attemptedAtMs = now - 60000
  assert.equal((await observeVerifier(opts)).state, 'probe_progress_stalled')
  body.enabled = false; assert.equal((await observeVerifier(opts)).state, 'supervision_inactive')
  body.enabled = true; body.durable = false; assert.equal((await observeVerifier(opts)).state, 'incident_storage_unavailable')
  assert.equal((await observeVerifier({ ...opts, fetchImpl: async () => { throw Error('offline') } })).state, 'probe_unavailable')
  assert.equal((await observeVerifier({ ...opts, fetchImpl: async () => new Response('x'.repeat(256 * 1024 + 1)) })).state, 'probe_unavailable')
})
