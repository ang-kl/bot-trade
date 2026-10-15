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

function seedRow(db, { closedAgoMs = 48 * H, afterBars = 5, tf = '15m', symbol = 'ADAUSD', verified = false } = {}) {
  const tfm = tfMsOf(tf)
  // № 15,001: on the bar grid, as a broker's bars are (the fake below answers on the grid too)
  const closedMs = Math.floor((Date.now() - closedAgoMs) / tfm) * tfm
  const bars = Array.from({ length: afterBars + 3 }, (_, i) => {
    const t = closedMs + (i - 2) * tfm
    return [t, 100, 100.5, 99.5, 100, 0]
  })
  const info = db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, sl_price, opened_at, closed_at, net_pnl, account_id)
     VALUES (?, 'long', 'closed', 100, 99, ?, ?, -1, '43097342')`
  ).run(symbol, new Date(closedMs - 2 * H).toISOString(), new Date(closedMs).toISOString())
  db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, timeframe, side, entry_price, sl_price, classification, detail, bars_json, bars_verified_at)
     VALUES (?, ?, ?, 'long', 100, 99, 'time_cap', 'as judged', ?, ?)`
  ).run(info.lastInsertRowid, symbol, tf, JSON.stringify(bars), verified ? new Date().toISOString() : null)
  return { closedMs, tfm }
}
const tfMsOf = (tf) => tf === '15m' ? 15 * MIN : tf === '4h' ? 4 * H : tf === '8h' ? 8 * H : H

/** A broker that has every bar: returns `count` bars ending at endMs. */
const fullHistory = async (_sym, tf, count, endMs) => {
  const tfm = tfMsOf(tf)
  const last = Math.floor(endMs / tfm) * tfm // bars sit on the timeframe grid
  return Array.from({ length: count }, (_, i) => {
    const t = last - (count - 1 - i) * tfm
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
  // № 15,001 (#35): a full row is skipped once its bars were read against the
  // clock rule (bars_verified_at); an unverified full row is re-read once —
  // see the forming-bar tests below.
  seedRow(db, { symbol: 'DDD', afterBars: REPLAY_AFTERMATH_BARS + 2, verified: true }) // already full, verified

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

// ── Claude · № 13,571 12-Oct (W5; claude-builder) ───────────────────────────
// Batch 2 of W5 (12-10) updated 0 rows and stopped on 25 errors. The fetch
// window was fixed in clock time at close + (target + 2) bars; a market that
// closes (weekends here) leaves fewer bars than that in the window, so after
// one pass took them every later pass found nothing new and counted an error.
import { WINDOW_SLOTS, MAX_WINDOWS, parseCursor, FETCH_BUDGET } from './aftermath-extend-apply.js'
import { tfMs } from '../lib/timeframes.js'

const DAY = 24 * H
/**
 * A broker closed on Saturday and Sunday (UTC). Like the live fetch
 * (ctrader-ws.js: fromTimestamp = end - (count + 5) bars), it answers with
 * the last `count` bars it has inside that window.
 */
function weekdayBroker(calls = []) {
  return async (_sym, tf, count, endMs) => {
    calls.push({ tf, count, endMs })
    const tfm = tfMs(tf)
    const out = []
    for (let t = Math.floor(endMs / tfm) * tfm; out.length < count && t >= endMs - (count + 5) * tfm; t -= tfm) {
      const d = new Date(t).getUTCDay()
      if (d !== 0 && d !== 6) out.push({ t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 })
    }
    return out.reverse()
  }
}
const isOpen = (t) => { const d = new Date(t).getUTCDay(); return d !== 0 && d !== 6 }
/** A row closed at `closedMs` (aligned to the bar) holding `afterBars` open-market bars after it. */
function seedAt(db, { closedMs, tf = '1h', afterBars = 5, symbol = 'EURUSD', closedAtText = null }) {
  const tfm = tfMs(tf)
  const bars = []
  for (let t = closedMs - 2 * tfm; t <= closedMs; t += tfm) bars.push([t, 100, 100.5, 99.5, 100, 0])
  for (let t = closedMs + tfm, n = 0; n < afterBars; t += tfm) if (isOpen(t)) { bars.push([t, 100, 100.5, 99.5, 100, 0]); n++ }
  const info = db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, sl_price, opened_at, closed_at, net_pnl, account_id)
     VALUES (?, 'long', 'closed', 100, 99, ?, ?, -1, '43097342')`
  ).run(symbol, new Date(closedMs - 2 * H).toISOString(), closedAtText ?? new Date(closedMs).toISOString())
  db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, timeframe, side, entry_price, sl_price, classification, detail, bars_json)
     VALUES (?, ?, ?, 'long', 100, 99, 'time_cap', 'as judged', ?)`
  ).run(info.lastInsertRowid, symbol, tf, JSON.stringify(bars))
}
const storedAfter = (db, closedMs, id = 1) => JSON.parse(db.prepare('SELECT bars_json FROM trade_postmortems WHERE id = ?').get(id).bars_json).filter(b => b[0] > closedMs)
const FRI_20 = Date.UTC(2026, 8, 4, 20) // Friday 4 Sep 2026, 20:00 UTC
/** The open-market bars after `fromMs`, in order: what a complete stored aftermath holds. */
const openBarsAfter = (fromMs, tfm, n) => { const out = []; for (let t = fromMs + tfm; out.length < n; t += tfm) if (isOpen(t)) out.push(t); return out }

test('W5: a row closed before a weekend fills to its target across passes — the window starts at the row\'s last bar, not at a fixed clock end', async () => {
  const db = initDB(':memory:')
  seedAt(db, { closedMs: FRI_20, afterBars: 3 })
  const now = FRI_20 + 30 * DAY
  const calls = []
  const first = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now })
  assert.equal(first.errors, 0); assert.equal(first.updated, 1)
  const second = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now })
  assert.equal(second.errors, 0, 'RED on the clock window: the second pass found nothing new before close + 98 h and counted an error')
  const after = storedAfter(db, FRI_20).map(b => b[0])
  assert.deepEqual(after, openBarsAfter(FRI_20, H, REPLAY_AFTERMATH_BARS + 2), 'the capture convention: target + 2 open-market bars, contiguous, nothing skipped')
  for (const c of calls) assert.ok(c.count <= WINDOW_SLOTS + 5, `each request stays at the broker's 400 (asked ${c.count})`)
  assert.equal(second.alreadyFull + second.updated, 1)
})

