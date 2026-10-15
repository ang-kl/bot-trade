// node --test agent/services/symbol-hours.test.js
//
// Broker-truth market hours: pure schedule evaluator + week-seconds mapping,
// the refresh upsert, and the cached gate with heuristic fallback.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import {
  secondsIntoWeek, isOpenBySchedule, refreshSymbolHours, isSymbolOpenCached,
  getSwapInfo,
} from './symbol-hours.js'

const HOUR = 3600
const DAY = 24 * HOUR

// Wed 2026-07-15 14:30 UTC.
const wed = (h, m = 0) => new Date(Date.UTC(2026, 6, 15, h, m))

test('secondsIntoWeek: UTC maps Sunday 00:00 = 0, Wed 14:30 correctly', () => {
  assert.equal(secondsIntoWeek(new Date(Date.UTC(2026, 6, 12, 0, 0, 0)), 'UTC'), 0) // Sunday
  // Wed = day 3 → 3*DAY + 14:30
  assert.equal(secondsIntoWeek(wed(14, 30), 'UTC'), 3 * DAY + 14 * HOUR + 30 * 60)
})

test('secondsIntoWeek: a real timezone shifts the wall clock (DST-correct via Intl)', () => {
  // New York in July is UTC-4. 14:30 UTC Wed = 10:30 EDT Wed.
  const sow = secondsIntoWeek(wed(14, 30), 'America/New_York')
  assert.equal(sow, 3 * DAY + 10 * HOUR + 30 * 60)
})

test('isOpenBySchedule: empty schedule = always open (broker imposes no window)', () => {
  assert.equal(isOpenBySchedule([], 12345), true)
  assert.equal(isOpenBySchedule(null, 12345), true)
})

test('isOpenBySchedule: inside/outside a simple interval', () => {
  // Open Mon 00:00 (1*DAY) to Fri 21:00 (5*DAY + 21h)
  const sched = [{ start: 1 * DAY, end: 5 * DAY + 21 * HOUR }]
  assert.equal(isOpenBySchedule(sched, 3 * DAY + 14 * HOUR), true)  // Wed 14:00
  assert.equal(isOpenBySchedule(sched, 6 * DAY), false)             // Saturday
  assert.equal(isOpenBySchedule(sched, 0), false)                   // Sunday 00:00
})

test('isOpenBySchedule: an interval that wraps the Sunday boundary', () => {
  // e.g. open Sat 22:00 (6*DAY+22h) through Sun 06:00 (6h)
  const sched = [{ start: 6 * DAY + 22 * HOUR, end: 6 * HOUR }]
  assert.equal(isOpenBySchedule(sched, 6 * DAY + 23 * HOUR), true)  // Sat 23:00
  assert.equal(isOpenBySchedule(sched, 3 * HOUR), true)             // Sun 03:00
  assert.equal(isOpenBySchedule(sched, 12 * HOUR), false)           // Sun 12:00
})

test('refreshSymbolHours upserts schedule + tz from an injected broker fetch', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, COCOA: 20 }))
  const fetchStub = async (ids) => ({
    symbol: ids.map(id => ({
      symbolId: id,
      scheduleTimeZone: id === 20 ? 'America/New_York' : 'UTC',
      schedule: id === 20
        ? [{ startSecond: 1 * DAY + 13 * HOUR, endSecond: 1 * DAY + 18 * HOUR }] // Mon window
        : [{ startSecond: 1 * DAY, endSecond: 5 * DAY + 21 * HOUR }],
    })),
  })
  const out = await refreshSymbolHours(db, { ready: true }, { fetch: fetchStub, getState })
  assert.equal(out.updated, 2)
  const row = db.prepare(`SELECT * FROM symbol_hours WHERE symbol = 'COCOA'`).get()
  assert.equal(row.symbol_id, 20)
  assert.equal(row.tz, 'America/New_York')
  assert.ok(JSON.parse(row.schedule_json).length === 1)
  // Broker omitted swap fields → NULL (unknown), never defaulted to 0.
  assert.equal(row.swap_long, null)
  assert.equal(row.swap_short, null)
})

test('refreshSymbolHours captures swap rates when the broker provides them', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ USDTRY: 7 }))
  const fetchStub = async (ids) => ({
    symbol: ids.map(id => ({
      symbolId: id, scheduleTimeZone: 'UTC', schedule: [],
      swapLong: -412.7, swapShort: 118.3, swapRollover3Days: 3,
    })),
  })
  await refreshSymbolHours(db, { ready: true }, { fetch: fetchStub, getState })
  const info = getSwapInfo(db, 'usdtry')
  assert.equal(info.swapLong, -412.7)
  assert.equal(info.swapShort, 118.3)
  assert.equal(info.rollover3Days, 3)
  // Unknown symbol → null, and a swap-free 0 survives as 0 (not null).
  assert.equal(getSwapInfo(db, 'BTCUSD'), null)
})

