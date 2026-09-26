// node --test agent/services/fast-monitor-m7-probes.test.js
//
// M7 (P1/P4-4, V3-SEQUENCE:536-543; OD-22 26-09-2026: "parallel probes under
// a cap, with backoff <= 5 min"). Pins the WIRING half — that fast-monitor.js
// actually routes its broker fallback through the scheduler in
// `../lib/fast-monitor-probes.js` (unit-pinned on its own in
// `../lib/fast-monitor-probes.test.js`): several positions needing a real
// broker quote in one pass launch CONCURRENTLY rather than stacking behind
// each other, and a quiet symbol backs off while the rest of its side stays
// fresh, on fast-monitor.js's OWN injected clock.
//
// OPEN (not answered here, OD-22's second half): the staleness rule for a
// symbol that stays quiet in an OPEN market is an owner decision — this file
// only tests HOW OFTEN the broker is re-asked, never whether an old quote is
// good enough to trade on.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { runFastMonitor, _resetFastDecisionStateForTests, _resetFastMonitorProbeSchedulerForTests, _setFastMonitorProbeCapForTests, _getFastMonitorProbeCapForTests } from './fast-monitor.js'
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
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDCAD: 3, AUDUSD: 4 }))
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

test('M7 parallel batch: four symbols all needing a broker probe in ONE pass run CONCURRENTLY, not one at a time', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD'); addPos(db, 'AUDUSD')
  let inFlight = 0
  let maxInFlight = 0
  const d = deps({
    onProbe: () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => { inFlight-- }, 15) },
  })
  const out = await runFastMonitor(db, CREDS, d)
  assert.equal(out.checked, 4)
  assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 4, stale: 0 })
  assert.deepEqual(d.calls.ws.sort(), [1, 2, 3, 4], 'every symbol was actually probed')
  assert.equal(maxInFlight, 4, `all four broker probes must overlap — a serial fallback would peak at 1, got ${maxInFlight}`)
})

test('M7 cap: with the cap set to 2, only 2 of 3 due symbols probe THIS pass; the third is deferred, not invented', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(2)
  try {
    addPos(db, 'EURUSD'); addPos(db, 'GBPUSD'); addPos(db, 'USDCAD')
    let maxInFlight = 0
    let inFlight = 0
    const d = deps({
      onProbe: () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => { inFlight-- }, 15) },
    })
    const out = await runFastMonitor(db, CREDS, d)
    assert.equal(out.checked, 2, 'the deferred position is not evaluated this pass — no invented quote')
    assert.deepEqual(out.quotes, { fromSidecar: 0, fromBroker: 3, stale: 0 }, 'all three counted as needing the broker; only 2 actually reached it')
    assert.equal(d.calls.ws.length, 2, 'exactly the cap, never all three')
    assert.equal(maxInFlight, 2, 'the two that DID launch ran concurrently, not serially')
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('M7 backoff: a quiet symbol is not re-probed on the very next due tick while its side stays fresh; a truly stale side keeps retrying', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  // A tiny override so the position is due again well inside the default
  // 60s backoff window — cadence has its own 15s floor (effectiveCadenceMs),
  // so the gap below is chosen to clear THAT floor while staying inside the
  // backoff window, isolating backoff from the cadence gate.
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
  let t = clockBase += 3_600_000
  // First tick: the sidecar carries nothing for EURUSD (missing) but DOES
  // carry a fresh quote for another symbol on the same side (GBPUSD, id 2)
  // — the side is up, only EURUSD is quiet.
  const quotesWithOther = (tt) => ({ feed: 'up', generation: 1, accountId: '111', nowMs: tt, count: 1, quotes: [{ symbolId: 2, bid: 1.27, ask: 1.2702, tsMs: tt - 500, recvMs: tt - 500 }] })
  // B1: backoff arms only after a NO-QUOTE probe — the broker mock must
  // actually return nothing for EURUSD to legitimately exercise it.
  const d = deps({ now: t, quotesBody: quotesWithOther, brokerQuote: null })
  const out1 = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(out1.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 })
  assert.deepEqual(d.calls.ws, [1], 'first tick: probed once')

  // Second tick, 20s later (past the 15s cadence floor, well inside the
  // default 60s backoff window), same fresh-other-symbol side: must NOT
  // probe again.
  t += 20_000
  d.now = () => t
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.deepEqual(out2.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 }, 'still counted as a broker-path symbol')
  assert.deepEqual(d.calls.ws, [1], 'backed off — no second broker round trip')

  // Third case: the side itself has gone quiet too (no fresh quote for ANY
  // symbol) — a feed problem, not a quiet symbol. Must keep retrying.
  const db2 = mkDb()
  addPos(db2, 'EURUSD')
  setState(db2, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 }))
  const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }
  const d2 = deps({ now: t, quotesBody: emptySide })
  await runFastMonitor(db2, CREDS, d2)
  t += 20_000
  d2.now = () => t
  const out2b = await runFastMonitor(db2, CREDS, d2)
  assert.deepEqual(out2b.quotes, { fromSidecar: 0, fromBroker: 1, stale: 0 })
  assert.deepEqual(d2.calls.ws, [1, 1], 'a quiet SIDE keeps retrying every tick — never backs off')
})