test('W5: a one-minute row closed on Friday evening steps through the weekend and appends Monday\'s bars contiguously', async () => {
  // and so does a broker that ignores the window's left edge and returns the last bars it has (all Friday's)
  const db0 = initDB(':memory:')
  const c0 = Date.UTC(2026, 8, 4, 23, 50)
  seedAt(db0, { closedMs: c0, tf: '1m', afterBars: 2 })
  const noLeftEdge = async (_sym, tf, count, endMs) => { const tfm = tfMs(tf); const out = []; for (let t = Math.floor(endMs / tfm) * tfm; out.length < count; t -= tfm) if (isOpen(t)) out.push({ t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 }); return out.reverse() }
  const o0 = await applyAftermathExtension(db0, noLeftEdge, { ...noSleep, now: c0 + 20 * DAY })
  assert.equal(o0.errors, 0); assert.equal(o0.updated, 1)
  assert.deepEqual(storedAfter(db0, c0).map(b => b[0]), openBarsAfter(c0, MIN, REPLAY_AFTERMATH_BARS + 2))
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 4, 23, 50) // Friday 23:50 UTC
  seedAt(db, { closedMs, tf: '1m', afterBars: 2 })
  const calls = []
  const out = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now: closedMs + 20 * DAY })
  assert.equal(out.errors, 0, 'RED on the clock window: close + 98 minutes is all weekend, so nothing came back')
  assert.equal(out.updated, 1)
  assert.ok(calls.length > 1 && calls.length <= MAX_WINDOWS, `stepped ${calls.length} window(s)`)
  assert.deepEqual(storedAfter(db, closedMs).map(b => b[0]), openBarsAfter(closedMs, MIN, REPLAY_AFTERMATH_BARS + 2))
})

test('W5: a row whose missing bars do not exist yet is "noNewerBarsYet", not an error, and does not use the error budget', async () => {
  const db = initDB(':memory:')
  // closed Thursday 20:00; now is the next Monday 23:30 — past close + 98 h
  // of clock, but the broker holds only about 49 open-market hours since
  const closedMs = Date.UTC(2026, 8, 3, 20)
  seedAt(db, { closedMs, afterBars: 2 })
  const now = Date.UTC(2026, 8, 7, 23, 30)
  seedAt(db, { closedMs: Date.UTC(2026, 8, 3, 10), afterBars: 2, symbol: 'GBPUSD' })
  const one = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now })
  assert.equal(one.updated, 2); assert.equal(one.errors, 0)
  const later = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now, maxErrors: 1 })
  assert.equal(later.errors, 0, 'RED on the clock window: the broker has no newer bar, which is not a failure')
  assert.equal(later.noNewerBarsYet, 2)
  assert.equal(later.updated, 0); assert.equal(later.remaining, 0)
})

