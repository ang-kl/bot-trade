// node --test agent/services/calendar-coverage.test.js
//
// V3 K1 — calendar coverage per account, each calendar carried once.
//   - the demand is tiered feed → position → legacy → scope, and the tier
//     order is applied where the 512-identity cap bites (the add() order):
//     over 512 identities every gateway-feed identity is still demanded AND
//     exported;
//   - a scope account is demanded through its OWN map; a missing map is
//     missing coverage; paused and external held positions are demanded;
//   - at realistic size (7 accounts, ~420 identities, known weekday
//     calendars) the contract stays under cpp-verify's 256 KiB bound with
//     `work` intact — and every work item's calendar, resolved the way
//     cpp-verify resolves it (watchdog_state.cpp:148-152, ported below),
//     answers OPEN/CLOSED/UNKNOWN exactly as the pre-K1 full projection did;
//   - GET /state/calendar-coverage: not cached, built on the read-only worker
//     (0 statements on the management connection), explicit 503 on failure,
//     behind the app-level auth middleware, no broker connection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { recordMarketCalendar, readMarketCalendar } from './market-calendar.js'
import { recordScannerWork, watchdogCalendars } from './scanner-work.js'
import { watchdogCalendarDemand, createWatchdogCalendarRefresh } from './watchdog-calendar-refresh.js'
import { nodeWatchdogContract, CONTRACT_MAX_BYTES } from './watchdog-contract.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { buildCalendarCoverage } from './calendar-coverage.js'
import stateRouter from '../routes/state.js'

const H = 3600, D = 86400
const now = Date.parse('2026-09-25T06:00:00Z') // Friday
const size = v => Buffer.byteLength(JSON.stringify(v))
const DEMO = 'demo.ctraderapi.com', LIVE = 'live.ctraderapi.com'
const ACCOUNTS = ['42993489', '43002148', '43069009', '43097342', '46130058', '46979908', '47790949']
const IS_LIVE = new Set(['43002148', '43069009', '47790949'])
const hostOf = id => IS_LIVE.has(id) ? LIVE : DEMO

// ---- cpp-verify's calendar resolution and market(), ported line for line ----
const str = v => typeof v === 'string' ? v : ''
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && Number.isInteger(v) && v <= 9007199254740991 ? v : 0
const fresh = (at, t, age) => at > 0 && at <= t && t - at < age
const positiveId = v => typeof v === 'string' && v.length > 0 && v.length <= 19 && v[0] !== '0' && /^\d+$/.test(v)
/** watchdog_state.cpp:148-152 — the first `calendars` entry with the same
 * accountId/host/symbolId strings replaces the item's own calendar. */
function resolveLikeVerifier(contract, w) {
  for (const c of contract.calendars) {
    if (str(c.identity?.accountId) === str(w.accountId) && str(c.identity?.host) === str(w.host) && str(c.identity?.symbolId) === str(w.symbolId)) return { ...w, calendar: c.calendar }
  }
  return w
}
/** watchdog_state.cpp:19-42. */
function verifierMarket(w, t) {
  const c = w.calendar
  if (!c || typeof c !== 'object' || Array.isArray(c) || !positiveId(w.accountId) || !positiveId(w.symbolId) || (w.host !== DEMO && w.host !== LIVE)
    || str(c.identity?.provider) !== 'ctrader' || str(c.identity?.accountId) !== str(w.accountId) || str(c.identity?.host) !== str(w.host)
    || str(c.identity?.symbolId) !== str(w.symbolId) || c.source !== 'ctrader:ProtoOASymbol' || !str(c.version)
    || !fresh(num(c.observedAtMs), t, 86400000) || num(c.fromMs) > t || num(c.toMs) <= t || num(c.expiresAtMs) <= t
    || !Array.isArray(c.intervals) || c.intervals.length > 256) return 'UNKNOWN'
  let previous = num(c.fromMs), open = false
  for (const iv of c.intervals) {
    const a = num(iv.fromMs), b = num(iv.toMs)
    if (a < previous || b <= a || b > num(c.toMs)) return 'UNKNOWN'
    previous = b
    if (a <= t && t < b) open = true
  }
  return open ? 'OPEN' : 'CLOSED'
}

