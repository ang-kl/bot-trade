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
  // Q1 follow-up (checker B4): the purge count of a WITHHELD block counts the
  // trades that entered in its first purgeEvents — test-period information.
  assert.equal(withheld[2].withheld, true); assert.equal(withheld[2].trades, null); assert.equal(withheld[2].purged, null, 'RED if the withheld row still counts its own trades')
  assert.equal(withheld[0].trades, 1)
  // a single block has no boundaries and nothing to purge
  assert.deepEqual(blockSummaries(trades, 30, 1, 3).map(x => [x.name, x.trades, x.purged]), [['block1', 8, 0]])
})

test('Q1 follow-up (checker B4): withheld, the train and validation rows read no test-block price — a trade that exits inside the test block is out of them whatever purgeEvents the caller set; the confirmation run still counts it', () => {
  // The fixture's long enters at event 119 (train) and stops out at 260; the
  // test block starts at 2 × floor(389 / 3) = 258. With the purge off, the
  // train row used to carry that trade's netR (-1.1375) — a test-block exit —
  // while summary.trades read 0.
  const events = buildFixture()
  const params = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
  const open = simulate(events, params, { latencyMs: 60, minTargetToCost: 1, purgeEvents: 0, includeTest: true })
  const straddler = open.trades.find(t => t.entryIdx < 258 && t.exitIdx >= 258)
  assert.ok(straddler && straddler.entryIdx < 129, `the fixture's long enters in train and exits in the test block (${JSON.stringify(open.trades.map(t => [t.entryIdx, t.exitIdx]))})`)
  assert.equal(open.blocks[0].trades, 1, 'the confirmation run reads every block, so train counts it')
  const w = simulate(events, params, { latencyMs: 60, minTargetToCost: 1, purgeEvents: 0 })
  assert.equal(w.summary.trades, 0)
  assert.equal(w.blocks[0].trades, 0, 'RED if the train row is built from every trade: it read a test-block exit')
  assert.equal(w.blocks[0].netR, 0)
  assert.equal(w.blocks[2].withheld, true); assert.equal(w.blocks[2].purged, null)
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

// ---------------------------------------------------------------------------
// PR-Q3 (V3 P6/P7, 25-09-2026): the live filters as a stamped sim block.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { normalizeLiveFilters, fillVeto, liveFiltersKey, LIVE_FILTERS_VERSION } from './tick-replay-sim.js'

/** Flat wire-unit quotes (1.00000 / 1.00002), `n` events 100 ms apart, with per-index overrides [bid, ask, dt]. */
function wireSeries(n, overrides = {}) {
  const spec = []
  for (let i = 0; i < n; i++) spec.push(overrides[i] || [100_000, 100_002])
  return series(spec)
}
const plant = (ev, i, side, stopDistance, q = ev[i]) => ({ seq: ev[i].seq, recvMs: ev[i].recvMs, side, stopDistance, bid: q.bid, ask: q.ask })
const Q3_SIM = { latencyMs: 0, minTargetToCost: 1, blocks: 1 }
const vetoedSeqs = (r) => r.parity.vetoes.map(v => [v.seq, v.filter])
/** A trade's book identity: what the shadow would record for it. */
const bookOf = (t) => [t.side, t.signalSeq, t.entrySeq, t.exitSeq, t.entry, t.exit, t.reason, t.netR]

test('PR-Q3 stop floor: vetoes exactly the signal whose stop is under llround(minStopFraction × entry) — 149 < 150 refused, 150 kept — and the two models differ on what the refusal does to the book', () => {
  const ev = wireSeries(12)
  // entry = ask 100002, floor = round(0.0015 × 100002) = 150
  const signals = [plant(ev, 1, 'BUY', 149), plant(ev, 3, 'BUY', 150)]
  // 'book' (a ShadowBook applying the filter): the refused signal opens nothing and FREES the book.
  const r = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { model: 'book', minStopFraction: 0.0015 } }, { signalsOverride: signals })
  assert.deepEqual(vetoedSeqs(r), [[ev[1].seq, 'stopFloor']])
  assert.deepEqual(r.trades.map(t => t.signalSeq), [ev[3].seq], 'the 150 stop fills')
  assert.deepEqual(r.summary.diagnostics.vetoes, { counterTrend: 0, signalTtl: 0, priceBound: 0, stopFloor: 1, total: 1 })
  // Unfiltered, the 149 stop fills and holds the book, so the second signal is not taken.
  const off = simulate(ev, PARAMS, Q3_SIM, { signalsOverride: signals })
  assert.deepEqual(off.trades.map(t => t.signalSeq), [ev[1].seq]); assert.equal(off.rejected.noFill, 1)
  // 'firer' (the default — the gateway today): the shadow book fills the 149 and HOLDS it, the
  // firer refuses the live order, so the 150 is not taken and nothing trades.
  const f = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { minStopFraction: 0.0015 } }, { signalsOverride: signals })
  assert.equal(f.sim.liveFilters.model, 'firer')
  assert.deepEqual(vetoedSeqs(f), [[ev[1].seq, 'stopFloor']])
  assert.deepEqual(f.trades, [], 'RED if a refused fill is reported as a trade')
  assert.equal(f.rejected.noFill, 1, 'the held refusal blocks the 150, as the shadow would')
  assert.deepEqual(f.vetoedTrades.map(bookOf), off.trades.map(bookOf), 'the book held exactly the unfiltered trade')
  assert.equal(f.summary.diagnostics.outcome, 'live_filtered')
  assert.equal(f.summary.diagnostics.vetoedTrades.byFilter.stopFloor.trades, 1)
})

