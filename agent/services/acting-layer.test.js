// node --test agent/services/acting-layer.test.js
//
// The two invariants every stop-moving, position-closing layer must hold:
// one pass at a time, and this account only.
//
// Both were assumed and both were false. These tests are written so that
// re-introducing either defect fails loudly rather than quietly moving money.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  singleFlight, inFlightLayers, __resetInFlight,
  authorisedAccountId, accountFilterSql, scopeToAccount, sameSideAccountIds,
} from './acting-layer.js'

test.beforeEach(() => __resetInFlight())

// ---------------------------------------------------------------------------
// singleFlight
// ---------------------------------------------------------------------------

test('a second caller JOINS the pass in flight — it does not start another', async () => {
  // The defect, exactly: guardian's tick sweep and the fast monitor's 60s band
  // both entered runProfitKeeper, and nothing stopped two passes reading the
  // same position and both deciding to amend it.
  let starts = 0
  let release
  const gate = new Promise(r => { release = r })
  const work = () => { starts++; return gate.then(() => 'result') }

  const a = singleFlight('keeper', work)
  const b = singleFlight('keeper', work)
  assert.equal(starts, 1, 'the work ran once')
  assert.equal(a, b, 'both callers hold the SAME promise, not two equal ones')

  release()
  assert.deepEqual(await Promise.all([a, b]), ['result', 'result'])
})

test('the lock clears when the pass settles, so the next tick runs a fresh one', async () => {
  let starts = 0
  const work = async () => { starts++; return starts }
  assert.equal(await singleFlight('k', work), 1)
  assert.equal(await singleFlight('k', work), 2)
  assert.deepEqual(inFlightLayers(), [])
})

test('a THROWING pass does not lock the layer out forever', async () => {
  // The failure mode that turns a transient broker error into a permanently
  // dead protection layer. The `finally` is why this passes.
  await assert.rejects(singleFlight('k', async () => { throw new Error('broker said no') }), /broker said no/)
  assert.deepEqual(inFlightLayers(), [], 'the lock released on the error path')
  assert.equal(await singleFlight('k', async () => 'recovered'), 'recovered')
})

test('a SYNCHRONOUSLY throwing pass releases the lock too', async () => {
  await assert.rejects(singleFlight('k', () => { throw new Error('bad config') }), /bad config/)
  assert.deepEqual(inFlightLayers(), [])
})

test('different layers do not block each other', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const held = singleFlight('keeper', () => gate)
  assert.equal(await singleFlight('guards', async () => 'ran'), 'ran')
  assert.deepEqual(inFlightLayers(), ['keeper'])
  release('done')
  await held
})

test('the loss cap keys per ACCOUNT, so account 2 is never swallowed by account 1', async () => {
  // runLossCapAllAccounts calls runLossCap once per account, in sequence. A
  // single global key would make every account after the first join the
  // first's pass and never actually be checked.
  const seen = []
  const pass = (id) => singleFlight(`loss_cap:${id}`, async () => { seen.push(id); return id })
  assert.deepEqual(await Promise.all([pass('A'), pass('B'), pass('A')]), ['A', 'B', 'A'])
  assert.deepEqual(seen, ['A', 'B'], 'A ran once, B ran once — neither was skipped')
})

// ---------------------------------------------------------------------------
// account scoping
// ---------------------------------------------------------------------------

test('authorisedAccountId is null only when creds genuinely carry none', () => {
  assert.equal(authorisedAccountId({ accountId: 5203012 }), '5203012')
  assert.equal(authorisedAccountId({ accountId: '5203012' }), '5203012')
  assert.equal(authorisedAccountId({ accountId: null }), null)
  assert.equal(authorisedAccountId({ accountId: '' }), null)
  assert.equal(authorisedAccountId(undefined), null)
})

