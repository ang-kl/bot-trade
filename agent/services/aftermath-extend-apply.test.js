// node --test agent/services/aftermath-extend-apply.test.js
//
// The apply may touch bars_json and NOTHING else, must stop at each row's own
// target (96 bars — or the 7-day wall-clock cap on 4h+ timeframes the owner
// approved), and must stay resumable: a partial run leaves the remainder
// discoverable by the same predicate, not by a progress marker that can lie.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { applyAftermathExtension, targetAfterBars, SLOW_TF_CAP_MS } from './aftermath-extend-apply.js'
import { REPLAY_AFTERMATH_BARS } from './loss-postmortem.js'

const MIN = 60_000
const H = 3_600_000
const noSleep = { throttleMs: 0 }

function seedRow(db, { closedAgoMs = 48 * H, afterBars = 5, tf = '15m', symbol = 'ADAUSD' } = {}) {
  const tfm = tfMsOf(tf)
  const closedMs = Date.now() - closedAgoMs
  const bars = Array.from({ length: afterBars + 3 }, (_, i) => {
    const t = closedMs + (i - 2) * tfm
    return [t, 100, 100.5, 99.5, 100, 0]
  })
  const info = db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, sl_price, opened_at, closed_at, net_pnl, account_id)
     VALUES (?, 'long', 'closed', 100, 99, ?, ?, -1, '43097342')`
  ).run(symbol, new Date(closedMs - 2 * H).toISOString(), new Date(closedMs).toISOString())
  db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, timeframe, side, entry_price, sl_price, classification, detail, bars_json)
     VALUES (?, ?, ?, 'long', 100, 99, 'time_cap', 'as judged', ?)`
  ).run(info.lastInsertRowid, symbol, tf, JSON.stringify(bars))
  return { closedMs, tfm }
}
const tfMsOf = (tf) => tf === '15m' ? 15 * MIN : tf === '4h' ? 4 * H : tf === '8h' ? 8 * H : H

/** A broker that has every bar: returns `count` bars ending at endMs. */
const fullHistory = async (_sym, tf, count, endMs) => {
  const tfm = tfMsOf(tf)
  return Array.from({ length: count }, (_, i) => {
    const t = endMs - (count - 1 - i) * tfm
    return { t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }
  })
}

test('a short row is topped up to exactly its target, sorted, deduped, and nothing but bars_json changes', async () => {
  const db = initDB(':memory:')
  const { closedMs } = seedRow(db, { afterBars: 5 })
  const before = db.prepare('SELECT classification, detail, entry_price, sl_price FROM trade_postmortems').get()

  const out = await applyAftermathExtension(db, fullHistory, noSleep)
  assert.equal(out.updated, 1)
  assert.equal(out.errors, 0)

  const row = db.prepare('SELECT * FROM trade_postmortems').get()
  const bars = JSON.parse(row.bars_json)
  const after = bars.filter(b => b[0] > closedMs)
  assert.equal(after.length, REPLAY_AFTERMATH_BARS + 2, 'topped up to close + (target+2) bars, the capture convention')
  const ts = bars.map(b => b[0])
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'chronological')
  assert.equal(new Set(ts).size, ts.length, 'no duplicate timestamps')
  assert.deepEqual(
    { classification: row.classification, detail: row.detail, entry_price: row.entry_price, sl_price: row.sl_price },
    before, 'the verdict stays as judged — bars_json is the only writable column')
})

test('the 7-day wall-clock cap governs slow timeframes', async () => {
  // 96 bars of 8h would be 32 days of candles for a replay whose slowest rule
  // caps at 120 minutes. 7d/8h = 21 bars.
  assert.equal(targetAfterBars(15 * MIN), REPLAY_AFTERMATH_BARS)
  assert.equal(targetAfterBars(4 * H), Math.floor(SLOW_TF_CAP_MS / (4 * H)))
  assert.equal(targetAfterBars(8 * H), Math.floor(SLOW_TF_CAP_MS / (8 * H)))

  const db = initDB(':memory:')
  const { closedMs } = seedRow(db, { tf: '8h', afterBars: 3, closedAgoMs: 20 * 24 * H })
  const out = await applyAftermathExtension(db, fullHistory, noSleep)
  assert.equal(out.updated, 1)
  const bars = JSON.parse(db.prepare('SELECT bars_json FROM trade_postmortems').get().bars_json)
  const after = bars.filter(b => b[0] > closedMs).length
  assert.ok(after <= 21 + 2, `8h row must stop at the capped target, held ${after}`)
})

test('fresh rows and full rows are skipped; a partial batch leaves the rest discoverable', async () => {
  const db = initDB(':memory:')
  seedRow(db, { symbol: 'AAA' })
  seedRow(db, { symbol: 'BBB' })
  seedRow(db, { symbol: 'CCC', closedAgoMs: 10 * MIN }) // history still forming
  seedRow(db, { symbol: 'DDD', afterBars: REPLAY_AFTERMATH_BARS + 2 }) // already full

  const first = await applyAftermathExtension(db, fullHistory, { ...noSleep, maxRows: 1 })
  assert.equal(first.updated, 1)
  assert.equal(first.remaining, 1, 'the batch limit reports what it left behind')
  assert.equal(first.historyStillForming, 1)
  assert.equal(first.alreadyFull, 1)

  const second = await applyAftermathExtension(db, fullHistory, { ...noSleep, maxRows: 10 })
  assert.equal(second.updated, 1, 'the re-run finds exactly the row the first run left')
  assert.equal(second.alreadyFull, 2, 'the first run\'s work now reads as full — the data is the progress tracker')
})

test('a fetch failure is counted and leaves the row untouched for a re-run', async () => {
  const db = initDB(':memory:')
  seedRow(db)
  const before = db.prepare('SELECT bars_json FROM trade_postmortems').get()
  const out = await applyAftermathExtension(db, async () => { throw new Error('502 from broker') }, noSleep)
  assert.equal(out.errors, 1)
  assert.equal(out.updated, 0)
  assert.deepEqual(db.prepare('SELECT bars_json FROM trade_postmortems').get(), before)
})
