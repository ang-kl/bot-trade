import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState, getState } from '../db.js'
import { createWatchdogCalendarRefresh, watchdogCalendarDemand, startWatchdogCalendarRefresh } from './watchdog-calendar-refresh.js'
import { readMarketCalendar } from './market-calendar.js'
import { probeOneSidecar } from './heartbeat.js'
const now = Date.parse('2026-09-23T12:00Z'), host = 'demo.ctraderapi.com'
const symbol = id => ({ symbolId: id, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 0, endSecond: 604800 }], holiday: [] })
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const account of ['11', '22']) {
    db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,0)').run(account)
    setState(db, `symbol_id_map:${account}`, JSON.stringify({ builtAt: new Date(now).toISOString(), map: { ETHUSD: account === '11' ? 7 : 8 } }))
    db.prepare("INSERT INTO monitored_positions (symbol,account_id,source,status) VALUES ('ETHUSD',?,'autopilot','active')").run(account)
  }
  setState(db, 'independent_watchdog_json', JSON.stringify({ readAt: new Date(now).toISOString(), status: { enabled: true } }))
  return db
}
const credentials = accountId => ({ ready: true, accountId, host })
test('real heartbeat health receipt supplies feed identities absent from recorder status', async t => {
  const db = fixture(t)
  db.prepare('DELETE FROM monitored_positions').run()
  const exec = {
    pingSidecar: async () => ({ ok: true, tick: { enabled: true, feedAccountId: 11, subscribed: [7, 9] },
      spotFeed: { connected: true, symbols: [{ id: 7, lastTickAtMs: now }] } }),
    sidecarTickStatus: async () => ({ enabled: true, recording: false, state: 'OFF', events: { total: 0 } }),
  }
  await probeOneSidecar(db, exec, { name: 'cpp_exec_demo', isLive: false }, { now: new Date(now) })
  assert.equal(JSON.parse(getState(db, 'cpp_exec_demo_tick_json')).status.subscribed, undefined)
  const demand = watchdogCalendarDemand(db, now)
  assert.deepEqual(demand.identities.map(i => [i.accountId, i.symbolId]), [['11', '7'], ['11', '9']])
  assert.equal(demand.complete, true)
  let requested
  const result = await createWatchdogCalendarRefresh(db, { now: () => now, credentials, fetchSymbols: async (c, ids) => {
    requested = [c.accountId, ids]; return { ctidTraderAccountId: c.accountId, symbol: ids.map(symbol) }
  } })()
  assert.deepEqual(requested, ['11', [7, 9]])
  assert.equal(result.recorded, 2)
})

test('missing active feed identity and stale or failed health never assert complete inventory', t => {
  const db = fixture(t)
  for (const health of [
    { at: new Date(now).toISOString(), ok: true, spotFeed: { connected: true }, tick: { enabled: true } },
    { at: new Date(now - 360_000).toISOString(), ok: true, tick: { feedAccountId: 11, subscribed: [9] } },
    { at: new Date(now).toISOString(), ok: false, tick: { feedAccountId: 11, subscribed: [9] } },
  ]) {
    setState(db, 'cpp_exec_demo_health_json', JSON.stringify(health))
    const demand = watchdogCalendarDemand(db, now)
    assert.equal(demand.complete, false)
    assert.equal(demand.identities.length, 2, 'only independently identified positions remain')
  }
})