test('the SQL filter admits unstamped rows and excludes other accounts', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, account_id TEXT);
           INSERT INTO t (account_id) VALUES ('5203012'), ('46130058'), (NULL);`)
  const got = db.prepare(`SELECT id, account_id FROM t WHERE ${accountFilterSql('account_id')}`).all('5203012')
  assert.deepEqual(got.map(r => r.account_id), ['5203012', null],
    'NULL is UNKNOWN ownership, not foreign — excluding it would stop guarding pre-M1a positions')
})

test('a foreign position is refused before it can reach the execution engine', () => {
  // The trade-guard defect. Its query had no account column at all, so a row
  // owned by 46130058 was amended with 5203012's credentials, and withAccount
  // stamped the wrong account onto the broker call.
  const rows = [
    { position_id: '1', account_id: '5203012' },
    { position_id: '2', account_id: '46130058' },
  ]
  const live = new Map([['1', {}], ['2', {}]])
  const { owned, foreign } = scopeToAccount(rows, { accountId: '5203012', live })
  assert.deepEqual(owned.map(r => r.position_id), ['1'])
  assert.deepEqual(foreign.map(r => r.position_id), ['2'])
})

test('the BROKER gate is required — a ledger claim alone is not ownership', () => {
  // A stale ledger row for a position closed elsewhere would otherwise be
  // amended against a position id the account no longer holds.
  const rows = [{ position_id: '9', account_id: '5203012' }]
  const { owned, unknown } = scopeToAccount(rows, { accountId: '5203012', live: new Map() })
  assert.deepEqual(owned, [])
  assert.deepEqual(unknown.map(r => r.position_id), ['9'])
})

test('a caller with NO reconcile gets nothing — not everything', () => {
  // Fail closed. A pass without broker truth cannot know whose position it is
  // holding, which is precisely the state trade-guard ran in.
  const rows = [{ position_id: '1', account_id: '5203012' }]
  const { owned, unknown } = scopeToAccount(rows, { accountId: '5203012' })
  assert.deepEqual(owned, [])
  assert.equal(unknown.length, 1)
})

test('an unstamped row the broker confirms IS ours', () => {
  const rows = [{ position_id: '1', account_id: null }]
  const live = new Map([['1', {}]])
  assert.equal(scopeToAccount(rows, { accountId: '5203012', live }).owned.length, 1)
})

test('numeric and string account ids compare equal', () => {
  const live = new Map([['1', {}]])
  const owned = scopeToAccount([{ position_id: 1, account_id: 5203012 }], { accountId: '5203012', live }).owned
  assert.equal(owned.length, 1, 'a type mismatch must not read as a foreign account')
})

test('creds with no account id fall back to the broker gate alone', () => {
  const rows = [{ position_id: '1', account_id: '46130058' }]
  const live = new Map([['1', {}]])
  assert.equal(scopeToAccount(rows, { accountId: null, live }).owned.length, 1,
    'with no authorised account there is nothing to contradict; reconcile decides')
})

// ---------------------------------------------------------------------------
// same-side roster
// ---------------------------------------------------------------------------

function rosterDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE accounts (account_id TEXT PRIMARY KEY, is_live INTEGER, enabled INTEGER);
           INSERT INTO accounts VALUES ('42993489',1,1), ('5203012',0,1), ('46130058',0,1), ('5067353',0,0);`)
  return db
}

test('the roster never crosses the live/demo line', () => {
  // profit-ratchet walked every enabled row with one credential set. A demo
  // token cannot read a live account, so each off-side account produced an
  // authorisation error rather than a staircase.
  const db = rosterDb()
  assert.deepEqual(sameSideAccountIds(db, { accountId: '5203012', isLive: false }).sort(),
    ['46130058', '5203012'])
  assert.deepEqual(sameSideAccountIds(db, { accountId: '42993489', isLive: true }),
    ['42993489'])
})

test('disabled accounts are not swept, and the selected account always leads', () => {
  const db = rosterDb()
  const ids = sameSideAccountIds(db, { accountId: '46130058', isLive: false })
  assert.equal(ids[0], '46130058', 'the account the operator is looking at goes first')
  assert.equal(ids.includes('5067353'), false, 'disabled')
})

test('a missing registry still sweeps the selected account', () => {
  // A registry gap must never silently drop the account in front of the
  // operator — that is a protection regression wearing a config bug's clothes.
  const db = new Database(':memory:')
  assert.deepEqual(sameSideAccountIds(db, { accountId: '5203012', isLive: false }), ['5203012'])
})

// ---------------------------------------------------------------------------
// the layers actually use it
// ---------------------------------------------------------------------------

const SERVICES = new URL('./', import.meta.url)
const src = (f) => readFileSync(new URL(f, SERVICES), 'utf8')

test('EVERY acting layer runs under single-flight', () => {
  for (const [file, key] of [
    ['trade-guard.js', 'trade_guards'],
    ['profit-keeper.js', 'profit_keeper'],
    ['loss-guardian.js', 'loss_guardian'],
    ['profit-ratchet.js', 'profit_ratchet'],
    ['loss-cap.js', 'loss_cap'],
  ]) {
    assert.match(src(file), new RegExp(`singleFlight\\(\`?'?${key}`), `${file} must wrap its pass in singleFlight`)
  }
})

test('EVERY acting layer scopes its query to the authorised account', () => {
  for (const f of ['trade-guard.js', 'profit-keeper.js', 'loss-guardian.js', 'loss-cap.js']) {
    assert.ok(src(f).includes('accountFilterSql('), `${f} must filter its query by account`)
  }
})

test('EVERY layer that amends or closes checks the position against the broker', () => {
  // profit-ratchet is exempt by construction: it acts on ACCOUNT equity and
  // closes only rows it selected with an explicit `m.account_id = ?`.
  for (const f of ['trade-guard.js', 'profit-keeper.js', 'loss-guardian.js']) {
    const s = src(f)
    assert.ok(s.includes('exec.reconcile('), `${f} must obtain broker truth`)
    assert.ok(s.includes('scopeToAccount('), `${f} must gate rows on it`)
  }
})

test('no acting layer writes to the broker outside a scoped pass', () => {
  // A blunt but effective tripwire: any NEW service that calls amendPosition
  // or closePosition must be added here deliberately, with a note saying why
  // it does not need scoping. Silence is how trade-guard went unnoticed.
  const EXEMPT = new Set([
    'position-protect.js',   // one position by id, operator-supplied, §41 level 7
    'weekend-bank.js',       // loop reconcile phase, per-account creds
    'acting-layer.test.js',
  ])
  const offenders = []
  for (const f of readdirSync(SERVICES)) {
    if (!f.endsWith('.js') || f.endsWith('.test.js') || EXEMPT.has(f)) continue
    const s = src(f)
    if (!/exec\.(amendPosition|closePosition)\(/.test(s)) continue
    if (!s.includes('singleFlight(')) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    `these write to a position without a single-flight pass: ${offenders.join(', ')}`)
})
