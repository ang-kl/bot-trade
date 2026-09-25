// agent/lib/tick-replay-sim.test.js — P4: fills at executable prices after
// latency, exits at the side that crossed, gaps fill where the price was,
// costs are charged, caps are finite, blocks purge straddlers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { simulate, summarize, blockSummaries, resolveLatency, wilsonInterval } from './tick-replay-sim.js'
import { buildFixture } from './tick-strategy.test.js'

function series(spec) {
  // spec: [[bid, ask, dtMs], ...] → oracle quotes
  const ev = []; let t = 1_000_000, seq = 0
  for (const [bid, ask, dt = 100] of spec) { t += dt; seq++; ev.push({ seq, recvMs: t, bid, ask, snapshot: false, crossed: false, changed: true }) }
  return ev
}
const PARAMS = { rangeEvents: 64, momentumEvents: 16 }

test('a long fills at the first ask after the latency, exits at the bid that crossed the target, net of costs', () => {
  const ev = series([[100, 102], [100, 102], [101, 103], [101, 103, 300], [120, 122], [140, 142], [141, 143]])
  const sig = { seq: 2, recvMs: ev[1].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 }
  // blocks: 1 — PR-Q1: a withheld run's summary stops at the test block, and
  // cutting seven events in three puts this trade's exit in it. The fill and
  // exit rules are what this test pins, so it asks for one block.
  const r = simulate(ev, PARAMS, { latencyMs: 250, slippage: 1, commissionPerSide: 2, targetR: 3, minTargetToCost: 1, blocks: 1 }, { signalsOverride: [sig] })
  assert.equal(r.trades.length, 1)
  const t = r.trades[0]
  assert.equal(t.entrySeq, 4, 'the first tradable event at or after signal + 250 ms (seq 3 is only 100 ms later)')
  assert.equal(t.entry, 103 + 1, 'ask plus slippage'); assert.equal(t.stop, 94); assert.equal(t.target, 134)
  assert.equal(t.reason, 'target'); assert.equal(t.exitSeq, 6, 'bid 140 ≥ target 134'); assert.equal(t.exit, 139)
  assert.equal(t.grossR, +((139 - 104) / 10).toFixed(4)); assert.equal(t.netR, +((139 - 104 - 4) / 10).toFixed(4))
  assert.equal(r.summary.exits.target, 1); assert.equal(r.summary.profitFactor, Infinity)
})

test('a gap through the stop fills at the bid that was there; a short mirrors on the ask; caps are finite; costs screen signals', () => {
  const ev = series([[100, 102], [100, 102], [100, 102, 300], [60, 62], [61, 63]])
  const r = simulate(ev, PARAMS, { latencyMs: 250, minTargetToCost: 1 }, { signalsOverride: [{ seq: 1, recvMs: ev[0].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 }] })
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].entrySeq, 3); assert.equal(r.trades[0].reason, 'stop'); assert.equal(r.trades[0].exit, 60, 'not the stop price 92: the gap fills where the bid was')
  assert.equal(r.trades[0].netR, -4.2)
  const sh = series([[100, 102], [100, 102, 300], [99, 101], [80, 82], [70, 72]])
  const rs = simulate(sh, PARAMS, { latencyMs: 250, minTargetToCost: 1 }, { signalsOverride: [{ seq: 1, recvMs: sh[0].recvMs, side: 'SELL', stopDistance: 5, bid: 100, ask: 102 }] })
  assert.equal(rs.trades[0].entry, 100); assert.equal(rs.trades[0].reason, 'target'); assert.equal(rs.trades[0].exit, 82, 'ask 82 ≤ target 85')
  // holding cap in events
  const flat = series(Array.from({ length: 20 }, () => [100, 102]))
  const rh = simulate(flat, PARAMS, { latencyMs: 0, maxHoldEvents: 5, minTargetToCost: 1 }, { signalsOverride: [{ seq: 1, recvMs: flat[0].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 }] })
  assert.equal(rh.trades[0].reason, 'hold_events'); assert.equal(rh.trades[0].holdEvents, 5)
  // holding cap in clock time (a halted feed: one event 7 h later)
  const halted = series([[100, 102], [100, 102], [100, 102, 7 * 3600_000]])
  const rc = simulate(halted, PARAMS, { latencyMs: 0, minTargetToCost: 1 }, { signalsOverride: [{ seq: 1, recvMs: halted[0].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 }] })
  assert.equal(rc.trades[0].reason, 'hold_clock')
  // cost screening: spread 2 + commissions 4 = 6 round trip; target 30 / 6 = 5 passes at 3, fails at 6
  const rj = simulate(ev, PARAMS, { latencyMs: 250, commissionPerSide: 2, minTargetToCost: 6 }, { signalsOverride: [{ seq: 1, recvMs: ev[0].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 }] })
  assert.equal(rj.trades.length, 0); assert.equal(rj.rejected.cost, 1)
})

