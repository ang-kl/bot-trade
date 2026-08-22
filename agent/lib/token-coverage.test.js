// node --test agent/lib/token-coverage.test.js
//
// THE MEASUREMENT THIS EXISTS FOR. Deploy log, 2026-08-22:
//
//   09:23:55  [actions] ctrader token stored — 7 account(s) available
//   09:24:40  [actions] ctrader token stored — 2 account(s) available
//
// Two OAuth links a minute apart; the narrower one won. Everything the second
// token could not reach then failed CH_ACCESS_TOKEN_INVALID for the rest of the
// day, and the only complaint in the log was a count nobody had a baseline for.

import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenCoverage, describeCoverage } from './token-coverage.js'

const enabled = [{ account_id: '46130058' }, { account_id: '43097342' },
  { account_id: '46979908' }, { account_id: '47790949' }]

test('THE PRODUCTION CASE: a 2-account token against a 4-account registry', () => {
  // The exact roster from the log — the sidecar held [46130058, 47790949]
  // while the registry enabled four.
  const cov = tokenCoverage([{ ctidTraderAccountId: 46130058 }, { ctidTraderAccountId: 47790949 }], enabled)
  assert.equal(cov.ok, false)
  assert.deepEqual(cov.missing, ['43097342', '46979908'])
  assert.deepEqual(cov.covered, ['46130058', '47790949'])
  const said = describeCoverage(cov)
  assert.match(said, /43097342/)
  assert.match(said, /46979908/)
  assert.match(said, /CH_ACCESS_TOKEN_INVALID/)
})

test('full coverage says NOTHING — a warning on the happy path stops being read', () => {
  const cov = tokenCoverage(enabled.map(r => ({ ctidTraderAccountId: r.account_id })), enabled)
  assert.equal(cov.ok, true)
  assert.deepEqual(cov.missing, [])
  assert.equal(describeCoverage(cov), null)
})

test('ids compare as strings — the broker sends numbers, the registry stores text', () => {
  // A number/string mismatch here would report every account missing on a
  // perfectly good token, which is worse than the silence it replaces.
  const cov = tokenCoverage([{ ctidTraderAccountId: 46130058 }], [{ account_id: '46130058' }])
  assert.equal(cov.ok, true)
})

test('several id spellings and bare ids are all accepted', () => {
  for (const acct of [{ accountId: '7' }, { account_id: '7' }, { ctidTraderAccountId: 7 }, '7', 7]) {
    assert.equal(tokenCoverage([acct], [{ account_id: '7' }]).ok, true, JSON.stringify(acct))
  }
})

test('a token covering accounts we do not run is reported as extra, not missing', () => {
  const cov = tokenCoverage([{ ctidTraderAccountId: '1' }, { ctidTraderAccountId: '9' }], [{ account_id: '1' }])
  assert.equal(cov.ok, true)
  assert.deepEqual(cov.extra, ['9'])
})

test('an EMPTY registry cannot be under-covered', () => {
  // Nothing is enabled yet — the first-ever link. Warning here would fire on
  // every clean setup.
  const cov = tokenCoverage([{ ctidTraderAccountId: '1' }], [])
  assert.equal(cov.ok, true)
  assert.equal(describeCoverage(cov), null)
})

test('a token that lists NOTHING reports every enabled account, not silence', () => {
  const cov = tokenCoverage([], enabled)
  assert.equal(cov.missing.length, 4)
  assert.match(describeCoverage(cov), /4 enabled account/)
})

test('junk inputs do not throw', () => {
  for (const [a, b] of [[null, null], [undefined, enabled], [[null, undefined], enabled]]) {
    assert.doesNotThrow(() => tokenCoverage(a, b))
  }
  assert.equal(describeCoverage(null), null)
})
