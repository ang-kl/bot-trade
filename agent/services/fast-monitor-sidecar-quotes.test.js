// node --test agent/services/fast-monitor-sidecar-quotes.test.js
//
// 19-09-2026: the fast monitor prices open positions from the sidecar's
// GET /quotes — ONE pull per side per tick — and falls back to the broker
// round trip (wsGetSpotOnce) only for a symbol the sidecar does not carry or
// a quote older than QUOTE_MAX_AGE_MS on the sidecar's receipt clock.
// Measured before: 48 serial round trips per pass, worst tick 51 s,
// skipShare10m 0.45–0.75 against the goal table's ≤ 10 %.
//
// Every case here injects the two dependencies (exec.sidecarQuotes and
// ws.wsGetSpotOnce) and COUNTS their calls — behaviour, not a source grep.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { runFastMonitor, startFastMonitor, pickSidecarQuote, quoteMapFrom, sidecarSymbolIdFor, quoteMaxAgeMs, QUOTE_MAX_AGE_DEFAULT_MS, PASS_RECORD_KEY, _resetFastDecisionStateForTests } from './fast-monitor.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'

const CREDS = { ready: true, host: 'demo.ctraderapi.com', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '111', isLive: false }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function mkDb({ accounts = true } = {}) {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDJPY: 3 }))
  setState(db, 'ctrader_account_id', '111')
  if (accounts) {
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',1,1,'active')`).run()
  }
  _resetFastDecisionStateForTests()
  return db
}
function addPos(db, symbol, accountId, { source = 'autopilot' } = {}) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, created_at)
    VALUES (?, 'BUY', 1.1000, 1.0950, 1.1200, 0.0050, 'active', ?, 'fib_618_fade', ?, datetime('now'))
  `).run(symbol, source, accountId).lastInsertRowid
}
// Each position is fresh (never checked) so it is due on the first tick;
// position ids are per fresh :memory: db so the pacing maps do not collide
// across tests... except that they DO share ids across dbs — so every test
// uses a distinct fake clock far enough ahead that the cadence has elapsed.
let clockBase = 1_800_000_000_000
function deps({ quotesBody, quotesBySide = null, now }) {
  const calls = { sidecar: [], ws: [] }
  const t = now ?? (clockBase += 60 * 60_000)
  return {
    calls,
    now: () => t,
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsGetSpotOnce: async (_h, _c, _s, _t, _a, symbolId) => { calls.ws.push(symbolId); return { bid: 1.1005, ask: 1.1007 } },
    },
    exec: {
      sidecarQuotes: async (isLive, opts) => {
        calls.sidecar.push({ isLive, ids: [...(opts?.ids || [])].sort((a, b) => a - b) })
        if (quotesBySide) return quotesBySide(isLive)
        return typeof quotesBody === 'function' ? quotesBody(t) : quotesBody
      },
    },
  }
}
const fresh = (t, symbolId, bid = 1.1005, ask = 1.1007) => ({ symbolId, bid, ask, tsMs: t - 500, recvMs: t - 500 })

test('pickSidecarQuote: fresh → sidecar; older than the max age on recvMs → stale; absent or one-sided → missing', () => {
  const now = 1_000_000
  const m = new Map([[1, { bid: 1, ask: 1.1, tsMs: 1, recvMs: now - 9_999 }], [2, { bid: 1, ask: 1.1, tsMs: 1, recvMs: now - 10_001 }], [3, { bid: 1, ask: null, tsMs: 1, recvMs: now }]])
  assert.deepEqual(pickSidecarQuote(m, 1, now), { quote: { bid: 1, ask: 1.1 }, source: 'sidecar' })
  assert.deepEqual(pickSidecarQuote(m, 2, now), { quote: null, source: 'stale' })
  assert.deepEqual(pickSidecarQuote(m, 2, now, 20_000), { quote: { bid: 1, ask: 1.1 }, source: 'sidecar' }, 'the max age is a parameter')
  assert.deepEqual(pickSidecarQuote(m, 3, now), { quote: null, source: 'missing' }, 'a never-seen side is not a price')
  assert.deepEqual(pickSidecarQuote(m, 9, now), { quote: null, source: 'missing' })
  assert.deepEqual(pickSidecarQuote(undefined, 1, now), { quote: null, source: 'missing' })
  // the broker's own timestamp is NOT the age clock: a quiet symbol's last
  // event can be minutes old and still be the current price
  assert.equal(pickSidecarQuote(new Map([[1, { bid: 1, ask: 1.1, tsMs: now - 600_000, recvMs: now - 100 }]]), 1, now).source, 'sidecar')
})

test('quoteMaxAgeMs: 10 s by default, FAST_MONITOR_QUOTE_MAX_AGE_MS overrides, garbage falls back', () => {
  assert.equal(QUOTE_MAX_AGE_DEFAULT_MS, 10_000)
  assert.equal(quoteMaxAgeMs({}), 10_000)
  assert.equal(quoteMaxAgeMs({ FAST_MONITOR_QUOTE_MAX_AGE_MS: '2500' }), 2500)
  assert.equal(quoteMaxAgeMs({ FAST_MONITOR_QUOTE_MAX_AGE_MS: '-1' }), 10_000)
  assert.equal(quoteMaxAgeMs({ FAST_MONITOR_QUOTE_MAX_AGE_MS: 'x' }), 10_000)
})

test('quoteMapFrom: a body → map by id; absent feed, null body and bad rows → empty / skipped', () => {
  assert.equal(quoteMapFrom(null).size, 0)
  assert.equal(quoteMapFrom({ feed: 'absent', quotes: [{ symbolId: 1, bid: 1, ask: 1 }] }).size, 0, 'an absent feed carries no usable quotes')
  const m = quoteMapFrom({ feed: 'up', quotes: [{ symbolId: '41', bid: '1.1', ask: null, tsMs: 5, recvMs: 6 }, { symbolId: 0 }, {}] })
  assert.deepEqual([...m.entries()], [[41, { bid: 1.1, ask: null, tsMs: 5, recvMs: 6 }]])
})

test('sidecarSymbolIdFor: the account\'s own map wins; the global map only for the primary account or no account; another account without a map → null', () => {
  const db = mkDb()
  setState(db, accountSymbolMapKey('222'), JSON.stringify({ builtAt: new Date().toISOString(), map: { EURUSD: 901 } }))
  const g = { EURUSD: 1 }
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '111' }, g, '111'), 1, 'primary → global')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'eurusd', account_id: null }, g, '111'), 1, 'no account → global')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '222' }, g, '111'), 901, 'another account → its own map, never the global id')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'GBPUSD', account_id: '222' }, g, '111'), null, 'its own map lacks the symbol → no sidecar lookup')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'GBPUSD', account_id: '333' }, g, '111'), null, 'no map on file → no sidecar lookup')
})

test('sidecar-first: a fresh sidecar quote prices the position and the broker is NOT called; the counts say so', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', '111')
  const d = deps({ quotesBody: (t) => ({ feed: 'up', generation: 1, count: 1, quotes: [fresh(t, 1)] }) })
  const out = await runFastMonitor(db, CREDS, d)
  assert.equal(out.checked, 1)
  assert.deepEqual(out.quotes, { fromSidecar: 1, fromBroker: 0, stale: 0 })
  assert.equal(out.sidecarPulls, 1)
  assert.deepEqual(d.calls.ws, [], 'no broker round trip')
  assert.deepEqual(d.calls.sidecar, [{ isLive: false, ids: [1] }])
  const row = db.prepare(`SELECT last_check_action FROM monitored_positions`).get()
  assert.equal(row.last_check_action, 'FAST:HOLD', 'the evaluation ran on the sidecar price')
})

test('stale fallback: a sidecar quote older than the max age on recvMs is not used — the broker is called, stale is counted', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', '111')
  const d = deps({ quotesBody: (t) => ({ feed: 'up', generation: 1, count: 1, quotes: [{ symbolId: 1, bid: 1.1, ask: 1.1002, tsMs: t - 10_001, recvMs: t - 10_001 }] }) })
  const out = await runFastMonitor(db, CREDS, d)
  assert.equal(out.checked, 1)
  assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 1, stale: 1 })
  assert.deepEqual(d.calls.ws, [1], 'the broker round trip, exactly as before')
  // the max age is injectable and env-driven: the same quote is fresh under a 20 s bound
  const db2 = mkDb()
  addPos(db2, 'EURUSD', '111')
  const d2 = deps({ quotesBody: (t) => ({ feed: 'up', generation: 1, count: 1, quotes: [{ symbolId: 1, bid: 1.1, ask: 1.1002, tsMs: t - 10_001, recvMs: t - 10_001 }] }) })
  const out2 = await runFastMonitor(db2, CREDS, { ...d2, quoteMaxAgeMs: 20_000 })
  assert.deepEqual(out2.quotes, { fromSidecar: 1, fromBroker: 0, stale: 0 })
  assert.deepEqual(d2.calls.ws, [])
})

test('missing-symbol fallback: the sidecar does not carry the symbol (or has no feed, or is unreachable) → broker, not stale', async () => {
  for (const body of [
    { feed: 'up', generation: 1, count: 1, quotes: [] },                          // carried nothing
    (t) => ({ feed: 'up', generation: 1, count: 1, quotes: [fresh(t, 2)] }),      // another symbol
    { feed: 'absent', generation: 0, count: 0, quotes: [] },                      // the live sidecar without a feed
    null,                                                                         // unreachable / old binary
  ]) {
    const db = mkDb()
    addPos(db, 'EURUSD', '111')
    const d = deps({ quotesBody: body })
    const out = await runFastMonitor(db, CREDS, d)
    assert.equal(out.checked, 1)
    assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 })
    assert.deepEqual(d.calls.ws, [1])
  }
  // a throwing sidecarQuotes is the same as null
  const db = mkDb()
  addPos(db, 'EURUSD', '111')
  const d = deps({})
  d.exec.sidecarQuotes = async () => { throw new Error('boom') }
  const out = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 })
})

test('wiring pin: ONE sidecarQuotes call per side per tick, each with that side\'s ids; a side with no sidecar-resolvable position is not asked', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', '111')   // demo, primary → global id 1
  addPos(db, 'GBPUSD', '111')   // demo, primary → global id 2
  addPos(db, 'USDJPY', '222')   // live, its own map → 903
  addPos(db, 'EURUSD', '222', { source: 'external' }) // observe-only: never priced, never asked for
  setState(db, accountSymbolMapKey('222'), JSON.stringify({ builtAt: new Date().toISOString(), map: { USDJPY: 903 } }))
  const d = deps({ quotesBySide: null })
  let t = d.now()
  d.exec.sidecarQuotes = async (isLive, opts) => {
    d.calls.sidecar.push({ isLive, ids: [...opts.ids].sort((a, b) => a - b) })
    return isLive
      ? { feed: 'up', generation: 1, count: 1, quotes: [fresh(t, 903, 150.1, 150.12)] }
      : { feed: 'up', generation: 1, count: 2, quotes: [fresh(t, 1), fresh(t, 2, 1.27, 1.2702)] }
  }
  const out = await runFastMonitor(db, CREDS, d)
  assert.equal(out.checked, 3)
  assert.deepEqual(out.quotes, { fromSidecar: 3, fromBroker: 0, stale: 0 })
  assert.deepEqual(d.calls.sidecar.sort((a, b) => Number(a.isLive) - Number(b.isLive)), [{ isLive: false, ids: [1, 2] }, { isLive: true, ids: [903] }])
  assert.deepEqual(d.calls.ws, [])
  // the next tick pulls once per side again — and the count is per TICK, not cumulative per position
  d.calls.sidecar.length = 0
  t += 120_000; d.now = () => t
  const again = await runFastMonitor(db, CREDS, d)
  assert.equal(again.sidecarPulls, 2)
  assert.equal(d.calls.sidecar.length, 2, 'two sides, two pulls, three positions')
  // a live position whose account has no symbol map on file cannot be looked up on the live sidecar: no live pull, broker fallback
  const db2 = mkDb()
  addPos(db2, 'EURUSD', '111')
  addPos(db2, 'USDJPY', '222')
  const d2 = deps({ quotesBody: (t2) => ({ feed: 'up', generation: 1, count: 1, quotes: [fresh(t2, 1)] }) })
  const out2 = await runFastMonitor(db2, CREDS, d2)
  assert.deepEqual(d2.calls.sidecar, [{ isLive: false, ids: [1] }], 'only the demo side is asked')
  assert.deepEqual(out2.quotes, { fromSidecar: 1, fromBroker: 1, stale: 0 })
  assert.deepEqual(d2.calls.ws, [3], 'the live position still prices — through the broker, as before')
})

test('the counts land in the pass record (fast_monitor_pass_json tick.quotes) through the ticker', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', '111')
  addPos(db, 'GBPUSD', '111')
  const hb = { beat: () => {} }
  const d = deps({ quotesBody: (t) => ({ feed: 'up', generation: 1, count: 1, quotes: [fresh(t, 1)] }) }) // GBPUSD (id 2) missing → broker
  const stop = startFastMonitor(db, () => CREDS, { ...d, tickMs: 5, bandMs: 10_000, heartbeat: hb, runBand: async () => {} })
  await sleep(80)
  stop()
  const rec = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.deepEqual(rec.tick.quotes, { fromSidecar: 1, fromBroker: 1, stale: 0 })
  assert.equal(typeof rec.tick.skipShare10m === 'number' || rec.tick.skipShare10m === null, true, 'the older tick fields are still there')
})

test('an injected runTick that returns a bare error or null still reads as before (no quotes, error carried)', async () => {
  const db = initDB(':memory:')
  const beats = []
  const hb = { beat: (_db, name, info) => beats.push({ name, info }) }
  const stop = startFastMonitor(db, () => ({ ready: false }), { tickMs: 5, bandMs: 10_000, heartbeat: hb, runBand: async () => {}, runTick: async () => new Error('tick broke') })
  await sleep(30)
  stop()
  const b = beats.find(x => x.name === 'fast_monitor')
  assert.ok(b && b.info.ok === false && b.info.error === 'tick broke')
  const rec = JSON.parse(getState(db, PASS_RECORD_KEY))
  assert.equal(rec.tick.quotes, null)
})
