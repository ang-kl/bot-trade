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
import { initDB, setState } from '../db.js'
import { runFastMonitor, _resetFastDecisionStateForTests, _resetFastMonitorProbeSchedulerForTests, _setFastMonitorProbeCapForTests } from './fast-monitor.js'

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
function deps({ quotesBody = { feed: 'up', generation: 1, accountId: '111', count: 0, quotes: [] }, now, onProbe } = {}) {
  const calls = { sidecar: [], ws: [] }
  const t = now ?? (clockBase += 3_600_000)
  return {
    calls,
    now: () => t,
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }),
      wsGetSpotOnce: async (_h, _c, _s, _t, _a, symbolId) => {
        calls.ws.push(symbolId)
        onProbe?.(symbolId)
        await sleep(15)
        return { bid: 1.1005, ask: 1.1007 }
      },
    },
    exec: {
      sidecarQuotes: async (isLive) => { calls.sidecar.push({ isLive }); return typeof quotesBody === 'function' ? quotesBody(t) : quotesBody },
    },
  }
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
  const d = deps({ now: t, quotesBody: quotesWithOther })
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
