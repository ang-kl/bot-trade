// node --test agent/services/fast-monitor-m7-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Pins the WIRING — that runFastMonitor keeps
// the round-4 invariants I1–I6 of ../lib/fast-monitor-probes.js (the board
// itself is unit-pinned in ../lib/fast-monitor-probes.test.js; the behaviour
// against origin/main in fast-monitor-m7-differential.test.js):
//
//   I1  probes launch where main would await them, in parallel under the cap,
//       and an answer inside the pass's wait is acted on IN THAT PASS; a
//       slower one is acted on first thing next pass;
//   I2  inside a spike window every tick re-prices (round 2's pin, restored —
//       round 3 had deleted it);
//   I3  a failure never backs off; only a clean empty answer can, and never
//       in a spike window;
//   I4  a position waiting on a probe has no verdict: probe_pending, no
//       decision row, no quote_unavailable;
//   I5  the wait carries main's lateness eligibility, across a restart too;
//   I6  one broker call is counted once; a launch-only pass counts nothing.
//
// Plus the round-3 nits: the spike detector's clock (nit 3) and the probe's
// own staleness bound (nit 4).

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  runFastMonitor, startFastMonitor, waitEligibility, _resetFastDecisionStateForTests, _resetFastMonitorProbeSchedulerForTests,
  _setFastMonitorProbeCapForTests, _getFastMonitorProbeCapForTests, _drainFastMonitorProbesForTests,
} from './fast-monitor.js'
import { PROBE_CAP_DEFAULT, PROBE_CAP_MAX } from '../lib/fast-monitor-probes.js'
import { _resetAmendLatencyForTests, _amendLatencyStateForTests } from './protection-latency.js'

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
  db.prepare(`DELETE FROM decision_log WHERE stage = 'fast_monitor'`).run()
  setState(db, 'ctrader_account_id', '111')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDCAD: 3, AUDUSD: 4, NZDUSD: 5 }))
  setState(db, 'monitor_overrides_json', '{}')
  setState(db, 'fast_monitor_position_work_json', null)
  _resetFastDecisionStateForTests()
  _resetFastMonitorProbeSchedulerForTests()
  return db
}

