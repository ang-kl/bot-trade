import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { recordMarketCalendar, readMarketCalendar, storedHolidays, CALENDAR_MAX_AGE_MS } from './market-calendar.js'
import { refreshSymbolHours, isSymbolOpenCached } from './symbol-hours.js'
import stateRouter from '../routes/state.js'

const D = 86400, H = 3600
const HOUR_MS = H * 1000
const ID = { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }
const NOW = Date.parse('2026-09-22T06:00:00Z') // Tuesday
const spec = extra => ({ symbolId: 7, scheduleTimeZone: 'UTC', tradingMode: 0,
  schedule: [{ startSecond: D, endSecond: 5 * D + 21 * H }], holiday: [], ...extra })
function fixture(t) { const db = initDB(':memory:'); t.after(() => db.close()); return db }
const read = (db, nowMs = NOW, identity = ID) => readMarketCalendar(db, identity, { nowMs })
const write = (db, symbol = spec(), nowMs = NOW, identity = ID) => recordMarketCalendar(db, identity, symbol, { nowMs })
const cacheKey = identity => `market_calendar:v1:${marketIdentityKey(identity)}`

test('identity isolates account, environment and instrument; no unsafe numeric IDs or credentials', () => {
  assert.notEqual(marketIdentityKey(ID), marketIdentityKey({ ...ID, accountId: '22' }))
  assert.notEqual(marketIdentityKey(ID), marketIdentityKey({ ...ID, host: 'live.ctraderapi.com' }))
  assert.notEqual(marketIdentityKey(ID), marketIdentityKey({ ...ID, symbolId: '8' }))
  assert.deepEqual(marketIdentity({ ...ID, accessToken: 'never-persist-this' }), { provider: 'ctrader', ...ID })
  for (const extra of [{ host: 'unknown' }, { accountId: 'all' }, { symbolId: 2 ** 53 }, { accountId: null }, { symbolId: 0 }, { provider: 'other' }, { symbolId: ['7'] }, { accountId: {} }]) {
    assert.equal(marketIdentity({ ...ID, ...extra }), null)
  }
})

test('fresh observation is explicit about version, expiry, broker receipt time and trading mode', t => {
  const db = fixture(t)
  assert.equal(write(db).recorded, true)
  const r = read(db)
  assert.equal(r.marketStatus, 'OPEN')
  assert.equal(r.sourceTimestamp, null, 'receipt time is not a broker event timestamp')
  assert.equal(r.observedAt, new Date(NOW).toISOString())
  assert.equal(r.expiresAt, new Date(NOW + CALENDAR_MAX_AGE_MS).toISOString())
  assert.match(r.version, /^[a-f0-9]{64}$/)
  assert.equal(r.tradingMode, 'ENABLED')
  assert.equal(r.entryPermissionKnown, true)
  assert.equal(read(db, NOW, { ...ID, accountId: '22' }).reason, 'calendar_missing')
  assert.equal(read(db, NOW, { ...ID, host: 'live.ctraderapi.com' }).reason, 'calendar_missing')
})

test('age boundary, future time and invalid policy remain unknown, including after restart-style reads', t => {
  const db = fixture(t); write(db)
  assert.equal(read(db, NOW + CALENDAR_MAX_AGE_MS - 1).open, true)
  assert.equal(read(db, NOW + CALENDAR_MAX_AGE_MS).reason, 'calendar_stale')
  assert.equal(read(db, NOW - 1).reason, 'observation_time_future')
  assert.equal(readMarketCalendar(db, ID, { nowMs: NOW, maxAgeMs: 0 }).reason, 'freshness_policy_invalid')
  assert.equal(readMarketCalendar(db, ID, { nowMs: NaN }).reason, 'freshness_policy_invalid')
  const db2 = fixture(t)
  setState(db2, cacheKey(ID), getState(db, cacheKey(ID)))
  assert.deepEqual(read(db2, NOW + 1000), read(db, NOW + 1000), 'no restart grace or fresh timestamp')
})

test('new invalid evidence stays unknown and retains, but does not renew, the last valid record', t => {
  const db = fixture(t); write(db)
  const version = read(db).version
  write(db, spec({ schedule: [] }), NOW + 1000)
  const r = read(db, NOW + 1000)
  assert.equal(r.open, null)
  assert.equal(r.reason, 'calendar_schedule_missing')
  assert.equal(r.lastVerified.observedAt, new Date(NOW).toISOString())
  assert.equal(r.lastVerified.version, version)
  assert.equal(r.calendar, null)
})

