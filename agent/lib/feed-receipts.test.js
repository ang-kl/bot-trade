// V3 WEB-9b (8,989-A row 11, second half): what the agent RECEIVED from the
// broker's market feed — per-timeframe bar receipts and the broker-stamped
// spot latency. These are the figures the Data-feed card's chips and latency
// line print, so each rule here is one that would otherwise print a fake.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  noteBarReceipt, noteSpotStamp, feedReceiptsSnapshot, feedReceiptsForStore, hydrateFeedReceipts,
  _resetFeedReceiptsForTests, FEED_LATENCY_WINDOW_MS, FEED_LATENCY_RANGE_MS, MAX_SPOT_EVENTS,
} from './feed-receipts.js'

const T0 = Date.parse('2026-09-25T12:00:30Z')
const H = 3_600_000
const bar = (t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 })

test('a bar receipt is stamped per timeframe with the newest bar and whether it was still forming', () => {
  _resetFeedReceiptsForTests(T0 - 60_000)
  // 1h: newest bar opened 12:00, received 12:00:30 → still forming.
  assert.equal(noteBarReceipt({ timeframe: '1h', periodMs: H, bars: [bar(T0 - 30_000 - H), bar(T0 - 30_000)], receivedAtMs: T0, symbolId: 1, accountId: '46130058', host: 'demo.ctraderapi.com', source: 'strategy_scan' }), true)
  // 1d: newest bar opened the PREVIOUS broker day (23-09 21:00Z) → closed at receipt.
  const prevDay = Date.parse('2026-09-23T21:00:00Z')
  noteBarReceipt({ timeframe: '1d', periodMs: 24 * H, bars: [bar(prevDay - 24 * H), bar(prevDay)], receivedAtMs: T0, symbolId: 2, accountId: '46130058', source: 'daily_bar' })

  const snap = feedReceiptsSnapshot(T0 + 5_000)
  const [h1, d1] = snap.bars.timeframes
  assert.deepEqual(snap.bars.timeframes.map(r => r.timeframe), ['1h', '1d'], 'shortest period first')
  assert.equal(h1.lastReceivedAtMs, T0)
  assert.equal(h1.ageMs, 5_000)
  assert.equal(h1.newestBarOpenMs, T0 - 30_000)
  assert.equal(h1.newestBarForming, true)
  assert.equal(h1.source, 'strategy_scan')
  assert.equal(h1.accountId, '46130058')
  assert.equal(h1.bars, 2)
  assert.equal(d1.newestBarForming, false, 'a day-old D1 bar is recorded as closed at receipt, not as the forming bar')
  assert.equal(d1.newestBarOpenMs, prevDay)
  assert.equal(snap.bars.sinceMs, T0 - 60_000)
})

test('each reader keeps its own receipt; the chip age is the latest of any reader', () => {
  _resetFeedReceiptsForTests(T0)
  noteBarReceipt({ timeframe: '15m', periodMs: 900_000, bars: [bar(T0 - 30_000)], receivedAtMs: T0, source: 'strategy_scan' })
  noteBarReceipt({ timeframe: '15m', periodMs: 900_000, bars: [bar(T0 - 30_000)], receivedAtMs: T0 + 40_000 }) // unnamed caller
  const [r] = feedReceiptsSnapshot(T0 + 50_000).bars.timeframes
  assert.equal(r.lastReceivedAtMs, T0 + 40_000)
  assert.equal(r.source, 'other', 'an unnamed caller is recorded as other, never as the scan')
  assert.deepEqual(r.sources.map(s => [s.source, s.receivedAtMs]), [['other', T0 + 40_000], ['strategy_scan', T0]])
  assert.equal(r.receipts, 2)
})

test('an empty answer is counted, not stamped as a received bar', () => {
  _resetFeedReceiptsForTests(T0)
  assert.equal(noteBarReceipt({ timeframe: '4h', periodMs: 4 * H, bars: [], receivedAtMs: T0, source: 'strategy_scan' }), false)
  const [r] = feedReceiptsSnapshot(T0).bars.timeframes
  assert.equal(r.lastReceivedAtMs, null)
  assert.equal(r.emptyResponses, 1)
  assert.equal(r.lastEmptyAtMs, T0)
})

test('bad input records nothing and never throws', () => {
  _resetFeedReceiptsForTests(T0)
  assert.equal(noteBarReceipt({ timeframe: 'x', bars: [bar(T0)] }), false)
  assert.equal(noteBarReceipt({ timeframe: '1h', bars: null }), false)
  assert.equal(noteBarReceipt({ timeframe: '1h', bars: [bar(T0)], receivedAtMs: NaN }), false)
  assert.equal(noteBarReceipt(), false)
  assert.equal(noteBarReceipt({ timeframe: '1h', bars: [bar(T0)], receivedAtMs: T0, source: 'Not A Label!' }), true)
  assert.equal(feedReceiptsSnapshot(T0).bars.timeframes[0].source, 'other')
})

