// agent/lib/tick-replay-sim.test.js — P4: fills at executable prices after
// latency, exits at the side that crossed, gaps fill where the price was,
// costs are charged, caps are finite, blocks purge straddlers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { simulate, summarize, blockSummaries } from './tick-replay-sim.js'
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
  assert.ok(r.trades[0].entrySeq > 106 && r.trades[0].entrySeq <= 109, 'filled on the next events after the 60 ms latency')
  assert.ok(['stop', 'target', 'hold_events', 'hold_clock', 'data_end'].includes(r.trades[0].reason))
  assert.equal(r.trades[1].reason, 'data_end', 'the short is still open when the data ends and is marked to the last bid/ask, not dropped')
  assert.equal(r.blocks.length, 3); assert.equal(r.blocks.map(b => b.name).join(','), 'train,validation,test')
  assert.equal(r.blocks.reduce((a, b) => a + b.trades + b.purged, 0), 2)
  assert.equal(typeof r.profileHash, 'string'); assert.equal(r.events, events.length)
  const s = summarize([{ netR: 2, reason: 'target', holdEvents: 3 }, { netR: -1, reason: 'stop', holdEvents: 2 }])
  assert.equal(s.profitFactor, 2); assert.equal(s.tailShare, 0.5); assert.equal(s.maxDrawdownR, 1)
  const b = blockSummaries([{ netR: 1, reason: 'target', holdEvents: 1, entryIdx: 9, exitIdx: 12 }], 30, 3, 5)
  assert.equal(b[0].purged, 1, 'a trade entered in train and exited inside the purge window after the boundary is dropped')
})
