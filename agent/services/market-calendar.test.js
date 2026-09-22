import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState, getState } from '../db.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { recordMarketCalendar, readMarketCalendar, CALENDAR_MAX_AGE_MS } from './market-calendar.js'
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
    { holiday: [{}] }, { tradingMode: 'bogus' }, { holiday: [{ holidayDate: 1, isRecurring: false, scheduleTimeZone: 'UTC' }] },
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