test('PR-Q3 price bound: vetoes the fill more than floor(overshootFraction × stop) from the signal\'s own quote — ask for a BUY, bid for a SELL; exactly the bound is kept', () => {
  // stop 200 × 0.25 = 50. BUY at idx1 (ask 100002) fills at idx2 ask 100053: 51 away → refused.
  // BUY at idx4 fills at idx5 ask 100052: 50 away → kept. It runs to the target (idx7 bid jumps).
  // SELL at idx9 (bid 100000) fills at idx10 bid 99949: 51 away → refused.
  const ev = wireSeries(14, { 2: [100_051, 100_053], 5: [100_050, 100_052], 7: [100_700, 100_702], 10: [99_949, 99_951] })
  const signals = [plant(ev, 1, 'BUY', 200), plant(ev, 4, 'BUY', 200), plant(ev, 9, 'SELL', 200)]
  const r = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { model: 'book', overshootFraction: 0.25 } }, { signalsOverride: signals })
  assert.deepEqual(vetoedSeqs(r), [[ev[1].seq, 'priceBound'], [ev[9].seq, 'priceBound']])
  assert.deepEqual(r.trades.map(t => [t.signalSeq, t.entry, t.reason]), [[ev[4].seq, 100_052, 'target']])
  assert.equal(r.summary.diagnostics.vetoes.priceBound, 2); assert.equal(r.summary.diagnostics.vetoes.total, 2)
})