function addPos(db, symbol, { trigger = null, entry = 1.1000, sl = 1.0950 } = {}) {
  return db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, invalidation_trigger, created_at)
    VALUES (?, 'BUY', ?, ?, 1.1200, 0.0050, 'active', 'autopilot', 'fib_618_fade', '111', ?, datetime('now'))
  `).run(symbol, entry, sl, trigger).lastInsertRowid
}

let clockBase = 1_900_000_000_000
// `answer`: what wsProbeSpot answers — an object, or a function of symbolId.
function deps({ quotesBody = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }, now, answer = { kind: 'quote', bid: 1.1005, ask: 1.1007 }, delayMs = 15, probeWaitMs = 2_000 } = {}) {
  const calls = { ws: [], actions: [] }
  const t = now ?? (clockBase += 3_600_000)
  const d = {
    calls,
    now: () => t,
    probeWaitMs,
    answer,
    delayMs,
    inFlight: 0,
    maxInFlight: 0,
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsProbeSpot: async (_h, _c, _s, _t, _a, symbolId) => {
        calls.ws.push(symbolId)
        d.inFlight++
        d.maxInFlight = Math.max(d.maxInFlight, d.inFlight)
        try {
          await sleep(d.delayMs)
          return typeof d.answer === 'function' ? d.answer(symbolId) : d.answer
        } finally { d.inFlight-- }
      },
      // other consumers of the same ws (the ticker's session-open guard) ask the legacy call
      wsGetSpotOnce: async () => null,
    },
    exec: {
      sidecarQuotes: async () => (typeof quotesBody === 'function' ? quotesBody(d.now()) : quotesBody),
    },
  }
  return d
}
// A side whose OTHER symbol (GBPUSD, id 2) streams fresh quotes: the
// condition under which a quiet symbol may back off.
const sideFreshOther = (tt) => ({ feed: 'up', generation: 1, accountId: '111', nowMs: tt, count: 1, quotes: [{ symbolId: 2, bid: 1.27, ask: 1.2702, tsMs: tt - 500, recvMs: tt - 500 }] })
const readWork = (db) => JSON.parse(getState(db, 'fast_monitor_position_work_json')).positions
const rows = (db) => db.prepare(`SELECT decision, reason FROM decision_log WHERE stage = 'fast_monitor' ORDER BY id`).all()

test('I1: four symbols needing a broker probe in ONE pass launch together and are evaluated in THAT pass when they answer inside its wait', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD'); addPos(db, 'AUDUSD')
  const d = deps()
  const out = await runFastMonitor(db, CREDS, d)
  assert.deepEqual([...d.calls.ws].sort(), [1, 2, 3, 4])
  assert.equal(d.maxInFlight, 4, `all four broker probes overlap — a serial fallback peaks at 1, got ${d.maxInFlight}`)
  assert.equal(out.checked, 4, 'answered inside the wait: acted on in the pass that asked, as main would')
  assert.deepEqual(readWork(db).map(r => r.state), ['evaluated', 'evaluated', 'evaluated', 'evaluated'])
})

test('I1 cap: with the cap at 2 the third probe QUEUES and starts as a slot frees — never more than 2 at once, all three evaluated in the pass', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(2)
  try {
    addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD')
    const d = deps()
    const out = await runFastMonitor(db, CREDS, d)
    assert.equal(d.maxInFlight, 2, 'the cap holds')
    assert.deepEqual(d.calls.ws, [1, 2, 3], 'FIFO: the queued one started when the first slot freed')
    assert.equal(out.checked, 3)
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('I1/I4: a slow probe never holds the pass past its wait; the position waits with NO verdict, and is acted on first thing next pass without asking again', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  const d = deps({ delayMs: 400, probeWaitMs: 50 })
  const started = Date.now()
  const out1 = await runFastMonitor(db, CREDS, d)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 350, `the pass returned at its 50 ms wait, not after the 400 ms probe — took ${elapsed} ms`)
  assert.equal(out1.checked, 0)
  const r1 = readWork(db)[0]
  assert.equal(r1.state, 'probe_pending')
  assert.equal(r1.probeState, 'in_flight')
  assert.equal(r1.lastOutcome, null, 'no verdict was invented for a probe still in flight')
  assert.equal(r1.lastPricedAt, null)
  assert.deepEqual(rows(db), [], 'a wait is not a skip: no decision row (nit 2)')
  assert.deepEqual(out1.quotes, { fromSidecar: 0, fromBroker: 0, stale: 0 }, 'a launch-only pass counts nothing (I6) — it must not replace the last priced record')
  assert.equal(out1.timing.priced, 0)
  await _drainFastMonitorProbesForTests()
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 1, 'consumed at the START of the next pass (I1 a)')
  assert.deepEqual(d.calls.ws, [1], 'the landed answer was used, not re-asked')
  assert.deepEqual(out2.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 }, 'counted in the pass that priced with it')
  assert.equal(readWork(db)[0].state, 'evaluated')
  assert.deepEqual(rows(db), [], 'a successful broker-priced cycle writes no decision row, as on main (nit 2)')
})

// Round 2's pin, deleted in round 3 (a73efbb:202-251) and restored: the
// spike window re-prices on EVERY tick with a real broker probe.
test('I2: a symbol with a successful probe is re-probed on its normal cadence; a spike fast-tracks it — the spike triggers a real fourth probe', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 })) // 15s-floor cadence
  let t = clockBase += 3_600_000
  // A fresh OTHER symbol on the side: the backoff COULD arm here if its gate
  // were wrong, so a green run means the gate held, not that it was never asked.
  const d = deps({ now: t, quotesBody: sideFreshOther })
  d.now = () => t
  const out1 = await runFastMonitor(db, CREDS, d)
  assert.equal(out1.checked, 1)
  assert.deepEqual(d.calls.ws, [1])

  t += 20_000
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 1, 'pass 2 evaluated again, on a fresh probe')
  assert.deepEqual(d.calls.ws, [1, 1], 'a genuine second broker round trip, not a reuse')

  // Pass 3, 20 s later: the price jumps ~1.8 % against pass 2's 1.1006 — the
  // spike is detected on this pass's evaluation.
  t += 20_000
  d.answer = { kind: 'quote', bid: 1.1200, ask: 1.1202 }
  const out3 = await runFastMonitor(db, CREDS, d)
  assert.equal(out3.checked, 1)
  assert.deepEqual(d.calls.ws, [1, 1, 1])

  // Pass 4, 0.5 s later — far too soon for the 15 s cadence on its own.
  t += 500
  d.answer = { kind: 'quote', bid: 1.1205, ask: 1.1207 }
  const out4 = await runFastMonitor(db, CREDS, d)
  assert.equal(out4.checked, 1, 'the spike, not the cadence, made this due')
  assert.deepEqual(d.calls.ws, [1, 1, 1, 1], 'the spike triggered a real fourth probe')
})

test('I3: a FAILED probe is recorded as main records a null quote and retried on main\'s cadence — never backed off, however fresh the side', async () => {
  for (const failure of [{ kind: 'failed', reason: 'cTrader error: auth failed' }, 'legacy-null']) {
    const db = mkDb()
    const id = addPos(db, 'EURUSD')
    setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
    let t = clockBase += 3_600_000
    const d = deps({ now: t, quotesBody: sideFreshOther, answer: failure })
    d.now = () => t
    if (failure === 'legacy-null') {
      // an injected ws with only the legacy call: its null cannot say whether it failed or was silent
      d.ws = { wsGetTrendbarsBatch: d.ws.wsGetTrendbarsBatch, wsGetSpotOnce: async (_h, _c, _s, _t, _a, symbolId) => { d.calls.ws.push(symbolId); await sleep(10); return null } }
    }
    await runFastMonitor(db, CREDS, d)
    const r1 = readWork(db).find(p => p.positionId === id)
    assert.equal(r1.state, 'quote_unavailable', JSON.stringify(failure))
    assert.equal(r1.probeResult, 'failed')
    t += 16_000
    await runFastMonitor(db, CREDS, d)
    assert.deepEqual(d.calls.ws, [1, 1], `${JSON.stringify(failure)}: due again on the cadence → asked again, NOT backed off`)
    assert.notEqual(readWork(db).find(p => p.positionId === id).state, 'probe_backoff')
  }
})

test('I3: only a CLEAN EMPTY answer backs off — while the side streams, for backoffMs from the launch — and a spike window never backs off', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
  let t = clockBase += 3_600_000
  const t0 = t
  const d = deps({ now: t, quotesBody: sideFreshOther, answer: { kind: 'empty', reason: 'subscribed; no two-sided price' } })
  d.now = () => t
  await runFastMonitor(db, CREDS, d)
  assert.equal(readWork(db)[0].state, 'quote_unavailable')
  const skips = rows(db).length
  assert.equal(skips, 1, 'one skip row for the no-quote verdict, as on main')

  t = t0 + 16_000 // due on the cadence
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1], 'backed off: no second broker call')
  const r2 = readWork(db)[0]
  assert.equal(r2.state, 'probe_backoff', 'named as what it is — graded like any state, never exempt (X5)')
  assert.equal(r2.lastOutcome, 'quote_unavailable', 'the verdict that armed it is carried')
  // S1 (round 5): the backoff is its own decision state, so the transition-
  // gated log records it — under 'no_quote' (the empty answer's state) it
  // never reached the log.
  const logged = rows(db)
  assert.equal(logged.length, skips + 1, 'entering the backoff writes ONE decision row')
  assert.match(logged.at(-1).reason, /backing off.*OD-22/, 'the row says it is OD-22\'s backoff')
  assert.equal(out2.probes.backoff, 1, 'the pass result counts the position it left to the backoff')

  t = t0 + 19_000 // still inside the backoff, due again
  const out3 = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1], 'still backed off')
  assert.equal(rows(db).length, skips + 1, 'the same backoff episode: no second row')
  assert.equal(out3.probes.backoff, 1)

  t = t0 + 61_000 // past the 60 s backoff from the launch
  await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1, 1], 'past the backoff: asked again')
  assert.equal(rows(db).length, skips + 1, 'still empty: the same quiet episode — no row per backoff cycle')
  t = t0 + 80_000 // backed off again after the second empty answer
  await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1, 1], 'backed off again')
  assert.equal(rows(db).length, skips + 1, 'and still one row per state for the whole episode')

  // A spike window: price the symbol twice with a sharp move, then answer empty — the next tick still probes.
  const db2 = mkDb()
  addPos(db2, 'EURUSD')
  setState(db2, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
  t = clockBase += 3_600_000
  const d2 = deps({ now: t, quotesBody: sideFreshOther })
  d2.now = () => t
  await runFastMonitor(db2, CREDS, d2)
  t += 16_000
  d2.answer = { kind: 'quote', bid: 1.1200, ask: 1.1202 } // +1.8 % in 16 s: a spike
  await runFastMonitor(db2, CREDS, d2)
  t += 3_000
  d2.answer = { kind: 'empty', reason: 'silent' }
  await runFastMonitor(db2, CREDS, d2)
  t += 3_000
  await runFastMonitor(db2, CREDS, d2)
  assert.deepEqual(d2.calls.ws, [1, 1, 1, 1], 'inside the spike window every tick probes, empty answer or not')
  assert.notEqual(readWork(db2)[0].state, 'probe_backoff')
})

test('I6 (nit 1): two positions on one symbol share ONE probe — one broker call counted once, two positions priced', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD'); addPos(db, 'EURUSD')
  const d = deps({ quotesBody: { feed: 'up', generation: 1, accountId: '111', count: 1, quotes: [{ symbolId: 1, bid: 1.1, ask: 1.1002, tsMs: 0, recvMs: 0 }] } })
  const out = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1], 'one broker call')
  assert.equal(out.checked, 2)
  assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 1, stale: 1 }, 'fromBroker and stale per CALL, not per position')
  assert.equal(out.timing.brokerQuotes, 1)
  assert.equal(out.timing.priced, 2, 'positions priced')
  assert.ok(out.timing.pricingMs >= 10 && out.timing.pricingMs < 200, `the one call's round trip, once: ${out.timing.pricingMs} ms`)
})

