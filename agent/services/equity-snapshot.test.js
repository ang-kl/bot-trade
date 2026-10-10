import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import {
  EQUITY_SNAPSHOT_LAST_KEY, EQUITY_SNAPSHOT_INTERVAL_MS, CLOSE_CATCH_UP_MS,
  equitySnapshotDue, snapshotAccountEquity, runEquitySnapshot, equityCurve, lastNyCloseMs, startEquityCloseTicker,
} from './equity-snapshot.js'

const T0 = Date.parse('2026-09-19T21:00:00Z')

function dbWith(accounts) {
  const db = initDB(':memory:')
  const ins = db.prepare(`INSERT INTO accounts (account_id, trader_login, broker_label, is_live, enabled) VALUES (?, ?, ?, ?, 1)`)
  for (const a of accounts) ins.run(a.id, a.id, a.id, a.isLive ? 1 : 0)
  return db
}

function fakeWs({ balances = {}, pnl = {}, fail = {} } = {}) {
  const calls = []
  return {
    calls,
    async wsGetTrader(host, _c, _s, _t, accountId) {
      calls.push(['trader', host, String(accountId)])
      if (fail[accountId] === 'trader') throw new Error('trader unreachable')
      return { balance: Math.round(balances[accountId] * 100), moneyDigits: 2 }
    },
    traderBalance(tr) { return tr?.balance == null ? null : tr.balance / 100 },
    async wsGetUnrealizedPnl(host, _c, _s, _t, accountId) {
      calls.push(['pnl', host, String(accountId)])
      if (fail[accountId] === 'pnl') throw new Error('pnl unreachable')
      return pnl[accountId] || {}
    },
  }
}

test('equitySnapshotDue: never-run is due, a fresh stamp is not, a day-old stamp is', () => {
  const db = initDB(':memory:')
  assert.equal(equitySnapshotDue(db, T0), true)
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, new Date(T0 - 60_000).toISOString())
  assert.equal(equitySnapshotDue(db, T0), false)
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, new Date(T0 - EQUITY_SNAPSHOT_INTERVAL_MS).toISOString())
  assert.equal(equitySnapshotDue(db, T0), true)
})

test('snapshotAccountEquity: balance + the broker\'s net unrealised P&L = equity, one row, on the account\'s own host', async () => {
  const db = dbWith([{ id: '46130058', isLive: false }])
  const ws = fakeWs({ balances: { 46130058: 29800.5 }, pnl: { 46130058: { 1: { gross: 10, net: 7.25 }, 2: { gross: -3, net: -3.5 } } } })
  const r = await snapshotAccountEquity(db, { clientId: 'c', clientSecret: 's', accessToken: 't', host: 'demo.ctraderapi.com' }, '46130058', { deps: { ws }, now: T0 })
  assert.equal(r.balance, 29800.5)
  assert.equal(r.openPnl, 3.75)
  assert.equal(r.equity, 29804.25)
  assert.equal(r.openPositions, 2)
  assert.equal(r.error, null)
  assert.ok(ws.calls.every(c => c[1] === 'demo.ctraderapi.com'), 'the host it was given')
  const row = db.prepare('SELECT * FROM equity_snapshots').get()
  assert.equal(row.account_id, '46130058')
  assert.equal(row.equity_usd, 29804.25)
  assert.equal(row.at, new Date(T0).toISOString())
})

test('snapshotAccountEquity: a failed read writes the row with null equity and the error — a gap, not a guess', async () => {
  const db = dbWith([{ id: '42993489', isLive: true }])
  const ws = fakeWs({ balances: { 42993489: 56 }, fail: { 42993489: 'pnl' } })
  const r = await snapshotAccountEquity(db, { clientId: 'c', clientSecret: 's', accessToken: 't', host: 'live.ctraderapi.com' }, '42993489', { deps: { ws }, now: T0 })
  assert.equal(r.balance, 56)
  assert.equal(r.equity, null)
  assert.match(r.error, /open pnl: pnl unreachable/)
  assert.ok(ws.calls.every(c => c[1] === 'live.ctraderapi.com'), 'the host it was given')
  const row = db.prepare('SELECT * FROM equity_snapshots').get()
  assert.equal(row.balance_usd, 56)
  assert.equal(row.equity_usd, null)
  assert.match(row.error, /pnl unreachable/)
})

test('runEquitySnapshot: every enabled account on its own host (the one routing read), token-refused skipped, the stamp written before the work', async () => {
  const db = dbWith([{ id: '46130058', isLive: false }, { id: '42993489', isLive: true }, { id: '43002148', isLive: true }])
  const ws = fakeWs({ balances: { 46130058: 100, 42993489: 50, 43002148: 0 } })
  const out = await runEquitySnapshot(db, { clientId: 'c', clientSecret: 's', accessToken: 't' }, { deps: { ws, tokenRefused: new Set(['43002148']) }, now: T0 })
  assert.equal(out.swept, 2)
  assert.equal(out.written, 2)
  assert.deepEqual(out.skipped, ['43002148'])
  assert.deepEqual(ws.calls.filter(c => c[0] === 'trader').map(c => [c[2], c[1]]).sort(), [['42993489', 'live.ctraderapi.com'], ['46130058', 'demo.ctraderapi.com']], 'each account on its own host')
  assert.equal(getState(db, EQUITY_SNAPSHOT_LAST_KEY), new Date(T0).toISOString())
  assert.equal(db.prepare('SELECT COUNT(*) n FROM equity_snapshots').get().n, 2)
  assert.equal(equitySnapshotDue(db, T0 + 3600_000), false, 'not due again an hour later')
})

