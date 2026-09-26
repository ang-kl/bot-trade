// node --test agent/services/entry-hours.test.js
//
// V3 S-8 (Wave 3 row 3.2): holidays on the entry path, UNKNOWN never reads
// open. Each test drives the real gate over a real in-memory calendar; the
// last two drive loop.js autoTrade itself, so the wiring is pinned by
// behaviour, not by reading the source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { recordMarketCalendar } from './market-calendar.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import {
  entryMarketGate, resolveEntryMarketGate, _resetEntryHoursRefresh,
  ENTRY_HOURS_SOURCE, ENTRY_HOURS_SOURCES, ENTRY_HOURS_REFRESH_COOLDOWN_MS,
} from './entry-hours.js'

const D = 86400, H = 3600, W = 7 * D
const HOST = 'demo.ctraderapi.com'
const ACCT = '4242'
const SYM = '0700.HK', SYM_ID = 7700
const IDENTITY = { host: HOST, accountId: ACCT, symbolId: String(SYM_ID) }
const dayNo = iso => Date.parse(`${iso}T00:00:00Z`) / 86400_000
// HKEX regular hours in local seconds-into-week, Mon–Fri 09:30–16:00 (the
// lunch break is not needed here).
const HK_SCHEDULE = [1, 2, 3, 4, 5].map(d => ({ startSecond: d * D + 9.5 * H, endSecond: d * D + 16 * H }))
const HOLIDAY_0110 = { holidayId: 1, name: 'National Day', scheduleTimeZone: 'Asia/Hong_Kong', holidayDate: dayNo('2026-10-01'), isRecurring: false }
const hkSymbol = holiday => ({ symbolId: SYM_ID, scheduleTimeZone: 'Asia/Hong_Kong', tradingMode: 0, schedule: HK_SCHEDULE, holiday })
const WED_0930_1000 = Date.parse('2026-09-30T02:00:00Z') // Wed 30-09 10:00 HKT: open
const THU_0110_1000 = Date.parse('2026-10-01T02:00:00Z') // Thu 01-10 10:00 HKT: HKEX National Day
const OBSERVED = Date.parse('2026-09-30T00:00:00Z')
const OBSERVED_THU = Date.parse('2026-10-01T00:00:00Z') // within 24 h of the holiday instant

function fixture(t, { map = { [SYM]: SYM_ID }, holiday = [{ ...HOLIDAY_0110, startSecond: 0, endSecond: D }], observedMs = OBSERVED } = {}) {
  const db = initDB(':memory:'); t.after(() => db.close())
  _resetEntryHoursRefresh()
  if (map) setState(db, accountSymbolMapKey(ACCT), JSON.stringify({ builtAt: '2026-09-30T00:00:00Z', accountId: ACCT, map }))
  if (holiday) recordMarketCalendar(db, IDENTITY, hkSymbol(holiday), { nowMs: observedMs })
  // The name-keyed row the pre-S-8 gate read: same weekly hours, no holidays.
  db.prepare('INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)')
    .run(SYM, JSON.stringify(HK_SCHEDULE.map(i => ({ start: i.startSecond, end: i.endSecond }))), 'Asia/Hong_Kong')
  return db
}
const gate = (db, nowMs, extra = {}) => entryMarketGate(db, { symbol: SYM, accountId: ACCT, host: HOST, nowMs, ...extra })

test('OD-8 is one switch, built on the recommended answer: the account calendar gates entries', () => {
  assert.equal(ENTRY_HOURS_SOURCE, 'account_calendar')
  assert.deepEqual([...ENTRY_HOURS_SOURCES], ['account_calendar', 'symbol_hours'])
})

test('an ordinary trading day reads OPEN on the account calendar', t => {
  const db = fixture(t)
  const g = gate(db, WED_0930_1000)
  assert.equal(g.open, true)
  assert.equal(g.status, 'OPEN')
  assert.equal(g.hoursSource, 'account_calendar')
})

test('HKEX 01-10: a current full-day holiday reads CLOSED where the old name-keyed gate read OPEN', t => {
  const db = fixture(t, { observedMs: OBSERVED_THU })
  assert.equal(isSymbolOpenCached(db, SYM, new Date(THU_0110_1000)).open, true, 'the pre-S-8 gate: weekly schedule only, holiday ignored')
  const g = gate(db, THU_0110_1000)
  assert.equal(g.open, false, 'RED if the entry path ignores the holiday')
  assert.equal(g.unknown, false)
  assert.equal(g.status, 'CLOSED')
  assert.equal(g.calendarReason, 'broker_holiday')
  assert.match(g.reason, /closed per the account calendar \(broker holiday\)/)
})