test('malformed, empty, invalid-zone and contradictory calendar data never become verified open/closed', t => {
  const db = fixture(t)
  for (const extra of [
    { schedule: null }, { schedule: [] }, { schedule: [{ startSecond: 0, endSecond: 0 }] },
    { schedule: [{ startSecond: -1, endSecond: D }] }, { schedule: [{ startSecond: 0, endSecond: 8 * D }] },
    { scheduleTimeZone: 'Not/AZone' }, { scheduleTimeZone: null }, { holiday: null },
    { holiday: [{}] }, { tradingMode: 'bogus' },
    // V3 K1b: an omitted-bound row dated 1970 would now lie behind every
    // window and be skipped; recurring (it returns every year) and current
    // rows keep this list's meaning — never verified.
    { holiday: [{ holidayDate: 1, isRecurring: true, scheduleTimeZone: 'UTC' }] },
    { holiday: [{ holidayDate: 20727, isRecurring: false, scheduleTimeZone: 'UTC' }] },
  ]) {
    write(db, spec(extra))
    assert.equal(read(db).marketStatus, 'MARKET_STATUS_UNKNOWN', JSON.stringify(extra))
    assert.equal(read(db).open, null)
  }
})

test('broker holidays use their own zone, annual recurrence and explicit intraday/early-close windows', t => {
  const db = fixture(t)
  const holidayDate = Date.parse('2026-09-22T00:00:00Z') / (D * 1000)
  const holiday = { holidayDate, isRecurring: false, scheduleTimeZone: 'Asia/Singapore', startSecond: 14 * H, endSecond: 16 * H }
  write(db, spec({ holiday: [holiday] }), NOW - HOUR_MS)
  assert.equal(read(db, NOW - 1).open, true)
  assert.equal(read(db, NOW).reason, 'broker_holiday')
  assert.equal(read(db, NOW + 2 * HOUR_MS).open, true, 'exclusive holiday end')
  const nextYear = Date.parse('2027-09-22T06:00:00Z')
  write(db, spec({ holiday: [{ ...holiday, isRecurring: true }] }), nextYear)
  assert.equal(read(db, nextYear).reason, 'broker_holiday')
  write(db, spec({ holiday: [holiday] }), nextYear)
  assert.equal(read(db, nextYear).open, true, 'non-recurring past holiday is not applied next year')
})

test('week wrap, intraday breaks and crypto maintenance follow intervals, not asset names', t => {
  const db = fixture(t)
  const wrap = spec({ schedule: [{ startSecond: 6 * D + 22 * H, endSecond: 6 * H }] })
  const sat = Date.parse('2026-09-26T23:00:00Z')
  write(db, wrap, sat)
  assert.equal(read(db, sat).open, true)
  assert.equal(read(db, sat + 4 * HOUR_MS).open, true)
  assert.equal(read(db, sat + 7 * HOUR_MS).open, false)
  const split = spec({ symbolName: 'BTCUSD', schedule: [
    { startSecond: 2 * D, endSecond: 2 * D + 6 * H },
    { startSecond: 2 * D + 7 * H, endSecond: 3 * D },
  ] })
  write(db, split, NOW - HOUR_MS)
  assert.equal(read(db, NOW - 1).open, true)
  assert.equal(read(db, NOW).open, false)
  assert.equal(read(db, NOW + HOUR_MS).open, true)
})

test('DST spring/fall and Friday/Sunday openings use real IANA local times', t => {
  const db = fixture(t)
  const schedule = spec({ scheduleTimeZone: 'America/New_York', schedule: [{ startSecond: 9 * H, endSecond: 10 * H }] })
  for (const [day, hour] of [['2026-03-01', 14], ['2026-03-08', 13], ['2026-10-25', 13], ['2026-11-01', 14]]) {
    const at = Date.parse(`${day}T${hour}:00:00Z`)
    write(db, schedule, at - HOUR_MS)
    assert.equal(read(db, at - 1).open, false)
    assert.equal(read(db, at).open, true)
    assert.equal(read(db, at + HOUR_MS).open, false)
  }
  const fx = spec({ schedule: [{ startSecond: 22 * H, endSecond: 5 * D + 21 * H }] })
  for (const [at, expected] of [['2026-09-25T20:59:59Z', true], ['2026-09-25T21:00:00Z', false], ['2026-09-27T21:59:59Z', false], ['2026-09-27T22:00:00Z', true]]) {
    const now = Date.parse(at); write(db, fx, now)
    assert.equal(read(db, now).open, expected)
  }
})