test('nit 3: the spike detector measures the move between the times prices were OBSERVED, never when a pass got round to them', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
  let t = clockBase += 3_600_000
  const t0 = t
  const d = deps({ now: t, probeWaitMs: 0, answer: { kind: 'quote', bid: 1.1000, ask: 1.1000 } })
  d.now = () => t
  // Observed at t0, acted on 2.5 s later.
  await runFastMonitor(db, CREDS, d)
  await _drainFastMonitorProbesForTests()
  t = t0 + 2_500
  assert.equal((await runFastMonitor(db, CREDS, d)).checked, 1)
  // Observed at t0 + 15 s, acted on at once: +0.09 % over the 15 s between
  // the observations is 0.36 %/min, under the 0.4 %/min spike rate; measured
  // from when the first was ACTED on (12.5 s) it would read 0.43 %/min.
  t = t0 + 15_000
  d.probeWaitMs = 2_000
  d.answer = { kind: 'quote', bid: 1.1009900, ask: 1.1009900 }
  assert.equal((await runFastMonitor(db, CREDS, d)).checked, 1)
  t = t0 + 16_000
  await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1, 1], 'no spike window was opened, so the next tick is not due')
})

test('nit 4: a landed quote older than the probe\'s own one-tick bound is never evaluated — however far FAST_MONITOR_QUOTE_MAX_AGE_MS is raised', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', { trigger: 'price<1.0950' })
  let t = clockBase += 3_600_000
  const t0 = t
  const d = deps({ now: t, probeWaitMs: 0, answer: { kind: 'quote', bid: 1.0900, ask: 1.0902 } }) // through the trigger
  d.now = () => t
  // S2 (round 5): a landed answer's age is read on the monotonic clock, so
  // the 11 s this test skips must pass on that clock too — as it does in a
  // real process, where both clocks advance together.
  d.monoNow = () => t
  d.quoteMaxAgeMs = 60_000
  d.loop = null
  await runFastMonitor(db, CREDS, d)
  await _drainFastMonitorProbesForTests()
  t = t0 + 11_000
  d.probeWaitMs = 2_000
  d.answer = { kind: 'quote', bid: 1.1005, ask: 1.1007 } // the market now: no exit
  const out = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1, 1], 'the 11 s old answer was not used: the broker was asked again')
  assert.equal(out.checked, 1, 'evaluated once — on the fresh answer')
  const row = db.prepare(`SELECT status, last_check_action FROM monitored_positions`).get()
  assert.equal(row.status, 'active', 'never closed on the stale price')
  assert.match(row.last_check_action, /FAST:HOLD/)
})

