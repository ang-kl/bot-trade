// node --test agent/services/broker-roster-refresh.test.js
// Claude · № 12,280 08-Oct (ordered "all three" after № 12,279; claude-builder).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { loadBrokerRoster, recordBrokerRoster } from './broker-roster.js'
import { refreshBrokerRosterIfStale, ROSTER_REFRESH_AFTER_MS, ROSTER_RETRY_AFTER_MS, ROSTER_ATTEMPT_KEY } from './broker-roster-refresh.js'

const T0 = Date.UTC(2026, 9, 8, 14, 0, 0)
const creds = { accessToken: 'tok', clientId: 'cid', clientSecret: 'sec' }
const listing = ids => async () => ({ ctidTraderAccount: ids.map(id => ({ ctidTraderAccountId: Number(id), isLive: false })) })

test('a fresh roster is left alone: no listing is made', async () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, [{ accountId: '1' }], T0 - ROSTER_REFRESH_AFTER_MS + 1000)
  let calls = 0
  const r = await refreshBrokerRosterIfStale(db, { now: T0, ...creds, listAccounts: async () => { calls++; return {} } })
  assert.equal(r.state, 'fresh')
  assert.equal(calls, 0)
})

test('a stale or absent roster is listed by the token and recorded through the same writer the page uses', async () => {
  const db = initDB(':memory:')
  let r = await refreshBrokerRosterIfStale(db, { now: T0, ...creds, listAccounts: listing(['42993489', '47790949']) })
  assert.equal(r.state, 'refreshed'); assert.equal(r.count, 2)
  assert.deepEqual(loadBrokerRoster(db).ids, ['42993489', '47790949'])
  assert.equal(loadBrokerRoster(db).at, new Date(T0).toISOString())
  // Older than the refresh age: listed again, with the host and token the page uses.
  const later = T0 + ROSTER_REFRESH_AFTER_MS + 1
  const seen = []
  r = await refreshBrokerRosterIfStale(db, { now: later, ...creds, listAccounts: async (host, cid, sec, tok) => { seen.push([host, cid, sec, tok]); return (await listing(['42993489'])()) } })
  assert.equal(r.state, 'refreshed')
  assert.deepEqual(seen, [['demo.ctraderapi.com', 'cid', 'sec', 'tok']])
  assert.deepEqual(loadBrokerRoster(db).ids, ['42993489'])
})

test('an empty listing is never recorded, and a failed one is paced before it is retried', async () => {
  const db = initDB(':memory:')
  recordBrokerRoster(db, [{ accountId: '1' }], T0 - 2 * ROSTER_REFRESH_AFTER_MS)
  let r = await refreshBrokerRosterIfStale(db, { now: T0, ...creds, listAccounts: listing([]) })
  assert.equal(r.state, 'empty')
  assert.deepEqual(loadBrokerRoster(db).ids, ['1'], 'the old record stays; an empty list is not evidence')
  // Paced: the attempt is on record, so the next cycle does not list again.
  let calls = 0
  r = await refreshBrokerRosterIfStale(db, { now: T0 + 1000, ...creds, listAccounts: async () => { calls++; return {} } })
  assert.equal(r.state, 'paced'); assert.equal(calls, 0)
  assert.equal(getState(db, ROSTER_ATTEMPT_KEY), String(T0))
  // After the retry window a failure is reported, not thrown, and paced again.
  r = await refreshBrokerRosterIfStale(db, { now: T0 + ROSTER_RETRY_AFTER_MS, ...creds, listAccounts: async () => { throw new Error('broker down') } })
  assert.equal(r.state, 'failed'); assert.match(r.error, /broker down/)
  r = await refreshBrokerRosterIfStale(db, { now: T0 + ROSTER_RETRY_AFTER_MS + 1, ...creds, listAccounts: async () => { calls++; return {} } })
  assert.equal(r.state, 'paced'); assert.equal(calls, 0)
})

test('without a token or client the refresher says so and lists nothing', async () => {
  const db = initDB(':memory:')
  let calls = 0
  const r = await refreshBrokerRosterIfStale(db, { now: T0, clientId: 'cid', clientSecret: 'sec', listAccounts: async () => { calls++; return {} } })
  assert.equal(r.state, 'no_credentials'); assert.equal(calls, 0)
  assert.equal(getState(db, ROSTER_ATTEMPT_KEY), null)
})
