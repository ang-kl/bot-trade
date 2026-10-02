// node --test agent/services/scanner-alignment-snapshot.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { comparisonRecord } from './scanner-comparison.js'
import { buildScannerAlignmentSnapshot, declaredUniverse, observedTickFeeds } from './scanner-alignment-snapshot.js'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const ENV = { SCANNER_TIMEFRAME_URL: 'http://tf.invalid', SCANNER_TIMEFRAME_SECRET: 's' }
const watchdog = (over = {}) => ({ schemaVersion: 1, service: 'cpp-scan-timeframe', observedAtMs: NOW - 1000, workComplete: true,
  work: [], cells: { count: 690, capacity: 1024, stale: 12 }, ...over })
const fetchOf = body => async () => new Response(JSON.stringify(body), { status: 200 })

function fixture() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 0, 1, ?)').run('101', 'active')
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 1, 1, ?)').run('202', 'active')
  setState(db, 'ctrader_account_id', '101')
  setState(db, 'symbol_id_map:101', JSON.stringify({ accountId: '101', builtAt: '2026-10-02T08:00:00.000Z', map: { EURUSD: 1 } }))
  setState(db, 'symbol_id_map:202', JSON.stringify({ accountId: '202', builtAt: '2026-10-02T08:00:00.000Z', map: { EURUSD: 9 } }))
  comparisonRecord(db, 'a', 'cpp-scan-tick', 'candidate', { feed: { accountId: '101', host: 'demo.ctraderapi.com', symbolId: '1' }, profileHash: 'h1' }, NOW - 5000)
  comparisonRecord(db, 'b', 'cpp-scan-tick', 'candidate', { feed: { accountId: '202', host: 'live.ctraderapi.com', symbolId: '9' }, profileHash: 'h2' }, NOW - 400_000)
  return db
}
const stateRows = db => JSON.stringify(db.prepare('SELECT key, value FROM agent_state ORDER BY key').all())

test('the snapshot carries every part the builder reads, fresh, and the registry digest is the revision', async () => {
  const db = fixture()
  const snap = await buildScannerAlignmentSnapshot(db, { now: NOW, env: ENV, fetchImpl: fetchOf(watchdog()) })
  assert.equal(snap.selected, '101')
  assert.deepEqual(snap.accounts.map(a => a.account_id), ['101', '202'])
  assert.equal(snap.maps['101'].accountId, '101')
  assert.equal(snap.maps['101'].builtAt, '2026-10-02T08:00:00.000Z')
  assert.equal(snap.revision.length, 64)
  assert.deepEqual(snap.nativeTimeframe, { observedAt: new Date(NOW - 1000).toISOString(), cells: { count: 690, capacity: 1024, stale: 12 }, pending: 0 })
  assert.equal(snap.universe.length, 56)
  assert.equal(snap.orderAuthority, false)
  // only the feed seen inside five minutes is reported, with its profile hash
  assert.deepEqual(snap.tickFeeds, [{ accountId: '101', host: 'demo.ctraderapi.com', profileHash: 'h1', observedAt: new Date(NOW - 5000).toISOString() }])
})

test('what cannot be read is null and named, never defaulted', async () => {
  const db = fixture()
  setState(db, 'symbol_id_map:202', null)
  const down = async () => { throw new Error('boom') }
  const snap = await buildScannerAlignmentSnapshot(db, { now: NOW, env: ENV, fetchImpl: down })
  assert.equal(snap.nativeTimeframe, null)
  assert.ok(snap.missing.some(m => m.startsWith('timeframe_watchdog_unreadable')))
  assert.ok(snap.missing.includes('map_missing:' + '202'.slice(-4)))
  const incomplete = await buildScannerAlignmentSnapshot(db, { now: NOW, env: ENV, fetchImpl: fetchOf(watchdog({ workComplete: false })) })
  assert.equal(incomplete.nativeTimeframe, null)
  assert.ok(incomplete.missing.includes('timeframe_watchdog_incomplete'))
  const none = await buildScannerAlignmentSnapshot(db, { now: NOW, env: {}, fetchImpl: down })
  assert.ok(none.missing.includes('timeframe_scanner_not_configured'))
  assert.deepEqual(observedTickFeeds(db, NOW + 3_600_000), [])
})

test('pending native work is summed so the builder can refuse an apply while it drains', async () => {
  const db = fixture()
  const snap = await buildScannerAlignmentSnapshot(db, { now: NOW, env: ENV, fetchImpl: fetchOf(watchdog({ work: [{ pending: 2 }, { pending: 3 }] })) })
  assert.equal(snap.nativeTimeframe.pending, 5)
})

test('building the snapshot writes nothing', async () => {
  const db = fixture()
  const before = stateRows(db), trades = db.prepare('SELECT COUNT(*) n FROM trades').get().n
  await buildScannerAlignmentSnapshot(db, { now: NOW, env: ENV, fetchImpl: fetchOf(watchdog()) })
  assert.equal(stateRows(db), before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, trades)
})

test('the declared universe is the 56 names of the momentum universe', () => {
  const u = declaredUniverse()
  assert.equal(new Set(u).size, 56)
})

test('the route is wired and never cached', () => {
  const src = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(src, /router\.get\('\/scanner-alignment-snapshot'/)
  assert.match(src, /NO_CACHE = new Set\(\['\/scanner-alignment-snapshot'/)
  assert.match(src, /buildScannerAlignmentSnapshot\(db\)/)
})