test('real account map envelope supplies isolated identities; native feed demand rejects wrong host and stale receipts', t => {
  const db = fixture(t)
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ at: new Date(now).toISOString(), ok: true, tick: { feedAccountId: 11, subscribed: [9] } }))
  setState(db, 'cpp_exec_health_json', JSON.stringify({ at: new Date(now).toISOString(), ok: true, tick: { feedAccountId: 22, subscribed: [10] } }))
  const demand = watchdogCalendarDemand(db, now)
  assert.deepEqual(demand.identities.map(i => [i.accountId, i.symbolId]), [['11', '7'], ['22', '8'], ['11', '9']])
  assert.equal(demand.complete, false)
  assert.equal(watchdogCalendarDemand(db, now + 360_000).identities.length, 2)
})
test('failed account cannot monopolise next batch; only broker observations refresh calendar evidence', async t => {
  const db = fixture(t), calls = []
  const refresh = createWatchdogCalendarRefresh(db, { now: () => now, credentials, fetchSymbols: async (c, ids) => {
    calls.push([c.accountId, ids]); if (c.accountId === '11') throw new Error('unavailable')
    return { ctidTraderAccountId: c.accountId, symbol: ids.map(symbol) }
  } })
  assert.equal((await refresh()).errors.length, 1)
  assert.equal((await refresh()).recorded, 1)
  assert.deepEqual(calls, [['11', [7]], ['22', [8]]])
  assert.equal(readMarketCalendar(db, { host, accountId: '11', symbolId: 7 }, { nowMs: now }).reason, 'calendar_missing')
  assert.equal(readMarketCalendar(db, { host, accountId: '22', symbolId: 8 }, { nowMs: now }).open, true)
  assert.equal((await refresh()).requested, 0)
})
test('wrong account response and ambiguous holiday remain unknown with diagnostic reasons', async t => {
  const db = fixture(t)
  const refresh = createWatchdogCalendarRefresh(db, { now: () => now, credentials, fetchSymbols: async (c, ids) => c.accountId === '11'
    ? { ctidTraderAccountId: '22', symbol: ids.map(symbol) }
    : { symbol: [{ ...symbol(8), holiday: [{ holidayDate: 20000, isRecurring: true, scheduleTimeZone: 'UTC' }] }] } })
  assert.equal((await refresh()).recorded, 0)
  const second = await refresh(); assert.equal(second.unknown, 1)
  assert.ok(second.errors.includes('8:calendar_holiday_window_unknown'))
  assert.equal(readMarketCalendar(db, { host, accountId: '22', symbolId: 8 }, { nowMs: now }).open, null)
})
test('one in-flight batch, fresh enabled observation required; muted notification policy does not suppress calendar reads', async t => {
  const db = fixture(t); setState(db, 'telegram_notify_json', '{"enabled":false}')
  let release
  const refresh = createWatchdogCalendarRefresh(db, { now: () => now, credentials, fetchSymbols: () => new Promise(resolve => { release = resolve }) })
  const pending = refresh()
  assert.deepEqual(await refresh(), { skipped: 'in_flight' })
  release({ symbol: [symbol(7)] }); assert.equal((await pending).recorded, 1)
  const before = getState(db, 'watchdog_calendar_refresh_json')
  setState(db, 'independent_watchdog_json', JSON.stringify({ readAt: new Date(now - 360_000).toISOString(), status: { enabled: true } }))
  assert.equal((await refresh()).skipped, 'observation_disabled_or_stale')
  assert.equal(getState(db, 'watchdog_calendar_refresh_json'), before)
})
test('batch and inventory bounds; timer is wired at actual boot and can be stopped', async t => {
  const db = fixture(t)
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ at: new Date(now).toISOString(), ok: true, tick: { feedAccountId: 11, subscribed: Array.from({ length: 600 }, (_, i) => 100 + i) } }))
  assert.equal(watchdogCalendarDemand(db, now).identities.length, 512)
  assert.equal(watchdogCalendarDemand(db, now).complete, false)
  const refresh = createWatchdogCalendarRefresh(db, { now: () => now, credentials, fetchSymbols: async (_c, ids) => { assert.equal(ids.length, 25); return { symbol: ids.map(symbol) } } })
  assert.equal((await refresh()).recorded, 25)
  let callback, cleared = false
  const handle = { unref() {} }
  const stop = startWatchdogCalendarRefresh(db, { setInterval: (fn, ms) => { callback = fn; assert.equal(ms, 60000); return handle }, clearInterval: timer => { assert.equal(timer, handle); cleared = true } })
  assert.equal(typeof callback, 'function'); stop(); assert.equal(cleared, true)
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.match(source, /await import\('\.\/services\/watchdog-calendar-refresh\.js'\)/)
  assert.match(source, /startWatchdogCalendarRefresh\(db\)/)
})