// ---- fixtures ----
function database(t, accounts = ACCOUNTS) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of accounts) db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run(id, IS_LIVE.has(id) ? 1 : 0)
  setState(db, 'telegram_notify_json', JSON.stringify({ enabled: false }))
  return db
}
const daily = (from, to, days = [1, 2, 3, 4, 5]) => days.map(d => ({ startSecond: d * D + from, endSecond: d * D + to }))
// Nine broker schedule shapes seen in production (24/5 FX, 23 h index days,
// cash sessions in five zones incl. lunch breaks, 24/7 crypto).
const SHAPES = [
  { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 21 * H, endSecond: 5 * D + 21 * H }] },
  { scheduleTimeZone: 'UTC', schedule: daily(22 * H, 22 * H + 23 * H - 60, [0, 1, 2, 3, 4]) },
  { scheduleTimeZone: 'America/New_York', schedule: daily(9.5 * H, 16 * H) },
  { scheduleTimeZone: 'Europe/London', schedule: daily(8 * H, 16.5 * H) },
  { scheduleTimeZone: 'Asia/Tokyo', schedule: daily(9 * H, 15.5 * H) },
  { scheduleTimeZone: 'Australia/Sydney', schedule: [...daily(10 * H, 16 * H), ...daily(16 * H + 600, 17 * H)] },
  { scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 7 * D }] },
  { scheduleTimeZone: 'Asia/Hong_Kong', schedule: [...daily(9.5 * H, 12 * H), ...daily(13 * H, 16 * H)] },
  { scheduleTimeZone: 'UTC', schedule: daily(23 * H, 23 * H + 22 * H, [0, 1, 2, 3, 4]) },
]
// Account-specific bounded holidays (production EC rows), so versions differ per account as they do live.
const ecHoliday = tag => [{ holidayDate: 20703, isRecurring: false, scheduleTimeZone: 'Europe/Moscow', startSecond: 72000, endSecond: 86399, name: `07.09.2026 EC ${tag}` }]
const NAMES = Array.from({ length: 70 }, (_, i) => `SYM${i}`)
function seedAccount(db, id, n, { names = NAMES, calendars = true } = {}) {
  const map = Object.fromEntries(names.map((s, i) => [s, 1000 * (n + 1) + i]))
  setState(db, `symbol_id_map:${id}`, JSON.stringify({ builtAt: new Date(now - 3600_000).toISOString(), map }))
  if (calendars) for (const [i, s] of names.entries()) {
    recordMarketCalendar(db, { host: hostOf(id), accountId: id, symbolId: String(map[s]) },
      { symbolId: map[s], ...SHAPES[i % SHAPES.length], holiday: ecHoliday(`${id}-${i % 2}`) }, { nowMs: now - 1000 })
  }
  return map
}
const feedHealth = (db, key, feedAccountId, ids) => setState(db, `${key}_health_json`, JSON.stringify({ at: new Date(now).toISOString(), ok: true, tick: { feedAccountId: Number(feedAccountId), subscribed: ids.map(Number) } }))
const barReceipt = (db, feed, map, scope, names) => recordScannerWork(db, { creds: { provider: 'ctrader', host: hostOf(feed), accountId: feed, ready: true }, scopeAccounts: scope, symbolMap: map,
  result: { scans: names.map(symbol => ({ symbol })), errors: [], coverage: { scanned: names.length, total: names.length } }, completedAt: now - 500, nextDue: now + 300_000 })
const position = (db, account, symbol, { paused = 0, source = 'autopilot' } = {}) => db.prepare("INSERT INTO monitored_positions (symbol,account_id,source,created_at,paused,status) VALUES (?,?,?,?,?,'active')")
  .run(symbol, account, source, new Date(now - 60_000).toISOString(), paused)
const pairs = identities => identities.map(i => `${i.accountId}:${i.symbolId}`)