test('PR-Q3 signal TTL: a pending signal whose first executable quote is more than signalTtlMs past its due time (signal + latency) is refused; exactly the TTL is kept', () => {
  // latency 250, TTL 5000: idx2 arrives 5,251 ms after the idx1 signal (waited 5,001) → expired;
  // idx4 arrives 5,250 ms after the idx3 signal (waited 5,000) → filled.
  const ev = series([[100_000, 100_002], [100_000, 100_002], [100_000, 100_002, 5_251], [100_000, 100_002], [100_000, 100_002, 5_250], [100_000, 100_002], [100_000, 100_002]])
  const signals = [plant(ev, 1, 'BUY', 200), plant(ev, 3, 'BUY', 200)]
  const r = simulate(ev, PARAMS, { ...Q3_SIM, latencyMs: 250, liveFilters: { model: 'book', signalTtlMs: 5000 } }, { signalsOverride: signals })
  assert.deepEqual(vetoedSeqs(r), [[ev[1].seq, 'signalTtl']])
  assert.deepEqual(r.trades.map(t => [t.signalSeq, t.entrySeq]), [[ev[3].seq, ev[4].seq]])
  // A gap marker (recvMs 0) is not a time: it expires nothing.
  const gap = [...ev.slice(0, 2), { seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true }, ...ev.slice(2)]
  const g = simulate(gap, PARAMS, { ...Q3_SIM, latencyMs: 250, liveFilters: { model: 'book', signalTtlMs: 5000 } }, { signalsOverride: signals })
  assert.deepEqual(vetoedSeqs(g), [[ev[1].seq, 'signalTtl']], 'still expired at the late quote, not at the marker')
  // 'firer': the book fills the late quote (the shadow has no expiry) and the firer refuses it.
  const f = simulate(ev, PARAMS, { ...Q3_SIM, latencyMs: 250, liveFilters: { signalTtlMs: 5000 } }, { signalsOverride: signals })
  assert.deepEqual(vetoedSeqs(f), [[ev[1].seq, 'signalTtl']])
  assert.deepEqual(f.vetoedTrades.map(t => [t.signalSeq, t.entrySeq, t.vetoedBy]), [[ev[1].seq, ev[2].seq, 'signalTtl']])
})

test('PR-Q3 counter-trend: under an up reading the SELL is vetoed at the signal and the BUY fills; no reading grants both sides and is counted; a missing reader is refused, never stamped as applied', () => {
  const ev = wireSeries(14, { 5: [100_700, 100_702] })
  // idx1 SELL (reading up → refused), idx3 BUY (up → taken, target at idx5), idx8 SELL (no reading → taken)
  const signals = [plant(ev, 1, 'SELL', 200), plant(ev, 3, 'BUY', 200), plant(ev, 8, 'SELL', 200)]
  const upUntil = ev[6].recvMs
  const asked = []
  const sidesAt = (ms) => { asked.push(ms); return ms < upUntil ? ['BUY'] : null }
  const r = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { model: 'book', counterTrend: true } }, { signalsOverride: signals, trendSidesAt: sidesAt })
  assert.deepEqual(vetoedSeqs(r), [[ev[1].seq, 'counterTrend']])
  assert.deepEqual(r.trades.map(t => t.signalSeq), [ev[3].seq, ev[8].seq])
  assert.equal(r.summary.diagnostics.counterTrendNoReading, 1)
  assert.deepEqual(asked, [ev[1].recvMs, ev[3].recvMs, ev[8].recvMs], 'the reading is asked AS OF each signal\'s own time')
  assert.throws(() => simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { counterTrend: true } }, { signalsOverride: signals }), /no trendSidesAt reader/)
})

/**
 * Six planted signals, each closed quickly so every refusal gets its own fill
 * under either model. latency 0, TTL 5000, bound floor(0.25 × 200) = 50,
 * floor round(0.0015 × entry) ≈ 150–152, the reading always 'up' (BUY only).
 */
function allFourFixture() {
  const ev = series([
    [100_000, 100_002], [100_000, 100_002],            // 1: SELL under an up reading → counterTrend
    [100_000, 100_002], [100_300, 100_302],            // 2: (firer) the SELL fills; 3: its stop; 3: BUY signal
    [100_000, 100_002, 5_001], [100_700, 100_702],     // 4: the BUY's quote 5,001 ms late → signalTtl; 5: target; 5: BUY signal
    [100_760, 100_762], [100_500, 100_502],            // 6: filled 60 from the 100,702 ask → priceBound; 7: stop; 7: BUY, stop 149
    [100_500, 100_502], [101_000, 101_002],            // 8: floor round(0.0015 × 100,502) = 151 > 149 → stopFloor; 9: target; 9: control BUY
    [101_000, 101_002], [101_700, 101_702],            // 10: the control fills; 10: BUY while it is open → noFill; 11: target
  ])
  const signals = [plant(ev, 1, 'SELL', 200), plant(ev, 3, 'BUY', 200), plant(ev, 5, 'BUY', 200), plant(ev, 7, 'BUY', 149), plant(ev, 9, 'BUY', 200), plant(ev, 10, 'BUY', 200)]
  return { ev, signals, lf: { minStopFraction: 0.0015, overshootFraction: 0.25, signalTtlMs: 5000, counterTrend: true } }
}