test('S2 (round 5): a landed answer\'s age is read on the MONOTONIC clock — a wall-clock step (NTP) alone neither ages it nor re-asks the broker', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD', { trigger: 'price<1.0950' })
  let t = clockBase += 3_600_000
  let m = 1_000_000
  const t0 = t
  const d = deps({ now: t, probeWaitMs: 0, answer: { kind: 'quote', bid: 1.1005, ask: 1.1007 } })
  d.now = () => t
  d.monoNow = () => m
  await runFastMonitor(db, CREDS, d)
  await _drainFastMonitorProbesForTests()
  // The wall clock steps 11 s forward; only 1 s really passed.
  t = t0 + 11_000
  m += 1_000
  d.probeWaitMs = 2_000
  const out = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(d.calls.ws, [1], 'the 1 s old answer was used: no second broker call on a wall-clock step')
  assert.equal(out.checked, 1)
})

test('I5: a waiter carries main\'s lateness eligibility — a first sighting stays first_seen, and a restart mid-wait keeps the eligibility the wait began with', async () => {
  _resetAmendLatencyForTests()
  const db = mkDb()
  addPos(db, 'EURUSD')
  const t = clockBase += 3_600_000
  const d = deps({ now: t, probeWaitMs: 0 })
  await runFastMonitor(db, CREDS, d)
  await _drainFastMonitorProbesForTests()
  await runFastMonitor(db, CREDS, d)
  assert.deepEqual(_amendLatencyStateForTests().excluded, { first_seen: 1, after_no_quote: 0, after_other: 0 }, 'the broker-priced first sighting is first_seen, as on main — not a one-pass lateness sample')
  assert.equal(_amendLatencyStateForTests().lateness.length, 0)

  // The unit: a probe_pending receipt answers with the eligibility it carries; anything else is main's rule.
  assert.deepEqual(waitEligibility({ state: 'probe_pending', nextDueAt: 'x', lastOutcome: 'evaluated', waitLateness: { eligible: false, reason: 'after_no_quote' } }), { eligible: false, reason: 'after_no_quote' })
  assert.deepEqual(waitEligibility({ state: 'not_due', nextDueAt: 'x', lastOutcome: 'evaluated' }), { eligible: true })
  assert.deepEqual(waitEligibility({ state: 'probe_backoff', nextDueAt: 'x', lastOutcome: 'quote_unavailable' }), { eligible: false, reason: 'after_no_quote' })
  assert.deepEqual(waitEligibility(undefined), { eligible: false, reason: 'first_seen' })
})