// The realistic seven-account load (production 25-09: 2 gateway feeds, 32 held
// positions of which 26 paused and 1 external, the 59-name bar scan on
// 46130058 scoped to all 7 accounts).
function realistic(t) {
  const db = database(t), maps = {}
  for (const [n, id] of ACCOUNTS.entries()) maps[id] = seedAccount(db, id, n)
  for (let i = 0; i < 32; i++) position(db, ACCOUNTS[i % 7], NAMES[i], { paused: i >= 5 && i < 31 ? 1 : 0, source: i === 31 ? 'external' : 'autopilot' })
  const bar = NAMES.slice(0, 59)
  barReceipt(db, '46130058', maps['46130058'], ACCOUNTS, bar)
  const feedNames = bar.slice(0, 56)
  feedHealth(db, 'cpp_exec_demo', '46130058', feedNames.map(s => maps['46130058'][s]))
  feedHealth(db, 'cpp_exec', '43069009', feedNames.map(s => maps['43069009'][s]))
  const feed = new Set([...feedNames.map(s => `46130058:${maps['46130058'][s]}`), ...feedNames.map(s => `43069009:${maps['43069009'][s]}`)])
  return { db, maps, feed }
}

// ---- demand tiers ----
test('over 512 identities the gateway feeds meet the cap first: every feed identity is demanded and exported', t => {
  const db = database(t), maps = {}
  for (const [n, id] of ACCOUNTS.entries()) maps[id] = seedAccount(db, id, n, { names: NAMES.slice(0, 59), calendars: false })
  // 120 feed ids on the demo feed account, each with a known calendar.
  const feedIds = Array.from({ length: 120 }, (_, i) => String(90_000 + i))
  for (const [i, symbolId] of feedIds.entries()) recordMarketCalendar(db, { host: DEMO, accountId: '46130058', symbolId }, { symbolId: Number(symbolId), ...SHAPES[i % 3], holiday: [] }, { nowMs: now - 1000 })
  feedHealth(db, 'cpp_exec_demo', '46130058', feedIds)
  for (let i = 0; i < 40; i++) position(db, ACCOUNTS[i % 7], NAMES[i])
  barReceipt(db, '46130058', maps['46130058'], ACCOUNTS, NAMES.slice(0, 59))
  const demand = watchdogCalendarDemand(db, now)
  assert.equal(demand.identities.length, 512)
  assert.equal(demand.complete, false, '120 + 40 + 59 + 7 × 59 wanted > 512')
  const demanded = new Set(pairs(demand.identities))
  const missingFeed = feedIds.filter(id => !demanded.has(`46130058:${id}`))
  assert.deepEqual(missingFeed, [], 'RED if the feed add() calls run after the cap is reached')
  assert.equal(demand.byTier.feed, 120)
  assert.ok(demand.byTier.position > 0 && demand.byTier.scope > 0)
  assert.deepEqual(pairs(demand.identities.slice(0, 120)), feedIds.map(id => `46130058:${id}`), 'the feed tier leads')
  const out = watchdogCalendars(db, now)
  const exported = new Set(out.calendars.filter(c => c.calendar).map(c => `${c.identity.accountId}:${c.identity.symbolId}`))
  assert.deepEqual(feedIds.filter(id => !exported.has(`46130058:${id}`)), [], 'every feed calendar is inside the 96 KiB export')
  assert.equal(out.demandComplete, false)
  assert.equal(out.calendarsComplete, false)
})