test('W5: a call stopped by its budget names where it stopped, and a call given that cursor starts there', async () => {
  const db = initDB(':memory:')
  const now = FRI_20 + 40 * DAY
  for (let i = 0; i < 4; i++) seedAt(db, { closedMs: FRI_20 - i * DAY, afterBars: 2, symbol: `S${i}` })
  // the two newest rows fail every pass (a dead symbol name)
  const failing = (fetch) => async (sym, ...rest) => { if (sym === 'S0' || sym === 'S1') throw new Error('symbolId unknown'); return fetch(sym, ...rest) }
  const first = await applyAftermathExtension(db, failing(weekdayBroker()), { ...noSleep, now, maxErrors: 2 })
  assert.equal(first.errors, 2); assert.equal(first.updated, 0); assert.equal(first.remaining, 2)
  assert.match(first.resumeFrom ?? '', /^\d+:\d+$/, 'RED before the cursor: the call said nothing about where it stopped')
  const second = await applyAftermathExtension(db, failing(weekdayBroker()), { ...noSleep, now, maxErrors: 2, from: first.resumeFrom })
  assert.equal(second.updated, 2, 'the rows behind the failing ones are reached'); assert.equal(second.errors, 0)
  assert.equal(second.resumeFrom, null)
  assert.deepEqual(parseCursor(first.resumeFrom), { closedMs: FRI_20 - 2 * DAY, pmId: 3 })
  assert.equal(parseCursor('nope'), null); assert.equal(parseCursor(null), null)
})

test('W5: the stored aftermath stays contiguous whichever end of a full window the broker keeps', async () => {
  // The live fetch asks for `count` bars over a window `count + 5` slots wide
  // (ctrader-ws.js planWindowStartMs), so a fully open window can hold more
  // bars than `count`. This broker keeps the EARLIEST `count` of them.
  const earliestFirst = async (_sym, tf, count, endMs) => {
    const tfm = tfMs(tf)
    const out = []
    for (let t = Math.floor((endMs - (count + 5) * tfm) / tfm) * tfm; t <= endMs && out.length < count; t += tfm) if (isOpen(t)) out.push({ t, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 })
    return out
  }
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 1, 2, 0) // Tuesday 02:00, a fully open stretch
  seedAt(db, { closedMs, tf: '1m', afterBars: 1 })
  // A 50-slot window (the live one is 395) so one window holds fewer bars
  // than the row needs and the next window must pick up where the bars ended.
  const out = await applyAftermathExtension(db, earliestFirst, { ...noSleep, now: closedMs + 20 * DAY, windowSlots: 50 })
  assert.equal(out.errors, 0); assert.equal(out.updated, 1)
  assert.ok(out.fetches >= 2, `fetched ${out.fetches} window(s)`)
  assert.deepEqual(storedAfter(db, closedMs).map(b => b[0]), openBarsAfter(closedMs, MIN, REPLAY_AFTERMATH_BARS + 2), 'no bar skipped between windows')
})

// Codex P1s on #1331 (review of 85bafb5b). Owner, after № 13,641: "Fix: sort
// by parsed time" and "Add a per-call fetch budget".
test('Codex P1 on #1331: rows are taken newest first by their parsed close time, so a cursor never skips a row stored in the other timestamp format', async () => {
  const db = initDB(':memory:')
  const day = Date.UTC(2026, 8, 1) // Tuesday
  const at = (h) => day + h * H
  const sqliteText = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
  // the same day: two ISO-with-T rows and one space-format row closed LATER
  seedAt(db, { closedMs: at(10), symbol: 'A_ISO' })
  seedAt(db, { closedMs: at(9), symbol: 'B_ISO' })
  seedAt(db, { closedMs: at(12), symbol: 'C_SPACE', closedAtText: sqliteText(at(12)) })
  const now = day + 30 * DAY
  const order = []
  const broker = weekdayBroker()
  const spy = async (sym, ...rest) => { order.push(sym); return broker(sym, ...rest) }
  const first = await applyAftermathExtension(db, spy, { ...noSleep, now, maxRows: 1 })
  assert.equal(first.updated, 1)
  assert.deepEqual(order.slice(0, 1), ['C_SPACE'], 'RED before the fix: the raw text order put both ISO rows first')
  const second = await applyAftermathExtension(db, spy, { ...noSleep, now, from: first.resumeFrom })
  assert.equal(second.updated, 2)
  for (const [id, sym] of [[1, 'A_ISO'], [2, 'B_ISO'], [3, 'C_SPACE']]) {
    const closedMs = sym === 'A_ISO' ? at(10) : sym === 'B_ISO' ? at(9) : at(12)
    assert.equal(storedAfter(db, closedMs, id).length, REPLAY_AFTERMATH_BARS + 2, `${sym} filled — none skipped by the cursor`)
  }
})

