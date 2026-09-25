// V3 WEB-9b: the bar receipts survive a restart as what they are — receipts
// made by the PREVIOUS process, with their own times — and are written only
// when something new was recorded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { noteBarReceipt, feedReceiptsSnapshot, _resetFeedReceiptsForTests } from '../lib/feed-receipts.js'
import { persistFeedReceipts, startFeedReceiptsRecord, storedFeedReceipts, _stopFeedReceiptsRecordForTests, FEED_RECEIPTS_KEY } from './feed-receipts-record.js'

const T0 = Date.parse('2026-09-25T12:00:30Z')
const bar = (t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 })

test('persist writes only after a new receipt; a restart seeds the record, marked as before the restart', t => {
  const db = initDB(':memory:'); t.after(() => { _stopFeedReceiptsRecordForTests(); db.close() })
  _stopFeedReceiptsRecordForTests()
  _resetFeedReceiptsForTests(T0 - 1000)
  assert.deepEqual(startFeedReceiptsRecord(db, { everyMs: 3_600_000 }), { seeded: 0 })
  assert.equal(persistFeedReceipts(db, T0), false, 'nothing recorded, nothing written')
  assert.equal(getState(db, FEED_RECEIPTS_KEY), null)

  noteBarReceipt({ timeframe: '1h', periodMs: 3_600_000, bars: [bar(T0 - 30_000)], receivedAtMs: T0, accountId: '46130058', host: 'demo.ctraderapi.com', source: 'strategy_scan' })
  assert.equal(persistFeedReceipts(db, T0 + 1), true)
  assert.equal(persistFeedReceipts(db, T0 + 2), false, 'unchanged since the last write')
  const stored = storedFeedReceipts(db)
  assert.equal(stored.v, 1)
  assert.equal(stored.timeframes[0].sources[0].receivedAtMs, T0)

  // A restart: new process state, the same database.
  _stopFeedReceiptsRecordForTests()
  _resetFeedReceiptsForTests(T0 + 3_600_000)
  assert.deepEqual(startFeedReceiptsRecord(db, { everyMs: 3_600_000 }), { seeded: 1 })
  assert.equal(startFeedReceiptsRecord(db), false, 'idempotent')
  const [row] = feedReceiptsSnapshot(T0 + 3_600_000 + 5_000).bars.timeframes
  assert.equal(row.timeframe, '1h')
  assert.equal(row.lastReceivedAtMs, T0, 'the receipt keeps its own time — its age is an hour, not zero')
  assert.equal(row.ageMs, 3_600_000 + 5_000)
  assert.equal(row.fromPreviousProcess, true)
  assert.equal(row.receipts, 0)
  assert.equal(persistFeedReceipts(db, T0 + 3_600_000 + 6_000), false, 'seeding alone is not written back')
})
