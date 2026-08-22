// node --test agent/lib/ctrader-env-adopt.test.js
//
// WHY THIS FILE EXISTS. On 2026-08-22 the owner changed CTRADER_REFRESH_TOKEN
// on the host, twice, and the agent kept failing with "Access denied" — env
// only seeds an EMPTY database, so once agent_state holds a token the host
// variable is inert. #743 made that visible in the boot log; nothing made it
// actionable.
//
// The dangerous fix is the obvious one. Spotware rotates the refresh token on
// every use, so the database holds the LIVE token and env holds the spent
// original. "Overwrite from env each boot" works once and then reinstates a
// dead credential on every restart afterwards — a guard that causes the outage
// it was built to end.
//
// So the cases below pin the property that makes adoption safe: it is keyed to
// the VALUE, not to the flag. A distinct env value is adopted at most once,
// and the flag may be left on for ever without touching a rotated token.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptionEnabled, adoptionVerdict, fingerprint, adoptedKeyFor,
} from './ctrader-env-adopt.js'

const KEY = 'ctrader_refresh_token'
const v = (o) => adoptionVerdict({ stateKey: KEY, ...o })

// The flag -----------------------------------------------------------------

test('the flag is read tolerantly of spelling, like the credentials are', () => {
  for (const name of [
    'CTRADER_ADOPT_ENV_TOKENS', 'cTrader_Adopt_Env_Tokens',
    'ctrader-adopt-env-tokens', 'CTraderAdoptEnvTokens',
  ]) {
    assert.equal(adoptionEnabled({ [name]: 'true' }), true, name)
  }
})

test('only genuinely truthy values switch it on', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
    assert.equal(adoptionEnabled({ CTRADER_ADOPT_ENV_TOKENS: on }), true, on)
  }
  for (const off of ['0', 'false', 'no', 'off', 'maybe']) {
    assert.equal(adoptionEnabled({ CTRADER_ADOPT_ENV_TOKENS: off }), false, off)
  }
  assert.equal(adoptionEnabled({}), false)
})

// The verdict --------------------------------------------------------------

test('an EMPTY database is seeded — the pre-existing behaviour, unchanged', () => {
  assert.equal(v({ envValue: 'tok', stored: null, enabled: false }).action, 'seed')
  assert.equal(v({ envValue: 'tok', stored: '', enabled: true }).action, 'seed')
})

test('with the flag OFF a differing env value is still ignored', () => {
  // The default must not change. Adoption is opt-in.
  const out = v({ envValue: 'new', stored: 'old', enabled: false })
  assert.equal(out.action, 'ignore')
  assert.match(out.reason, /adoption is off/)
})

test('with the flag ON a NEW env value is adopted', () => {
  const out = v({ envValue: 'new', stored: 'old', adoptedFp: null, enabled: true })
  assert.equal(out.action, 'adopt')
})

test('THE ROTATION GUARD — the same env value is never adopted twice', () => {
  // This is the whole reason the flag is safe to leave switched on. After the
  // first adoption the database copy is the ROTATED descendant of this env
  // value; adopting again would reinstate a spent token and take the account
  // down on every restart.
  const envValue = 'the-token-the-owner-pasted'
  const first = v({ envValue, stored: 'stale', adoptedFp: null, enabled: true })
  assert.equal(first.action, 'adopt')

  const fp = fingerprint(KEY, envValue)
  const second = v({ envValue, stored: 'rotated-descendant', adoptedFp: fp, enabled: true })
  assert.equal(second.action, 'ignore')
  assert.match(second.reason, /already adopted once/)
})

test('after an adoption, a DIFFERENT env value is adopted again', () => {
  // The flag must stay useful. Pasting a second fresh token has to work.
  const out = v({
    envValue: 'a-second-fresh-token',
    stored: 'rotated-descendant',
    adoptedFp: fingerprint(KEY, 'the-first-token'),
    enabled: true,
  })
  assert.equal(out.action, 'adopt')
})

test('env and database agreeing is a no-op regardless of the flag', () => {
  for (const enabled of [true, false]) {
    assert.equal(v({ envValue: 'same', stored: 'same', enabled }).action, 'none')
  }
})

test('no env value means nothing happens, flag or not', () => {
  for (const enabled of [true, false]) {
    assert.equal(v({ envValue: undefined, stored: 'x', enabled }).action, 'none')
  }
})

// The fingerprint ----------------------------------------------------------

test('THE FINGERPRINT IS NOT THE TOKEN — it is written to agent_state', () => {
  // A second copy of a credential in the database would be a leak with extra
  // steps. Only a truncated digest is stored.
  const token = 'SECRET-REFRESH-TOKEN-VALUE'
  const fp = fingerprint(KEY, token)
  assert.ok(!fp.includes(token))
  assert.match(fp, /^[0-9a-f]{16}$/)
})

test('the fingerprint is stable for one value and differs across values', () => {
  assert.equal(fingerprint(KEY, 'a'), fingerprint(KEY, 'a'))
  assert.notEqual(fingerprint(KEY, 'a'), fingerprint(KEY, 'b'))
})

test('the same token under two state keys fingerprints differently', () => {
  // Salted by key, so adopting an access token cannot mark a refresh token
  // adopted — they are separate decisions.
  assert.notEqual(
    fingerprint('ctrader_refresh_token', 'same-token'),
    fingerprint('ctrader_access_token', 'same-token'),
  )
})

test('the marker key is derived from the state key, not hardcoded', () => {
  assert.equal(adoptedKeyFor('ctrader_refresh_token'), 'ctrader_refresh_token_env_adopted_fp')
  assert.equal(adoptedKeyFor('ctrader_access_token'), 'ctrader_access_token_env_adopted_fp')
})