test('OD-7: production\'s 0/0 "Closed" row on 01-10 never reads open (CLOSED once K3 is in, UNKNOWN before)', t => {
  const db = fixture(t, { holiday: [{ ...HOLIDAY_0110, startSecond: 0, endSecond: 0 }], observedMs: OBSERVED_THU })
  const g = gate(db, THU_0110_1000)
  assert.equal(g.open, false)
  assert.ok(g.status === 'CLOSED' || g.status === 'UNKNOWN', g.status)
})

test('UNKNOWN never reads open: every way the account calendar cannot answer refuses the entry', t => {
  const cases = [
    ['account_symbol_map_missing', fixture(t, { map: null }), {}],
    ['symbol_not_in_account_map', fixture(t, { map: { OTHER: 1 } }), {}],
    ['calendar_missing', fixture(t, { holiday: null }), {}],
    ['calendar_stale', fixture(t, { observedMs: WED_0930_1000 - 25 * H * 1000 }), {}],
    ['holiday_bounds_omitted', fixture(t, { holiday: [{ ...HOLIDAY_0110 }] }), {}],
    ['entry_hours_source_invalid', fixture(t), { source: 'something_else' }],
    ['account_required', fixture(t), { accountId: null }],
    ['account_not_registered', fixture(t), { host: undefined }],
  ]
  for (const [reason, db, extra] of cases) {
    const g = gate(db, WED_0930_1000, extra)
    assert.equal(g.open, false, `${reason}: RED if UNKNOWN reads open`)
    assert.equal(g.unknown, true, reason)
    assert.equal(g.status, 'UNKNOWN', reason)
    assert.equal(g.calendarReason, reason)
  }
})

test('no heuristic fallback: a symbol with no calendar is UNKNOWN, not the sessions.js guess', t => {
  const db = fixture(t, { map: { 'EURUSD': 1 }, holiday: null })
  const legacy = isSymbolOpenCached(db, 'EURUSD', new Date(WED_0930_1000))
  assert.equal(legacy.source, 'heuristic', 'precondition: the old gate would have guessed')
  const g = gate(db, WED_0930_1000, { symbol: 'EURUSD' })
  assert.equal(g.open, false)
  assert.equal(g.calendarReason, 'calendar_missing')
})

test('the OD-8 switch set to symbol_hours restores the pre-S-8 gate exactly (holiday ignored)', t => {
  const db = fixture(t, { observedMs: OBSERVED_THU })
  const g = gate(db, THU_0110_1000, { source: 'symbol_hours' })
  assert.equal(g.open, true)
  assert.equal(g.hoursSource, 'symbol_hours')
  assert.equal(g.source, 'broker')
})

test('a missing calendar is re-read once from the broker with the account\'s own credentials, then judged', async t => {
  const db = fixture(t, { holiday: null })
  const calls = []
  const deps = {
    nowMs: THU_0110_1000,
    credentials: id => ({ ready: true, accountId: id, host: HOST }),
    fetchSymbols: async (c, ids) => { calls.push([c.accountId, ids]); return { symbol: [hkSymbol([{ ...HOLIDAY_0110, startSecond: 0, endSecond: D }])] } },
  }
  const g = await resolveEntryMarketGate(db, { symbol: SYM, accountId: ACCT, host: HOST }, deps)
  assert.deepEqual(calls, [[ACCT, [SYM_ID]]])
  assert.equal(g.refresh, 'refreshed')
  assert.equal(g.status, 'CLOSED', 'the fresh calendar carries the holiday')
  // Now recorded: no second read.
  const again = await resolveEntryMarketGate(db, { symbol: SYM, accountId: ACCT, host: HOST }, deps)
  assert.equal(calls.length, 1)
  assert.equal(again.status, 'CLOSED')
})

test('a failed re-read leaves UNKNOWN standing, named, and is not retried inside the cooldown', async t => {
  const db = fixture(t, { holiday: null })
  let n = 0
  const deps = nowMs => ({ nowMs, credentials: id => ({ ready: true, accountId: id, host: HOST }), fetchSymbols: async () => { n++; throw new Error('timeout') } })
  const input = { symbol: SYM, accountId: ACCT, host: HOST }
  const first = await resolveEntryMarketGate(db, input, deps(WED_0930_1000))
  assert.equal(first.open, false); assert.equal(first.unknown, true)
  assert.match(first.refresh, /^failed: timeout/)
  const second = await resolveEntryMarketGate(db, input, deps(WED_0930_1000 + 60_000))
  assert.equal(second.refresh, 'cooldown'); assert.equal(n, 1)
  await resolveEntryMarketGate(db, input, deps(WED_0930_1000 + ENTRY_HOURS_REFRESH_COOLDOWN_MS))
  assert.equal(n, 2, 'retried after the cooldown')
})