test('Codex P1 on #1331: a call stops at its fetch budget and returns resumeFrom at the next row it has not started', async () => {
  const db = initDB(':memory:')
  const now = FRI_20 + 60 * DAY
  // one-minute rows: 12 empty windows of 395 slots (~79 h) stop short of the present, as for a row beyond retention
  for (let i = 0; i < 5; i++) seedAt(db, { closedMs: FRI_20 - i * DAY, tf: '1m', afterBars: 2, symbol: `OLD${i}` })
  let fetches = 0
  const noHistory = async () => { fetches++; return [] } // beyond the broker's retention: every window empty
  const out = await applyAftermathExtension(db, noHistory, { ...noSleep, now, maxFetches: 20 })
  assert.ok(out.fetches <= 20 + MAX_WINDOWS - 1, `fetched ${out.fetches} windows (RED before the budget: 5 rows × ${MAX_WINDOWS} = ${5 * MAX_WINDOWS})`)
  assert.equal(fetches, out.fetches)
  assert.match(out.resumeFrom ?? '', /^\d+:\d+$/, 'the call says where to resume')
  assert.ok(out.remaining >= 1)
  assert.equal(out.errors + out.remaining, 5, 'every row is either tried or left for the cursor')
  assert.equal(FETCH_BUDGET, 100)
})

// ── Claude · № 15,001 15-Oct (owner: "#35 forming bar — repair on next run" after № 14,989; claude-builder) ──
// Expected outcomes: a trendbar's `t` is its OPEN (ctrader-ws.js
// utcTimestampInMinutes × 60 000) and the broker's reply includes the bar
// still forming (fib-strategy.js S-3; fast-monitor.js slices it off). A bar
// is closed once open + one bar-length has passed. Bar VALUES here are
// fixtures: self-derived.
const closedAt = (db, id = 1) => db.prepare('SELECT bars_verified_at FROM trade_postmortems WHERE id = ?').get(id).bars_verified_at
const storedAll = (db, id = 1) => JSON.parse(db.prepare('SELECT bars_json FROM trade_postmortems WHERE id = ?').get(id).bars_json)

test('#35: a bar still forming at `now` is never stored; the next pass appends it once it has closed', async () => {
  const db = initDB(':memory:')
  seedAt(db, { closedMs: Date.UTC(2026, 8, 8, 10), afterBars: 2 }) // Tuesday 8 Sep 10:00, 1h
  // Monday 14 Sep 03:10: past close + 98 h; the broker holds 88 closed bars
  // since (Tue 11:00 – Fri 23:00, Mon 00:00 – 02:00) and the forming 03:00 bar,
  // all inside the 96 the row still needs.
  const now = Date.UTC(2026, 8, 14, 3, 10)
  const out = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now })
  assert.equal(out.updated, 1); assert.equal(out.errors, 0)
  const ts = storedAll(db).map(b => b[0])
  assert.ok(ts.every(t => t + H <= now), 'RED before: the forming 03:00 bar was stored with its partial values')
  assert.equal(ts[ts.length - 1], Date.UTC(2026, 8, 14, 2), 'the newest stored bar is the last CLOSED one')
  const later = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now: now + H })
  assert.equal(later.updated, 1)
  assert.equal(storedAll(db).map(b => b[0]).pop(), Date.UTC(2026, 8, 14, 3), 'closed now, so appended')
})