test('a scope account is demanded through its OWN map; a missing map or name is missing coverage, never an empty demand', t => {
  const db = database(t, ['46130058', '46979908', '43002148'])
  setState(db, 'symbol_id_map:46130058', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7, GBPUSD: 8 } }))
  setState(db, 'symbol_id_map:46979908', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 99 } }))
  barReceipt(db, '46130058', { EURUSD: 7, GBPUSD: 8 }, ['46130058', '46979908', '43002148'], ['EURUSD', 'GBPUSD'])
  const demand = watchdogCalendarDemand(db, now)
  assert.deepEqual(pairs(demand.identities), ['46130058:7', '46130058:8', '46979908:99'], 'RED if the scope loop is dropped: 46979908 gets nothing')
  assert.equal(demand.detail.get(JSON.stringify(['ctrader', DEMO, '46979908', '99'])).tier, 'scope')
  assert.ok(!pairs(demand.identities).includes('46979908:7'), 'never the feed account\'s id')
  assert.equal(demand.complete, false)
  assert.deepEqual(demand.unresolved.get('43002148'), { missingMap: true, unresolvedNames: 0 })
  assert.deepEqual(demand.unresolved.get('46979908'), { missingMap: false, unresolvedNames: 1 }, 'GBPUSD is not in its own map')
})

test('paused and external held positions are demanded: ownership does not change market hours', t => {
  const db = database(t, ['46130058'])
  setState(db, 'symbol_id_map:46130058', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7, 'KO.US': 21, XAUUSD: 41 } }))
  position(db, '46130058', 'EURUSD')
  position(db, '46130058', 'KO.US', { paused: 1 })
  position(db, '46130058', 'xauusd', { source: 'external' })
  const demand = watchdogCalendarDemand(db, now)
  assert.deepEqual(pairs(demand.identities), ['46130058:7', '46130058:21', '46130058:41'], 'RED if paused or external rows are filtered out again')
  assert.equal(demand.byTier.position, 3); assert.equal(demand.complete, true)
})

// ---- the contract at realistic size ----
test('realistic size: 7 accounts, ~420 identities, known weekday calendars — contract < 256 KiB, work intact, every feed calendar exported', t => {
  const { db, feed } = realistic(t)
  const demand = watchdogCalendarDemand(db, now)
  assert.ok(demand.identities.length >= 400 && demand.identities.length <= 512, `${demand.identities.length} identities`)
  assert.equal(demand.complete, true)
  const out = nodeWatchdogContract(db, { now })
  assert.ok(size(out) < CONTRACT_MAX_BYTES, `contract ${size(out)} B`)
  assert.equal(out.workComplete, true, 'RED without the dedupe: the contract passes 256 KiB and work is emptied')
  assert.equal(out.reason, undefined)
  assert.equal(out.entryDiagnostics.complete, true, 'the diagnostics were not dropped for size either')
  const activity = out.work.filter(w => w.role === 'entry_activity')
  assert.deepEqual([...new Set(activity.map(w => w.accountId))].sort(), [...ACCOUNTS].sort(), 'every account has its own entry_activity')
  const exported = new Set(out.calendars.filter(c => c.calendar).map(c => `${c.identity.accountId}:${c.identity.symbolId}`))
  assert.deepEqual([...feed].filter(k => !exported.has(k)), [], 'every tier-1 feed calendar is exported')
  assert.ok(size(out.calendars) <= 96 * 1024)
  t.diagnostic(`contract ${size(out)} B, ${demand.identities.length} identities, ${out.calendars.length} exported, ${out.work.length} work items`)
})

test('each calendar is carried once, and cpp-verify resolves every work item to the same OPEN/CLOSED/UNKNOWN as the pre-K1 embedded calendar', t => {
  const { db } = realistic(t)
  const out = nodeWatchdogContract(db, { now })
  let shared = 0, own = 0, compared = 0
  for (const w of out.work) {
    if (!w.accountId || !w.host || !w.symbolId) continue
    // Pre-K1, the item embedded this full projection.
    let before = null
    try { before = projectCalendar(readMarketCalendar(db, { accountId: w.accountId, host: w.host, symbolId: w.symbolId }, { nowMs: now }), now) } catch { before = null }
    if (w.calendarIn === 'calendars') { shared++; assert.equal(w.calendar, undefined) } else if (w.calendar) own++
    const resolved = resolveLikeVerifier(out, w)
    for (const at of [now, now + 6 * 3600_000, now + 20 * 3600_000]) {
      assert.equal(verifierMarket(resolved, at), verifierMarket({ ...w, calendar: before }, at), `${w.id} at +${(at - now) / 3600_000} h`)
      compared++
    }
  }
  assert.ok(shared > 50, `${shared} items point at the export`)
  assert.ok(compared > 300)
  // An exported calendar carries exactly what the verifier reads.
  const c = out.calendars.find(e => e.calendar).calendar
  assert.deepEqual(Object.keys(c).sort(), ['expiresAtMs', 'fromMs', 'identity', 'intervals', 'observedAtMs', 'source', 'toMs', 'version'])
  assert.equal(c.fromMs, Math.floor(now / 86400_000) * 86400_000 - 86400_000)
  t.diagnostic(`${shared} shared, ${own} own, ${compared} verifier readings compared`)
})

