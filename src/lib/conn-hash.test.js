// npx vitest run src/lib/conn-hash.test.js
import { describe, it, expect } from 'vitest'
import { parseConnHash, looksLikeSecret } from './conn-hash.js'

describe('parseConnHash', () => {
  it('does NOT treat an in-page anchor as a secret — the 2026-08-06 logout', () => {
    // THE REGRESSION. `risk-minRR` is the id Field.jsx renders for the Min R:R
    // field, so it is what location.hash becomes when the anchor is followed.
    // The old parser wrote it over the stored session token, and the agent
    // answered every subsequent request with
    //   [auth] 401 — stale/unknown token risk-minRR…
    // which the operator experienced as being logged out while trying to
    // change a risk limit.
    const r = parseConnHash('#risk-minRR')
    expect(r.secret).toBe(null)
    expect(r.url).toBe(null)
    expect(r.ignored).toBe('risk-minRR')
  })

  it('leaves every other anchor shape alone too', () => {
    for (const h of ['#sec-acct-engineering', '#top', '#risk-dailyLossPct', '#tab=2overview']) {
      const r = parseConnHash(h)
      if (!h.includes('=')) expect(r.secret).toBe(null)
    }
  })

  it('still accepts the named setup link', () => {
    const r = parseConnHash('#agent=https://sg-trade.up.railway.app&secret=abc123')
    expect(r.url).toBe('https://sg-trade.up.railway.app')
    expect(r.secret).toBe('abc123')
  })

  it('trusts a NAMED secret even when it is oddly shaped', () => {
    // The operator spelled out which field is which, so there is nothing to
    // infer. A self-hosted deployment may use a secret this app would never
    // mint, and refusing it would break a documented setup link.
    const r = parseConnHash('#secret=my-own-passphrase')
    expect(r.secret).toBe('my-own-passphrase')
  })

  it('accepts a bare fragment ONLY when it is shaped like a real credential', () => {
    const sess = 'sess_' + 'a1b2c3d4'.repeat(6)
    expect(parseConnHash('#' + sess).secret).toBe(sess)
    const hex64 = 'f'.repeat(64)
    expect(parseConnHash('#' + hex64).secret).toBe(hex64)
  })

  it('rejects the old documented shorthand, and that is the point', () => {
    // The header comment used to advertise `site.app/#123`. Three characters
    // cannot be told apart from an anchor or a typo, and the cost of guessing
    // wrong is a silent logout. The Connect page covers this case.
    expect(parseConnHash('#123').secret).toBe(null)
  })

  it('an empty or absent fragment does nothing', () => {
    for (const h of ['', '#', null, undefined]) {
      const r = parseConnHash(h)
      expect(r).toEqual({ url: null, secret: null, ignored: null })
    }
  })

  it('survives a malformed percent-escape without throwing', () => {
    expect(() => parseConnHash('#%E0%A4%A')).not.toThrow()
    expect(parseConnHash('#%E0%A4%A').secret).toBe(null)
  })
})

describe('looksLikeSecret', () => {
  it('admits the two shapes this system actually mints', () => {
    expect(looksLikeSecret('sess_' + '0123456789abcdef')).toBe(true)
    expect(looksLikeSecret('a'.repeat(32))).toBe(true)
    expect(looksLikeSecret('ABCDEF0123456789'.repeat(2))).toBe(true)  // case-insensitive
  })

  it('rejects anchors, words, and short strings', () => {
    for (const v of ['risk-minRR', 'sec-acct-engineering', 'top', '123', '', null, 'sess_short']) {
      expect(looksLikeSecret(v)).toBe(false)
    }
  })

  it('rejects hex that is too short to be a secret', () => {
    expect(looksLikeSecret('abcdef')).toBe(false)
    expect(looksLikeSecret('a'.repeat(31))).toBe(false)
    expect(looksLikeSecret('a'.repeat(32))).toBe(true)
  })
})
