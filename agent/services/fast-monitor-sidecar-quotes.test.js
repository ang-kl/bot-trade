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
import { runFastMonitor, startFastMonitor, pickSidecarQuote, quoteMapFrom, sidecarSymbolIdFor, sidePrimaryFor, quoteMaxAgeMs, QUOTE_MAX_AGE_DEFAULT_MS, PASS_RECORD_KEY, _resetFastDecisionStateForTests } from './fast-monitor.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'

const CREDS = { ready: true, host: 'demo.ctraderapi.com', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '111', isLive: false }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ONE db for every runFastMonitor case in this file: loop.js's
// prepareStatements is a process singleton bound to the FIRST db it sees, so a
// second :memory: db would have its metrics/checkpoint writes land in the
// first one and read back as null. Each case starts from an empty
// monitored_positions table and no per-account symbol maps.
let SHARED = null
function mkDb() {
  if (!SHARED) {
    SHARED = initDB(':memory:')
    setState(SHARED, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDJPY: 3 }))
    setState(SHARED, 'ctrader_account_id', '111')
    SHARED.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
    SHARED.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',1,1,'active')`).run()
    SHARED.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('333','3',0,1,'active')`).run() // demo, another broker
  }
  const db = SHARED
  db.prepare('DELETE FROM monitored_positions').run()
  db.prepare("UPDATE accounts SET enabled = 1").run()
  for (const a of ['222', '333', '444', '555', '666']) setState(db, accountSymbolMapKey(a), null)
  _resetFastDecisionStateForTests()
  return db
}
function addPos(db, symbol, accountId, { source = 'autopilot', sl = 1.0950 } = {}) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, created_at)
    VALUES (?, 'BUY', 1.1000, ?, 1.1200, 0.0050, 'active', ?, 'fib_618_fade', ?, datetime('now'))
  `).run(symbol, sl, source, accountId).lastInsertRowid
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
  assert.deepEqual([...m.entries()], [[41, { bid: 1.1, ask: null, tsMs: 5, recvMs: 6, ageMs: null }]], 'no nowMs on the body → no sidecar-clock age')
  const n = quoteMapFrom({ feed: 'up', nowMs: 1_000_000, quotes: [{ symbolId: 41, bid: 1.1, ask: 1.2, tsMs: 5, recvMs: 999_000 }] })
  assert.equal(n.get(41).ageMs, 1_000, 'ageMs = nowMs - recvMs on the sidecar\'s clock')
})

test('one clock (checker SHOULD 4): a body whose nowMs is far from Node\'s clock still ages on the sidecar\'s own clock', () => {
  const nodeNow = 2_000_000_000_000
  // the sidecar's clock runs 90 s AHEAD of Node's: recvMs looks "in the future" to Node
  const ahead = quoteMapFrom({ feed: 'up', nowMs: nodeNow + 90_000, quotes: [
    { symbolId: 1, bid: 1, ask: 1.1, recvMs: nodeNow + 90_000 - 2_000 },   // 2 s old on the sidecar
    { symbolId: 2, bid: 1, ask: 1.1, recvMs: nodeNow + 90_000 - 30_000 },  // 30 s old on the sidecar — Node's clock would call it 60 s FRESH
  ] })
  assert.equal(pickSidecarQuote(ahead, 1, nodeNow).source, 'sidecar')
  assert.equal(pickSidecarQuote(ahead, 2, nodeNow).source, 'stale', 'a 30 s-old quote is stale although Node\'s clock reads it as 60 s in the future')
  // the sidecar's clock runs 90 s BEHIND: Node's clock would call a fresh quote 90 s stale
  const behind = quoteMapFrom({ feed: 'up', nowMs: nodeNow - 90_000, quotes: [{ symbolId: 1, bid: 1, ask: 1.1, recvMs: nodeNow - 90_000 - 1_000 }] })
  assert.equal(pickSidecarQuote(behind, 1, nodeNow).source, 'sidecar', 'a 1 s-old quote is fresh although Node\'s clock reads it as 91 s old')
  // an older sidecar without nowMs: Node's clock, as the first cut did
  const legacy = quoteMapFrom({ feed: 'up', quotes: [{ symbolId: 1, bid: 1, ask: 1.1, recvMs: nodeNow - 10_001 }] })
  assert.equal(pickSidecarQuote(legacy, 1, nodeNow).source, 'stale')
})

test('sidePrimaryFor: the selected account when it is enabled on the side, else the first enabled row; null when the side has none', () => {
  const db = mkDb()
  assert.equal(sidePrimaryFor(db, false, '111'), '111')
  assert.equal(sidePrimaryFor(db, false, '222'), '111', 'the selected account is live → the demo side\'s first enabled row')
  assert.equal(sidePrimaryFor(db, true, '111'), '222')
  db.prepare("UPDATE accounts SET enabled = 0 WHERE account_id = '222'").run()
  assert.equal(sidePrimaryFor(db, true, '111'), null)
})