test('equityCurve: per-account points oldest first, change and max drawdown over readable nights, null nights kept', async () => {
  const db = dbWith([{ id: '46130058', isLive: false }])
  const ins = db.prepare(`INSERT INTO equity_snapshots (at, account_id, balance_usd, open_pnl_usd, equity_usd, open_positions, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const day = 86400_000
  ins.run(new Date(T0 - 4 * day).toISOString(), '46130058', 100, 0, 100, 0, null)
  ins.run(new Date(T0 - 3 * day).toISOString(), '46130058', 100, 10, 110, 1, null)
  ins.run(new Date(T0 - 2 * day).toISOString(), '46130058', null, null, null, null, 'balance: trader unreachable')
  ins.run(new Date(T0 - 1 * day).toISOString(), '46130058', 95, 0, 95, 0, null)
  ins.run(new Date(T0 - 200 * day).toISOString(), '46130058', 1, 0, 1, 0, null) // outside the window
  const c = equityCurve(db, { days: 90, now: T0 })
  assert.equal(c.accounts.length, 1)
  const a = c.accounts[0]
  assert.equal(a.nights, 4)
  assert.equal(a.nightsRead, 3)
  assert.equal(a.first, 100)
  assert.equal(a.last, 95)
  assert.equal(a.change, null)
  assert.equal(a.recordedEquityChange, -5)
  assert.equal(a.maxDrawdownUsd, null, 'legacy columns do not establish USD')
  assert.equal(a.maxSampledDrawdown, 15)
  assert.equal(a.points[2].equity, null)
  assert.match(a.points[2].error, /unreachable/)
  assert.equal(equityCurve(db, { days: 90, now: T0, accountId: '999' }).accounts.length, 0)
})

test('wiring pins: the loop runs the nightly pass on the due rule, the route serves the curve, the heartbeat knows the controller', () => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /equitySnapshotDue\(db\)/)
  assert.match(loop, /runEquitySnapshot\(db, \{ clientId, clientSecret, accessToken \}\)/)
  assert.match(loop, /hbeat\(db, 'equity_snapshot'/)
  // Claude · № 13,029: the close ticker is started with the process's own credentials.
  assert.match(loop, /startEquityCloseTicker\(db, getCtraderCreds, \{ log \}\)/)
  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/equity-curve'/)
  assert.match(state, /router\.get\('\/family-edge'/)
  const hb = strip(readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8'))
  assert.match(hb, /equity_snapshot:\s*\{/)
})

// Claude · № 13,029 10-Oct (owner: "write your day's balance right at the New
// York regular market close (4:00 PM ET)"): the pass is anchored to 16:00
// America/New_York, DST from the tz database, with a bounded catch-up.
const iso = ms => new Date(ms).toISOString()

test('lastNyCloseMs: 4:00 PM New York, 20:00 UTC in summer time and 21:00 UTC in winter, across both DST changes', () => {
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-10-10T12:08:00Z'))), '2026-10-09T20:00:00.000Z', 'before today\'s close: yesterday\'s')
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-10-10T19:59:59Z'))), '2026-10-09T20:00:00.000Z')
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-10-10T20:00:00Z'))), '2026-10-10T20:00:00.000Z', 'on the bell: today\'s')
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-12-15T20:30:00Z'))), '2026-12-14T21:00:00.000Z', 'winter: 21:00 UTC')
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-12-15T21:00:00Z'))), '2026-12-15T21:00:00.000Z')
  // Spring forward (Sunday 14-03-2027, 02:00 local) lies between Saturday's close and this instant.
  assert.equal(iso(lastNyCloseMs(Date.parse('2027-03-14T07:00:00Z'))), '2027-03-13T21:00:00.000Z')
  assert.equal(iso(lastNyCloseMs(Date.parse('2027-03-14T20:00:00Z'))), '2027-03-14T20:00:00.000Z')
  // Fall back (Sunday 01-11-2026).
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-11-01T06:30:00Z'))), '2026-10-31T20:00:00.000Z')
  assert.equal(iso(lastNyCloseMs(Date.parse('2026-11-01T21:00:00Z'))), '2026-11-01T21:00:00.000Z')
})

test('equitySnapshotDue: due once the close has passed and nothing ran since it; never outside the catch-up window', () => {
  const db = initDB(':memory:')
  const close = Date.parse('2026-10-10T20:00:00Z')
  // Today's transition: the last rolling pass stamped 00:00 UTC (08:00 Singapore).
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, '2026-10-10T00:00:00.000Z')
  assert.equal(equitySnapshotDue(db, Date.parse('2026-10-10T12:08:00Z')), false, 'the 00:00 UTC pass already followed yesterday\'s close')
  assert.equal(equitySnapshotDue(db, close - 1000), false, 'not before the bell')
  assert.equal(equitySnapshotDue(db, close), true, 'on the bell')
  assert.equal(equitySnapshotDue(db, close + CLOSE_CATCH_UP_MS), true, 'caught up to the edge of the window')
  assert.equal(equitySnapshotDue(db, close + CLOSE_CATCH_UP_MS + 1000), false, 'after it the day is a gap, not a late reading')
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, new Date(close + 5000).toISOString())
  assert.equal(equitySnapshotDue(db, close + 60_000), false, 'one pass per close')
  // Never run, unparseable or a future stamp: due inside the window only.
  const fresh = initDB(':memory:')
  assert.equal(equitySnapshotDue(fresh, close + 60_000), true)
  assert.equal(equitySnapshotDue(fresh, close - 3 * 3600_000), false, 'a new database waits for the bell')
  setState(fresh, EQUITY_SNAPSHOT_LAST_KEY, 'garbage')
  assert.equal(equitySnapshotDue(fresh, close + 60_000), true)
  setState(fresh, EQUITY_SNAPSHOT_LAST_KEY, new Date(close + 86_400_000).toISOString())
  assert.equal(equitySnapshotDue(fresh, close + 60_000), true)
})

test('startEquityCloseTicker: one pass per close on the process credentials; no credentials, no pass and no stamp; inert when disarmed', async () => {
  const db = dbWith([{ id: '46130058', isLive: false }])
  const close = Date.parse('2026-10-10T20:00:00Z')
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, '2026-10-10T00:00:00.000Z')
  let now = close - 30_000, creds = { clientId: 'c', clientSecret: 's', accessToken: 't', host: 'ignored' }
  const runs = [], beats = [], logs = []
  // The stamp lands only after an await here, so the single-flight lock, not the stamp, is what holds the second tick back.
  const run = async (d, c, o) => { runs.push([c, o.now]); await new Promise(r => setTimeout(r, 5)); setState(d, EQUITY_SNAPSHOT_LAST_KEY, new Date(o.now).toISOString())
    return { swept: 1, written: 1, failed: 0, results: [{ accountId: '46130058', equity: 1 }], skipped: [] } }
  let ticks = 0
  const stop = startEquityCloseTicker(db, () => creds, { env: {}, clock: () => now, run, log: m => logs.push(m),
    beat: (_d, name, b) => beats.push([name, b.ok]), setInterval: () => { ticks++; return 1 }, clearInterval: () => {} })
  assert.equal(ticks, 1)
  assert.equal(await stop.tick(), null, 'before the bell')
  now = close + 20_000
  creds = { clientId: 'c', clientSecret: 's', accessToken: null }
  assert.equal(await stop.tick(), null, 'no token: nothing read')
  assert.equal(getState(db, EQUITY_SNAPSHOT_LAST_KEY), '2026-10-10T00:00:00.000Z', 'and the close is not used up')
  creds = { clientId: 'c', clientSecret: 's', accessToken: 't' }
  const [a, b] = await Promise.all([stop.tick(), stop.tick()])
  assert.equal(runs.length, 1, 'two ticks at once read the close once')
  assert.ok(a || b)
  assert.deepEqual(runs[0], [{ clientId: 'c', clientSecret: 's', accessToken: 't' }, close + 20_000])
  now = close + 50_000
  assert.equal(await stop.tick(), null, 'stamped: not again')
  assert.equal(runs.length, 1)
  assert.deepEqual(beats, [['equity_snapshot', true]])
  assert.match(logs[0], /New York close\): 1\/1/)
  let started = 0
  const inert = startEquityCloseTicker(db, () => creds, { env: { RAILWAY_ENVIRONMENT_NAME: 'staging' }, setInterval: () => { started++ } })
  assert.equal(started, 0); assert.equal(typeof inert, 'function')
})

test('startEquityCloseTicker with the real pass: the row is written at the close and the stamp is the close tick', async () => {
  const db = dbWith([{ id: '46130058', isLive: false }])
  const close = Date.parse('2026-10-10T20:00:00Z')
  setState(db, EQUITY_SNAPSHOT_LAST_KEY, '2026-10-10T00:00:00.000Z')
  const ws = fakeWs({ balances: { 46130058: 30009.96 }, pnl: { 46130058: { 1: { net: 399.06 } } } })
  const stop = startEquityCloseTicker(db, () => ({ clientId: 'c', clientSecret: 's', accessToken: 't' }), { env: {}, clock: () => close + 12_000,
    run: (d, c, o) => runEquitySnapshot(d, c, { ...o, deps: { ws } }), log: () => {}, beat: () => {}, setInterval: () => 1, clearInterval: () => {} })
  await stop.tick()
  const row = db.prepare('SELECT at, balance_usd, equity_usd FROM equity_snapshots').get()
  assert.deepEqual(row, { at: '2026-10-10T20:00:12.000Z', balance_usd: 30009.96, equity_usd: 30409.02 })
  assert.equal(getState(db, EQUITY_SNAPSHOT_LAST_KEY), '2026-10-10T20:00:12.000Z')
})
