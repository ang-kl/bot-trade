// node --test agent/ctrader-adopt-wiring.test.js
//
// WHY A WIRING TEST. lib/ctrader-env-adopt.js is pure and fully covered by its
// own unit tests — and every one of them would stay green if boot never called
// it. That is failure mode #4 in CLAUDE.md: a repair nothing calls, the same
// shape as reconcileTradePricesToBroker wired only into a manual POST route
// nobody runs. The decision function is invisible from the module under test,
// and a refactor drops the call site in silence.
//
// COMMENTS ARE STRIPPED BEFORE ASSERTING (failure mode #2). The block above
// the seeding code in index.js explains this mechanism in prose and names
// every identifier below; asserting against raw source would let the whole
// implementation be deleted while the explanation kept the test green.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

test('boot IMPORTS the adoption module', () => {
  // Static `from '...'` or the dynamic `await import('...')` boot uses — the
  // point is that the module is reached, not which syntax reaches it.
  assert.match(CODE, /(from|import\()\s*'\.\/lib\/ctrader-env-adopt\.js'/)
})

test('boot reads the flag and consults the verdict — not a reimplementation', () => {
  // Both must appear in CODE, not merely in the comment that explains them.
  assert.match(CODE, /adoptionEnabled\(\)/, 'the flag is never read')
  assert.match(CODE, /adoptionVerdict\(/, 'the decision is made somewhere other than the module that owns it')
})

test('every adoption branch the verdict can return is handled', () => {
  // A verdict value with no branch would fall through to the ignore message,
  // which is exactly the silent-no-op this whole change exists to remove.
  for (const action of ['seed', 'adopt']) {
    assert.match(CODE, new RegExp(`=== '${action}'`), `no branch for verdict '${action}'`)
  }
})

test('an adoption RECORDS its fingerprint, or the guard cannot fire', () => {
  // Without this write, adoptedFp is always null, adoptionVerdict always says
  // 'adopt', and the flag reinstates a spent token on every restart — the
  // footgun the rotation guard exists to prevent. The guard would be on,
  // configured, and out of reach of what it guards.
  assert.match(CODE, /setState\(db, adoptedKeyFor\(/)
  assert.match(CODE, /fingerprint\(/)
})

test('the three token slots still go through seedOrExplain', () => {
  // The adoption path is only reachable through this helper; a slot that stops
  // using it silently opts out of both the seeding and the diagnosis.
  // Matched per CALL rather than with a character class: the account-id call
  // passes `String(envAccountId)`, so a `[^)]*` scan stops at that paren and
  // reports a correctly-wired slot as missing.
  const calls = CODE.split('seedOrExplain(').slice(1).map(c => c.slice(0, 160))
  for (const key of ['ctrader_access_token', 'ctrader_refresh_token', 'ctrader_account_id']) {
    assert.ok(
      calls.some(c => c.includes(`'${key}'`)),
      `${key} no longer routed through seedOrExplain`,
    )
  }
})

test('the IGNORED message names the switch that resolves it', () => {
  // A diagnostic that says "this was ignored" and not "here is how to stop it
  // being ignored" is half a diagnostic — that gap is what cost two rounds of
  // the owner editing a host variable that nothing read.
  const msg = SRC.slice(SRC.indexOf('env value IGNORED'))
  assert.match(msg.slice(0, 400), /CTRADER_ADOPT_ENV_TOKENS/)
})