test('active feed calendars are exported before unrelated historical universe entries', async t => {
  const db = fixture(t)
  const { recordMarketCalendar } = await import('./market-calendar.js')
  const { watchdogCalendars } = await import('./scanner-work.js')
  for (let i = 100; i < 620; i++) recordMarketCalendar(db, { host, accountId: '1', symbolId: String(i) }, symbol(i), { nowMs: now })
  recordMarketCalendar(db, { host, accountId: '22', symbolId: '8' }, symbol(8), { nowMs: now })
  const output = watchdogCalendars(db, now)
  const own = output.calendars.find(c => c.identity.accountId === '22' && c.identity.symbolId === '8')
  assert.equal(own.calendar.identity.accountId, '22')
  assert.equal(output.calendars.find(c => c.identity.accountId === '11').reason, 'calendar_missing')
  assert.equal(output.calendarsComplete, false, 'retained cache truncation is not complete coverage')
})

test('all 512 failing identities receive an attempt before any expired cooldown is retried', async t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  let at = now; const seen = []
  const refresh = createWatchdogCalendarRefresh(db, { now: () => at, credentials, fetchSymbols: async (_c, ids) => {
    seen.push(...ids); throw new Error('unavailable')
  } })
  for (let minute = 0; minute < 21; minute++) {
    at = now + minute * 60_000
    setState(db, 'independent_watchdog_json', JSON.stringify({ readAt: new Date(at).toISOString(), status: { enabled: true } }))
    setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ at: new Date(at).toISOString(), ok: true, tick: { feedAccountId: 11, subscribed: Array.from({ length: 512 }, (_, i) => i + 1) } }))
    const result = await refresh(); assert.ok(result.requested <= 25)
  }
  assert.equal(new Set(seen.slice(0,512)).size, 512)
  assert.deepEqual(seen.slice(0,512), Array.from({ length: 512 }, (_, i) => i + 1))
  assert.ok(seen.length >= 512)
})

test('staging disarm blocks the timer and broker reads even with fresh enabled observation', async t => {
  const db = fixture(t), env = { RAILWAY_ENVIRONMENT_NAME: 'staging' }
  const forbidden = () => { throw new Error('staging must not start broker work') }
  const deps = { env, now: () => now, credentials: forbidden, fetchSymbols: forbidden, setInterval: forbidden }
  startWatchdogCalendarRefresh(db, deps)()
  assert.deepEqual(await createWatchdogCalendarRefresh(db, deps)(), { skipped: 'environment_disarmed' })
  assert.equal(getState(db, 'watchdog_calendar_refresh_json'), null)
})

test('malformed retained calendars make completeness false even without active demand', async t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  const { watchdogCalendars } = await import('./scanner-work.js')
  assert.equal(watchdogCalendars(db, now).calendarsComplete, true)
  setState(db, 'market_calendar:v1:broken', '{invalid')
  assert.equal(watchdogCalendars(db, now).calendarsComplete, false)
  setState(db, 'market_calendar:v1:broken', '{"latest":{"identity":{}}}')
  assert.equal(watchdogCalendars(db, now).calendarsComplete, false)
})

// V3 C4 (WP-B B2e): a tick account's entry_activity is judged on its OWN
// (account, symbolId) calendar, so a fresh tick permit receipt demands it.
const tickReceipt = (db, accounts, symbols, completedAt = now - 10_000) => setState(db, 'tick_entry_work_json', JSON.stringify({ cpp_exec_demo: {
  side: 'cpp_exec_demo', completedAt, nextDue: completedAt + 120_000, complete: true, pushed: true, symbols,
  accounts: accounts.map(accountId => ({ accountId, reached: true, permits: 0, paused: null, firstRefusal: null, refused: [] })) } }))

