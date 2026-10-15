// node --test agent/services/tick-activity.test.js
// Claude · № 15,036 15-Oct (activity screener step 1; claude-builder).
// Expected outcomes: the arithmetic of a minute ring (self-derived fixtures);
// that a tick on the guardian's stream reaches the counter and the flush
// writes agent_state (the real guardian with a stub stream).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { noteTick, median, activitySnapshot, flushActivity, activityReadout, __resetActivity, ACTIVITY_STATE_KEY, RING_MINUTES, MEDIAN_MINUTES } from './tick-activity.js'
import { startGuardian } from './guardian.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 15, 13, 0) // a minute boundary

test('median: zeros count, empty is 0, even and odd lengths', () => {
  assert.equal(median([]), 0)
  assert.equal(median([3, 0, 0, 0, 5]), 0)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([7]), 7)
})

test('snapshot: the current minute is still forming; last complete minute vs the 20-minute median; move first→last; silence by absence', () => {
  __resetActivity()
  // symbol 41: 10 ticks a minute for 20 minutes, then 40 in the last complete minute
  for (let m = 0; m < 20; m++) for (let i = 0; i < 10; i++) noteTick(41, 1.1 + i * 1e-5, T0 + m * MIN + i * 1000)
  for (let i = 0; i < 40; i++) noteTick(41, 1.1 + i * 1e-4, T0 + 20 * MIN + i * 1000) // minute 20: 1.1 → 1.1039
  for (let i = 0; i < 5; i++) noteTick(41, 1.2, T0 + 21 * MIN + i * 1000)             // minute 21: forming at `now`
  noteTick(7, 100, T0 + 20 * MIN + 5000)                                                 // symbol 7: one tick
  const now = T0 + 21 * MIN + 30_000
  const snap = activitySnapshot({ now, symbolNames: { 41: 'EURUSD' } })
  const eu = snap.symbols.find(s => s.symbolId === 41)
  assert.equal(eu.symbol, 'EURUSD')
  assert.equal(eu.ticksLastMin, 40, 'the last COMPLETE minute, not the forming one')
  assert.equal(eu.median20, 10)
  assert.equal(eu.relActivity, 4)
  assert.ok(Math.abs(eu.movePct1m - (1.1039 - 1.1) / 1.1 * 100) < 1e-3, `move ${eu.movePct1m} (stored to 4 decimals)`)
  const seven = snap.symbols.find(s => s.symbolId === 7)
  assert.equal(seven.symbol, '#7'); assert.equal(seven.ticksLastMin, 1); assert.equal(seven.median20, 0); assert.equal(seven.relActivity, 1)
  // a sparse symbol: 10 ticks in only 5 of the 20 prior minutes, then 10 in the last — silent
  // minutes count 0, so the median is 0 and the last minute reads as 10× the floor of 1
  for (const m of [2, 6, 9, 13, 17]) for (let i = 0; i < 10; i++) noteTick(77, 5, T0 + m * MIN + i * 1000)
  for (let i = 0; i < 10; i++) noteTick(77, 5, T0 + 20 * MIN + i * 1000)
  const sparse = activitySnapshot({ now }).symbols.find(s => s.symbolId === 77)
  assert.equal(sparse.median20, 0, 'RED if silent minutes were dropped: the median would read 10')
  assert.equal(sparse.relActivity, 10)
  // a symbol with no tick inside the ring is absent, never reported as 0
  assert.equal(activitySnapshot({ now: now + (RING_MINUTES + 5) * MIN }).symbols.length, 0)
  // bad inputs never land
  noteTick(null, 1, now); noteTick(9, 0, now); noteTick(9, -1, now); noteTick(9, 1, NaN)
  assert.equal(activitySnapshot({ now }).symbols.some(s => s.symbolId === 9), false)
  assert.equal(MEDIAN_MINUTES, 20)
})

test('the ring stays bounded under a fast feed', () => {
  __resetActivity()
  for (let m = 0; m < 500; m++) noteTick(5, 1, T0 + m * MIN)
  const snap = activitySnapshot({ now: T0 + 500 * MIN + 1000 })
  assert.equal(snap.symbols.length, 1)
  assert.equal(snap.symbols[0].ticksLastMin, 1)
})

test('flush writes the snapshot to agent_state; the readout ranks by relative activity and by |move|, bounds top, marks open/closed', () => {
  __resetActivity()
  const db = initDB(':memory:')
  for (let m = 0; m < 21; m++) {
    for (let i = 0; i < (m === 20 ? 30 : 10); i++) noteTick(1, 100 + (m === 20 ? i * 0.01 : 0), T0 + m * MIN + i * 1000) // 3× in the last minute, +0.29%
    for (let i = 0; i < 10; i++) noteTick(2, 50 - (m === 20 ? i * 0.1 : 0), T0 + m * MIN + i * 1000)                 // flat activity, −1.8% move
  }
  const now = T0 + 21 * MIN + 10_000
  flushActivity(db, setState, { now, symbolNames: { 1: 'AAA', 2: 'BBB' } })
  const raw = getState(db, ACTIVITY_STATE_KEY)
  assert.ok(raw, 'written')
  const out = activityReadout(raw, { top: 1, isOpen: (s) => ({ open: s === 'AAA' }) })
  assert.equal(out.tracked, 2)
  assert.deepEqual(out.byActivity.map(r => r.symbol), ['AAA'])
  assert.deepEqual(out.byMove.map(r => r.symbol), ['BBB'])
  assert.equal(out.byActivity[0].open, true); assert.equal(out.byMove[0].open, false)
  assert.equal(activityReadout(null).unavailable, true)
  assert.equal(activityReadout('not json').unavailable, true)
})