test('an identity beyond the export bound keeps its own calendar, in the verifier\'s shape', t => {
  const db = database(t, ['46130058'])
  // 220 known feed calendars overflow the 96 KiB export; the held position is tier 2, after them.
  const feedIds = Array.from({ length: 220 }, (_, i) => String(90_000 + i))
  for (const [i, symbolId] of feedIds.entries()) recordMarketCalendar(db, { host: DEMO, accountId: '46130058', symbolId }, { symbolId: Number(symbolId), ...SHAPES[i % 9], holiday: ecHoliday(i) }, { nowMs: now - 1000 })
  feedHealth(db, 'cpp_exec_demo', '46130058', feedIds)
  setState(db, 'symbol_id_map:46130058', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 7 } }))
  recordMarketCalendar(db, { host: DEMO, accountId: '46130058', symbolId: '7' }, { symbolId: 7, ...SHAPES[0], holiday: [] }, { nowMs: now - 1000 })
  position(db, '46130058', 'EURUSD')
  const out = nodeWatchdogContract(db, { now })
  assert.equal(out.calendarsComplete, false)
  // K1 checker nit: the export's own cut is reported apart from the demand.
  assert.equal(out.demandComplete, true, 'every identity was demanded')
  assert.equal(out.exportComplete, false, 'RED if the byte-bound cut is not recorded on the export itself')
  assert.ok(!out.calendars.some(c => c.identity.symbolId === '7'), 'the position is past the bound')
  const w = out.work.find(x => x.role === 'management')
  assert.equal(w.calendarIn, undefined)
  assert.deepEqual(Object.keys(w.calendar).sort(), ['expiresAtMs', 'fromMs', 'identity', 'intervals', 'observedAtMs', 'source', 'toMs', 'version'])
  assert.equal(verifierMarket(resolveLikeVerifier(out, w), now), 'OPEN')
})