test('the fixture through the real oracle produces trades with the planted long and short, and blocks purge straddlers', () => {
  const events = buildFixture()
  const params = { rangeEvents: 64, momentumEvents: 16, minEfficiency: 0.4, spreadBufferMult: 0.5, confirmations: 2, stopVolMult: 2, minStopPrice: 1, priceIncrement: 1, maxSpread: 200, maxQuoteAgeMs: 60_000 }
  const r = simulate(events, params, { latencyMs: 60, minTargetToCost: 1 })
  assert.equal(r.trades.length, 2)
  assert.equal(r.trades[0].side, 'BUY'); assert.equal(r.trades[1].side, 'SELL')
  assert.ok(r.trades[0].entrySeq > 118 && r.trades[0].entrySeq <= 121, `filled on the next events after the 60 ms latency (entered at ${r.trades[0].entrySeq})`)
  assert.ok(['stop', 'target', 'hold_events', 'hold_clock', 'data_end'].includes(r.trades[0].reason))
  assert.equal(r.trades[1].reason, 'data_end', 'the short is still open when the data ends and is marked to the last bid/ask, not dropped')
  assert.equal(r.blocks.length, 3); assert.equal(r.blocks.map(b => b.name).join(','), 'train,validation,test')
  // AUDIT 11-09-2026 (plan §7): the test block is WITHHELD on a research run
  assert.equal(r.blocks[2].withheld, true); assert.equal(r.blocks[2].trades, null)
  assert.equal(r.sim.latencySource, 'fixed'); assert.equal(r.sim.purgeEvents, Math.max(64 + 16, 4 * 64))
  const rTest = simulate(events, params, { latencyMs: 60, minTargetToCost: 1, includeTest: true })
  assert.equal(rTest.blocks[2].withheld, undefined); assert.ok(rTest.blocks[2].trades != null, 'the owner\'s confirmation run unseals it')
  assert.equal(typeof r.profileHash, 'string'); assert.equal(r.events, events.length)
  const s = summarize([{ netR: 2, reason: 'target', holdEvents: 3 }, { netR: -1, reason: 'stop', holdEvents: 2 }])
  assert.equal(s.profitFactor, 2); assert.equal(s.tailShare, 0.5); assert.equal(s.maxDrawdownR, 1)
})

test('AUDIT 11-09-2026 (plan §7): the purge drops trades entered within the window BEFORE a boundary and within the window AFTER it, both ways; the final block is withheld unless asked for', () => {
  // 30 events, 3 blocks of 10, purge 3: boundaries at 10 and 20
  const t = (entryIdx, exitIdx) => ({ netR: 1, reason: 'target', holdEvents: exitIdx - entryIdx, entryIdx, exitIdx })
  const trades = [
    t(2, 4),    // train, clear
    t(8, 12),   // train, entered inside the 3 before the boundary → purged (its exit leaks block 2 prices) — the OLD rule kept this when the exit fell past the window
    t(9, 30),   // train, entered inside the window, exits far later → purged (the old rule KEPT it: inverted)
    t(11, 13),  // validation, entered inside the 3 after the boundary → purged (feature window reaches back: the embargo the old rule lacked)
    t(14, 16),  // validation, clear
    t(18, 19),  // validation, inside the window before the next boundary → purged
    t(21, 22),  // test, embargoed
    t(25, 27),  // test, clear
  ]
  const b = blockSummaries(trades, 30, 3, 3)
  assert.deepEqual(b.map(x => [x.name, x.trades, x.purged]), [['train', 1, 2], ['validation', 1, 2], ['test', 1, 1]])
  const withheld = blockSummaries(trades, 30, 3, 3, { includeTest: false })
  assert.equal(withheld[2].withheld, true); assert.equal(withheld[2].trades, null); assert.equal(withheld[2].purged, 1, 'the purge count is still honest')
  assert.equal(withheld[0].trades, 1)
  // a single block has no boundaries and nothing to purge
  assert.deepEqual(blockSummaries(trades, 30, 1, 3).map(x => [x.name, x.trades, x.purged]), [['block1', 8, 0]])
})

