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

test('risk gate: carryGateEnabled vetoes negative_carry side-aware; off by default; unknown = no block', async () => {
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
  const cfg = { ...DEFAULT_RISK_CONFIG, carryGateEnabled: true, carryMaxNegativeSwapPoints: -50 }
  const on = evaluateTrade(db, proposal, cfg)
  assert.equal(on.approved, false)
  assert.match(on.veto_reason, /negative_carry: swapLong -412\.7/)
  // The SHORT side earns +118.3 → passes the carry check.
  assert.equal(evaluateCarryCost(db, { symbol: 'USDTRY', side: 'SELL' }, -50).vetoReason, undefined)
  // Unknown symbol swap → null, never a block.
  assert.equal(evaluateCarryCost(db, { symbol: 'EURUSD', side: 'BUY' }, -50), null)
  // Enabled but threshold null → gate is a no-op.
  const noThresh = evaluateTrade(db, proposal, { ...DEFAULT_RISK_CONFIG, carryGateEnabled: true })
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