test('risk gate: carryGate.on vetoes negative_carry side-aware; off by default; unknown = no block', async () => {
  const { initDB, setState } = await import('../db.js')
  const { evaluateTrade, evaluateCarryCost, DEFAULT_RISK_CONFIG } = await import('./risk.js')
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'ctrader_account_id', 'A')
  setState(db, 'symbol_id_map', JSON.stringify({ USDTRY: 7 }))
  await refreshSymbolHours(db, { ready: true }, {
    fetch: async (ids) => ({ symbol: ids.map(id => ({ symbolId: id, scheduleTimeZone: 'UTC', schedule: [], swapLong: -412.7, swapShort: 118.3 })) }),
    getState,
  })
  const proposal = { symbol: 'USDTRY', side: 'BUY', entry: 32.5, sl: 32.2, tp1: 33.1, requestedVolume: 0.01, accountId: 'A' }
  // Default config: gate OFF → no carry veto.
  const off = evaluateTrade(db, proposal, { ...DEFAULT_RISK_CONFIG })
  assert.ok(!/negative_carry/.test(off.veto_reason || ''), 'gate must be off by default')
  // Enabled with threshold: the long side (-412.7) is below -50 → vetoed.
  const cfg = { ...DEFAULT_RISK_CONFIG, carryGate: { on: true, maxNegativeSwapPoints: -50 } }
  const on = evaluateTrade(db, proposal, cfg)
  assert.equal(on.approved, false)
  assert.match(on.veto_reason, /negative_carry: swapLong -412\.7/)
  // The SHORT side earns +118.3 → passes the carry check.
  assert.equal(evaluateCarryCost(db, { symbol: 'USDTRY', side: 'SELL' }, -50).vetoReason, undefined)
  // Unknown symbol swap → null, never a block.
  assert.equal(evaluateCarryCost(db, { symbol: 'EURUSD', side: 'BUY' }, -50), null)
  // Enabled but threshold null → gate is a no-op.
  const noThresh = evaluateTrade(db, proposal, { ...DEFAULT_RISK_CONFIG, carryGate: { on: true, maxNegativeSwapPoints: null } })
  assert.ok(!/negative_carry/.test(noThresh.veto_reason || ''))
})

test('isSymbolOpenCached: uses broker table when present, heuristic when not', () => {
  const db = initDB(':memory:')
  // EURUSD cached open Mon–Fri 24h; COCOA not cached → heuristic.
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('EURUSD', 1, ?, 'UTC')`)
    .run(JSON.stringify([{ start: 1 * DAY, end: 5 * DAY + 21 * HOUR }]))

  const openEur = isSymbolOpenCached(db, 'EURUSD', wed(14, 0))
  assert.equal(openEur.open, true)
  assert.equal(openEur.source, 'broker')

  const sat = new Date(Date.UTC(2026, 6, 18, 12)) // Saturday
  const closedEur = isSymbolOpenCached(db, 'EURUSD', sat)
  assert.equal(closedEur.open, false)
  assert.equal(closedEur.source, 'broker')

  // Uncached symbol → heuristic path (crypto always open).
  const btc = isSymbolOpenCached(db, 'BTCUSD', sat)
  assert.equal(btc.open, true)
  assert.equal(btc.source, 'heuristic')
})

test('nextOpenInfo: open symbol → open:true; closed → next interval start projected to real time', async () => {
  const { nextOpenInfo } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  // Open Mon 00:00 → Fri 21:00 (UTC)
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('EURUSD', 1, ?, 'UTC')`)
    .run(JSON.stringify([{ start: 1 * DAY, end: 5 * DAY + 21 * HOUR }]))

  const openRead = nextOpenInfo(db, 'EURUSD', wed(14, 0))
  assert.equal(openRead.open, true)
  assert.equal(openRead.next_open_at, null)

  // Saturday 12:00 UTC → next open is Monday 00:00 UTC (36h later)
  const sat = new Date(Date.UTC(2026, 6, 18, 12))
  const closedRead = nextOpenInfo(db, 'EURUSD', sat)
  assert.equal(closedRead.open, false)
  assert.equal(closedRead.next_open_at, new Date(sat.getTime() + 36 * 3600 * 1000).toISOString())

  // Heuristic symbol (no schedule row): honest null next_open_at
  const btc = nextOpenInfo(db, 'BTCUSD', sat)
  assert.equal(btc.next_open_at, null)
})

