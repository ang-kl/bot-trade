// node --test agent/lib/ctrader-env.test.js
//
// WHY THIS FILE EXISTS. This module resolves BROKER CREDENTIALS and had no
// test at all. On 2026-08-22 the owner asked "I have so many cTrader
// variables, which one is actual?" and nothing in the system could answer:
// the lookup accepted six spellings, picked one by `Object.entries`
// enumeration order, and named nothing. The client secret alone has two
// accepted spellings, so two variables holding two different secrets
// resolved by luck — surfacing only as an unattributable "Access denied"
// from Spotware.
//
// The cases below pin the three properties that make that answerable:
// tolerance (any spelling works), determinism (the same config always
// resolves the same way), and disclosure (a disagreement is reported, and
// no value ever is).

import test from 'node:test'
import assert from 'node:assert/strict'
import { ctraderEnv, ctraderEnvReport, CTRADER_ENV_KINDS } from './ctrader-env.js'

// Spelling tolerance ------------------------------------------------------

test('any capitalization or separator spelling resolves', () => {
  const spellings = [
    'CTRADER_CLIENT_ID', 'cTrader_ClientID', 'ctrader-client-id',
    'CTraderClientId', 'ctraderclientid',
  ]
  for (const name of spellings) {
    assert.equal(ctraderEnv('clientId', { [name]: 'v' }), 'v', name)
  }
})

test('the client secret accepts BOTH its documented spellings', () => {
  // This is the pair that made an arbitrary choice possible — the owner's
  // production config uses the second one.
  assert.equal(ctraderEnv('clientSecret', { CTRADER_CLIENT_SECRET: 'a' }), 'a')
  assert.equal(ctraderEnv('clientSecret', { cTrader_Secret: 'b' }), 'b')
})

test('an unrelated cTrader variable fills no slot', () => {
  // CTRADER_WS_POOL is real in production and must not be mistaken for a
  // credential by a loose match.
  const env = { CTRADER_WS_POOL: 'pool' }
  for (const kind of CTRADER_ENV_KINDS) {
    assert.equal(ctraderEnv(kind, env), undefined, kind)
  }
})

test('an empty value is not a match', () => {
  assert.equal(ctraderEnv('clientId', { CTRADER_CLIENT_ID: '' }), undefined)
})

// Determinism -------------------------------------------------------------

test('two spellings resolve the SAME way regardless of insertion order', () => {
  // The defect: Object.entries yields insertion order, so the platform's
  // ordering decided which secret was used. Sorted selection removes that.
  const a = { CTRADER_CLIENT_SECRET: 'first', cTrader_Secret: 'second' }
  const b = { cTrader_Secret: 'second', CTRADER_CLIENT_SECRET: 'first' }
  assert.equal(ctraderEnv('clientSecret', a), ctraderEnv('clientSecret', b))
  // And it is the first BY NAME, which is stateable in a log line.
  assert.equal(ctraderEnv('clientSecret', a), 'first')
})

// Disclosure --------------------------------------------------------------

test('the report names the variable actually used', () => {
  const rep = ctraderEnvReport({ cTrader_Secret: 'x' })
  const secret = rep.find(r => r.kind === 'clientSecret')
  assert.equal(secret.chosen, 'cTrader_Secret')
  assert.deepEqual(secret.names, ['cTrader_Secret'])
  assert.equal(secret.conflict, false)
})

test('candidates that DISAGREE are reported as a conflict, and both named', () => {
  const rep = ctraderEnvReport({ CTRADER_CLIENT_SECRET: 'one', cTrader_Secret: 'two' })
  const secret = rep.find(r => r.kind === 'clientSecret')
  assert.equal(secret.conflict, true)
  assert.equal(secret.names.length, 2)
  assert.ok(secret.names.includes('CTRADER_CLIENT_SECRET'))
  assert.ok(secret.names.includes('cTrader_Secret'))
})

test('duplicate spellings holding the SAME value are not a conflict', () => {
  // Harmless redundancy must not cry wolf, or the real conflict gets ignored.
  const rep = ctraderEnvReport({ CTRADER_CLIENT_SECRET: 'same', cTrader_Secret: 'same' })
  assert.equal(rep.find(r => r.kind === 'clientSecret').conflict, false)
})

test('THE REPORT NEVER CARRIES A VALUE — it goes to the boot log', () => {
  // A credential that reaches a log has leaked. This is the assertion that
  // makes logging the report safe, so it is checked against every field of
  // every row rather than the one field a reader happens to remember.
  const env = {
    CTRADER_CLIENT_ID: 'id-SECRET-VALUE',
    cTrader_Secret: 'secret-SECRET-VALUE',
    CTRADER_ACCESS_TOKEN: 'access-SECRET-VALUE',
    CTRADER_REFRESH_TOKEN: 'refresh-SECRET-VALUE',
    CTRADER_ACCOUNT_ID: '46130058',
    CTRADER_IS_LIVE: 'true',
  }
  const serialized = JSON.stringify(ctraderEnvReport(env))
  for (const value of Object.values(env)) {
    assert.ok(!serialized.includes(value), `report leaked the value of a credential: ${value}`)
  }
})

test('every kind appears in the report, present or not', () => {
  const rep = ctraderEnvReport({})
  assert.deepEqual(rep.map(r => r.kind).sort(), [...CTRADER_ENV_KINDS].sort())
  for (const r of rep) {
    assert.equal(r.chosen, null)
    assert.deepEqual(r.names, [])
    assert.equal(r.conflict, false)
  }
})

test('the report agrees with the lookup — same variable, same choice', () => {
  // A report that described a different selection than the one in use would
  // be worse than no report: it would explain the wrong thing convincingly.
  const env = { CTRADER_CLIENT_SECRET: 'one', cTrader_Secret: 'two' }
  const chosenName = ctraderEnvReport(env).find(r => r.kind === 'clientSecret').chosen
  assert.equal(ctraderEnv('clientSecret', env), env[chosenName])
})