test('PR-Q3: all four on, both models — each vetoes exactly its planted signal, and signals = filled + cost + noFill + vetoed (+ pending)', () => {
  const { ev, signals, lf } = allFourFixture()
  for (const model of ['book', 'firer']) {
    const r = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: { ...lf, model } }, { signalsOverride: signals, trendSidesAt: () => ['BUY'] })
    assert.deepEqual(vetoedSeqs(r), [[ev[1].seq, 'counterTrend'], [ev[3].seq, 'signalTtl'], [ev[5].seq, 'priceBound'], [ev[7].seq, 'stopFloor']], model)
    assert.deepEqual(r.trades.map(t => t.signalSeq), [ev[9].seq], `${model}: only the control is a trade`)
    const d = r.summary.diagnostics
    assert.deepEqual(d.vetoes, { counterTrend: 1, signalTtl: 1, priceBound: 1, stopFloor: 1, total: 4 })
    assert.equal(d.signals, 6); assert.equal(d.filled, 1); assert.equal(d.noFill, 1); assert.equal(d.costRejected, 0); assert.equal(d.pendingAtScopeEnd, 0)
    assert.equal(d.countsAddUp, true)
    assert.equal(d.signals, r.trades.length + r.rejected.cost + r.rejected.noFill + d.vetoes.total, 'every signal is accounted for exactly once')
    assert.deepEqual(r.rejected.vetoed, { counterTrend: 1, signalTtl: 1, priceBound: 1, stopFloor: 1 })
    assert.deepEqual(r.sim.liveFilters, { version: LIVE_FILTERS_VERSION, model, minStopFraction: 0.0015, overshootFraction: 0.25, signalTtlMs: 5000, counterTrend: { asOf: 'signal_time', gateOn: null, maxRegimeAgeMin: null }, configSource: null })
    assert.equal(d.model, model)
  }
  // Every signal vetoed, nothing else: the outcome names the filters, not "no executable fills".
  const allOut = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: lf }, { signalsOverride: signals.slice(0, 4), trendSidesAt: () => ['BUY'] })
  assert.equal(allOut.summary.diagnostics.outcome, 'live_filtered')
})

