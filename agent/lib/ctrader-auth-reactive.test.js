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
  withRetry, setAuthErrorHook, isAuthTokenError, _resetAuthRecoveryForTests,
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
  assert.match(loop, /setAuthErrorHook\(\(\) => refreshCtraderToken\(db\)\)/,
    'a hook nothing sets is the same dead repair this replaces')
  const actions = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.match(actions, /router\.post\('\/ctrader-token-refresh'/,
    'the on-demand lever must exist for recovery without waiting on a broker error')
  assert.doesNotMatch(actions.slice(actions.indexOf("'/ctrader-token-refresh'"), actions.indexOf("'/ctrader-token-refresh'") + 900), /req\.body/,
    'the route must never accept a caller-supplied refresh token')
})