test('AUDIT 11-09-2026 (plan §7): latency may be MEASURED samples — the fill waits their pessimistic quantile, never their mean, and the trial says which', () => {
  assert.deepEqual(resolveLatency(250), { ms: 250, source: 'fixed' })
  assert.deepEqual(resolveLatency([120, 80, 300, 90, 110, 95, 100, 85, 130, 900]), { ms: 300, source: 'measured p90 of 10 samples' })
  assert.deepEqual(resolveLatency([120, 80, 300], 0.5), { ms: 120, source: 'measured p50 of 3 samples' })
  assert.equal(resolveLatency([]).source, 'default (no usable samples)')
  assert.equal(resolveLatency(['x', -1]).ms, 250)
  const events = buildFixture()
  const params = { rangeEvents: 64, momentumEvents: 16, minEfficiency: 0.4, spreadBufferMult: 0.5, confirmations: 2, stopVolMult: 2, minStopPrice: 1, priceIncrement: 1, maxSpread: 200, maxQuoteAgeMs: 60_000 }
  const r = simulate(events, params, { latencyMs: [40, 60, 55, 500], minTargetToCost: 1 })
  assert.equal(r.sim.latencyMs, 500); assert.equal(r.sim.latencySource, 'measured p90 of 4 samples')
})

// Plan D2 (25-09-2026): win rate is reported WITH its Wilson interval. Pins
// that a normal approximation cannot pass: at k = 1 of 10 it gives a lower
// bound of −8.6 %, and at k = 0 it collapses to [0, 0] where Wilson's upper
// bound is 27.75 %.
test('wilsonInterval: null on no trades; Wilson (not normal) bounds at k = 0, 1, 5 of 10; bounded in [0, 100]', () => {
  assert.equal(wilsonInterval(0, 0), null)
  assert.deepEqual(wilsonInterval(5, 10), { pct: 50, lo: 23.66, hi: 76.34 })
  assert.deepEqual(wilsonInterval(0, 10), { pct: 0, lo: 0, hi: 27.75 })
  assert.deepEqual(wilsonInterval(1, 10), { pct: 10, lo: 1.79, hi: 40.42 })
  assert.deepEqual(wilsonInterval(12, 30), { pct: 40, lo: 24.59, hi: 57.68 })
  const full = wilsonInterval(10, 10)
  assert.equal(full.hi, 100); assert.ok(full.lo >= 0 && full.lo < 100)
})

// ---------------------------------------------------------------------------
// PR-Q1 (V3 P6/P7, 25-09-2026): replay honesty.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { normalizeParams as normParams } from './tick-strategy.js'
import { STATISTICS_VERSION, normalizeMaxHoldEvents } from './tick-replay-sim.js'

/** The reviewer's leak fixture: four planted BUY signals, one in train and three in the last third. */
function leakFixture() {
  // 30 events, flat at 100/102, with a jump to 140/142 right after each
  // planted signal so every trade closes at its target two events later.
  const spec = []
  for (let i = 0; i < 30; i++) spec.push([100, 102])
  for (const i of [3, 22, 25, 28]) { spec[i] = [140, 142]; spec[i + 1] = [100, 102] }
  const ev = series(spec)
  const sig = (i) => ({ seq: ev[i].seq, recvMs: ev[i].recvMs, side: 'BUY', stopDistance: 10, bid: 100, ask: 102 })
  // signals at events 1, 20, 23, 26: each fills on the next event (latency 0)
  // and exits at the target on the jump (bid 140 >= target)
  return { ev, signals: [sig(1), sig(20), sig(23), sig(26)] }
}
const LEAK_SIM = { latencyMs: 0, minTargetToCost: 1, purgeEvents: 0 }