// ---- the coverage read ----
function coverageFixture(t) {
  const db = database(t, ['46979908', '43002148'])
  setState(db, 'symbol_id_map:46979908', JSON.stringify({ builtAt: new Date(now - 7200_000).toISOString(), map: { '0066.HK': 12095, EURUSD: 1, GBPUSD: 2 } }))
  // HKEX National Day, Thu 01-10: the broker row with no bounds (the K3 case).
  recordMarketCalendar(db, { host: DEMO, accountId: '46979908', symbolId: '12095' }, { symbolId: 12095, ...SHAPES[7],
    holiday: [{ holidayDate: 20727, isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong', name: 'National Day' }] }, { nowMs: now - 1000 })
  recordMarketCalendar(db, { host: DEMO, accountId: '46979908', symbolId: '1' }, { symbolId: 1, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 7 * D }],
    holiday: [{ holidayDate: 20726, isRecurring: false, scheduleTimeZone: 'Europe/Bucharest', name: 'Maintenance', startSecond: 36000, endSecond: 46800 }] }, { nowMs: now - 1000 })
  position(db, '46979908', '0066.HK', { paused: 1 })
  position(db, '46979908', 'EURUSD')
  position(db, '43002148', 'EURUSD')
  // The name-keyed entry gate says EURUSD is closed (its broker schedule row is Sunday 00-01 UTC).
  db.prepare("INSERT INTO symbol_hours (symbol,symbol_id,schedule_json,tz) VALUES ('EURUSD',1,?,'UTC')").run(JSON.stringify([{ startSecond: 0, endSecond: 3600 }]))
  setState(db, 'acct:46979908:autopilot_symbols_json', JSON.stringify(['0066.HK', 'EURUSD', 'GBPUSD', 'NOPE']))
  return db
}

test('the coverage read: a missing map is missing, reasons are split, disagreements and the 01-10 holiday are named, no broker connection', async t => {
  const db = coverageFixture(t)
  // Persist a skip through the real collector: the observer reading is absent.
  assert.deepEqual(await createWatchdogCalendarRefresh(db, { env: {}, now: () => now })(), { skipped: 'observation_disabled_or_stale' })
  const connects = [], realConnect = net.Socket.prototype.connect, realFetch = globalThis.fetch
  net.Socket.prototype.connect = function (...args) { connects.push(args[0]); return realConnect.apply(this, args) }
  globalThis.fetch = async (...args) => { connects.push(String(args[0])); throw new Error('no network in the coverage build') }
  let report
  try { report = buildCalendarCoverage(db, { now }) } finally { net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch }
  assert.deepEqual(connects, [], 'the build opened no connection')
  const byId = Object.fromEntries(report.accounts.map(a => [a.accountId, a]))
  const missing = byId['43002148']
  assert.equal(missing.symbolMap.status, 'missing')
  assert.equal(missing.demand.missingMap, true)
  assert.equal(missing.demandedCoverage, 'missing', 'RED if a missing map reads as covered')
  assert.equal(missing.host, LIVE)
  const hk = byId['46979908']
  assert.deepEqual(hk.symbolMap, { status: 'present', builtAt: new Date(now - 7200_000).toISOString(), ageMs: 7200_000, size: 3 })
  assert.deepEqual(hk.demand.byTier, { feed: 0, position: 2, legacy: 0, scope: 0 })
  assert.deepEqual(hk.status, { OPEN: 1, CLOSED: 0, UNKNOWN: 1 })
  assert.deepEqual(hk.unknownReasons, { holiday_bounds_omitted: 1 })
  assert.equal(hk.demandedCoverage, 'partial')
  assert.equal(hk.oldestObservedAt, new Date(now - 1000).toISOString())
  assert.equal(hk.gateDisagreements.compared, 1)
  assert.equal(hk.gateDisagreements.disagree, 1)
  assert.deepEqual(hk.gateDisagreements.examples[0], { symbol: 'EURUSD', symbolId: '1', accountCalendar: 'OPEN', calendarReason: null, symbolHours: 'CLOSED', symbolHoursSource: 'broker' })
  assert.deepEqual(hk.holidays, [
    { dateIso: '2026-09-30', name: 'Maintenance', scheduleTimeZone: 'Europe/Bucharest', isRecurring: false, bounds: 'explicit', startSecond: 36000, endSecond: 46800, identities: 1, symbols: ['EURUSD'] },
    { dateIso: '2026-10-01', name: 'National Day', scheduleTimeZone: 'Asia/Hong_Kong', isRecurring: false, bounds: 'holiday_bounds_omitted', identities: 1, symbols: ['0066.HK'] },
  ], 'the omitted bounds stay absent')
  assert.deepEqual(hk.watchlist, { source: 'own', total: 4, demanded: 2, notDemanded: 1, notDemandedWithStoredCalendar: 0, noSymbolId: 1, notDemandedSymbols: ['GBPUSD'] })
  assert.equal(report.collector.latest, 'skip')
  assert.equal(report.collector.lastSkip.skipped, 'observation_disabled_or_stale')
  assert.equal(report.collector.receipt, null)
  assert.equal(report.demand.complete, false)
  assert.equal(report.export.demandComplete, false)
  assert.equal(report.export.calendarsComplete, false)
  assert.equal(report.export.exportComplete, true, 'the export itself was not cut: only the demand (the missing map) is incomplete')
  assert.equal(report.export.workComplete, true)
  assert.ok(report.export.contractBytes > 0 && report.export.contractBytes < report.export.contractMaxBytes)
  assert.equal(report.export.workItemsSharingAnExportedCalendar, 1, 'the EURUSD management item points at its exported calendar')
  assert.equal(report.brokerCalls, 0)
})

// ---- the route ----
async function serve(t, connection, onClose = () => {}) {
  const app = express(); app.use('/state', stateRouter(connection))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); onClose() })
  return path => `http://127.0.0.1:${server.address().port}/state${path}`
}
function diskFixture() {
  const dir = tempDir('calendar-coverage-http-')
  const db = initDB(join(dir, 'fixture.db'))
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run('46979908', 0)
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run('43002148', 1)
  setState(db, 'symbol_id_map:46979908', JSON.stringify({ builtAt: new Date().toISOString(), map: { '0066.HK': 12095 } }))
  recordMarketCalendar(db, { host: DEMO, accountId: '46979908', symbolId: '12095' }, { symbolId: 12095, ...SHAPES[7],
    holiday: [{ holidayDate: 20727, isRecurring: false, scheduleTimeZone: 'Asia/Hong_Kong', name: 'National Day' }] })
  position(db, '46979908', '0066.HK', { paused: 1 })
  return { dir, db }
}