test('B1: a stale cached quote is NEVER evaluated — a cap-deferred position takes the no-quote path, not its old probe result', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(1)
  try {
    addPos(db, 'EURUSD') // BUY, entry 1.1000, stop 1.0950
    let t = clockBase += 3_600_000
    setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01, GBPUSD: 0.01 }))
    const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }

    // Pass 1: EURUSD alone, probe succeeds with a SAFE quote well clear of
    // its stop — this is the quote a bug would later reuse.
    const d1 = deps({ now: t, quotesBody: emptySide, brokerQuote: { bid: 1.1005, ask: 1.1007 } })
    const out1 = await runFastMonitor(db, CREDS, d1)
    assert.equal(out1.checked, 1, 'pass 1: evaluated on the real quote')
    const row1 = db.prepare(`SELECT last_check_action FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
    assert.match(row1.last_check_action, /FAST:HOLD/)

    // Pass 2: GBPUSD now also due; the broker would answer 1.0900 for
    // EURUSD if asked — THROUGH the 1.0950 stop — but the cap (1) is fair
    // (sortFair): GBPUSD, never probed, wins it; EURUSD, already probed
    // once, is deferred. If EURUSD's OLD safe quote were reused, it would
    // wrongly HOLD; it must instead take the no-quote path.
    addPos(db, 'GBPUSD')
    t += 20_000
    const brokerNowThroughStop = (symbolId) => (symbolId === 1 ? { bid: 1.0900, ask: 1.0902 } : { bid: 1.27, ask: 1.2702 })
    const d2 = deps({ now: t, quotesBody: emptySide, brokerQuote: brokerNowThroughStop })
    const out2 = await runFastMonitor(db, CREDS, d2)
    assert.deepEqual(d2.calls.ws, [2], 'only GBPUSD (never-probed) actually reached the broker this pass — EURUSD did not')
    const row2 = db.prepare(`SELECT last_check_action, status FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
    assert.equal(row2.status, 'active', 'never touched by a broker action from a stale quote')
    // The pass-1 HOLD stamp is the last thing written for EURUSD — pass 2
    // must not have re-stamped it from an invented/cached evaluation.
    assert.match(row2.last_check_action, /FAST:HOLD/, 'still the pass-1 stamp, not a fresh (and wrong) one')
    const readWork = () => JSON.parse(getState(db, 'fast_monitor_position_work_json')).positions
    const eurReceipt = readWork().find((p) => p.symbol === 'EURUSD')
    assert.equal(eurReceipt.probeState, 'deferred')
    assert.equal(eurReceipt.state, 'quote_unavailable', 'deferred takes the no-quote path — never "evaluated"')
    void out2
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('M7: a symbol with a successful probe is re-probed on its normal cadence (never permanently deferred/backed off); a spike still fast-tracks it', async () => {
  const db = mkDb()
  addPos(db, 'EURUSD')
  setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01 })) // 15s-floor cadence
  let t = clockBase += 3_600_000
  // WIRING PIN (nit round, 26-09-2026): a FRESH quote for another symbol on
  // the same side (GBPUSD, id 2) — not the empty side used elsewhere in this
  // file. With an empty side, sideHasFreshQuote is always false and
  // ProbeScheduler.plan()'s backoff branch can never arm regardless of B1's
  // no-quote gate, so mutating that gate out leaves this test green for the
  // wrong reason (it never exercises the branch at all). With a fresh other
  // symbol here, backoff WOULD arm on pass 2 if B1's gate were removed
  // (EURUSD's pass-1 probe succeeded, side is fresh) — the assertion that
  // pass 2 still reaches the broker is what actually pins the gate.
  const sideFreshOther = (tt) => ({ feed: 'up', generation: 1, accountId: '111', nowMs: tt, count: 1, quotes: [{ symbolId: 2, bid: 1.27, ask: 1.2702, tsMs: tt - 500, recvMs: tt - 500 }] })
  const d = deps({ now: t, quotesBody: sideFreshOther, brokerQuote: { bid: 1.1005, ask: 1.1007 } })
  const out1 = await runFastMonitor(db, CREDS, d)
  assert.equal(out1.checked, 1)
  assert.deepEqual(d.calls.ws, [1])

  // Normal cadence: 20s later (past the 15s floor), still due, a SECOND
  // real broker probe — a successful probe is never backed off (B1), so it
  // is not stuck reusing pass 1's answer.
  t += 20_000
  d.now = () => t
  const out2 = await runFastMonitor(db, CREDS, d)
  assert.equal(out2.checked, 1, 'pass 2 evaluated again, on a fresh probe')
  assert.deepEqual(d.calls.ws, [1, 1], 'a genuine second broker round trip, not a reuse')

  // Pass 3, 20s later (normal cadence again — NOT yet a spike): the price
  // jumps hard versus pass 2's 1.1006. isSpikeMove is evaluated AFTER this
  // pass prices, comparing against the PREVIOUS mid — so this pass arms
  // spikeUntil for the position but is itself still an ordinary due-by-
  // cadence check.
  t += 20_000
  d.now = () => t
  d.brokerQuote = { bid: 1.1200, ask: 1.1202 } // ~1.8% move in 20s — far past SPIKE_PCT_PER_MIN
  const out3 = await runFastMonitor(db, CREDS, d)
  assert.equal(out3.checked, 1, 'pass 3: due by cadence as usual, and this is where the spike is detected')
  assert.deepEqual(d.calls.ws, [1, 1, 1])

  // Pass 4, 0.5s later — far too soon for the 15s cadence on its own: the
  // spike armed by pass 3 must fast-track it anyway.
  t += 500
  d.now = () => t
  d.brokerQuote = { bid: 1.1205, ask: 1.1207 }
  const out4 = await runFastMonitor(db, CREDS, d)
  assert.equal(out4.checked, 1, 'the spike, not the cadence, made this due')
  assert.deepEqual(d.calls.ws, [1, 1, 1, 1], 'the spike triggered a real fourth probe')
})

