import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { readAccountSnapshot } from './account-snapshot.js'

const NOW = Date.parse('2026-09-22T04:00:00.000Z')
const options = { nowMs: NOW, maxAgeMs: 60_000 }
const fixture = (patch = {}) => ({
  fetchedAt: new Date(NOW - 1000).toISOString(),
  account: { accountId: '22', currency: 'USD', health: { balance: 0, usedMargin: 0 } },
  ...patch,
})

function database(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  return db
}

test('reads only the matching account cache and retains a real zero balance', t => {
  const db = database(t)
  setState(db, 'broker_snapshot_cache_json', JSON.stringify(fixture({ account: { accountId: '11', balance: 9000 } })))
  assert.equal(readAccountSnapshot(db, '22', options).reason, 'snapshot_missing')
  const own = fixture()
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(own))
  const actual = readAccountSnapshot(db, 22, { ...options, expectedCurrency: 'USD' })
  assert.equal(actual.status, 'fresh')
  assert.equal(actual.ageMs, 1000)
  assert.deepEqual(actual.snapshot, own)
})

test('a foreign payload under the correct cache key is not returned', t => {
  const db = database(t)
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(fixture({ account: { accountId: '11', currency: 'EUR' } })))
  const actual = readAccountSnapshot(db, '22', options)
  assert.equal(actual.reason, 'account_mismatch')
  assert.equal(actual.snapshot, null)
  assert.equal(actual.currency, null)
})

test('malformed cache and absent account identity remain unavailable', t => {
  const db = database(t)
  for (const raw of ['{', 'null', '[]', '{}', '{"account":[]}']) {
    setState(db, 'acct:22:broker_snapshot_cache_json', raw)
    assert.equal(readAccountSnapshot(db, '22', options).reason, 'snapshot_malformed', raw)
  }
  for (const id of [null, '', 'all', '22:other', '022']) {
    assert.equal(readAccountSnapshot(db, id, options).reason, 'account_required')
  }
})

test('age boundary, future timestamps and missing timezone cannot report fresh', t => {
  const db = database(t)
  for (const [stamp, reason] of [
    [new Date(NOW - 60_000).toISOString(), 'snapshot_stale'],
    [new Date(NOW + 1).toISOString(), 'snapshot_time_future'],
    ['2026-09-22 03:59:00', 'snapshot_time_invalid'],
    ['not a date', 'snapshot_time_invalid'],
    [null, 'snapshot_time_invalid'],
  ]) {
    setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(fixture({ fetchedAt: stamp })))
    const actual = readAccountSnapshot(db, '22', options)
    assert.equal(actual.reason, reason)
    assert.equal(actual.snapshot, null)
  }
})

test('currency is preserved; an explicit USD consumer cannot use EUR or unknown units', t => {
  const db = database(t)
  for (const currency of ['EUR', null]) {
    setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(fixture({ account: { accountId: '22', currency } })))
    assert.equal(readAccountSnapshot(db, '22', options).currency, currency)
    const actual = readAccountSnapshot(db, '22', { ...options, expectedCurrency: 'USD' })
    assert.equal(actual.reason, currency ? 'currency_mismatch' : 'currency_unknown')
    assert.equal(actual.snapshot, null)
  }
})

test('a stamped account error is not a successful snapshot', t => {
  const db = database(t)
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify(fixture({ account: { accountId: '22', currency: 'USD', error: 'broker timeout' } })))
  assert.equal(readAccountSnapshot(db, '22', options).reason, 'snapshot_error')
  assert.equal(readAccountSnapshot(db, '22', { ...options, maxAgeMs: Infinity }).reason, 'invalid_freshness_policy')
})