test('trading mode is distinct from scheduled hours and never grants account admission', t => {
  const db = fixture(t)
  write(db, spec({ tradingMode: 3 }))
  assert.equal(read(db).open, true)
  assert.equal(read(db).tradingMode, 'CLOSE_ONLY_MODE')
  write(db, spec({ tradingMode: undefined }))
  assert.equal(read(db).entryPermissionKnown, false)
  assert.equal(read(db).tradingMode, null)
})

test('foreign identity, corrupt payloads, altered versions and oversized data stay unknown', t => {
  const db = fixture(t); write(db)
  const saved = getState(db, cacheKey(ID))
  const foreign = JSON.parse(saved); foreign.latest.identity.accountId = '22'
  setState(db, cacheKey(ID), JSON.stringify(foreign))
  assert.equal(read(db).reason, 'identity_mismatch')
  const changed = JSON.parse(saved); changed.latest.calendar.schedule[0].endSecond = 3 * D
  setState(db, cacheKey(ID), JSON.stringify(changed))
  assert.equal(read(db).reason, 'calendar_version_mismatch')
  setState(db, cacheKey(ID), '{bad')
  assert.equal(read(db).reason, 'calendar_read_failed')
  write(db, spec({ holiday: [{ name: 'x'.repeat(70000) }] }))
  assert.equal(read(db).reason, 'calendar_payload_too_large')
  assert.ok(getState(db, cacheKey(ID)).length < 2000)
  assert.equal(write(db, spec({ symbolId: 8 })).recorded, false)
})

test('a malformed identity in persisted evidence or caller input returns unknown instead of throwing', t => {
  const db = fixture(t); write(db)
  const saved = getState(db, cacheKey(ID))
  for (const identity of [null, false, 11, '11', [], {}]) {
    assert.equal(marketIdentity(identity), null)
    assert.equal(readMarketCalendar(db, identity, { nowMs: NOW }).reason, 'identity_required')
    const broken = JSON.parse(saved); broken.latest.identity = identity
    setState(db, cacheKey(ID), JSON.stringify(broken))
    assert.equal(read(db).reason, 'identity_mismatch')
    const brokenLast = JSON.parse(saved); brokenLast.lastVerified.identity = identity
    setState(db, cacheKey(ID), JSON.stringify(brokenLast))
    assert.equal(read(db).marketStatus, 'OPEN')
    assert.equal(read(db).lastVerified, null)
  }
})

test('existing refresh captures real identified responses without extra fetches or changing legacy gates', async t => {
  const db = fixture(t)
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 7 }))
  let calls = 0
  const fetch = async () => { calls++; return { ctidTraderAccountId: 11, symbol: [spec({ holiday: [{ name: 'incomplete' }] })] } }
  await refreshSymbolHours(db, { ...ID, ready: true }, { fetch })
  assert.equal(calls, 1)
  assert.equal(readMarketCalendar(db, ID).marketStatus, 'MARKET_STATUS_UNKNOWN')
  assert.equal(isSymbolOpenCached(db, 'EURUSD', new Date(NOW)).open, true, 'legacy entry interpretation remains unchanged')
  assert.equal(readMarketCalendar(db, { ...ID, accountId: '22' }).reason, 'calendar_missing')
  const before = getState(db, cacheKey(ID))
  await refreshSymbolHours(db, { ...ID, ready: true }, { fetch: async () => ({ ctidTraderAccountId: 22, symbol: [spec()] }) })
  assert.equal(getState(db, cacheKey(ID)), before, 'foreign response must not refresh own evidence')
  await refreshSymbolHours(db, { ...ID, ready: true }, { fetch: async () => { throw new Error('offline') } })
  assert.equal(getState(db, cacheKey(ID)), before, 'failed refresh must not stamp old data fresh')
})

