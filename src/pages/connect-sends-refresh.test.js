// src/pages/connect-sends-refresh.test.js  (vitest)
//
// THE OTHER HALF OF THE TRAP. agent/routes/ctrader-token-route.test.js proves
// the agent STORES a refresh token when one arrives. It cannot prove one ever
// arrives — and for as long as this file has existed, none did: the OAuth
// exchange returned both tokens and Connect.jsx forwarded only the access
// token. A green route test over a caller that sends nothing is exactly the
// shape of guard this project keeps paying for.
//
// This is a source scan because the send happens inside a `useEffect` fired by
// an OAuth redirect, with no injection point short of rendering the page under
// a fake location and a fake fetch. Comments are stripped first: the block
// above the call names `refreshToken` while explaining the bug, so asserting
// on raw source would let the payload line be deleted and stay green — the
// amend-preserves-tp defect, repeated.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fs.readFileSync(fileURLToPath(new URL('./Connect.jsx', import.meta.url)), 'utf8')
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

/** The `/actions/ctrader-token` call, from the agentPost to its closing brace. */
function tokenPost() {
  const i = CODE.indexOf("agentPost('/actions/ctrader-token'")
  expect(i, "the /actions/ctrader-token call is gone — this test's anchor with it").toBeGreaterThan(-1)
  return CODE.slice(i, i + 300)
}

describe('the link-up handoff', () => {
  it('forwards the REFRESH token, not only the access token', () => {
    // The defect: without this, re-linking cannot repair an expired refresh
    // token, and there is no other way to write that field.
    expect(tokenPost()).toMatch(/refreshToken/)
  })

  it('forwards the access token too — both, not one swapped for the other', () => {
    expect(tokenPost()).toMatch(/accessToken/)
  })

  it('takes the refresh token from the EXCHANGE RESPONSE', () => {
    // `refreshToken: something-else` would satisfy the case above while
    // sending the wrong value. It must come off the object the token exchange
    // returned.
    expect(tokenPost()).toMatch(/refreshToken:\s*ex\.refreshToken/)
  })
})
