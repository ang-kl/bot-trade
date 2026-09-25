// V3 WEB-9b (8,989-A rows 10 and 11): GET /actions/stream-prices asks the
// broker for its spot timestamp, forwards it beside the AGENT's receipt time,
// and records broker-stamp → receipt as the market-feed latency that
// GET /state/data-feed serves. End to end over HTTP, with the broker socket
// replaced through the router's test seam.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { _resetFeedReceiptsForTests } from '../lib/feed-receipts.js'

async function readFrames(url, want) {
  const ctrl = new AbortController()
  const res = await fetch(url, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames = []
  const deadline = Date.now() + 5_000
  while (frames.length < want && Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)))
    }
  }
  ctrl.abort()
  return frames
}

test('stream-prices subscribes timestamped, forwards the broker stamp beside the agent receipt, and feeds the latency record', async t => {
  _resetFeedReceiptsForTests()
  const env = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'test-client'
  process.env.CTRADER_CLIENT_SECRET = 'test-secret'
  t.after(() => {
    if (env.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = env.id
    if (env.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = env.secret
  })
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,0)').run('46130058')
  setState(db, 'ctrader_access_token', 'test-token')
  setState(db, 'symbol_id_map', JSON.stringify({ BTCUSD: 101, ETHUSD: 102 }))

  const subscriptions = []
  const streamSpots = async (host, _cid, _sec, _tok, accountId, ids, onTick, _onClose, options) => {
    subscriptions.push({ host, accountId, ids, options })
    setImmediate(() => {
      const now = Date.now()
      onTick({ symbolId: 101, bid: 1, ask: 2, t: now, brokerAtMs: now - 3 * 3_600_000 }) // BTC snapshot: an old close quote
      onTick({ symbolId: 102, bid: 3, ask: 4, t: now, brokerAtMs: now - 5_000 })         // ETH snapshot
      onTick({ symbolId: 101, bid: 1.1, ask: 2, t: now, brokerAtMs: now - 150 })
      onTick({ symbolId: 102, bid: 3.1, ask: 4, t: now, brokerAtMs: now - 250 })
      onTick({ symbolId: 101, bid: 1.2, ask: 2, t: now })                                // no broker stamp
    })
    return { close: () => {} }
  }
  const app = express()
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db, { streamSpots }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
  const base = `http://127.0.0.1:${server.address().port}`

  const frames = await readFrames(`${base}/actions/stream-prices?symbols=BTCUSD,ETHUSD&account=46130058`, 5)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].options?.timestamped, true, 'the subscription asks for the broker spot timestamp')
  assert.equal(frames.length, 5)
  const btc = frames.filter(f => f.symbol === 'BTCUSD')
  assert.ok(Number.isSafeInteger(btc[1].brokerAtMs), 'the broker stamp is forwarded')
  assert.ok(btc[1].receivedAtMs - btc[1].brokerAtMs >= 150, 'receivedAtMs is the agent clock at receipt, after the broker stamp')
  assert.equal(btc[2].brokerAtMs, null, 'an unstamped event says so — never a made-up stamp')

  const report = await (await fetch(`${base}/state/data-feed?account=46130058`)).json()
  const fl = report.feedLatency
  assert.equal(fl.status, 'measured')
  assert.equal(fl.byHost.length, 1)
  const h = fl.byHost[0]
  assert.equal(h.host, 'demo.ctraderapi.com')
  assert.equal(h.events, 2, 'the two snapshots and the unstamped event are not latency samples')
  assert.equal(h.snapshotsSkipped, 2)
  assert.equal(h.unstamped, 1)
  assert.ok(h.minMs >= 150 && h.minMs < 2_000, `min ${h.minMs}`)
  assert.ok(h.maxMs >= 250 && h.maxMs < 2_100, `max ${h.maxMs}`)
  assert.deepEqual(h.accounts, ['46130058'])
  assert.ok(!report.notMeasured.some(n => n.key === 'feed_latency'), 'feed latency is no longer listed as unmeasured')
})