test('feed latency: receipt minus broker stamp, per host; the subscription snapshot is not a sample', () => {
  _resetFeedReceiptsForTests(T0)
  const host = 'live.ctraderapi.com'
  // The snapshot: an old market-close quote, 3 hours stale. Counted, not measured.
  assert.equal(noteSpotStamp({ brokerAtMs: T0 - 3 * H, receivedAtMs: T0, host, accountId: '9', symbolId: 1, snapshot: true }), 'snapshot')
  for (const [i, lat] of [120, 80, 100, 400, 90].entries()) {
    assert.equal(noteSpotStamp({ brokerAtMs: T0 + i * 1000 - lat, receivedAtMs: T0 + i * 1000, host, accountId: '9', symbolId: 1 }), 'measured')
  }
  assert.equal(noteSpotStamp({ brokerAtMs: null, receivedAtMs: T0 + 6000, host, symbolId: 1 }), 'unstamped')
  assert.equal(noteSpotStamp({ brokerAtMs: T0 + 7000 - FEED_LATENCY_RANGE_MS - 1, receivedAtMs: T0 + 7000, host, symbolId: 1 }), 'out_of_range')
  noteSpotStamp({ brokerAtMs: T0 + 8000 - 30, receivedAtMs: T0 + 8000, host: 'demo.ctraderapi.com', symbolId: 2 })

  const fl = feedReceiptsSnapshot(T0 + 10_000).feedLatency
  assert.equal(fl.status, 'measured')
  const live = fl.byHost.find(h => h.host === host)
  assert.equal(live.events, 5, 'the snapshot, the unstamped and the out-of-range events are not samples')
  assert.equal(live.p50Ms, 100)
  assert.equal(live.p90Ms, 400)
  assert.equal(live.maxMs, 400)
  assert.equal(live.minMs, 80)
  assert.equal(live.snapshotsSkipped, 1)
  assert.equal(live.unstamped, 1)
  assert.equal(live.outOfRange, 1)
  const demo = fl.byHost.find(h => h.host === 'demo.ctraderapi.com')
  assert.equal(demo.events, 1, 'hosts are never pooled')
  assert.equal(demo.p50Ms, 30)
  assert.match(fl.meaning, /clock offset/)
})

test('the latency window ends: after 10 minutes the figure is "not measured recently", with the last one kept', () => {
  _resetFeedReceiptsForTests(T0)
  noteSpotStamp({ brokerAtMs: T0 - 50, receivedAtMs: T0, host: 'demo.ctraderapi.com', symbolId: 1 })
  assert.equal(feedReceiptsSnapshot(T0 + 1000).feedLatency.status, 'measured')
  const later = feedReceiptsSnapshot(T0 + FEED_LATENCY_WINDOW_MS + 1).feedLatency
  assert.equal(later.status, 'not_measured_recently')
  assert.equal(later.byHost.length, 0)
  assert.equal(later.lastMeasured.byHost[0].p50Ms, 50)
  assert.equal(later.lastMeasured.atMs, T0)
})