// Claude · № 15,08x 16-Oct (Codex P2 round 2 on #1382, owner: "book as a
// follow-up"; claude-builder). Expected instants are the IANA zone's own
// rules (America/New_York: DST begins Sun 2026-03-08 02:00 local, ends Sun
// 2026-11-01 02:00 local) applied to a Monday 09:30 local open — Codex's
// worked example (Fri 2026-03-06 noon → Mon 09:30 is 13:30Z, not 14:30Z).
const NY_OPEN_MON_0930 = [{ start: 1 * DAY + 9 * HOUR + 30 * 60, end: 1 * DAY + 16 * HOUR }]

test('nextOpenInfo: a DST change between now and the boundary does not shift next_open_at by an hour (spring)', async () => {
  const { nextOpenInfo } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('NYSTOCK', 7, ?, 'America/New_York')`)
    .run(JSON.stringify(NY_OPEN_MON_0930))
  // Fri 2026-03-06 12:00 EST (17:00Z); DST starts that Sunday.
  const friNoonEst = new Date(Date.UTC(2026, 2, 6, 17, 0, 0))
  const read = nextOpenInfo(db, 'NYSTOCK', friNoonEst)
  assert.equal(read.open, false)
  // Mon 2026-03-09 09:30 EDT = 13:30Z. The wall-clock-seconds projection
  // (now + delta) read 14:30Z — one hour late, the whole first half of the
  // 2 h pre-open window lost.
  assert.equal(read.next_open_at, '2026-03-09T13:30:00.000Z')
})

test('nextOpenInfo: the autumn change projects the local open to the later UTC instant (fall)', async () => {
  const { nextOpenInfo } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('NYSTOCK', 7, ?, 'America/New_York')`)
    .run(JSON.stringify(NY_OPEN_MON_0930))
  // Fri 2026-10-30 12:00 EDT (16:00Z); DST ends that Sunday.
  const friNoonEdt = new Date(Date.UTC(2026, 9, 30, 16, 0, 0))
  const read = nextOpenInfo(db, 'NYSTOCK', friNoonEdt)
  assert.equal(read.open, false)
  // Mon 2026-11-02 09:30 EST = 14:30Z (the old projection read 13:30Z —
  // an hour early, admitting the symbol to the pre-open window an hour soon).
  assert.equal(read.next_open_at, '2026-11-02T14:30:00.000Z')
})

test('nextOpenInfo: no transition in between → unchanged projection', async () => {
  const { nextOpenInfo } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('NYSTOCK', 7, ?, 'America/New_York')`)
    .run(JSON.stringify(NY_OPEN_MON_0930))
  // Fri 2026-07-10 12:00 EDT (16:00Z) → Mon 2026-07-13 09:30 EDT = 13:30Z, 69.5 h later.
  const friNoonJuly = new Date(Date.UTC(2026, 6, 10, 16, 0, 0))
  const read = nextOpenInfo(db, 'NYSTOCK', friNoonJuly)
  assert.equal(read.next_open_at, '2026-07-13T13:30:00.000Z')
  assert.equal(new Date(read.next_open_at).getTime() - friNoonJuly.getTime(), 69.5 * HOUR * 1000)
})

test('epochOfNextWeekSecond: UTC is the identity projection; a gap-time target never resolves before the gap ends', async () => {
  const { epochOfNextWeekSecond, wallClockEpochMs } = await import('./symbol-hours.js')
  const sat = new Date(Date.UTC(2026, 6, 18, 12))
  assert.equal(epochOfNextWeekSecond(sat, 'UTC', 1 * DAY), sat.getTime() + 36 * HOUR * 1000)
  // Same wall second as now → a full week ahead, never "now".
  assert.equal(epochOfNextWeekSecond(sat, 'UTC', 6 * DAY + 12 * HOUR), sat.getTime() + 7 * DAY * 1000)
  // Unknown zone → the UTC fallback secondsIntoWeek also takes.
  assert.equal(epochOfNextWeekSecond(sat, 'Not/AZone', 1 * DAY), sat.getTime() + 36 * HOUR * 1000)
  // Wall epoch: Sat 2026-03-07 12:00Z is 07:00 EST → wall 07:00 "UTC".
  const satMar = new Date(Date.UTC(2026, 2, 7, 12))
  assert.equal(wallClockEpochMs(satMar, 'America/New_York'), Date.UTC(2026, 2, 7, 7))
  // Sun 2026-03-08 02:30 New York does not exist (02:00 → 03:00). The
  // documented resolution is the offset read after the gap: 07:30Z
  // (03:30 EDT), one hour later by the wall clock and not before the
  // gap's end at 07:00Z. Self-derived: no broker schedule opens inside a
  // DST gap; this pins the rule, not a broker fact.
  const inGap = epochOfNextWeekSecond(satMar, 'America/New_York', 2 * HOUR + 30 * 60)
  assert.ok(inGap >= Date.UTC(2026, 2, 8, 7, 0), 'not before the gap ends')
  assert.equal(inGap, Date.UTC(2026, 2, 8, 7, 30))
})

test('nextOpenInfo: an interval starting inside the fall-back repeated hour opens again in the second fold, not a week later (Codex round 1 on #1388)', async () => {
  const { nextOpenInfo, isSymbolOpenCached } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  // Sunday 01:30–01:45 New York. On 2026-11-01 the clock reads 01:xx twice
  // (EDT, then EST after 06:00Z).
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('REPEAT', 9, ?, 'America/New_York')`)
    .run(JSON.stringify([{ start: 1 * HOUR + 30 * 60, end: 1 * HOUR + 45 * 60 }]))
  // 05:50Z = 01:50 EDT: the first fold's interval has passed …
  const now = new Date(Date.UTC(2026, 10, 1, 5, 50, 0))
  const read = nextOpenInfo(db, 'REPEAT', now)
  assert.equal(read.open, false)
  // … but the same wall time comes round at 06:30Z (01:30 EST), and the
  // cached open test agrees at 06:35Z. The wall-clock delta alone pointed to
  // 8 November.
  assert.equal(read.next_open_at, '2026-11-01T06:30:00.000Z')
  assert.equal(isSymbolOpenCached(db, 'REPEAT', new Date(Date.UTC(2026, 10, 1, 6, 35, 0))).open, true)
  // Before the first fold the first occurrence is the answer (strictly after now).
  const early = nextOpenInfo(db, 'REPEAT', new Date(Date.UTC(2026, 10, 1, 5, 20, 0)))
  assert.equal(early.next_open_at, '2026-11-01T05:30:00.000Z')
})