test('a fresh tick receipt demands each tick account\'s own calendar identity; a stale one demands nothing', t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  setState(db, 'symbol_id_map:11', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 1234 } }))
  setState(db, 'symbol_id_map:22', JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 99 } }))
  tickReceipt(db, ['11', '22'], ['EURUSD'])
  const demand = watchdogCalendarDemand(db, now)
  assert.deepEqual(demand.identities.map(i => [i.accountId, i.symbolId]), [['11', '1234'], ['22', '99']], 'RED if the tick block is removed')
  assert.equal(demand.complete, true)
  tickReceipt(db, ['11', '22'], ['EURUSD'], now - 360_000)
  assert.deepEqual(watchdogCalendarDemand(db, now).identities, [], 'RED if freshness is ignored')
  // a name missing from an account's own map is missing coverage, never an empty demand
  tickReceipt(db, ['11'], ['GBPUSD'])
  assert.equal(watchdogCalendarDemand(db, now).complete, false)
})

test('the identity cap truncates the tick demand symbol-major, so every tick account keeps coverage', t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  const names = Array.from({ length: 200 }, (_, i) => `SYM${i}`)
  const accounts = ['11', '22', '33']
  db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,1)').run('33')
  for (const [n, id] of accounts.entries()) {
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ builtAt: new Date(now).toISOString(), map: Object.fromEntries(names.map((s, i) => [s, 1000 * (n + 1) + i])) }))
  }
  tickReceipt(db, accounts, names)
  const demand = watchdogCalendarDemand(db, now)
  assert.equal(demand.identities.length, 512)
  assert.equal(demand.complete, false, '600 wanted > 512 cap')
  for (const id of accounts) assert.ok(demand.identities.filter(i => i.accountId === id).length >= 170, `account ${id} keeps coverage (RED if the loop is account-major: the third account gets none)`)
  assert.equal(demand.identities.find(i => i.accountId === '33').host, 'live.ctraderapi.com', 'the account\'s own host')
})

// Checker nit 1 (C4 fix round): the tick demand runs on the main thread, so at
// the identity cap it stops instead of resolving every remaining pair only to
// refuse it. Observed through the state reads the demand makes: each tick
// account's symbol map is one agent_state read.
function countingStateReads(db) {
  const keys = []
  const spy = new Proxy(db, { get(target, prop) {
    if (prop === 'prepare') return sql => {
      const statement = target.prepare(sql)
      if (!/FROM agent_state WHERE key = \?/.test(sql)) return statement
      return { get: key => { keys.push(key); return statement.get(key) } }
    }
    const value = target[prop]
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { spy, keys }
}

test('with the identity cap already full, the tick demand stops and reads no tick account map', t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  // The sidecar's own feed fills the 512 cap before the tick block runs.
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ at: new Date(now).toISOString(), ok: true, tick: { feedAccountId: 11, subscribed: Array.from({ length: 512 }, (_, i) => 100 + i) } }))
  const accounts = Array.from({ length: 40 }, (_, i) => String(500 + i))
  for (const id of accounts) {
    db.prepare('INSERT INTO accounts (account_id,is_live) VALUES (?,0)').run(id)
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ builtAt: new Date(now).toISOString(), map: { EURUSD: 1, GBPUSD: 2 } }))
  }
  tickReceipt(db, accounts, ['EURUSD', 'GBPUSD'])
  const { spy, keys } = countingStateReads(db)
  const demand = watchdogCalendarDemand(spy, now)
  assert.equal(demand.identities.length, 512)
  assert.equal(demand.complete, false, 'unread tick pairs are missing coverage')
  assert.ok(keys.includes('tick_entry_work_json'), 'the receipt itself was read (the spy sees state reads)')
  assert.deepEqual(keys.filter(k => k.startsWith('symbol_id_map:5')), [], 'RED if the loop keeps resolving pairs after the cap is full')
})

test('a tick demand that exactly fills the cap is complete', t => {
  const db = fixture(t); db.prepare('DELETE FROM monitored_positions').run()
  const names = Array.from({ length: 256 }, (_, i) => `SYM${i}`)
  for (const [n, id] of ['11', '22'].entries()) {
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ builtAt: new Date(now).toISOString(), map: Object.fromEntries(names.map((s, i) => [s, 1000 * (n + 1) + i])) }))
  }
  tickReceipt(db, ['11', '22'], names)
  const demand = watchdogCalendarDemand(db, now)
  assert.equal(demand.identities.length, 512)
  assert.equal(demand.complete, true, 'RED if the cap check runs after the last pair instead of before the next one')
})