// N1 (nit round, 26-09-2026): _setFastMonitorProbeCapForTests must CLAMP,
// not bare-assign — the wiring-level pin for the board's own clampCap.
test('_setFastMonitorProbeCapForTests (N1): clamps through clampCap, not a bare assignment', () => {
  try {
    _setFastMonitorProbeCapForTests(0)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT, 'a bare assignment would leave the board with cap 0 — probing silently disabled')
    _setFastMonitorProbeCapForTests(-5)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT)
    _setFastMonitorProbeCapForTests(1e9)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_MAX, 'a bare assignment would leave the board unbounded')
    _setFastMonitorProbeCapForTests(0.5)
    assert.equal(_getFastMonitorProbeCapForTests(), PROBE_CAP_DEFAULT, '0.5 floors to 0, not a valid 1')
    _setFastMonitorProbeCapForTests(3)
    assert.equal(_getFastMonitorProbeCapForTests(), 3)
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('the ticker hands each pass a wait of the tick less a second (probeWaitForTick) — never the direct-call default', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  const d = deps({ delayMs: 3_000 })
  delete d.probeWaitMs // an explicit wait wins over the tick's; this pins the tick's
  const beats = []
  const stop = startFastMonitor(db, () => CREDS, { ...d, tickMs: 1_150, bandMs: 60_000, heartbeat: { beat: (_db, name, info) => beats.push({ name, info }) }, runBand: async () => {} })
  await sleep(1_700)
  stop()
  const first = beats.find(b => b.name === 'fast_monitor' && b.info?.detail?.ms != null)
  assert.ok(first, 'the first pass finished inside 1.7 s — with the 2 s direct-call default it could not have')
  assert.ok(first.info.detail.ms >= 100 && first.info.detail.ms < 1_000, `the pass waited ~150 ms for the 3 s probe, took ${first.info.detail.ms} ms`)
  await _drainFastMonitorProbesForTests()
})