test('sidecarSymbolIdFor (checker BLOCKER 1): the lookup id is in the SIDE PRIMARY\'s space; a position\'s own id must agree, else no sidecar lookup', () => {
  const db = mkDb()
  const g = { EURUSD: 1, GBPUSD: 2 }
  // 333 (same side as the primary 111) maps EURUSD → 2 — GBPUSD's id in 111's space
  setState(db, accountSymbolMapKey('333'), JSON.stringify({ builtAt: new Date().toISOString(), map: { EURUSD: 2, USDCAD: 9 } }))
  // 444 agrees with the primary on EURUSD
  setState(db, accountSymbolMapKey('444'), JSON.stringify({ builtAt: new Date().toISOString(), map: { EURUSD: 1 } }))
  const cache = new Map()
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '111' }, g, '111', cache, '111'), 1, 'the primary itself → the global map (built from it)')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'eurusd', account_id: null }, g, '111', cache, '111'), 1, 'no account → the side space')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '333' }, g, '111', cache, '111'), null, 'its own id (2) disagrees with the side space (1) → NOT looked up — never GBPUSD\'s quote')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'USDCAD', account_id: '333' }, g, '111', cache, '111'), null, 'the side primary has no id for the name → nothing to look up')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '444' }, g, '111', cache, '111'), 1, 'agrees → looked up')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'GBPUSD', account_id: '444' }, g, '111', cache, '111'), null, 'no own id for the name → cannot confirm → not looked up')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '555' }, g, '111', cache, '111'), null, 'no map on file → not looked up')
  // the side primary is NOT the account the global map was built from: only its own map counts
  setState(db, accountSymbolMapKey('222'), JSON.stringify({ builtAt: new Date().toISOString(), map: { USDJPY: 903 } }))
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'USDJPY', account_id: '222' }, g, '111', cache, '222'), 903)
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '222' }, g, '111', cache, '222'), null, 'the global map is never the live side\'s space')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'USDJPY', account_id: '666' }, g, '111', cache, '666'), null, 'a side primary with no map and not the global\'s account → no space at all')
  assert.equal(sidecarSymbolIdFor(db, { symbol: 'EURUSD', account_id: '111' }, g, '111', cache, null), null, 'no side primary → nothing')
})

test('CHECKER 1 (blocker): a same-name symbol with different ids on two same-side accounts is never priced from the other id', async () => {
  // The demo sidecar's feed authenticates as the side primary (111): its table
  // is keyed 1 = EURUSD, 2 = GBPUSD. Account 333 (also demo, another broker)
  // maps EURUSD → 2 in ITS space. The first cut priced 333's EURUSD from
  // GBPUSD's 1.2602 and logged a PARTIAL_EXIT on a fictitious +16R.
  const db = mkDb()
  setState(db, accountSymbolMapKey('333'), JSON.stringify({ builtAt: new Date().toISOString(), map: { EURUSD: 2 } }))
  addPos(db, 'EURUSD', '333', { sl: 1.2650 }) // a stop GBPUSD's price would touch and EURUSD's would not
  const d = deps({ quotesBody: (t) => ({ feed: 'up', generation: 1, nowMs: t, count: 2, quotes: [fresh(t, 1), fresh(t, 2, 1.2601, 1.2603)] }) })
  const out = await runFastMonitor(db, CREDS, d)
  const row = db.prepare('SELECT last_check_action, status FROM monitored_positions').get()
  assert.equal(out.quotes.fromSidecar, 0, `priced from the sidecar by another account's id space: ${JSON.stringify(out.quotes)} → ${row.last_check_action}`)
  assert.deepEqual(d.calls.sidecar, [], 'nothing on the demo side is sidecar-resolvable → the side is not even asked')
  assert.deepEqual(d.calls.ws, [1], 'priced through the broker, as before this change')
  assert.equal(row.status, 'active')
  assert.ok(String(row.last_check_action).startsWith('FAST:HOLD'), row.last_check_action)
})

test('CHECKER 3: the per-side pulls are made concurrently, so two slow sidecars cost one timeout, not two', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', '111') // demo
  setState(db, accountSymbolMapKey('222'), JSON.stringify({ builtAt: new Date().toISOString(), map: { USDJPY: 903 } }))
  addPos(db, 'USDJPY', '222') // live
  const d = deps({})
  const started = []
  let inFlight = 0, maxInFlight = 0
  d.exec.sidecarQuotes = async (isLive) => {
    started.push(isLive); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    await sleep(60)
    inFlight--
    return null
  }
  const t0 = Date.now()
  await runFastMonitor(db, CREDS, d)
  const elapsed = Date.now() - t0
  assert.equal(started.length, 2)
  assert.equal(maxInFlight, 2, `both sides' pulls must be in flight together (max in flight was ${maxInFlight}; elapsed ${elapsed} ms)`)
  // (elapsed is reported, not bounded: the first case in a process pays the loop.js import)
  void elapsed
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
  addPos(db, 'EURUSD', '111', { source: 'external' }) // observe-only on the PRIMARY (resolvable): never priced, never asked for — checker NOTE 5
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
  assert.equal(db.prepare("SELECT last_check_action FROM monitored_positions WHERE source = 'external'").get().last_check_action, null, 'the external position was not priced')
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