test('B2: a cap-deferred item is NOT stamped lastCheckAt — it stays due on the very next tick, no matter how soon', async () => {
  const db = mkDb()
  _setFastMonitorProbeCapForTests(1)
  try {
    addPos(db, 'EURUSD'); addPos(db, 'GBPUSD')
    setState(db, 'monitor_overrides_json', JSON.stringify({ EURUSD: 0.01, GBPUSD: 0.01 }))
    let t = clockBase += 3_600_000
    const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }
    const d = deps({ now: t, quotesBody: emptySide, brokerQuote: { bid: 1.1005, ask: 1.1007 } })
    const out1 = await runFastMonitor(db, CREDS, d)
    assert.equal(out1.checked, 1, 'only one of the two — the cap is 1')
    assert.deepEqual(d.calls.ws, [1], 'EURUSD (first in insertion order, never-probed) wins the cap')
    const readWork = () => JSON.parse(getState(db, 'fast_monitor_position_work_json')).positions
    const gbpAfter1 = readWork().find((p) => p.symbol === 'GBPUSD')
    assert.equal(gbpAfter1.probeState, 'deferred')

    // 200ms later — nowhere near the 15s cadence floor on its own. If the
    // deferred item had been stamped lastCheckAt in pass 1 (the bug), it
    // would read as not_due here; it must instead still be due, because it
    // was never actually checked.
    t += 200
    d.now = () => t
    const out2 = await runFastMonitor(db, CREDS, d)
    assert.deepEqual(d.calls.ws, [1, 2], 'GBPUSD (deferred last time, never-probed still beats EURUSD which already ran once) now gets the cap')
    const gbpAfter2 = readWork().find((p) => p.symbol === 'GBPUSD')
    assert.equal(gbpAfter2.probeState, 'probed', 'no longer deferred — it was still due, not skipped by a false lastCheckAt stamp')
    assert.equal(out2.checked, 1)
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
})

test('B2: fairness — N > cap positions on an empty side are ALL probed within ceil(N/cap) passes, none starved', async () => {
  const db = mkDb()
  const CAP = 2
  _setFastMonitorProbeCapForTests(CAP)
  try {
    const symbols = ['EURUSD', 'GBPUSD', 'USDCAD', 'AUDUSD', 'NZDUSD']
    setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, USDCAD: 3, AUDUSD: 4, NZDUSD: 5 }))
    for (const s of symbols) addPos(db, s)
    setState(db, 'monitor_overrides_json', JSON.stringify(Object.fromEntries(symbols.map((s) => [s, 0.01]))))
    let t = clockBase += 3_600_000
    const emptySide = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] } // the side itself: nothing ever fresh
    const d = deps({ now: t, quotesBody: emptySide, brokerQuote: { bid: 1.1005, ask: 1.1007 } })
    const everProbed = new Set()
    const passes = Math.ceil(symbols.length / CAP)
    for (let pass = 0; pass < passes; pass++) {
      // 20s each pass: past the 15s cadence floor, so EVERY symbol —
      // winners of the previous pass's cap included — is due again, not
      // just the ones the cap deferred. This is what makes the ordering
      // itself (sortFair), not merely "don't stamp a deferred item",
      // load-bearing: without it, the same first `cap` keys in raw
      // insertion order would win every single pass, starving the rest
      // outright rather than resolving within ceil(N/cap) passes.
      if (pass > 0) { t += 20_000; d.now = () => t }
      d.calls.ws.length = 0
      await runFastMonitor(db, CREDS, d)
      for (const id of d.calls.ws) everProbed.add(id)
    }
    assert.deepEqual([...everProbed].sort((a, b) => a - b), [1, 2, 3, 4, 5], `every symbol must be probed within ${passes} passes (cap ${CAP}, ${symbols.length} symbols)`)
  } finally {
    _setFastMonitorProbeCapForTests(8)
  }
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
