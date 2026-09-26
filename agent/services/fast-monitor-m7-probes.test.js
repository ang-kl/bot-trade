// node --test agent/services/fast-monitor-m7-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Pins the WIRING half — that fast-monitor.js
// actually routes its broker fallback through the scheduler in
// `../lib/fast-monitor-probes.js` (unit-pinned on its own in
// `../lib/fast-monitor-probes.test.js`).
//
// FIX ROUND 3 REWRITE (26-09-2026): an adversarial refute against the FIRST
// M7 design (batch-launch with Promise.all, THEN evaluate every position
// sequentially) reproduced five blockers — that design still let one
// position's `executeBrokerAction` age out ANOTHER position's already-
// fetched quote before it was ever evaluated (B1), among others. The
// scheduler (`../lib/fast-monitor-probes.js`) is now genuinely fire-and-
// forget: `launch()` is never awaited by a pass, and a LATER pass's
// `peek()` (re-checked per position, at that position's own evaluation
// moment) decides whether a result is still fresh enough to use.
//
// THE SHAPE OF EVERY TEST BELOW CHANGES ACCORDINGLY: a pass that only
// LAUNCHES a probe evaluates NOTHING from it (`checked` stays 0 for that
// symbol) — the result is used on a LATER pass, exactly as V3-SEQUENCE
// item 33 specifies ("results used on the next pass"). Every test here
// therefore runs the tick TWICE (launch, then drain, then evaluate) where
// the old file ran it once and awaited the batch inline. `_drainFastMonitorProbesForTests()`
// is the seam that makes "the background probe finished" deterministic
// between two simulated passes instead of racing real timers.
//
// OPEN (not answered here, OD-22's second half): the staleness rule for a
// symbol that stays quiet in an OPEN market is an owner decision — this file
// only tests HOW OFTEN the broker is re-asked, never whether an old quote is
// good enough to trade on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  runFastMonitor, _resetFastDecisionStateForTests, _resetFastMonitorProbeSchedulerForTests,
  _setFastMonitorProbeCapForTests, _getFastMonitorProbeCapForTests, _drainFastMonitorProbesForTests,
} from './fast-monitor.js'
import { PROBE_CAP_DEFAULT, PROBE_CAP_MAX } from '../lib/fast-monitor-probes.js'

const CREDS = { ready: true, host: 'demo.ctraderapi.com', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '111', isLive: false }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One db reused across cases in this file — loop.js memoises its prepared
// statements against the FIRST db it sees (same convention as the sibling
// sidecar-quotes test file).
let SHARED = null
function mkDb() {
  if (!SHARED) {
    SHARED = initDB(':memory:')
    SHARED.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  }
  const db = SHARED
  db.prepare('DELETE FROM monitored_positions').run()
  setState(db, 'ctrader_account_id', '111')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDCAD: 3, AUDUSD: 4, NZDUSD: 5 }))
  _resetFastDecisionStateForTests()
  _resetFastMonitorProbeSchedulerForTests()
  return db
}

