// node --test agent/services/broker-roster.test.js
//
// "Gone from the broker" vs "nobody has checked". Getting these two confused
// is the only way this feature can do harm: it would push the owner to disable
// a live, funded, trading account on the strength of a roster nobody had
// refreshed. So every ambiguity resolves to UNKNOWN, never to MISSING.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  recordBrokerRoster, loadBrokerRoster, brokerRosterStatus,
  accountAtBroker, staleRegistryAccounts, ROSTER_MAX_AGE_MS,
} from './broker-roster.js'

const T0 = Date.UTC(2026, 7, 2, 12, 0, 0)
const acct = (id, o = {}) => ({ account_id: id, trader_login: `L${id}`, is_live: 0, enabled: 0, mode: 'manage_only', ...o })
const brokerList = (...ids) => ids.map(id => ({ accountId: id }))

test('with NO roster recorded, every answer is unknown — never "missing"', () => {
  const db = initDB(':memory:')
  assert.equal(loadBrokerRoster(db), null)
  assert.equal(accountAtBroker(db, '5203012', T0), null)
  const st = brokerRosterStatus(db, T0)
  assert.equal(st.known, false)
  assert.equal(st.fresh, false)
  // And nothing is reported stale, however many rows the registry holds.
  const { stale } = staleRegistryAccounts(db, [acct('5203012'), acct('9999999')], T0)
  assert.deepEqual(stale, [], 'cannot call a row gone without a roster to compare to')
})

test('a recorded roster answers present / absent for the accounts it covers', () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, brokerList('5203012', '5306502'), T0)
  assert.equal(accountAtBroker(db, '5203012', T0), true)
  assert.equal(accountAtBroker(db, '5306502', T0), true)
  assert.equal(accountAtBroker(db, '5268549', T0), false, 'listed accounts exist and this is not among them')
  assert.equal(accountAtBroker(db, null, T0), null)
  assert.equal(accountAtBroker(db, '', T0), null)
})

test('a STALE roster answers unknown again — an old list is not evidence', () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, brokerList('5203012'), T0)
  // Just inside the window it still answers.
  assert.equal(accountAtBroker(db, '5268549', T0 + ROSTER_MAX_AGE_MS - 60_000), false)
  // Past it, the honest answer is "I do not know", not "gone".
  assert.equal(accountAtBroker(db, '5268549', T0 + ROSTER_MAX_AGE_MS + 60_000), null)
  assert.equal(accountAtBroker(db, '5203012', T0 + ROSTER_MAX_AGE_MS + 60_000), null)
  const { stale } = staleRegistryAccounts(db, [acct('5268549')], T0 + ROSTER_MAX_AGE_MS + 60_000)
  assert.deepEqual(stale, [])
})

test('an EMPTY broker list is never recorded', () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, brokerList('5203012'), T0)
  // A token that legitimately sees nothing is indistinguishable from a call
  // that half-failed — and acting on it would flag EVERY account at once.
  assert.equal(recordBrokerRoster(db, [], T0 + 1000), null)
  assert.equal(recordBrokerRoster(db, null, T0 + 2000), null)
  assert.deepEqual(loadBrokerRoster(db).ids, ['5203012'], 'the good roster survives')
})

test('THE INCIDENT: two accounts ticked at the broker, five rows in the registry', () => {
  const db = initDB(':memory:')
  // Owner 02-08-2026: "I select only two account from the CTrader, but still
  // shows 5 in the Tune > Pipeline."
  recordBrokerRoster(db, brokerList('5203012', '5306502'), T0)
  const rows = [
    acct('5203012', { enabled: 1, mode: 'active' }),
    acct('5306502'),
    acct('5067353', { enabled: 1, mode: 'active' }),   // gone AND still trading
    acct('5268549'),                                   // gone, already disabled
    acct('1251247', { is_live: 1 }),                   // gone, live, disabled
  ]
  const { stale, rosterStatus } = staleRegistryAccounts(db, rows, T0)
  assert.equal(rosterStatus.fresh, true)
  assert.deepEqual(stale.map(s => s.accountId), ['5067353', '5268549', '1251247'])
  // ENABLED FIRST — that is the one the loop and the sidecar still target,
  // and the only one where the flag is urgent rather than tidy-up.
  assert.equal(stale[0].accountId, '5067353')
  assert.equal(stale[0].enabled, true)
  assert.equal(stale[1].enabled, false)
  // Identity travels with it so the UI can offer a Disable for a row that has
  // already vanished from every broker-fed surface.
  assert.equal(stale[0].traderLogin, 'L5067353')
  assert.equal(stale[2].isLive, true)
})