test('through the real guardian: a tick on the stub stream is counted, and the maintenance pass flushes it to agent_state', async t => {
  __resetActivity()
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 41 }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))
  let onTick = null
  const stop = startGuardian(db, () => ({ ready: true, accountId: '1', isLive: false }), {
    maintMs: 5, cooldownMs: 0, firstAttachMs: 1, backstopMs: 1e9, activityFlushMs: 0,
    streamSpots: async (...args) => { onTick = args[6]; return { close() {} } },
    accountRegistry: { getEnabledAccounts: () => [] },
    tradeGuard: { runTradeGuards: async () => ({ slMoves: 0 }) },
    profitKeeper: { runProfitKeeper: async () => ({ slMoves: 0, trailSpecs: [] }) },
    exec: { pushTrailConfig: async () => true },
  })
  t.after(stop)
  const deadline = Date.now() + 2000
  while (!onTick && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  assert.ok(onTick, 'the stream attached')
  const now = Date.now()
  onTick({ symbolId: 41, bid: 1.1, ask: 1.1002 })
  onTick({ symbolId: 41, bid: 1.1001, ask: 1.1003 })
  const snap = activitySnapshot({ now: now + 2 * MIN, symbolNames: { 41: 'EURUSD' } })
  assert.equal(snap.symbols.find(s => s.symbolId === 41)?.ticksLastMin ?? 0, 0, 'the current minute is forming')
  const ring = activitySnapshot({ now: Math.floor(now / MIN) * MIN + MIN + 1 })
  assert.equal(ring.symbols.find(s => s.symbolId === 41)?.ticksLastMin, 2, 'RED before: nothing counted ticks on the stream')
  // the maintenance pass flushes every activityFlushMs (0 here): wait for a flush that saw the ticks
  const until = Date.now() + 2000
  const read = () => { try { return JSON.parse(getState(db, ACTIVITY_STATE_KEY) || 'null') } catch { return null } }
  while (!(read()?.symbols || []).some(s => s.symbolId === 41) && Date.now() < until) await new Promise(r => setTimeout(r, 10))
  const stored = read()
  const row = (stored?.symbols || []).find(s => s.symbolId === 41)
  assert.ok(row, 'the maintenance pass flushed a snapshot carrying the ticked symbol (by id; names come from the tradable-union watchlist the fixture does not register)')
  assert.equal(row.ticksLastMin, 0, 'at flush time the ticks sit in the forming minute, so the last COMPLETE minute reads 0 — never a guessed count')
})

// ── № 15,074 16-Oct (Codex P2 on #1382, owner: "Fix both in #1382"; claude-builder) ──
test('through the real guardian: spike_scan_priority=false stops the FLAG, not the stream — the enabled watchlist is still subscribed and counted', async t => {
  __resetActivity()
  const db = initDB(':memory:')
  t.after(() => db.close())
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 41 }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'EURUSD', enabled: true }]))
  setState(db, 'spike_scan_priority', 'false')
  let onTick = null, ids = null
  const stop = startGuardian(db, () => ({ ready: true, accountId: '1', isLive: false }), {
    maintMs: 5, cooldownMs: 0, firstAttachMs: 1, backstopMs: 1e9, activityFlushMs: 0,
    streamSpots: async (...args) => { ids = args[5]; onTick = args[6]; return { close() {} } },
    accountRegistry: { getEnabledAccounts: () => [] },
    tradeGuard: { runTradeGuards: async () => ({ slMoves: 0 }) },
    profitKeeper: { runProfitKeeper: async () => ({ slMoves: 0, trailSpecs: [] }) },
    exec: { pushTrailConfig: async () => true },
  })
  t.after(stop)
  const deadline = Date.now() + 2000
  while (!onTick && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  assert.ok(onTick, 'the stream attached')
  assert.deepEqual(ids, [41], 'RED before: with the flag off the stream held only held positions, so the measurement saw nothing')
  const now = Date.now()
  onTick({ symbolId: 41, bid: 1.1, ask: 1.1002 })
  onTick({ symbolId: 41, bid: 1.2, ask: 1.2002 }) // a 9% jump: a spike by any threshold
  const ring = activitySnapshot({ now: Math.floor(now / MIN) * MIN + MIN + 1 })
  assert.equal(ring.symbols.find(s => s.symbolId === 41)?.ticksLastMin, 2, 'ticks counted')
  assert.equal(getState(db, 'scan_priority_symbols_json'), null, 'the flag stays off: no scan priority written')
})