test('credentials for another account or host are never used for the re-read', async t => {
  const db = fixture(t, { holiday: null })
  let fetched = false
  const g = await resolveEntryMarketGate(db, { symbol: SYM, accountId: ACCT, host: HOST }, {
    nowMs: WED_0930_1000, credentials: () => ({ ready: true, accountId: ACCT, host: 'live.ctraderapi.com' }),
    fetchSymbols: async () => { fetched = true; return { symbol: [] } },
  })
  assert.equal(fetched, false)
  assert.equal(g.refresh, 'credentials_unavailable')
  assert.equal(g.open, false)
})

// --- loop.js autoTrade: the wiring, by behaviour ---------------------------

const SYNTH = { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, tp2: 106, strategy: 'tsmom_long', timeframe: '1d', overall_conviction: 8 }
async function withCreds(fn) {
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'c'; process.env.CTRADER_CLIENT_SECRET = 's'
  try { return await fn() } finally {
    if (saved.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = saved.secret
  }
}

test('autoTrade: a holiday TODAY on the account calendar takes the closed-market branch — no market order', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  _resetEntryHoursRefresh()
  const now = Date.now(), today = Math.floor(now / 86400_000)
  setState(db, 'ctrader_access_token', 't')
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(ACCT, ACCT)
  setState(db, 'closed_market_limits_json', JSON.stringify({ on: false })) // legacy queue: no broker call
  setState(db, accountSymbolMapKey(ACCT), JSON.stringify({ builtAt: new Date(now).toISOString(), accountId: ACCT, map: { [SYM]: SYM_ID } }))
  // Open every second of the week, closed all of today (UTC) by a holiday row.
  recordMarketCalendar(db, IDENTITY, { symbolId: SYM_ID, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: [{ startSecond: 0, endSecond: W }],
    holiday: [{ holidayId: 9, name: 'today', scheduleTimeZone: 'UTC', holidayDate: today, isRecurring: false, startSecond: 0, endSecond: D }] }, { nowMs: now })
  db.prepare('INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)').run(SYM, '[]', 'UTC') // the old gate: always open
  const { autoTrade } = await import('../loop.js')
  const out = await withCreds(() => autoTrade(db, SYM, SYNTH, {}, { accountId: ACCT, isLive: false, producerId: 'daily_momentum_account' }))
  assert.equal(out ?? null, null, 'nothing placed')
  const veto = db.prepare('SELECT veto_reason FROM risk_events').all().map(r => r.veto_reason)
  assert.equal(veto.length, 1)
  assert.match(veto[0], /^market_closed: 0700\.HK: closed per the account calendar \(broker holiday\)/, 'RED if autoTrade still reads the name-keyed gate')
  assert.equal(db.prepare("SELECT count(*) AS n FROM pending_signals WHERE status = 'pending'").get().n, 1, 'queued for the reopen, as any closed market')
})

test('autoTrade: UNKNOWN refuses with ONE decision_log skip per (account, symbol), no veto, no queue, no limit', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  _resetEntryHoursRefresh()
  setState(db, 'ctrader_access_token', 't')
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(ACCT, ACCT)
  setState(db, 'closed_market_limits_json', JSON.stringify({ on: false }))
  // No account symbol map → UNKNOWN (account_symbol_map_missing); no broker re-read is possible.
  db.prepare('INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)').run(SYM, '[]', 'UTC') // the old gate: open
  const { autoTrade } = await import('../loop.js')
  for (let i = 0; i < 2; i++) {
    const out = await withCreds(() => autoTrade(db, SYM, SYNTH, {}, { accountId: ACCT, isLive: false, producerId: 'cross_sectional_book' }))
    assert.equal(out ?? null, null)
  }
  const skips = db.prepare("SELECT account_id, symbol, reason, detail_json FROM decision_log WHERE stage = 'market_hours_unknown'").all()
  assert.equal(skips.length, 1, 'RED if UNKNOWN is let through (no row) or re-written every call')
  assert.equal(skips[0].account_id, ACCT)
  assert.equal(skips[0].reason, 'market_hours_unknown: account_symbol_map_missing')
  const detail = JSON.parse(skips[0].detail_json)
  assert.equal(detail.producerId, 'cross_sectional_book')
  assert.equal(detail.proposal.side, 'BUY')
  assert.equal(db.prepare('SELECT count(*) AS n FROM risk_events').get().n, 0, 'a skip, not a veto')
  assert.equal(db.prepare('SELECT count(*) AS n FROM pending_signals').get().n, 0, 'UNKNOWN is not queued as closed')
})