test('nothing here mutates the registry — flag only, never act', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode)
              VALUES ('5067353', 'L1', 0, 1, 'active')`).run()
  recordBrokerRoster(db, brokerList('5203012'), T0)
  staleRegistryAccounts(db, [acct('5067353', { enabled: 1 })], T0)
  accountAtBroker(db, '5067353', T0)
  const row = db.prepare("SELECT enabled, mode FROM accounts WHERE account_id = '5067353'").get()
  assert.equal(row.enabled, 1, 'the owner asked to be warned, not overruled')
  assert.equal(row.mode, 'active')
})

test('a malformed roster reads as absent rather than throwing', () => {
  const db = initDB(':memory:')
  db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES ('broker_account_roster_json', '{oops')").run()
  assert.equal(loadBrokerRoster(db), null)
  assert.equal(accountAtBroker(db, '5203012', T0), null)
  assert.deepEqual(staleRegistryAccounts(db, [acct('5203012')], T0).stale, [])
})

test('ids are normalised and de-duplicated', () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, [{ accountId: 5203012 }, { accountId: '5203012' }, { accountId: null }], T0)
  assert.deepEqual(loadBrokerRoster(db).ids, ['5203012'])
  assert.equal(accountAtBroker(db, 5203012, T0), true, 'a numeric id must match its stored string')
})

// ---------------------------------------------------------------------------
// Through the route, because the honesty rule has to survive the wiring too.
// ---------------------------------------------------------------------------
import express from 'express'
import stateRouter from '../routes/state.js'

function server(db) {
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}
const seed = (db, id, enabled = 0, isLive = 0) => db.prepare(
  `INSERT OR REPLACE INTO accounts (account_id, trader_login, is_live, enabled, mode)
   VALUES (?, ?, ?, ?, ?)`).run(id, `L${id}`, isLive, enabled, enabled ? 'active' : 'manage_only')

test('GET /state/accounts reports staleAccounts and per-row atBroker', async () => {
  const db = initDB(':memory:')
  seed(db, '5203012', 1)
  seed(db, '5067353', 1)      // enabled AND gone — the dangerous one
  seed(db, '5268549', 0)      // gone, already disabled
  recordBrokerRoster(db, brokerList('5203012'))
  const s = await server(db)
  try {
    const r = await fetch(s.url('/state/accounts')).then(x => x.json())
    assert.equal(r.brokerRoster.fresh, true)
    assert.deepEqual(r.staleAccounts.map(a => a.accountId), ['5067353', '5268549'])
    assert.equal(r.staleAccounts[0].enabled, true, 'enabled first — that is the urgent one')
    const by = Object.fromEntries(r.accounts.map(a => [String(a.account_id), a.atBroker]))
    assert.equal(by['5203012'], true)
    assert.equal(by['5067353'], false)
  } finally { s.close() }
})

test('GET /state/accounts flags NOTHING when no roster has been recorded', async () => {
  const db = initDB(':memory:')
  seed(db, '5203012', 1)
  seed(db, '5067353', 1)
  const s = await server(db)
  try {
    const r = await fetch(s.url('/state/accounts')).then(x => x.json())
    assert.equal(r.brokerRoster.known, false)
    assert.deepEqual(r.staleAccounts, [], 'a fresh install must not accuse every account of being gone')
    // atBroker is UNKNOWN for every row, which the UI renders as nothing at
    // all — never as a warning.
    for (const a of r.accounts) assert.equal(a.atBroker, null)
  } finally { s.close() }
})