test('GET /state/calendar-coverage is built on the read-only worker, never cached, and shows the missing map as missing', async t => {
  const { db } = diskFixture()
  const url = await serve(t, db, () => db.close())
  const prepare = db.prepare
  let managementReads = 0
  // A pool slot is held until the previous worker EXITS; only an explicit
  // capacity 503 is waited out.
  const get = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(url('/calendar-coverage')), body = await res.json()
      if (res.status !== 503 || body.reason !== 'performance_report_worker_capacity') return { res, body }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('worker capacity never freed')
  }
  let first, second
  db.prepare = () => { managementReads++; throw new Error('the coverage read ran on the management connection') }
  try { first = await get(); second = await get() } finally { db.prepare = prepare }
  const { res, body } = first
  assert.equal(res.status, 200)
  assert.equal(managementReads, 0, 'RED if the build runs on the event loop connection')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(second.res.status, 200)
  assert.equal(second.res.headers.get('x-cache'), null, 'the second read is built again, never served from the state response cache')
  const byId = Object.fromEntries(body.accounts.map(a => [a.accountId, a]))
  assert.equal(byId['43002148'].demandedCoverage, 'missing')
  assert.deepEqual(byId['46979908'].unknownReasons, { holiday_bounds_omitted: 1 })
  // The same holiday row, readable on the identity read while the calendar is UNKNOWN.
  const one = await (await fetch(url('/market-calendar?account=46979908&symbolId=12095'))).json()
  assert.equal(one.marketStatus, 'MARKET_STATUS_UNKNOWN')
  assert.deepEqual(one.unresolvedHolidays.map(h => [h.name, h.dateIso, 'startSecond' in h, 'endSecond' in h]), [['National Day', '2026-10-01', false, false]])
})

test('a coverage build that fails is an explicit 503 with no accounts, never an empty healthy body', async t => {
  const { dir, db } = diskFixture()
  const missing = new Proxy(db, { get(target, key) {
    if (key === 'name') return join(dir, 'missing.db')
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const url = await serve(t, missing, () => db.close())
  const res = await fetch(url('/calendar-coverage'))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.accounts, undefined)
  assert.ok(body.code)
})

test('the route sits behind the app-level auth middleware, which has no exemption for it', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  const auth = index.indexOf('app.use(authMiddleware)'), mount = index.indexOf("app.use('/state', stateRouter(db))")
  assert.ok(auth > 0 && mount > auth, 'the state router is mounted after authMiddleware')
  const fn = index.slice(index.indexOf('function authMiddleware'), index.indexOf('function authMiddleware') + 800)
  assert.doesNotMatch(fn, /calendar/, 'no exemption names this route')
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/calendar-coverage', async \(_req, res\) => \{\s*res\.set\('Cache-Control', 'no-store'\)\s*try \{\s*res\.json\(await readCalendarCoverage\(db\)\)/)
})