test('#35: the newest stored bar is re-fetched and takes the closed values (a copy stored while forming is repaired)', async () => {
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 8, 10)
  seedAt(db, { closedMs, afterBars: 3 })
  const bars = storedAll(db).map(b => [b[0], 100, 100.5, 99.5, 100, 1]); const newest = bars[bars.length - 1]
  bars[bars.length - 1] = [newest[0], 100, 100.1, 99.9, 100, 0] // partial: the high/low/volume of a bar read mid-way
  db.prepare('UPDATE trade_postmortems SET bars_json = ? WHERE id = 1').run(JSON.stringify(bars))
  const calls = []
  const out = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now: closedMs + 10 * DAY })
  assert.equal(out.errors, 0); assert.equal(out.updated, 1)
  assert.equal(out.barsReplaced, 1, 'RED before: the window started strictly AFTER the newest stored bar, so it was never re-read')
  const after = storedAll(db).find(b => b[0] === newest[0])
  assert.deepEqual(after, [newest[0], 100, 100.5, 99.5, 100, 1], 'the broker\'s closed values replace the partial copy')
  const ts = storedAll(db).map(b => b[0])
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b)); assert.equal(new Set(ts).size, ts.length, 'no duplicate timestamps')
  assert.ok(calls.every(c => c.count <= WINDOW_SLOTS + 5), 'each request stays at the broker\'s 400')
  assert.ok(closedAt(db), 'the row is stamped as read against the clock rule')
})

test('#35: a full row whose capture-time bar was stored forming is repaired ONCE, then skipped as before', async () => {
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 8, 10)
  seedAt(db, { closedMs, afterBars: REPLAY_AFTERMATH_BARS + 2 })
  // the capture ran at 12:20 on 8 Sep: the 12:00 bar was forming and was stored partial
  const bars = storedAll(db).map(b => [b[0], 100, 100.5, 99.5, 100, 1]); const k = bars.findIndex(b => b[0] === Date.UTC(2026, 8, 8, 12))
  bars[k] = [bars[k][0], 100, 100.1, 99.9, 100, 0]
  db.prepare(`UPDATE trade_postmortems SET bars_json = ?, created_at = '2026-09-08 12:20:00' WHERE id = 1`).run(JSON.stringify(bars))
  const calls = []
  const one = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now: closedMs + 20 * DAY })
  assert.equal(one.alreadyFull, 0, 'RED before: a full row was never visited, so the stored partial bar had no path to repair')
  assert.equal(one.verified, 1); assert.equal(one.barsReplaced, 1); assert.equal(one.updated, 1); assert.equal(one.errors, 0)
  assert.equal(calls.length, 1, 'one fetch, covering the capture-time bar through the newest stored bar')
  assert.deepEqual(storedAll(db)[k], [Date.UTC(2026, 8, 8, 12), 100, 100.5, 99.5, 100, 1])
  assert.equal(storedAll(db).filter(b => b[0] > closedMs).length, REPLAY_AFTERMATH_BARS + 2, 'still exactly full — the re-read appends nothing')
  const stampedAt = closedAt(db); assert.ok(stampedAt)
  const two = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now: closedMs + 21 * DAY })
  assert.equal(two.alreadyFull, 1); assert.equal(two.verified, 0); assert.equal(two.updated, 0)
  assert.equal(calls.length, 1, 'no second fetch: the stamp is the one-shot')
  assert.equal(closedAt(db), stampedAt)
})

test('#35: a stored bar still forming now is dropped from a full row without a fetch, and the row reads short again', async () => {
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 8, 10)
  seedAt(db, { closedMs, afterBars: REPLAY_AFTERMATH_BARS - 1 })
  const bars = storedAll(db); const tN = bars[bars.length - 1][0]
  bars.push([tN + H, 100, 100.1, 99.9, 100, 0])                       // a bar that is still forming at `now`
  db.prepare(`UPDATE trade_postmortems SET bars_json = ?, bars_verified_at = '2026-09-10T00:00:00.000Z' WHERE id = 1`).run(JSON.stringify(bars))
  const now = tN + H + 10 * MIN
  const calls = []
  const out = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now, maxFetches: 0 })
  assert.equal(out.barsDropped, 1, 'RED before: the forming bar stayed stored')
  assert.ok(storedAll(db).every(b => b[0] + H <= now))
  assert.equal(calls.length, 0, 'a drop needs no fetch; the row is budgeted like any short row for its top-up (maxFetches 0 here)')
  assert.equal(out.remaining, 1, 'and is discoverable for the next call')
})

