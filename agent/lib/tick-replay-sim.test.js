// agent/lib/tick-replay-sim.test.js — P4: fills at executable prices after
// latency, exits at the side that crossed, gaps fill where the price was,
// costs are charged, caps are finite, blocks purge straddlers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { simulate, summarize, blockSummaries, resolveLatency } from './tick-replay-sim.js'
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
  const r = simulate(ev, PARAMS, { latencyMs: 250, slippage: 1, commissionPerSide: 2, targetR: 3, minTargetToCost: 1 }, { signalsOverride: [sig] })
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
