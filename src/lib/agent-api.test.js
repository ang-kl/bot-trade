// D12 (2026-07-27): the build-time connection default must only ever grant
// the read tier — VITE_AGENT_SECRET/VITE_AGENT_SECRET_AUTOPILOT (the old
// full-privilege fallbacks) must no longer be read at all.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAgentConn } from './agent-api.js'

beforeEach(() => {
  // node environment — no window/localStorage, matching the guarded paths.
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

test('getAgentConn: falls back to VITE_AGENT_SECRET_READ when nothing is saved', () => {
  vi.stubEnv('VITE_AGENT_SECRET_READ', 'read-only-value')
  expect(getAgentConn().secret).toBe('read-only-value')
})

test('getAgentConn: the old full-privilege vars are never read, even if still set', () => {
  vi.stubEnv('VITE_AGENT_SECRET_AUTOPILOT', 'full-value')
  vi.stubEnv('VITE_AGENT_SECRET', 'also-full-value')
  expect(getAgentConn().secret).toBe('')
})

test('getAgentConn: no env vars set at all → empty secret, never throws', () => {
  expect(getAgentConn().secret).toBe('')
})

// V3 M2b (M2 check nit 3): agentGet threw only the reply's `error` text, so a
// report 503's reason, detail and retry hint never reached the page — the
// Latest-prices note read "Latest prices unavailable (Latest prices are
// temporarily unavailable. Please retry.)". The reply now rides on the error.
test('agentGet: a failed read throws the same message with the reply attached, and the price note names the reason from it', async () => {
  vi.stubEnv('VITE_AGENT_SECRET_READ', 'read-only-value')
  const reply = { status: 'unavailable', error: 'Latest prices are temporarily unavailable. Please retry.', code: 'latest_prices_unavailable',
    reason: 'performance_report_deadline', retryAfter: 30, retryable: true }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply), { status: 503, headers: { 'content-type': 'application/json' } })))
  try {
    const { agentGet } = await import('./agent-api.js')
    const error = await agentGet('/state/prices').then(() => null, e => e)
    expect(error.message).toBe(reply.error)
    expect(error.status).toBe(503)
    expect(error.body).toEqual(reply)
    const { loadLatestPrices, latestPricesNote } = await import('./latest-prices.js')
    const note = latestPricesNote(await loadLatestPrices(agentGet))
    expect(note).toContain('(the price read ran past its time limit — performance_report_deadline, HTTP 503, retry after 30 s)')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('agentGet: a non-JSON failure keeps its status line and carries no body', async () => {
  vi.stubEnv('VITE_AGENT_SECRET_READ', 'read-only-value')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } })))
  try {
    const { agentGet } = await import('./agent-api.js')
    const error = await agentGet('/state/prices').then(() => null, e => e)
    expect(error.message).toBe('GET /state/prices 502')
    expect(error.status).toBe(502)
    expect(error.body).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})

// CHARACTERISATION TEST, not a regression guard (relabelled on the WP-A
// checker's nit 7, 25-09-2026). It pins client behaviour that predates WP-A:
// agentPost already threw `j.error` from a refusal, so against this stubbed
// reply it cannot go red on the WP-A change. What WP-A added — the ROUTE
// putting the named reason in `error` — is pinned by the route tests in
// agent/services/entry-mode.test.js (the WP-A "…answers 400 with the named
// reason in `error`" test, and the mode-less overlay test for that branch).
// Kept so the client half of the contract (the panel shows
// "tick_not_ready: …", not "POST /actions/entry-mode 400") stays described.
test('agentPost (characterisation, pre-WP-A behaviour): a 400 refusal throws the server\'s named reason from `error`', async () => {
  vi.stubEnv('VITE_AGENT_SECRET_READ', 'read-only-value')
  const reason = 'tick_not_ready: profile_pinned, profile_matches_sidecar, replay_evidence, validation_stage'
  const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason, error: reason }), { status: 400, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchStub)
  vi.doMock('sonner', () => ({ toast: { error: () => {} } }))
  try {
    const { agentPost } = await import('./agent-api.js')
    await expect(agentPost('/actions/entry-mode', { accountId: '46979908', mode: 'TIME_BASED', admittedBases: ['bar', 'tick'], expectedRevision: 2 })).rejects.toThrow(reason)
    const sent = JSON.parse(fetchStub.mock.calls[0][1].body)
    expect(sent.admittedBases).toEqual(['bar', 'tick'])
  } finally {
    vi.unstubAllGlobals()
    vi.doUnmock('sonner')
  }
})