test('nextOpenInfo: with several starts, the earliest PROJECTED instant wins, not the smallest wall-clock delta (Codex round 2 on #1388)', async () => {
  const { nextOpenInfo } = await import('./symbol-hours.js')
  const db = initDB(':memory:')
  // Sunday 01:30–01:45 and 02:00–03:00 New York. At 05:50Z on 2026-11-01
  // (01:50 EDT) the 02:00 start is 10 wall-clock minutes away and the 01:30
  // start a week — but the clock falls back at 06:00Z, so 01:30 EST comes
  // round at 06:30Z and 02:00 EST only at 07:00Z.
  db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('TWOSTARTS', 11, ?, 'America/New_York')`)
    .run(JSON.stringify([
      { start: 1 * HOUR + 30 * 60, end: 1 * HOUR + 45 * 60 },
      { start: 2 * HOUR, end: 3 * HOUR },
    ]))
  const read = nextOpenInfo(db, 'TWOSTARTS', new Date(Date.UTC(2026, 10, 1, 5, 50, 0)))
  assert.equal(read.open, false)
  assert.equal(read.next_open_at, '2026-11-01T06:30:00.000Z')
  // Outside the repeated hour the two selections agree: Monday 2026-07-13
  // 00:00Z (Sunday 20:00 EDT) → the next start is Sunday 2026-07-19 01:30 EDT = 05:30Z.
  const plain = nextOpenInfo(db, 'TWOSTARTS', new Date(Date.UTC(2026, 6, 13, 0, 0, 0)))
  assert.equal(plain.next_open_at, '2026-07-19T05:30:00.000Z')
})

test('projection reuses one formatter per zone and kind — not one per wall-clock read (Codex round 3 on #1388)', async () => {
  const { epochOfNextWeekSecond, nextOpenInfo } = await import('./symbol-hours.js')
  const Real = Intl.DateTimeFormat
  let built = 0
  // Count constructions; the cache may already hold the zone from earlier
  // tests in this file, so the bound is on NEW constructions during the run.
  Intl.DateTimeFormat = function (...args) { built++; return new Real(...args) }
  try {
    const now = new Date(Date.UTC(2026, 2, 6, 17))
    for (let i = 0; i < 100; i++) epochOfNextWeekSecond(now, 'Europe/Berlin', 1 * DAY + 9 * HOUR)
    const db = initDB(':memory:')
    db.prepare(`INSERT INTO symbol_hours (symbol, symbol_id, schedule_json, tz) VALUES ('DE', 13, ?, 'Europe/Berlin')`)
      .run(JSON.stringify([1, 2, 3, 4, 5].map(d => ({ start: d * DAY + 9 * HOUR, end: d * DAY + 17.5 * HOUR }))))
    for (let i = 0; i < 100; i++) nextOpenInfo(db, 'DE', new Date(Date.UTC(2026, 2, 7, 12)))
  } finally {
    Intl.DateTimeFormat = Real
  }
  // Two kinds (week clock, wall clock) for one new zone: at most two
  // constructions across 100 + 500 projections, each of which reads the wall
  // clock about ten times. Uncached this is several thousand.
  assert.ok(built <= 2, `formatters built: ${built}`)
})