function addPos(db, symbol) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, created_at)
    VALUES (?, 'BUY', 1.1000, 1.0950, 1.1200, 0.0050, 'active', 'autopilot', 'fib_618_fade', '111', datetime('now'))
  `).run(symbol).lastInsertRowid
}

let clockBase = 1_900_000_000_000
// `brokerQuote`: what wsGetSpotOnce resolves to — a fixed quote object by
// default, or `null` to simulate a genuinely quiet symbol (no quote at
// all), the only condition under which B1 lets backoff arm. May also be a
// function of symbolId for per-symbol control.
function deps({ quotesBody = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }, now, onProbe, brokerQuote = { bid: 1.1005, ask: 1.1007 } } = {}) {
  const calls = { sidecar: [], ws: [] }
  const t = now ?? (clockBase += 3_600_000)
  const d = {
    calls,
    now: () => t,
    brokerQuote, // read via `d.brokerQuote` below — reassignable mid-test, unlike a closed-over parameter
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsGetSpotOnce: async (_h, _c, _s, _t, _a, symbolId) => {
        calls.ws.push(symbolId)
        onProbe?.(symbolId)
        await sleep(15)
        return typeof d.brokerQuote === 'function' ? d.brokerQuote(symbolId) : d.brokerQuote
      },
    },
    exec: {
      sidecarQuotes: async (isLive) => { calls.sidecar.push({ isLive }); return typeof quotesBody === 'function' ? quotesBody(t) : quotesBody },
    },
  }
  return d
}

const readWork = (db) => JSON.parse(getState(db, 'fast_monitor_position_work_json')).positions

test('M7 fire-and-forget: four symbols needing a broker probe in ONE pass all LAUNCH concurrently; none is evaluated until a LATER pass peeks a fresh result', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD'); addPos(db, 'AUDUSD')
  let inFlight = 0
  let maxInFlight = 0
  const d = deps({
    onProbe: () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => { inFlight-- }, 15) },
  })
  const out1 = await runFastMonitor(db, CREDS, d)
  assert.equal(out1.checked, 0, 'nothing is evaluated on the pass that LAUNCHES the probes — results are used on the NEXT pass (V3-SEQUENCE:537)')
  assert.deepEqual(d.calls.ws.sort(), [1, 2, 3, 4], 'every symbol was launched this pass')
  assert.equal(maxInFlight, 4, `all four broker probes must overlap — a serial fallback would peak at 1, got ${maxInFlight}`)

  await _drainFastMonitorProbesForTests()
  // Same instant (the fixed clock never moved) — every probe landed and is
  // still fresh, so the SECOND pass is where they are actually used.
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 4, 'all four now evaluated from their fresh (peeked) probe results')
  assert.deepEqual(d.calls.ws.sort(), [1, 2, 3, 4], 'no symbol was re-probed — a fresh cached result was reused, not re-fetched')
})

test('M7 cap: with the cap set to 2, only 2 of 3 due symbols LAUNCH this pass; the third is deferred, not invented, and gets its own later launch (never a stale/reused quote)', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(2)
  try {
    addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD')
    const d = deps()
    const out1 = await runFastMonitor(db, CREDS, d)
    assert.equal(out1.checked, 0, 'launch-only pass — nothing evaluated yet')
    assert.equal(d.calls.ws.length, 2, 'exactly the cap launched, never all three')
    assert.deepEqual(d.calls.ws, [1, 2], 'EURUSD and GBPUSD (first two, both never-probed) win the cap; USDCAD is deferred')

    await _drainFastMonitorProbesForTests()
    const out2 = await runFastMonitor(db, CREDS, d)
    assert.equal(out2.checked, 2, 'EURUSD and GBPUSD evaluated from their now-fresh probes')
    assert.deepEqual(d.calls.ws, [1, 2, 3], 'USDCAD (still never-probed) now gets the cap — its own launch, not a reused/invented quote')

    await _drainFastMonitorProbesForTests()
    const out3 = await runFastMonitor(db, CREDS, d)
    assert.equal(out3.checked, 1, 'only USDCAD evaluated this pass — the other two are not yet due again on the unchanged clock')
    assert.deepEqual(d.calls.ws, [1, 2, 3], 'no further launches were needed')
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('B2 fairness (wiring pin): N > cap symbols on an empty side are ALL launched within ceil(N/cap) passes, none starved by sortFair', async () => {
  const db = mkDb()
  const CAP = 2
  _setFastMonitorProbeCapForTests(CAP)
  try {
    const symbols = ['EURUSD', 'GBPUSD', 'USDCAD', 'AUDUSD', 'NZDUSD']
    for (const s of symbols) addPos(db, s)
    const d = deps()
    const everLaunched = new Set()
    const passes = Math.ceil(symbols.length / CAP)
    for (let pass = 0; pass < passes; pass++) {
      d.calls.ws.length = 0
      await runFastMonitor(db, CREDS, d) // launches whatever is still never-probed, under the cap
      for (const id of d.calls.ws) everLaunched.add(id)
      await _drainFastMonitorProbesForTests() // lets this pass's launches land so the NEXT pass can evaluate + free room
    }
    assert.deepEqual([...everLaunched].sort((a, b) => a - b), [1, 2, 3, 4, 5], `every symbol must be launched within ${passes} passes (cap ${CAP}, ${symbols.length} symbols)`)
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('B1 wiring pin: a cap-deferred position never gets a stale or reused quote — it takes NO verdict this pass, never an old (or invented) one', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(1)
  try {
    addPos(db, 'EURUSD') // BUY, entry 1.1000, stop 1.0950
    setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01, GBPUSD: 0.01 })) // 15s-floor cadence
    const t0 = clockBase += 3_600_000
    const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }
    const d = deps({ now: t0, quotesBody: emptySide, brokerQuote: { bid: 1.1005, ask: 1.1007 } })

    // Pass 1: launch EURUSD's probe. Nothing evaluated yet.
    const out1 = await runFastMonitor(db, CREDS, d)
    assert.equal(out1.checked, 0)
    assert.deepEqual(d.calls.ws, [1])
    await _drainFastMonitorProbesForTests()

    // Pass 2, same instant: EURUSD's fresh (SAFE) probe result is peeked and
    // evaluated — this is the quote a stale-reuse bug would later replay.
    const out2 = await runFastMonitor(db, CREDS, d)
    assert.equal(out2.checked, 1)
    const row1 = db.prepare(`SELECT last_check_action FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
    assert.match(row1.last_check_action, /FAST:HOLD/)

    // Pass 3, 16s later: past both the 15s cadence floor (EURUSD due again)
    // and the 10s peek freshness window (EURUSD's pass-1 probe result is now
    // stale). GBPUSD is newly added and never-probed. The broker WOULD
    // answer 1.0900 for EURUSD (through its 1.0950 stop) if it were asked —
    // but the cap (1) is fair (sortFair): GBPUSD (never-probed) wins it;
    // EURUSD (already probed once before) is deferred. If EURUSD's stale
    // cached quote — or anything invented — were reused, it would wrongly
    // act on a position that was never actually re-priced this pass.
    addPos(db, 'GBPUSD')
    const t3 = t0 + 16_000
    d.now = () => t3
    const brokerNowThroughStop = (symbolId) => (symbolId === 1 ? { bid: 1.0900, ask: 1.0902 } : { bid: 1.27, ask: 1.2702 })
    d.brokerQuote = brokerNowThroughStop
    const out3 = await runFastMonitor(db, CREDS, d)
    assert.deepEqual(d.calls.ws, [1, 2], 'GBPUSD (never-probed) wins the cap this pass — EURUSD is not relaunched, and nothing stale is reused for it')
    assert.equal(out3.checked, 0, 'neither position gets a verdict this pass: GBPUSD only just launched, EURUSD deferred')
    const row2 = db.prepare(`SELECT last_check_action, status FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
    assert.equal(row2.status, 'active', 'never touched by a broker action from a stale or reused quote')
    assert.match(row2.last_check_action, /FAST:HOLD/, 'still the pass-2 stamp — pass 3 wrote nothing for EURUSD')
    const eurReceipt = readWork(db).find((p) => p.symbol === 'EURUSD')
    assert.equal(eurReceipt.state, 'probe_deferred', 'deferred — never quote_unavailable, never evaluated, never anything reused')
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('B3 wiring pin: a cap-deferred position is NEVER stamped lastCheckAt — it stays due on the very next tick, however soon, instead of being silently skipped as not_due', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(2)
  try {
    addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD')
    const t = clockBase += 3_600_000
    const d = deps({ now: t, brokerQuote: { bid: 1.1005, ask: 1.1007 } })

    const out1 = await runFastMonitor(db, CREDS, d)
    assert.equal(out1.checked, 0, 'launch-only pass — nothing evaluated yet')
    assert.deepEqual(d.calls.ws, [1, 2], 'EURUSD and GBPUSD (first two, both never-probed) win the cap of 2; USDCAD is deferred')
    const usdAfter1 = readWork(db).find((p) => p.symbol === 'USDCAD')
    assert.equal(usdAfter1.state, 'probe_deferred')
    await _drainFastMonitorProbesForTests()

    // Same instant (the clock never moved) — if the cap-deferred item had
    // been stamped lastCheckAt in pass 1 (the bug B3 fixed), it would now
    // read as not_due and would never even reach the scheduler again; it
    // must instead still be due, and — with both other slots now free after
    // the drain — actually get its own launch this time.
    const out2 = await runFastMonitor(db, CREDS, d)
    assert.equal(out2.checked, 2, 'EURUSD and GBPUSD evaluated from their now-fresh probes')
    assert.deepEqual(d.calls.ws, [1, 2, 3], 'USDCAD (still due — never falsely marked not_due) now gets its own launch')
    const usdAfter2 = readWork(db).find((p) => p.symbol === 'USDCAD')
    assert.equal(usdAfter2.state, 'probe_deferred', 'launched this time, but still no verdict THIS pass — fire-and-forget')
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('M7 backoff (B1/B2): a quiet symbol backs off once its clean no-quote answer goes stale, ONLY while its side stays fresh; past the backoff window it is eligible again', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 })) // 15s-floor cadence
  const t0 = clockBase += 3_600_000
  // A fresh quote for another symbol on the same side (GBPUSD, id 2) — the
  // side is up, only EURUSD itself is quiet. `quotesBody` is a function of
  // the pass's own `now()` so "fresh" tracks whichever pass is running.
  const quotesWithOther = (tt) => ({ feed: 'up', generation: 1, accountId: '111', nowMs: tt, count: 1, quotes: [{ symbolId: 2, bid: 1.27, ask: 1.2702, tsMs: tt - 500, recvMs: tt - 500 }] })
  // B1: backoff arms only after a NO-QUOTE probe — the broker mock must
  // actually return nothing for EURUSD to legitimately exercise it.
  const d = deps({ now: t0, quotesBody: quotesWithOther, brokerQuote: null })

  // Pass 1: launch EURUSD's probe (fire-and-forget).
  const out1 = await runFastMonitor(db, CREDS, d)
  assert.equal(out1.checked, 0)
  assert.deepEqual(d.calls.ws, [1])
  await _drainFastMonitorProbesForTests()

  // Pass 2, shortly after (lastCheckAt was never stamped in pass 1, so this
  // is due regardless of the gap): the fresh clean "nothing here" answer is
  // peeked directly — a genuine quote_unavailable confirmation, not backoff
  // yet. This is what stamps lastCheckAt for the first time.
  const t2 = t0 + 100
  d.now = () => t2
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 0, 'a clean no-quote confirmation is never an evaluation')
  assert.deepEqual(d.calls.ws, [1], 'no re-probe — the fresh cached "nothing here" answer was reused')
  const row2 = readWork(db).find((p) => p.symbol === 'EURUSD')
  assert.equal(row2.state, 'quote_unavailable')

  // Pass 3, 16s after pass 2 (past the 15s cadence floor from lastCheckAt,
  // AND past the probe's own 10s freshness window from its pass-1 launch):
  // due again, but now with nothing fresh to peek — this is where backoff
  // is actually decided.
  const t3 = t2 + 16_000
  d.now = () => t3
  const out3 = await runFastMonitor(db, CREDS, d)
  assert.equal(out3.checked, 0)
  assert.deepEqual(d.calls.ws, [1], 'backed off — the last probe SUCCEEDED with no quote and the rest of the side is fresh (B1); no second broker round trip')
  const row3 = readWork(db).find((p) => p.symbol === 'EURUSD')
  assert.equal(row3.state, 'probe_backoff')

  // Pass 4, past the 60s default backoff window measured from the ORIGINAL
  // probe launch (t0): eligible again, and actually relaunches.
  const t4 = t0 + 61_000
  d.now = () => t4
  const out4 = await runFastMonitor(db, CREDS, d)
  assert.equal(out4.checked, 0, 'launch-only pass again')
  assert.deepEqual(d.calls.ws, [1, 1], 'past the backoff window: a genuine second broker round trip')
})

test('M7 backoff: a quiet SIDE (no fresh quote anywhere) never backs off — it keeps retrying every time it is due', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }
  const t0 = clockBase += 3_600_000
  const d = deps({ now: t0, quotesBody: emptySide, brokerQuote: null })

  const out1 = await runFastMonitor(db, CREDS, d)
  assert.equal(out1.checked, 0)
  assert.deepEqual(d.calls.ws, [1])
  await _drainFastMonitorProbesForTests()

  // Past the probe's 10s freshness window (so the cached clean no-quote
  // answer is 'stale', not reused) — with the side itself never fresh,
  // shouldBackoff's own guard (`if (!sideHasFreshQuote) return false`)
  // means this is eligible again regardless of how little time passed
  // since the last probe.
  const t2 = t0 + 11_000
  d.now = () => t2
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 0)
  assert.deepEqual(d.calls.ws, [1, 1], 'a quiet SIDE keeps retrying — never backs off')
  await _drainFastMonitorProbesForTests()

  const t3 = t2 + 11_000
  d.now = () => t3
  const out3 = await runFastMonitor(db, CREDS, d)
  assert.equal(out3.checked, 0)
  assert.deepEqual(d.calls.ws, [1, 1, 1], 'still retrying — a stale SIDE is a feed problem, not a quiet symbol')
})

test('skip share (point 7): a slow/hung broker probe never makes the PASS itself slow — launch really is fire-and-forget', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  const d = deps({ brokerQuote: { bid: 1.1005, ask: 1.1007 } })
  // Replace wsGetSpotOnce with one that hangs far longer than any
  // reasonable pass budget — if launch() ever awaited this inline (the
  // pre-M7 design, or a batch-then-Promise.all design), the pass itself
  // would take just as long.
  d.ws.wsGetSpotOnce = async (_h, _c, _s, _t, _a, symbolId) => {
    d.calls.ws.push(symbolId)
    await sleep(1_500)
    return { bid: 1.1005, ask: 1.1007 }
  }
  const start = Date.now()
  const out = await runFastMonitor(db, CREDS, d)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 500, `the pass itself must return almost immediately regardless of the probe's own duration — took ${elapsed}ms`)
  assert.equal(out.checked, 0, 'nothing evaluated yet — the probe is still in flight in the background')
  assert.deepEqual(d.calls.ws, [1])
  await _drainFastMonitorProbesForTests() // let the background timer settle before the process/test file exits
})

// N1 (nit round, 26-09-2026): _setFastMonitorProbeCapForTests must CLAMP,
// not bare-assign — the wiring-level pin for fast-monitor-probes.js's own
// clampCap unit tests, so a bare `probeScheduler.cap = n` regression here
// is caught even if the library's own validation stays intact.
test('_setFastMonitorProbeCapForTests (N1): clamps through clampCap, not a bare assignment', () => {
  try {
    _setFastMonitorProbeCapForTests(0)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT, 'a bare assignment would leave the scheduler with cap 0 — probing silently disabled')
    _setFastMonitorProbeCapForTests(-5)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT)
    _setFastMonitorProbeCapForTests(1e9)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_MAX, 'a bare assignment would leave the scheduler unbounded')
    _setFastMonitorProbeCapForTests(0.5)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT, '0.5 floors to 0, not a valid 1')
    _setFastMonitorProbeCapForTests(3)
    assert.equal(_getFastMonitorProbeCapForTests(), 3, 'an ordinary valid value passes through unchanged')
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})
