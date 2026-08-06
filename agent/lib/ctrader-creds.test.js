// node --test agent/lib/ctrader-creds.test.js
//
// M2: getCtraderCreds carries the registry's enabled-account roster
// (accountIds) so the sidecar pre-authorizes every enabled account on one
// session — restricted to the creds' own live/demo side, primary first.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { getCtraderCreds } from './ctrader-creds.js'
import { upsertAccount, syncSelectedAccount } from '../services/account-registry.js'
import { sameSideAccountIds, credsAreLive } from '../services/acting-layer.js'

function fresh() {
  process.env.CTRADER_CLIENT_ID = 'ci'
  process.env.CTRADER_CLIENT_SECRET = 'cs'
  const db = initDB(':memory:')
  setState(db, 'ctrader_access_token', 'tok')
  setState(db, 'ctrader_account_id', '100')
  setState(db, 'ctrader_is_live', 'false')
  return db
}

test('roster: primary first, other enabled same-side accounts follow, other side excluded', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)                       // demo, enabled primary
  upsertAccount(db, { accountId: '200', isLive: false })      // demo, disabled → excluded
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '200'`).run()
  upsertAccount(db, { accountId: '900', isLive: true })       // live → excluded (wrong side)
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '900'`).run()

  const creds = getCtraderCreds(db)
  assert.equal(creds.accountId, '100')
  assert.deepEqual(creds.accountIds, ['100', '200'])
  assert.equal(creds.ready, true)
})

test('roster: single enabled account degrades to a one-entry roster (legacy shape)', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)
  const creds = getCtraderCreds(db)
  assert.deepEqual(creds.accountIds, ['100'])
})

test('roster: accountOverride flips the side filter and leads the roster', () => {
  const db = fresh()
  syncSelectedAccount(db, '100', false)
  upsertAccount(db, { accountId: '900', isLive: true })
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '900'`).run()

  const creds = getCtraderCreds(db, { accountId: '900', isLive: true })
  assert.equal(creds.host, 'live.ctraderapi.com')
  assert.deepEqual(creds.accountIds, ['900'], 'demo accounts must not ride a live session')
})

test('roster: empty registry leaves accountIds as the primary only', () => {
  const db = fresh() // no registry rows at all
  const creds = getCtraderCreds(db)
  assert.deepEqual(creds.accountIds, ['100'])
})

// ---------------------------------------------------------------------------
// F-RISK-01 (Algorithmic Decision Integrity audit, 2026-08-06).
//
// `isLive` was COMPUTED here, used to pick the host and to filter the roster,
// and then dropped from the returned object. `sameSideAccountIds` reads it, so
// it evaluated `!!undefined === false` on EVERY call and selected the demo side
// unconditionally.
//
// The demo half of that is noise — a live token fails against a demo account.
// The half that matters is the other direction: with live credentials, a SECOND
// live account is not in the returned set, so `loss-cap` and `profit-ratchet`
// never sweep it. No loss cap, no ratchet, and nothing says so. Only one live
// account is enabled today, which is the sole reason this had not yet cost
// anything.
//
// Proved by execution against the real modules before the fix.
// ---------------------------------------------------------------------------
test('F-RISK-01: getCtraderCreds returns the side it computed, and the sweep selects it', () => {
  const db = fresh()
  syncSelectedAccount(db, '900', true)                        // live primary
  upsertAccount(db, { accountId: '901', isLive: true })        // second LIVE account
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '901'`).run()
  upsertAccount(db, { accountId: '100', isLive: false })
  upsertAccount(db, { accountId: '101', isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 0 WHERE account_id IN ('100','101')`).run()
  setState(db, 'ctrader_is_live', 'true')
  setState(db, 'ctrader_account_id', '900')

  const creds = getCtraderCreds(db)
  assert.equal(creds.host, 'live.ctraderapi.com')
  // The field itself. Before the fix this was `undefined`, and `!!undefined`
  // is a perfectly valid boolean — which is exactly why nothing failed.
  assert.equal(creds.isLive, true, 'getCtraderCreds must return the side it computed')

  const ids = sameSideAccountIds(db, creds)
  assert.ok(ids.includes('900'), 'the selected account is always included')
  assert.ok(ids.includes('901'), 'THE DEFECT: a second LIVE account was dropped from the sweep entirely')
  assert.ok(!ids.includes('100') && !ids.includes('101'),
    'demo accounts must never be swept with live credentials')
})

test('F-RISK-01: the side is read from the HOST, so hand-assembled creds are right too', () => {
  // loop.js:324, :493, :1387, :2137, :3824 and :3885 all build creds as
  // `{ host: isLive ? live : demo, … }` with no `isLive` field at all. Reading
  // the flag would silently mis-scope every one of them; reading the host does
  // not. A wrong host fails loudly at connect — a wrong flag fails silently.
  const db = fresh()
  syncSelectedAccount(db, '900', true)
  upsertAccount(db, { accountId: '901', isLive: true })
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 1 WHERE account_id = '901'`).run()
  upsertAccount(db, { accountId: '100', isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1, is_live = 0 WHERE account_id = '100'`).run()

  const handAssembled = { host: 'live.ctraderapi.com', accountId: '900' } // no isLive
  assert.equal(credsAreLive(handAssembled), true)
  const ids = sameSideAccountIds(db, handAssembled)
  assert.deepEqual(ids.sort(), ['900', '901'])

  assert.equal(credsAreLive({ host: 'demo.ctraderapi.com' }), false)
  assert.equal(credsAreLive({ host: 'LIVE.CtraderAPI.com' }), true, 'host match is case-insensitive')
  // Unknown or absent host: fall back to the flag rather than guessing a side.
  assert.equal(credsAreLive({ isLive: true }), true)
  assert.equal(credsAreLive({ host: 'weird.example', isLive: true }), true)
  assert.equal(credsAreLive({}), false)
  assert.equal(credsAreLive(null), false)
})