test('a stored snapshot seeds a new process, marked as received before the restart, never newer than a live receipt', () => {
  _resetFeedReceiptsForTests(T0)
  noteBarReceipt({ timeframe: '1h', periodMs: H, bars: [bar(T0 - 30_000)], receivedAtMs: T0, accountId: '1', source: 'strategy_scan' })
  noteBarReceipt({ timeframe: '4h', periodMs: 4 * H, bars: [bar(T0 - 30_000)], receivedAtMs: T0, accountId: '1', source: 'strategy_scan' })
  noteSpotStamp({ brokerAtMs: T0 - 70, receivedAtMs: T0, host: 'demo.ctraderapi.com', symbolId: 1 })
  feedReceiptsSnapshot(T0 + 1)
  const stored = JSON.parse(JSON.stringify(feedReceiptsForStore(T0 + 1)))

  // New process. A live 1h receipt arrives BEFORE the seed runs.
  _resetFeedReceiptsForTests(T0 + H)
  noteBarReceipt({ timeframe: '1h', periodMs: H, bars: [bar(T0 + H - 10_000)], receivedAtMs: T0 + H, accountId: '1', source: 'strategy_scan' })
  assert.equal(hydrateFeedReceipts(stored), 1, 'only 4h is seeded; the stored 1h is older than the live one')
  const snap = feedReceiptsSnapshot(T0 + H + 1000)
  const h1 = snap.bars.timeframes.find(r => r.timeframe === '1h')
  const h4 = snap.bars.timeframes.find(r => r.timeframe === '4h')
  assert.equal(h1.lastReceivedAtMs, T0 + H)
  assert.equal(h1.fromPreviousProcess, false)
  assert.equal(h4.lastReceivedAtMs, T0)
  assert.equal(h4.fromPreviousProcess, true)
  assert.equal(h4.receipts, 0, 'no receipt is claimed for this process')
  assert.equal(snap.feedLatency.status, 'not_measured_recently')
  assert.equal(snap.feedLatency.lastMeasured.fromPreviousProcess, true)
  assert.equal(snap.feedLatency.lastMeasured.byHost[0].p50Ms, 70)

  assert.equal(hydrateFeedReceipts({ v: 2 }), 0)
  assert.equal(hydrateFeedReceipts(null), 0)
  assert.equal(hydrateFeedReceipts({ v: 1, timeframes: [{ timeframe: '1h', sources: [{ source: 'x', receivedAtMs: 'bad' }] }] }), 0)
})

test('an open stream with no usable sample is served with its counts, not dropped', () => {
  // WEB-9b checker: 1 snapshot + 30 events all 90 s off (a clock offset beyond
  // the range) must reach the card as an open host with 0 samples.
  _resetFeedReceiptsForTests(T0)
  const host = 'live.ctraderapi.com'
  noteSpotStamp({ brokerAtMs: T0 - 3 * H, receivedAtMs: T0, host, symbolId: 1, snapshot: true })
  for (let i = 1; i <= 30; i++) {
    assert.equal(noteSpotStamp({ brokerAtMs: T0 + i * 1000 - 90_000, receivedAtMs: T0 + i * 1000, host, symbolId: 1 }), 'out_of_range')
  }
  const fl = feedReceiptsSnapshot(T0 + 31_000).feedLatency
  assert.equal(fl.status, 'not_measured_recently')
  assert.equal(fl.byHost.length, 1)
  assert.deepEqual([fl.byHost[0].events, fl.byHost[0].snapshotsSkipped, fl.byHost[0].outOfRange], [0, 1, 30])
})

test('each host keeps its own ring; a ring that dropped events inside the window says what span it covers', () => {
  _resetFeedReceiptsForTests(T0)
  const quiet = 'live.ctraderapi.com'
  const busy = 'demo.ctraderapi.com'
  // The quiet host's one sample comes first; the busy host then sends
  // 12,000 events over 10 minutes (20/s), three times its ring.
  noteSpotStamp({ brokerAtMs: T0 - 25, receivedAtMs: T0, host: quiet, symbolId: 9 })
  const N = 12_000
  const step = 50 // ms → 12,000 events over 600 s
  for (let i = 1; i <= N; i++) noteSpotStamp({ brokerAtMs: T0 + i * step - 40, receivedAtMs: T0 + i * step, host: busy, symbolId: 1 })
  const now = T0 + N * step
  const fl = feedReceiptsSnapshot(now).feedLatency
  const q = fl.byHost.find(h => h.host === quiet)
  const b = fl.byHost.find(h => h.host === busy)
  assert.ok(q, "the busy host never pushes another host's events out")
  assert.equal(q.events, 1)
  assert.equal(q.truncated, false)
  assert.equal(q.coversMs, FEED_LATENCY_WINDOW_MS)
  assert.equal(b.events, MAX_SPOT_EVENTS)
  assert.equal(b.truncated, true, 'events inside the window were dropped')
  // The oldest kept event is the (N - 4000 + 1)th: the figures cover 3,999 steps.
  assert.equal(b.oldestAtMs, T0 + (N - MAX_SPOT_EVENTS + 1) * step)
  assert.equal(b.coversMs, (MAX_SPOT_EVENTS - 1) * step)
  assert.ok(b.coversMs < FEED_LATENCY_WINDOW_MS / 2, 'about 200 s, not the 10 min window')
  assert.equal(fl.truncated, true)
  assert.equal(fl.maxEventsPerHost, MAX_SPOT_EVENTS)
  // A ring that dropped only events OLDER than the window covers the window.
  const later = feedReceiptsSnapshot(now + FEED_LATENCY_WINDOW_MS - 1000).feedLatency.byHost.find(h => h.host === busy)
  assert.equal(later.truncated, false)
  assert.equal(later.coversMs, FEED_LATENCY_WINDOW_MS)
})