test('PR-Q1 LEAK FIX: withheld, the summary covers train and validation only — 1 trade, not the 4 whose test-block three could be read by subtraction; includeTest gives all 4', () => {
  const { ev, signals } = leakFixture()
  const r = simulate(ev, PARAMS, LEAK_SIM, { signalsOverride: signals })
  assert.equal(r.trades.length, 4, 'the in-memory run still holds every trade')
  assert.equal(r.blocks[0].trades, 1); assert.equal(r.blocks[1].trades, 0); assert.equal(r.blocks[2].withheld, true)
  assert.equal(r.summary.trades, 1, 'RED on the leak: summarize(trades) over all trades reads 4')
  assert.equal(r.summary.netR, r.blocks[0].netR, 'the summary is the train block\'s trade and nothing else')
  assert.equal(r.summary.scope, 'train_validation')
  assert.equal(r.summary.diagnostics.signals, 1, 'the diagnostics stop at the test block too (4 signals were rung, 3 of them in it)')
  assert.equal(r.summary.diagnostics.events, 20)
  assert.equal(r.summary.window.events, 20)
  assert.equal(r.parity.signals.length, 1); assert.equal(r.parity.trades.length, 1, 'the parity record carries no test-block trade either')
  assert.equal(r.sim.statisticsVersion, STATISTICS_VERSION); assert.equal(STATISTICS_VERSION, 'mtm-moving-block-v2')
  const all = simulate(ev, PARAMS, { ...LEAK_SIM, includeTest: true }, { signalsOverride: signals })
  assert.equal(all.summary.trades, 4); assert.equal(all.summary.scope, 'all_blocks'); assert.equal(all.blocks[2].trades, 3)
  assert.equal(all.summary.netR, +(r.summary.netR + all.blocks[1].netR + all.blocks[2].netR).toFixed(4), 'with includeTest the summary is every trade, unchanged')
  // a trade that ENTERS before the test block and EXITS inside it read a test price: out of the withheld summary
  const straddle = simulate(ev, PARAMS, { ...LEAK_SIM }, { signalsOverride: [{ ...signals[0], seq: ev[18].seq, recvMs: ev[18].recvMs }] })
  assert.equal(straddle.trades.length, 1); assert.ok(straddle.trades[0].exitIdx >= 20 && straddle.trades[0].entryIdx < 20)
  assert.equal(straddle.summary.trades, 0, 'its exit read a test-block price')
  // the parity record keeps its ENTRY (the live book took it too) and nothing of its exit
  assert.deepEqual(straddle.parity.trades.map(t => [t.entrySeq, t.exitMs, t.reason]), [[ev[19].seq, null, 'open_at_scope_end']])
})

// C++ normalises maxHoldEvents 0 to 4 × rangeEvents (tick_shadow.cpp:84), and
// agent/config/tick-shadow-sim.json ships 0. The checked-in shadow-book
// expectations were generated by the replayer with the field ABSENT and are
// read by test_tick_shadow.cpp with maxHoldEvents 0 — so replaying the case's
// OWN sim, 0 included, must give the same trades.
test('PR-Q1: maxHoldEvents 0 is 4N inside simulate — the replayer given the C++ fixture\'s own sim (maxHoldEvents 0) closes the same trades the C++ book is pinned to', () => {
  const expected = JSON.parse(readFileSync(new URL('../../cpp-exec/src/tests/fixtures/tick_shadow_expected.json', import.meta.url), 'utf8'))
  const params = normParams({ rangeEvents: 64, momentumEvents: 16, minEfficiency: 0.4, spreadBufferMult: 0.5, confirmations: 2, stopVolMult: 2, minStopPrice: 1, priceIncrement: 1, maxSpread: 200, maxQuoteAgeMs: 60_000 })
  const zeroCases = expected.cases.filter(c => c.sim.maxHoldEvents === 0)
  assert.ok(zeroCases.length >= 1, 'the fixture carries a maxHoldEvents 0 case')
  for (const c of zeroCases) {
    const r = simulate(buildFixture(), params, c.sim)
    const got = r.trades.filter(t => t.reason !== 'data_end').map(t => [t.side, t.entrySeq, t.exitSeq, t.reason, t.holdEvents])
    const want = c.trades.map(t => [t.side, t.entrySeq, t.exitSeq, t.reason, t.holdEvents])
    assert.deepEqual(got, want, 'RED when 0 is read as a 0-event cap: every trade exits hold_events after one event')
    assert.equal(r.sim.maxHoldEventsResolved, 4 * 64)
    assert.equal(r.sim.maxHoldEvents, null, '0 and absent are stored the same way')
  }
  assert.equal(normalizeMaxHoldEvents(0, 64), 256); assert.equal(normalizeMaxHoldEvents(null, 64), 256); assert.equal(normalizeMaxHoldEvents(-3, 64), 256); assert.equal(normalizeMaxHoldEvents(40, 64), 40)
})
