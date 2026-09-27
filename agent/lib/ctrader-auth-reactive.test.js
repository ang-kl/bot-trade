// node --test agent/lib/ctrader-auth-reactive.test.js
//
// The reactive half of token recovery (26-08-2026, "controllers have been
// down"). ctrader-auth.js promised reactive refresh and nothing ever called
// it — failure mode #4 — so the access token Spotware invalidated at ~23:10Z
// stalled every controller. These pin the new contract: an auth error inside
// withRetry triggers ONE cooldown-limited refresh, any other error triggers
// none, a failing refresh never masks the original error, and the loop
// actually installs the hook (a hook nothing sets is the same dead repair).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  withRetry, setAuthErrorHook, isAuthTokenError, _resetAuthRecoveryForTests, tagAccount,
} from './ctrader-ws.js'

const authErr = () => new Error('cTrader error: CH_ACCESS_TOKEN_INVALID — Invalid access token')

test('an auth error triggers exactly one refresh per cooldown window', async () => {
  _resetAuthRecoveryForTests()
  let refreshes = 0
  setAuthErrorHook(async () => { refreshes++ })
  try {
    await assert.rejects(
      withRetry(async () => { throw authErr() }, 2, 'test'),
      /CH_ACCESS_TOKEN_INVALID/,
      'the original error still surfaces — recovery lands on the NEXT call'
    )
    assert.equal(refreshes, 1, '3 attempts, 1 refresh: the cooldown holds within one call too')
  } finally { setAuthErrorHook(null) }
})

test('a non-auth error never touches the hook', async () => {
  _resetAuthRecoveryForTests()
  let refreshes = 0
  setAuthErrorHook(async () => { refreshes++ })
  try {
    await assert.rejects(withRetry(async () => { throw new Error('socket hang up') }, 0, 'test'))
    assert.equal(refreshes, 0)
  } finally { setAuthErrorHook(null) }
})

test('a FAILING refresh is swallowed — the broker error stays the story', async () => {
  _resetAuthRecoveryForTests()
  setAuthErrorHook(async () => { throw new Error('token refresh rejected: invalid_grant') })
  try {
    await assert.rejects(
      withRetry(async () => { throw authErr() }, 0, 'test'),
      /CH_ACCESS_TOKEN_INVALID/,
      'the refresh failure must not replace the original error'
    )
  } finally { setAuthErrorHook(null) }
})

test('isAuthTokenError matches both broker spellings and nothing else', () => {
  assert.equal(isAuthTokenError(authErr()), true)
  assert.equal(isAuthTokenError(new Error('CH_ACCESS_TOKEN_EXPIRED')), true)
  assert.equal(isAuthTokenError(new Error('CH_CLIENT_AUTH_FAILURE')), false)
  assert.equal(isAuthTokenError(null), false)
})

// ---------------------------------------------------------------------------
// Wiring pins, source-scan style (loop.js starts the whole agent when
// imported — same justification as vercel-decomm.test.js).
// ---------------------------------------------------------------------------
test('the loop installs the hook and the on-demand route exists', () => {
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.match(loop, /setAuthErrorHook\(\(\) => refreshCtraderToken\(db\), \{/,
    'a hook nothing sets is the same dead repair this replaces')
  // B7: the loop hands the hook the refused-account predicate.
  assert.match(loop, /skip: \(err\) => err\?\.accountId != null && tokenRefusedAccounts\(db\)\.has\(String\(err\.accountId\)\)/,
    'a refusal for an account the token never covered must not read as a rotation')
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.match(actions, /router\.post\('\/ctrader-token-refresh'/,
    'the on-demand lever must exist for recovery without waiting on a broker error')
  assert.doesNotMatch(actions.slice(actions.indexOf("'/ctrader-token-refresh'"), actions.indexOf("'/ctrader-token-refresh'") + 900), /req\.body/,
    'the route must never accept a caller-supplied refresh token')
})

// ---------------------------------------------------------------------------
// B7 (18-09-2026): a refusal for an account the token never covered is NOT a
// rotation. Measured: …2148/…9009 answered CH_ACCESS_TOKEN_INVALID on every
// call, the hook refreshed the token every cooldown, and the heartbeat
// re-pushed the "rotated" token to both sidecars every ~3 minutes.
// ---------------------------------------------------------------------------
test('B7: the skip predicate declines the refresh for a refused account and leaves the cooldown untouched', async () => {
  _resetAuthRecoveryForTests()
  let refreshes = 0
  const refused = new Set(['43002148'])
  setAuthErrorHook(async () => { refreshes++ }, {
    skip: (err) => err?.accountId != null && refused.has(String(err.accountId)),
  })
  const logs = []
  const origLog = console.log
  console.log = (...a) => { logs.push(a.join(' ')) }
  try {
    await assert.rejects(
      withRetry(async () => { throw tagAccount(authErr(), '43002148') }, 1, 'test'),
      /CH_ACCESS_TOKEN_INVALID/)
    assert.equal(refreshes, 0, 'refused extra account → no refresh')
    assert.equal(logs.filter(l => /not a rotation, no reactive refresh/.test(l)).length, 2, 'said on each attempt, at info level')
    // The same error from a covered account still refreshes — the cooldown was
    // NOT consumed by the declined one.
    await assert.rejects(withRetry(async () => { throw tagAccount(authErr(), '42993489') }, 0, 'test'))
    assert.equal(refreshes, 1)
    // An untagged error (no account known) keeps today's behaviour.
    _resetAuthRecoveryForTests()
    await assert.rejects(withRetry(async () => { throw authErr() }, 0, 'test'))
    assert.equal(refreshes, 2)
  } finally { console.log = origLog; setAuthErrorHook(null) }
})

test('B7: tagAccount names the account once and never overwrites an existing tag', () => {
  const e = tagAccount(new Error('x'), 43002148)
  assert.equal(e.accountId, '43002148')
  assert.equal(tagAccount(e, '999').accountId, '43002148')
  assert.equal(tagAccount(null, '1'), null)
})

// V3 S-8: the entry path's broker reads pass recoverAuth false. The loop
// awaits them serially; the refresh is an OAuth request with no timeout of its
// own; and wsGetSymbolById's errors carry no account, so B7's skip could not
// tell a refused account's error from a rotated token.
test('recoverAuth false: an auth error never fires the hook; the default still does', async () => {
  _resetAuthRecoveryForTests()
  let refreshes = 0
  setAuthErrorHook(async () => { refreshes++ })
  try {
    await assert.rejects(withRetry(async () => { throw authErr() }, 0, 'test', null, { recoverAuth: false }), /CH_ACCESS_TOKEN_INVALID/)
    assert.equal(refreshes, 0, 'RED if an entry-path read can fire the reactive OAuth refresh')
    await assert.rejects(withRetry(async () => { throw authErr() }, 0, 'test'), /CH_ACCESS_TOKEN_INVALID/)
    assert.equal(refreshes, 1, 'every other caller keeps the reactive refresh')
  } finally { setAuthErrorHook(null) }
})