test('PR-Q3 firer model: the BOOK is the unfiltered replay\'s, trade for trade — the refused trades are held to their shadow exit, reported apart with what each veto cost, and never counted as trades', () => {
  const { ev, signals, lf } = allFourFixture()
  const off = simulate(ev, PARAMS, Q3_SIM, { signalsOverride: signals })
  const f = simulate(ev, PARAMS, { ...Q3_SIM, liveFilters: lf }, { signalsOverride: signals, trendSidesAt: () => ['BUY'] })
  assert.equal(off.trades.length, 5)
  const book = [...f.trades, ...f.vetoedTrades].sort((a, b) => a.entryIdx - b.entryIdx)
  assert.deepEqual(book.map(bookOf), off.trades.map(bookOf), 'RED if a firer refusal changes what the book takes')
  assert.deepEqual(f.vetoedTrades.map(t => [t.signalSeq, t.vetoedBy, t.netR]), [[ev[1].seq, 'counterTrend', -1.51], [ev[3].seq, 'signalTtl', 3.49], [ev[5].seq, 'priceBound', -1.31], [ev[7].seq, 'stopFloor', 3.3423]])
  // The summary and the blocks judge the firer's trades only.
  assert.equal(f.summary.trades, 1); assert.equal(f.summary.netR, 3.49); assert.equal(f.blocks[0].trades, 1)
  const v = f.summary.diagnostics.vetoedTrades
  assert.equal(v.trades, 4); assert.equal(v.wins, 2); assert.equal(v.netR, 4.0123); assert.equal(v.profitFactor, +((3.49 + 3.3423) / (1.51 + 1.31)).toFixed(4))
  assert.deepEqual(v.byFilter.priceBound, { trades: 1, wins: 0, netR: -1.31, profitFactor: 0 })
  assert.deepEqual(v.byFilter.stopFloor, { trades: 1, wins: 1, netR: 3.3423, profitFactor: null })
  // The parity record is the book's: all five, the refused ones flagged — what the shadow recorded.
  assert.deepEqual(f.parity.trades.map(t => [t.signalSeq, t.vetoedBy ?? null]), [[ev[1].seq, 'counterTrend'], [ev[3].seq, 'signalTtl'], [ev[5].seq, 'priceBound'], [ev[7].seq, 'stopFloor'], [ev[9].seq, null]])
  assert.deepEqual(f.parity.trades.map(t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'vetoedBy'))), off.parity.trades)
  // 'book' takes a different population on another fixture (see the stop-floor test); keyed apart.
  assert.equal(liveFiltersKey(f.sim.liveFilters, { book: true }), null, 'a firer block leaves the book as it was')
  assert.notEqual(liveFiltersKey({ ...f.sim.liveFilters, model: 'book' }, { book: true }), null)
})

test('PR-Q3: withheld, a veto made inside the test block is test-period information — out of the diagnostics and the parity record; the confirmation run counts it', () => {
  // 30 events, 3 blocks: the test block starts at 20. Stop-floor vetoes at idx 5 (train) and idx 25 (test).
  const ev = wireSeries(30)
  const signals = [plant(ev, 5, 'BUY', 100), plant(ev, 25, 'BUY', 100)]
  const sim = { latencyMs: 0, minTargetToCost: 1, purgeEvents: 0, liveFilters: { model: 'book', minStopFraction: 0.0015 } }
  const w = simulate(ev, PARAMS, sim, { signalsOverride: signals })
  assert.equal(w.summary.scope, 'train_validation')
  assert.equal(w.summary.diagnostics.vetoes.stopFloor, 1, 'RED if the test block\'s veto is counted in a withheld summary')
  assert.deepEqual(w.parity.vetoes.map(v => v.seq), [ev[5].seq]); assert.equal(w.parity.vetoesTotal, 1)
  const all = simulate(ev, PARAMS, { ...sim, includeTest: true }, { signalsOverride: signals })
  assert.equal(all.summary.diagnostics.vetoes.stopFloor, 2); assert.equal(all.parity.vetoesTotal, 2)
  // 'firer': the idx5 refusal is held on a flat series past the seal. Its veto is in scope (the
  // fill was), its RESULT is test-period information: out of vetoedTrades, in the record by entry only.
  const fsim = { ...sim, liveFilters: { minStopFraction: 0.0015 } }
  const fw = simulate(ev, PARAMS, fsim, { signalsOverride: signals })
  assert.equal(fw.summary.diagnostics.vetoes.stopFloor, 1); assert.equal(fw.summary.diagnostics.vetoedTrades.trades, 0, 'RED if a held trade\'s test-block exit is read')
  assert.deepEqual(fw.parity.trades, [{ side: 'BUY', signalSeq: ev[5].seq, entrySeq: ev[6].seq, entryMs: ev[6].recvMs, exitMs: null, reason: 'open_at_scope_end', vetoedBy: 'stopFloor' }])
  const fa = simulate(ev, PARAMS, { ...fsim, includeTest: true }, { signalsOverride: signals })
  assert.equal(fa.summary.diagnostics.vetoedTrades.trades, 1); assert.equal(fa.rejected.noFill, 1, 'the idx25 signal meets the held book')
})