// V3 K1 — two broker facts, two codes; the raw rows readable while UNKNOWN.
const holidayRow = extra => ({ holidayDate: 20727, isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong', name: 'National Day', ...extra })
test('omitted and present-but-invalid holiday bounds are distinct reasons, by precedence and not by row order', t => {
  const db = fixture(t)
  const cases = [
    [[holidayRow({})], 'holiday_bounds_omitted'],
    [[holidayRow({ endSecond: 36000 })], 'holiday_bounds_omitted'],
    [[holidayRow({ startSecond: 0 })], 'holiday_bounds_omitted'],
    [[holidayRow({ startSecond: null, endSecond: null })], 'holiday_bounds_omitted'],
    [[holidayRow({ startSecond: 36000, endSecond: 36000 })], 'holiday_bounds_invalid'],
    [[holidayRow({ startSecond: 0, endSecond: D + 1 })], 'holiday_bounds_invalid'],
    [[holidayRow({ startSecond: 1.5, endSecond: 3600 })], 'holiday_bounds_invalid'],
    [[holidayRow({}), holidayRow({ startSecond: 5, endSecond: 4 })], 'holiday_bounds_invalid'],
    [[holidayRow({ startSecond: 5, endSecond: 4 }), holidayRow({})], 'holiday_bounds_invalid'],
    [[holidayRow({}), { isRecurring: false }], 'calendar_holiday_invalid'],
  ]
  for (const [holiday, reason] of cases) {
    write(db, spec({ holiday }))
    const r = read(db)
    assert.equal(r.reason, reason, JSON.stringify(holiday))
    assert.equal(r.marketStatus, 'MARKET_STATUS_UNKNOWN', 'no boundary is invented: the whole calendar stays unknown')
  }
  write(db, spec({ holiday: [holidayRow({ startSecond: 0, endSecond: 36600 })] }))
  assert.equal(read(db).marketStatus, 'OPEN', 'explicit bounds, startSecond 0 included, still resolve')
})

test('unresolvedHolidays lists the stored rows exactly: absent bounds absent, sent bounds as sent; status unchanged', t => {
  const db = fixture(t)
  const diag = () => readMarketCalendar(db, ID, { nowMs: NOW, diagnostics: true })
  const bounded = holidayRow({ name: '07.09.2026 EC 20:00', holidayDate: 20703, scheduleTimeZone: 'Europe/Moscow', startSecond: 72000, endSecond: 86399 })
  write(db, spec({ holiday: [bounded, holidayRow({ holidayId: 9, description: 'HKEX' }), holidayRow({ name: 'Late', startSecond: 0 }), holidayRow({ name: 'Bad', startSecond: 9, endSecond: 3 })] }))
  assert.equal('unresolvedHolidays' in read(db), false, 'the status read (collector, contract) is unchanged: no diagnostic, no extra hash')
  const r = diag()
  assert.equal(r.marketStatus, 'MARKET_STATUS_UNKNOWN'); assert.equal(r.calendar, null)
  assert.deepEqual(r.unresolvedHolidays, [
    { reason: 'holiday_bounds_omitted', holidayId: 9, name: 'National Day', description: 'HKEX', holidayDate: 20727, dateIso: '2026-10-01', isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong' },
    { reason: 'holiday_bounds_omitted', holidayId: null, name: 'Late', description: null, holidayDate: 20727, dateIso: '2026-10-01', isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong', startSecond: 0 },
    { reason: 'holiday_bounds_invalid', holidayId: null, name: 'Bad', description: null, holidayDate: 20727, dateIso: '2026-10-01', isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong', startSecond: 9, endSecond: 3 },
  ], 'the bounded row is not listed; no row gains a bound it was not sent')
  write(db, spec({ holiday: [bounded] }))
  assert.deepEqual(diag().unresolvedHolidays, [], 'a resolved calendar has none')
  write(db, spec({ holiday: Array.from({ length: 400 }, () => holidayRow({})) }))
  assert.equal(read(db).reason, 'calendar_holidays_invalid')
  assert.equal(diag().unresolvedHolidays.length, 366, 'bounded at 366')
  const saved = JSON.parse(getState(db, cacheKey(ID))); saved.latest.version = 'f'.repeat(64)
  setState(db, cacheKey(ID), JSON.stringify(saved))
  assert.equal(diag().unresolvedHolidays, null, 'an altered payload is not described')
})

test('a row stored under the old combined code reads as the split code its own payload implies', t => {
  const db = fixture(t)
  for (const [holiday, reason] of [[holidayRow({}), 'holiday_bounds_omitted'], [holidayRow({ startSecond: 7, endSecond: 7 }), 'holiday_bounds_invalid']]) {
    write(db, spec({ holiday: [holiday] }))
    const stored = JSON.parse(getState(db, cacheKey(ID)))
    stored.latest.reason = 'calendar_holiday_window_unknown' // exactly what the pre-K1 collector stored
    setState(db, cacheKey(ID), JSON.stringify(stored))
    assert.equal(read(db).reason, reason)
    assert.equal(read(db).open, null)
  }
})

test('HTTP calendar consumer requires identity, has no name/global fallback and never caches current status', async t => {
  const db = fixture(t)
  db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)').run('11', 0)
  db.prepare('INSERT INTO accounts (account_id, is_live) VALUES (?, ?)').run('22', 1)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = params => fetch(`http://127.0.0.1:${server.address().port}/state/market-calendar${params}`)
  for (const params of ['', '?account=all&symbolId=7', '?account=33&symbolId=7', '?account=11&symbolId=EURUSD', '?account=11&symbolId=7&symbolId=8']) {
    assert.equal((await get(params)).status, 400)
  }
  recordMarketCalendar(db, ID, spec({ schedule: [{ startSecond: 0, endSecond: 7 * D }] }))
  let r = await get('?account=11&symbolId=7')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal((await r.json()).open, true)
  assert.equal((await (await get('?account=22&symbolId=7')).json()).reason, 'calendar_missing')
  recordMarketCalendar(db, ID, spec({ schedule: [] }))
  r = await get('?account=11&symbolId=7')
  assert.equal((await r.json()).open, null, 'a prior successful status cannot survive new invalid evidence')
})

// ---- V3 K1b: a holiday row whose bounds cannot be read, dated three or more
// UTC days before its own observation, lies behind every window and is
// skipped; a current one keeps the calendar unknown.
// REWRITTEN IN THE OPEN for V3 K3 (owner OD-7, 26-09): these tests were written
// on production's 0/0 "Closed" rows, which K1b could not read. K3 gives the
// 0/0 pair a meaning — the whole local day — so a 0/0 row is no longer
// unreadable and no longer exercises this rule (it is evaluated; see the K3
// tests below). The K1b rule still governs every OTHER unreadable pair, so
// the same cases now run on a sent-but-invalid pair (startSecond 5 >
// endSecond 4, holiday_bounds_invalid) and on omitted bounds.
const OBS_DAY = Math.floor(NOW / (D * 1000)) // 20718 = 2026-09-22
const unreadable = (holidayDate, extra = {}) => ({ holidayId: holidayDate, name: `${new Date(holidayDate * D * 1000).toISOString().slice(0, 10)} Closed`,
  holidayDate, isRecurring: false, scheduleTimeZone: 'Europe/Moscow', startSecond: 5, endSecond: 4, ...extra })

test('K1b: an unreadable row three UTC days before its observation is skipped; two days, current and future rows stay unknown', t => {
  const db = fixture(t)
  const cases = [
    [[unreadable(OBS_DAY - 3)], 'OPEN', null],
    [[unreadable(20447, { name: '25.12.2025 - Closed' }), unreadable(20454, { name: '01.01.2026 - Closed' }),
      unreadable(20703, { name: '07.09.2026 Closed', scheduleTimeZone: 'Europe/Bucharest' }), unreadable(19716, { name: '25.12.2023 - Closed' })], 'OPEN', null],
    [[unreadable(OBS_DAY - 2)], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    [[unreadable(OBS_DAY - 1)], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    [[unreadable(OBS_DAY)], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    [[unreadable(OBS_DAY + 9)], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    // One current row keeps the whole calendar unknown, whatever else is skipped.
    [[unreadable(20447), unreadable(20454), unreadable(OBS_DAY)], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    // A recurring row returns every year: it never expires.
    [[unreadable(20447, { isRecurring: true })], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_invalid'],
    // Omitted bounds are unreadable too, and expire the same way.
    [[holidayRow({ holidayDate: OBS_DAY - 3 })], 'OPEN', null],
    [[holidayRow({ holidayDate: OBS_DAY - 2 })], 'MARKET_STATUS_UNKNOWN', 'holiday_bounds_omitted'],
    // The row's structure is still checked: only its bounds are skipped.
    [[unreadable(OBS_DAY - 3, { scheduleTimeZone: 'Not/AZone' })], 'MARKET_STATUS_UNKNOWN', 'calendar_holiday_invalid'],
  ]
  for (const [holiday, status, reason] of cases) {
    const label = JSON.stringify(holiday.map(h => [h.holidayDate, h.isRecurring]))
    assert.equal(write(db, spec({ holiday })).reason, reason, `recorded ${label}`)
    const r = read(db)
    assert.equal(r.marketStatus, status, label)
    assert.equal(r.reason, reason, label)
  }
})

test('K1b: the cut is the observation\'s own UTC day, not the reader\'s clock', t => {
  const db = fixture(t)
  const row = unreadable(OBS_DAY - 2) // 2026-09-20
  const midnight = (OBS_DAY + 1) * D * 1000 // 2026-09-23T00:00:00.000Z, a Wednesday
  write(db, spec({ holiday: [row] }), midnight - 1)
  assert.equal(read(db, midnight - 1).reason, 'holiday_bounds_invalid', 'observed 22-09 23:59:59.999Z: the row is two days old')
  assert.equal(read(db, midnight + HOUR_MS).reason, 'holiday_bounds_invalid', 'a later read never re-judges an observation at its own clock')
  write(db, spec({ holiday: [row] }), midnight)
  assert.equal(read(db, midnight).marketStatus, 'OPEN', 'observed 23-09 00:00:00.000Z: three days old')
})

test('K1b: a skipped row stays in the stored payload (same version) and is listed as holiday_expired_ignored, never hidden', t => {
  const db = fixture(t)
  const old = unreadable(20447, { name: '25.12.2025 - Closed' }), current = unreadable(OBS_DAY, { name: '22.09.2026 Closed' })
  const symbol = spec({ holiday: [old] })
  const { version } = write(db, symbol)
  const diag = () => readMarketCalendar(db, ID, { nowMs: NOW, diagnostics: true })
  let r = diag()
  assert.equal(r.marketStatus, 'OPEN')
  assert.equal(r.version, version)
  assert.deepEqual(r.calendar.holiday, [old], 'the row is kept in the payload')
  assert.equal(version, createHash('sha256').update(JSON.stringify({ scheduleTimeZone: 'UTC', schedule: symbol.schedule, holiday: [old], tradingMode: 'ENABLED' })).digest('hex'),
    'the version hashes the payload WITH the skipped row: nothing was dropped to resolve it')
  assert.deepEqual(r.unresolvedHolidays, [])
  assert.deepEqual(r.expiredHolidays, [{ reason: 'holiday_bounds_invalid', ignored: 'holiday_expired_ignored', holidayId: 20447, name: '25.12.2025 - Closed',
    description: null, holidayDate: 20447, dateIso: '2025-12-25', isRecurring: false, scheduleTimeZone: 'Europe/Moscow', startSecond: 5, endSecond: 4 }])
  assert.equal('expiredHolidays' in read(db), false, 'the status read carries no diagnostic')
  write(db, spec({ holiday: [old, current] }))
  r = diag()
  assert.equal(r.reason, 'holiday_bounds_invalid')
  assert.deepEqual(r.unresolvedHolidays.map(h => [h.name, h.ignored]), [['22.09.2026 Closed', undefined]], 'only the current row keeps it unknown')
  assert.deepEqual(r.expiredHolidays.map(h => h.name), ['25.12.2025 - Closed'])
})

test('K1b: a record stored before K1b, or under the old combined code, is re-judged from its own payload at its own observation time', t => {
  const db = fixture(t)
  const storedAs = code => { const s = JSON.parse(getState(db, cacheKey(ID))); s.latest.reason = code; s.lastVerified = null; setState(db, cacheKey(ID), JSON.stringify(s)) }
  for (const code of ['holiday_bounds_invalid', 'calendar_holiday_window_unknown']) {
    const { version } = write(db, spec({ holiday: [unreadable(20447), unreadable(OBS_DAY - 3)] }))
    storedAs(code) // exactly what the pre-K1b (or pre-K1) collector stored for this payload
    assert.equal(read(db).marketStatus, 'OPEN', code)
    assert.equal(read(db).version, version)
    assert.equal(read(db, NOW + CALENDAR_MAX_AGE_MS).reason, 'calendar_stale', 'a re-judged record still ages out')
    write(db, spec({ holiday: [unreadable(OBS_DAY - 2)] }))
    storedAs(code)
    assert.equal(read(db).reason, 'holiday_bounds_invalid', `${code}: a row that can still reach a window keeps it unknown`)
  }
  // A payload that no longer matches its version keeps its stored code.
  write(db, spec({ holiday: [unreadable(20447)] }))
  const altered = JSON.parse(getState(db, cacheKey(ID)))
  altered.latest.reason = 'holiday_bounds_invalid'; altered.latest.version = 'f'.repeat(64)
  setState(db, cacheKey(ID), JSON.stringify(altered))
  assert.equal(read(db).reason, 'holiday_bounds_invalid')
})

test('K1b: lastVerified keeps an observation that resolved past a skipped row, judged at that observation\'s own time', t => {
  const db = fixture(t)
  const { version } = write(db, spec({ holiday: [unreadable(20447)] }))
  write(db, spec({ schedule: [] }), NOW + 1000)
  assert.equal(JSON.parse(getState(db, cacheKey(ID))).lastVerified?.version, version, 'the record path retains it')
  const r = read(db, NOW + 1000)
  assert.equal(r.reason, 'calendar_schedule_missing')
  assert.equal(r.lastVerified?.version, version, 'the read path returns it')
  assert.equal(r.lastVerified.observedAt, new Date(NOW).toISOString())
})

test('K1b: a skipped row is never evaluated — the eight-day projection lookback matches the same calendar without it', t => {
  const db = fixture(t)
  // Out-of-range bounds (endSecond past the day) four days back: evaluated, it would close that whole local day.
  const odd = { holidayDate: OBS_DAY - 4, isRecurring: false, scheduleTimeZone: 'UTC', name: 'odd', startSecond: 0, endSecond: D + 3600 }
  const always = { schedule: [{ startSecond: 0, endSecond: 7 * D }] }
  write(db, spec({ ...always, holiday: [odd] }))
  const other = { ...ID, symbolId: '8' }
  write(db, spec({ ...always, symbolId: 8 }), NOW, other)
  const withRow = read(db), without = read(db, NOW, other)
  assert.equal(withRow.marketStatus, 'OPEN')
  assert.notEqual(withRow.version, without.version)
  const a = projectCalendar(withRow, NOW), b = projectCalendar(without, NOW)
  assert.deepEqual(a.intervals, b.intervals, 'RED if calendarAt reads a meaning into the unreadable row')
  assert.equal(a.intervals.length, 1)
  // A readable holiday on the same day still closes it: evaluation of explicit bounds is unchanged.
  const third = { ...ID, symbolId: '9' }
  write(db, spec({ ...always, symbolId: 9, holiday: [{ ...odd, endSecond: D }] }), NOW, third)
  assert.equal(projectCalendar(read(db, NOW, third), NOW).intervals.length, 2)
})

// ---- V3 K3 (owner OD-7, answered yes 26-09-2026): a 0/0 holiday row means
// CLOSED for the whole local day, in the row's own zone. The worst case reads
// closed when the market was open, never the reverse.
const zeroZero = (holidayDate, extra = {}) => ({ holidayId: holidayDate, name: 'National Day', holidayDate, isRecurring: false,
  scheduleTimeZone: 'Asia/Hong_Kong', startSecond: 0, endSecond: 0, ...extra })
const ALWAYS = { schedule: [{ startSecond: 0, endSecond: 7 * D }] }
const at = iso => Date.parse(iso)
// A 3-day freshness policy so one observation covers the whole holiday (the policy allows up to 7).
const readAt = (db, iso) => readMarketCalendar(db, ID, { nowMs: at(iso), maxAgeMs: 3 * CALENDAR_MAX_AGE_MS })

test('K3: a current 0/0 row reads CLOSED for the whole local day in its own zone, and OPEN either side of it', t => {
  const db = fixture(t)
  const observed = at('2026-09-30T12:00:00Z')
  // HKEX National Day, 01-10-2026: local 00:00 HKT = 30-09 16:00Z; next local midnight = 01-10 16:00Z.
  assert.equal(write(db, spec({ ...ALWAYS, holiday: [zeroZero(20727)] }), observed).reason, null, 'recorded as a resolved calendar, not holiday_bounds_invalid')
  const cases = [
    ['2026-09-30T15:59:59.999Z', 'OPEN', null],
    ['2026-09-30T16:00:00.000Z', 'CLOSED', 'broker_holiday'],
    ['2026-10-01T03:00:00.000Z', 'CLOSED', 'broker_holiday'],
    ['2026-10-01T15:59:59.999Z', 'CLOSED', 'broker_holiday'],
    ['2026-10-01T16:00:00.000Z', 'OPEN', null],
  ]
  for (const [iso, status, reason] of cases) {
    const r = readAt(db, iso)
    assert.equal(r.marketStatus, status, iso)
    assert.equal(r.reason, reason, iso)
  }
})

test('K3: the projection (what the verifier and scanners read) carries the same whole-day gap', t => {
  const db = fixture(t)
  const observed = at('2026-09-30T12:00:00Z')
  write(db, spec({ ...ALWAYS, holiday: [zeroZero(20727)] }), observed)
  const p = projectCalendar(read(db, observed), observed)
  const closedGap = p.intervals.findIndex(i => i.toMs === at('2026-09-30T16:00:00Z'))
  assert.ok(closedGap >= 0, 'an interval ends at local midnight HKT')
  assert.equal(p.intervals[closedGap + 1].fromMs, at('2026-10-01T16:00:00Z'), 'the next opens at the following local midnight: the end is 86400 s, not 0')
})

test('K3: a future 0/0 row no longer makes today UNKNOWN; a past one inside the lookback is a closed day, not skipped', t => {
  const db = fixture(t)
  write(db, spec({ holiday: [zeroZero(OBS_DAY + 9)] }))
  assert.equal(read(db).marketStatus, 'OPEN', 'Tuesday 06:00Z, FX schedule open; the holiday is nine days away')
  write(db, spec({ holiday: [zeroZero(OBS_DAY)] }))
  assert.equal(read(db).marketStatus, 'CLOSED', 'the current day in Hong Kong (22-09 14:00 HKT) is closed')
  const r = readMarketCalendar(db, ID, { nowMs: NOW, diagnostics: true })
  assert.deepEqual(r.unresolvedHolidays, [], 'nothing is unresolved')
  assert.deepEqual(r.expiredHolidays, [], 'nothing is skipped')
  assert.deepEqual(storedHolidays(db, ID).holidays.map(h => [h.reason, h.interpreted]), [[null, 'holiday_full_local_day']], 'the row is labelled with the meaning K3 gave it')
})

test('K3: only the exact 0/0 pair gets the meaning — omitted, single and other invalid bounds stay UNKNOWN', t => {
  const db = fixture(t)
  for (const [extra, reason] of [
    [{ startSecond: undefined, endSecond: undefined }, 'holiday_bounds_omitted'],
    [{ startSecond: 0, endSecond: undefined }, 'holiday_bounds_omitted'],
    [{ startSecond: undefined, endSecond: 0 }, 'holiday_bounds_omitted'],
    [{ startSecond: 0, endSecond: null }, 'holiday_bounds_omitted'],
    [{ startSecond: '0', endSecond: '0' }, 'holiday_bounds_invalid'],
    [{ startSecond: 7, endSecond: 7 }, 'holiday_bounds_invalid'],
    [{ startSecond: 0, endSecond: D + 1 }, 'holiday_bounds_invalid'],
  ]) {
    const row = zeroZero(OBS_DAY, extra)
    for (const k of ['startSecond', 'endSecond']) if (row[k] === undefined) delete row[k]
    write(db, spec({ holiday: [row] }))
    const r = read(db)
    assert.equal(r.marketStatus, 'MARKET_STATUS_UNKNOWN', JSON.stringify(extra))
    assert.equal(r.reason, reason, JSON.stringify(extra))
  }
})

test('K3: a 0/0 row on a DST day closes the whole local day — 25 UTC hours on the EU autumn change', t => {
  const db = fixture(t)
  const observed = at('2026-10-24T12:00:00Z')
  // 25-10-2026 in Bucharest: local 00:00 EEST = 24-10 21:00Z; next local midnight 00:00 EET = 25-10 22:00Z.
  write(db, spec({ ...ALWAYS, holiday: [zeroZero(20751, { scheduleTimeZone: 'Europe/Bucharest' })] }), observed)
  assert.equal(readAt(db, '2026-10-24T20:59:59Z').marketStatus, 'OPEN')
  assert.equal(readAt(db, '2026-10-24T21:00:00Z').marketStatus, 'CLOSED')
  assert.equal(readAt(db, '2026-10-25T21:59:59Z').marketStatus, 'CLOSED', 'the 25th local hour is still the holiday')
  assert.equal(readAt(db, '2026-10-25T22:00:00Z').marketStatus, 'OPEN')
})

test('K3: a recurring 0/0 row closes that local date every year', t => {
  const db = fixture(t)
  const observed = at('2026-12-24T12:00:00Z') // Thu 24-12; 25-12 is a Friday, the FX schedule open
  write(db, spec({ holiday: [zeroZero(20447, { isRecurring: true, scheduleTimeZone: 'Europe/Moscow', name: '25.12 - Closed' })] }), observed)
  assert.equal(readAt(db, '2026-12-25T06:00:00Z').marketStatus, 'CLOSED')
  assert.equal(readAt(db, '2026-12-24T21:00:00Z').marketStatus, 'CLOSED', 'Moscow 25-12 00:00:00')
  assert.equal(readAt(db, '2026-12-24T20:59:59Z').marketStatus, 'OPEN', 'Moscow 24-12 23:59:59')
})

test('K3: a record stored before K3 as holiday_bounds_invalid is re-judged from its own payload — no re-collection needed', t => {
  const db = fixture(t)
  write(db, spec({ holiday: [zeroZero(OBS_DAY)] }))
  const s = JSON.parse(getState(db, cacheKey(ID))); s.latest.reason = 'holiday_bounds_invalid'; setState(db, cacheKey(ID), JSON.stringify(s))
  assert.equal(read(db).marketStatus, 'CLOSED')
})