test('#35: an unverified full row counts against the budget and is reached from the cursor', async () => {
  const db = initDB(':memory:')
  const now = FRI_20 + 40 * DAY
  seedAt(db, { closedMs: FRI_20, afterBars: REPLAY_AFTERMATH_BARS + 2, symbol: 'FULL0' })
  seedAt(db, { closedMs: FRI_20 - DAY, afterBars: 2, symbol: 'SHORT1' })
  const first = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now, maxFetches: 0 })
  assert.equal(first.remaining, 2); assert.equal(first.verified, 0)
  assert.match(first.resumeFrom, /^\d+:1$/)
  const second = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now, from: first.resumeFrom })
  assert.equal(second.verified, 2, 'both rows read against the clock rule'); assert.equal(second.remaining, 0)
  assert.ok(closedAt(db, 1) && closedAt(db, 2), 'both stamped')
  const third = await applyAftermathExtension(db, weekdayBroker(), { ...noSleep, now })
  assert.equal(third.verified, 0); assert.equal(third.alreadyFull, 2, 'nothing left to re-read')
})

// ── № 15,001 Codex round 1 on #1379 (owner: "Fix both, then merge when green") ──
test('P1: a full row the broker has nothing for is NOT stamped verified; it records unavailable, one fetch, then is skipped', async () => {
  const db = initDB(':memory:')
  const closedMs = Date.UTC(2026, 8, 8, 10)
  seedAt(db, { closedMs, afterBars: REPLAY_AFTERMATH_BARS + 2 })
  const bars = storedAll(db); const k = bars.findIndex(b => b[0] === Date.UTC(2026, 8, 8, 12))
  bars[k] = [bars[k][0], 100, 100.1, 99.9, 100, 0] // the capture-time bar, stored partial
  db.prepare(`UPDATE trade_postmortems SET bars_json = ?, created_at = '2026-09-08 12:20:00' WHERE id = 1`).run(JSON.stringify(bars))
  const calls = []
  const nothing = async (...a) => { calls.push(a); return [] } // beyond retention: a successful, empty answer
  const one = await applyAftermathExtension(db, nothing, { ...noSleep, now: closedMs + 20 * DAY })
  assert.equal(calls.length, 1)
  assert.equal(one.verified, 0, 'RED before: the row was stamped verified although nothing was re-read')
  assert.equal(one.unavailable, 1); assert.equal(one.errors, 0); assert.equal(one.updated, 0)
  assert.match(closedAt(db), /^unavailable:/, 'the record says the broker had nothing, not that the bars were checked')
  assert.deepEqual(storedAll(db)[k], bars[k], 'the partial bar is left as it is, never invented')
  const two = await applyAftermathExtension(db, nothing, { ...noSleep, now: closedMs + 21 * DAY })
  assert.equal(calls.length, 1, 'no second fetch'); assert.equal(two.alreadyFull, 1)
  // a broker that answers with bars but not the newest stored one: the newest bar was not re-read, so the row is
  // recorded unavailable too (never verified), and the other bars it did return are kept as they came
  const db2 = initDB(':memory:')
  seedAt(db2, { closedMs, afterBars: REPLAY_AFTERMATH_BARS + 2 })
  const tN = storedAll(db2).pop()[0]
  const partial = async (_s, tf, count, endMs) => (await weekdayBroker()(_s, tf, count, endMs)).filter(b => b.t !== tN)
  const r2 = await applyAftermathExtension(db2, partial, { ...noSleep, now: closedMs + 20 * DAY })
  assert.equal(r2.verified, 0); assert.equal(r2.unavailable, 1); assert.match(closedAt(db2), /^unavailable:/, 'the newest bar did not come back: not verified')
})

test('P2: a verification-only row consumes the row budget — batch 1 is one row, resumable from the cursor', async () => {
  const db = initDB(':memory:')
  const now = FRI_20 + 40 * DAY
  for (let i = 0; i < 3; i++) seedAt(db, { closedMs: FRI_20 - i * DAY, afterBars: REPLAY_AFTERMATH_BARS + 2, symbol: `FULL${i}` })
  // the stored bars already equal the broker's, so a re-read changes nothing
  for (const id of [1, 2, 3]) db.prepare('UPDATE trade_postmortems SET bars_json = ? WHERE id = ?').run(JSON.stringify(storedAll(db, id).map(b => [b[0], 100, 100.5, 99.5, 100, 1])), id)
  const calls = []
  const first = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now, maxRows: 1 })
  assert.equal(first.verified, 1); assert.equal(first.updated, 0)
  assert.equal(calls.length, 1, 'RED before: batch 1 verified every unverified row up to the fetch budget')
  assert.equal(first.remaining, 2); assert.match(first.resumeFrom, /^\d+:2$/)
  const second = await applyAftermathExtension(db, weekdayBroker(calls), { ...noSleep, now, maxRows: 5, from: first.resumeFrom })
  assert.equal(second.verified, 2); assert.equal(second.remaining, 0); assert.equal(calls.length, 3)
})