test('PR-Q3 regression: with the filters off (absent, null, false, {}, every filter off) the output is byte-identical to the replayer before the block — pinned by digest', () => {
  const P = { rangeEvents: 64, momentumEvents: 16, minEfficiency: 0.4, spreadBufferMult: 0.5, confirmations: 2, stopVolMult: 2, minStopPrice: 1, priceIncrement: 1, maxSpread: 200, maxQuoteAgeMs: 60_000 }
  // Digests of JSON.stringify(simulate(...)) from the replayer before PR-Q3
  // (origin/main cdb6711, byte-identical to 2e80f39's), measured against a
  // copy of that file. A deliberate change to the replayer's output updates
  // these; a filter leaking into an unfiltered run turns them red.
  const pinned = [
    [{ latencyMs: 60, minTargetToCost: 1 }, '85dd1759b233b36e'],
    [{ latencyMs: 60, minTargetToCost: 1, includeTest: true }, 'dce42f5ccfd8947c'],
  ]
  for (const [sim, digest] of pinned) {
    for (const off of [undefined, null, false, {}, { model: 'book' }, { counterTrend: false, minStopFraction: null, overshootFraction: null, signalTtlMs: null }]) {
      const s = off === undefined ? sim : { ...sim, liveFilters: off }
      const r = simulate(buildFixture(), P, s)
      assert.equal(createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16), digest, `off as ${JSON.stringify(off)}`)
      assert.equal('liveFilters' in r.sim, false, 'no key at all, so the trial id and sim hash are unchanged')
      assert.equal('vetoed' in r.rejected, false); assert.equal('vetoes' in r.summary.diagnostics, false); assert.equal('vetoes' in r.parity, false); assert.equal('vetoedTrades' in r, false)
    }
  }
})

test('PR-Q3: a misspelt filter, an unknown model or a bad value throws — it is never read as "off" and stamped as if applied', () => {
  assert.equal(normalizeLiveFilters(null), null); assert.equal(normalizeLiveFilters({}), null)
  assert.throws(() => normalizeLiveFilters({ minStopFrac: 0.0015 }), /not a live filter field/)
  assert.throws(() => normalizeLiveFilters({ minStopFraction: '0.0015' }), /finite number/)
  assert.throws(() => normalizeLiveFilters({ overshootFraction: -1 }), /finite number/)
  assert.throws(() => normalizeLiveFilters({ counterTrend: 'yes' }), /counterTrend/)
  assert.throws(() => normalizeLiveFilters({ minStopFraction: 0.0015, model: 'freed' }), /model must be one of firer, book/)
  assert.throws(() => normalizeLiveFilters(true), /object/)
  assert.equal(normalizeLiveFilters({ minStopFraction: 0.0015 }).model, 'firer', 'the default is the gateway as it runs today')
  // fillVeto: a non-positive signal quote is refused (order_guard.cpp priceWithinBound), the floor applies only above 0
  assert.equal(fillVeto({ overshootFraction: 0.25, minStopFraction: null }, { side: 'BUY', ask: 0, bid: 0, stopDistance: 200 }, 100), 'priceBound')
  assert.equal(fillVeto({ overshootFraction: null, minStopFraction: 0 }, { side: 'BUY', ask: 1, bid: 1, stopDistance: 1 }, 100_000), null)
  assert.equal(fillVeto({ overshootFraction: 0.25, minStopFraction: null }, { side: 'SELL', ask: 100_002, bid: 100_000, stopDistance: 203 }, 100_050), null, 'SELL judged on the bid: 50 = floor(0.25 × 203)')
  // the TTL is judged first, on how late the fill came past its due time
  const sig = { side: 'BUY', ask: 100_002, bid: 100_000, stopDistance: 10 }
  assert.equal(fillVeto({ signalTtlMs: 5000, overshootFraction: 0.25, minStopFraction: 0.0015 }, sig, 100_900, 5001), 'signalTtl')
  assert.equal(fillVeto({ signalTtlMs: 5000, overshootFraction: 0.25, minStopFraction: 0.0015 }, sig, 100_900, 5000), 'priceBound')
})
