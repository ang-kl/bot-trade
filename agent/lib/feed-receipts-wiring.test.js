// V3 WEB-9b WIRING: the bar receipts are stamped by the broker readers
// themselves — wsGetTrendbarsBatch (every strategy, fast-monitor and chart
// read), wsGetDailyOhlcv (the positions' daily bar) and wsGetLastCloses — so
// no caller can forget to. Exercised end to end through the pooled session
// with a scripted socket, the same seam ctrader-session.test.js uses: a
// recorder nobody calls would leave the card's chips reading "none" forever
// while the scan ran (CLAUDE.md failure mode #4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PT } from './ctrader-payload-types.js'
import { _resetPool, _setConnectForTests } from './ctrader-session.js'
import { wsGetTrendbarsBatch, wsGetDailyOhlcv, wsGetLastCloses } from './ctrader-ws.js'
import { feedReceiptsSnapshot, _resetFeedReceiptsForTests } from './feed-receipts.js'

class FakeWs extends EventEmitter {
  constructor(onSend) { super(); this.readyState = 1; this.onSend = onSend; setImmediate(() => this.emit('open')) }
  send(raw) {
    const msg = JSON.parse(raw)
    if (msg.payloadType === PT.HEARTBEAT) return
    this.onSend(msg, this)
  }
  close() { this.readyState = 3 }
  reply(payloadType, payload, clientMsgId) {
    this.emit('message', Buffer.from(JSON.stringify({ payloadType, payload, ...(clientMsgId ? { clientMsgId } : {}) })))
  }
}

// cTrader trendbar encoding: low in points (1e5) plus deltas, minutes since epoch.
const tb = (tMs) => ({ low: 100000, deltaOpen: 0, deltaHigh: 10, deltaClose: 5, volume: 7, utcTimestampInMinutes: Math.floor(tMs / 60_000) })

async function withBroker(barsFor, fn) {
  _resetPool()
  const prev = process.env.CTRADER_WS_POOL
  process.env.CTRADER_WS_POOL = '1'
  const requests = []
  _setConnectForTests(() => new FakeWs((msg, ws) => {
    if (msg.payloadType === PT.APP_AUTH_REQ) return ws.reply(PT.APP_AUTH_RES, {}, msg.clientMsgId)
    if (msg.payloadType === PT.ACCOUNT_AUTH_REQ) return ws.reply(PT.ACCOUNT_AUTH_RES, {}, msg.clientMsgId)
    if (msg.payloadType === PT.GET_TRENDBARS_REQ) {
      requests.push(msg.payload)
      ws.reply(PT.GET_TRENDBARS_RES, { trendbar: barsFor(msg.payload) }, msg.clientMsgId)
    }
  }))
  try { await fn(requests) } finally {
    _setConnectForTests(null)
    if (prev === undefined) delete process.env.CTRADER_WS_POOL
    else process.env.CTRADER_WS_POOL = prev
    _resetPool()
  }
}

const floorTo = (t, ms) => Math.floor(t / ms) * ms

test('a live trendbar batch stamps each timeframe under its reader; the bars returned are unchanged', async () => {
  _resetFeedReceiptsForTests()
  const now = Date.now()
  await withBroker(p => [tb(floorTo(now, 3_600_000) - 3_600_000), tb(floorTo(now, p.period === 9 ? 3_600_000 : 900_000))], async () => {
    const before = Date.now()
    const out = await wsGetTrendbarsBatch('demo.example.com', 'cid', 'sec', 'tok', '46130058', 41, ['1h', '15m'], 2, 2_000, 0, { purpose: 'strategy_scan' })
    assert.equal(out['1h'].length, 2)
    assert.equal(out['15m'].length, 2)
    const rows = feedReceiptsSnapshot().bars.timeframes
    assert.deepEqual(rows.map(r => r.timeframe), ['15m', '1h'])
    for (const r of rows) {
      assert.equal(r.source, 'strategy_scan')
      assert.equal(r.accountId, '46130058')
      assert.equal(r.host, 'demo.example.com')
      assert.equal(r.sources[0].symbolId, '41')
      assert.ok(r.lastReceivedAtMs >= before)
      assert.equal(r.newestBarForming, true, 'the forming bar the broker sent is recorded as forming')
    }
    assert.equal(rows.find(r => r.timeframe === '1h').newestBarOpenMs, floorTo(now, 3_600_000))
  })
})

test('a HISTORICAL window (a past trade\'s chart) is not a receipt of the current feed', async () => {
  _resetFeedReceiptsForTests()
  const past = Date.parse('2026-08-01T10:00:00Z')
  await withBroker(() => [tb(past - 3_600_000)], async () => {
    const out = await wsGetTrendbarsBatch('demo.example.com', 'cid', 'sec', 'tok', '1', 41, ['1h'], 2, 2_000, past)
    assert.equal(out['1h'].length, 1)
    assert.deepEqual(feedReceiptsSnapshot().bars.timeframes, [])
  })
})

test('a synthesised timeframe is stamped under the base timeframe the broker actually sent', async () => {
  _resetFeedReceiptsForTests()
  const now = Date.now()
  await withBroker(() => [tb(floorTo(now, 3_600_000) - 3_600_000), tb(floorTo(now, 3_600_000))], async (requests) => {
    await wsGetTrendbarsBatch('demo.example.com', 'cid', 'sec', 'tok', '1', 41, ['2h'], 1, 2_000)
    assert.equal(requests[0].period, 9, '2h is fetched as 1h bars')
    const rows = feedReceiptsSnapshot().bars.timeframes
    assert.deepEqual(rows.map(r => [r.timeframe, r.source]), [['1h', 'other']])
  })
})

test('the positions\' daily bar and the last-close read stamp 1D and 1m under their own names', async () => {
  _resetFeedReceiptsForTests()
  const now = Date.now()
  const dayOld = floorTo(now, 86_400_000) - 86_400_000 * 2
  await withBroker(p => (p.period === 12 ? [tb(dayOld)] : [tb(floorTo(now, 60_000))]), async () => {
    const daily = await wsGetDailyOhlcv('demo.example.com', 'cid', 'sec', 'tok', '46130058', [7])
    assert.equal(daily[7].t, dayOld)
    const closes = await wsGetLastCloses('demo.example.com', 'cid', 'sec', 'tok', '46130058', [7])
    assert.equal(closes[7], 1.00005)
    const rows = feedReceiptsSnapshot().bars.timeframes
    const d1 = rows.find(r => r.timeframe === '1d')
    const m1 = rows.find(r => r.timeframe === '1m')
    assert.equal(d1.source, 'daily_bar')
    assert.equal(d1.newestBarOpenMs, dayOld)
    assert.equal(d1.newestBarForming, false, 'a D1 bar two days old is recorded as closed, so the stale-bar question is measured')
    assert.equal(m1.source, 'last_close')
  })
})
