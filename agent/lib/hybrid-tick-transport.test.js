// Codex · №12,325 · 2026-10-09; codex-footprint: own gateway send boundary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hybridTickTransport } from './hybrid-tick-transport.js'
test('live/demo tick transport keeps host/account routing and resolves the current token at send', async () => {
  for (const host of ['live.ctraderapi.com', 'demo.ctraderapi.com']) {
    let token = 'old', sent
    const creds = { ready: true, host, accountId: '42', clientId: 'id', clientSecret: 'secret', accessToken: 'old', resolveAccessToken: () => token }
    const transport = hybridTickTransport({ env: { EXEC_SECRET: 'test-only' }, baseFor: h => { assert.equal(h, host); return 'https://own-gateway' },
      fetch: async (url, options) => { sent = { url, options }; return { ok: true, json: async () => ({ configured: true }) } } })
    token = 'current'
    await transport.configure(host, [{ creds, plans: [{ host, accountId: '42' }] }])
    assert.equal(JSON.parse(sent.options.body).accounts[0].accessToken, 'current')
    assert.equal(sent.options.redirect, 'error'); assert.equal(sent.options.headers.authorization, 'Bearer test-only')
    await transport.events(host); assert.equal(sent.options.method, 'GET'); assert.equal(sent.options.body, undefined)
    await transport.acknowledge(host, 'event'); assert.deepEqual(JSON.parse(sent.options.body), { eventId: 'event' })
    await assert.rejects(transport.configure(host, [{ creds, plans: [{ host, accountId: '43' }] }]), /routing/)
  }
})
test('missing gateway auth or failed response does not claim config or trigger success', async () => {
  const transport = hybridTickTransport({ env: {}, fetch: async () => { throw Error('must not call') } })
  await assert.rejects(transport.events('live.ctraderapi.com'), /authentication unavailable/)
  const failed = hybridTickTransport({ env: { EXEC_SECRET: 'fixture' }, baseFor: () => 'https://fixture',
    fetch: async () => ({ ok: false, status: 503 }) })
  await assert.rejects(failed.events('live.ctraderapi.com'), /503/)
})
