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
