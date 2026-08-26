// node --test agent/lib/env-disarm.test.js
//
// The staging kill-switch (26-08-2026 token war). Staging shares production's
// cTrader grant, so an armed staging agent invalidates production's access
// token on every refresh — and staging auto-deploys every merge to main, so
// stopping its deployment by hand lasts exactly one merge. These pin the
// durable fix: the agent refuses to arm inside the staging environment, and
// the refusal is wired into BOTH choke points (startLoop and
// refreshCtraderToken) — a guard nothing calls is failure mode #4.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { disarmReason } from './env-disarm.js'

const STAGING_ID = '373ac7e0-c627-4c83-908b-ef8e042e2fc6'
const PRODUCTION_ID = '7bc0dfc6-82c5-406c-a621-fd3ff549674d'

test('the staging environment ID disarms; production and empty do not', () => {
  assert.match(disarmReason({ RAILWAY_ENVIRONMENT_ID: STAGING_ID }), /staging environment/)
  assert.equal(disarmReason({ RAILWAY_ENVIRONMENT_ID: PRODUCTION_ID }), null,
    'production must NEVER match — the guard biting production is the catastrophic inversion')
  assert.equal(disarmReason({}), null, 'local dev / tests / CI see no Railway vars and arm normally')
})

test('a recreated staging environment is caught by NAME even with a fresh ID', () => {
  assert.match(disarmReason({ RAILWAY_ENVIRONMENT_ID: 'some-new-id', RAILWAY_ENVIRONMENT_NAME: 'staging' }),
    /named "staging"/)
  assert.match(disarmReason({ RAILWAY_ENVIRONMENT_NAME: 'Staging' }), /named "Staging"/, 'case-insensitive')
  assert.equal(disarmReason({ RAILWAY_ENVIRONMENT_NAME: 'production' }), null)
})

test('ALLOW_STAGING_TRADING=1 is the only re-arm, and only the exact string', () => {
  assert.equal(disarmReason({ RAILWAY_ENVIRONMENT_ID: STAGING_ID, ALLOW_STAGING_TRADING: '1' }), null)
  assert.match(disarmReason({ RAILWAY_ENVIRONMENT_ID: STAGING_ID, ALLOW_STAGING_TRADING: 'true' }),
    /staging environment/, 'anything but the documented "1" keeps the guard armed')
})

// ---------------------------------------------------------------------------
// Wiring pins, source-scan style (loop.js starts the whole agent when
// imported — same justification as ctrader-auth-reactive.test.js).
// ---------------------------------------------------------------------------
test('startLoop refuses before arming anything, and refreshCtraderToken blocks all refresh paths', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const startIdx = loop.indexOf('export function startLoop')
  assert.ok(startIdx > -1)
  const startSlice = loop.slice(startIdx, startIdx + 700)
  assert.match(startSlice, /disarmReason\(\)/,
    'the check must live in startLoop itself — loop, fast monitor and per-minute review all root here')
  assert.ok(startSlice.indexOf('disarmReason()') < startSlice.indexOf('runLoop'),
    'the refusal must come BEFORE the loop is scheduled')

  const auth = readFileSync(new URL('./ctrader-auth.js', import.meta.url), 'utf8')
  const refreshIdx = auth.indexOf('export async function refreshCtraderToken')
  const refreshSlice = auth.slice(refreshIdx, auth.indexOf('export async function maybeRefreshCtraderToken'))
  assert.match(refreshSlice, /disarmReason\(\)/,
    'refreshCtraderToken is the single choke point for proactive, reactive and manual refresh')
})
