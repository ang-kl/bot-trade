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
