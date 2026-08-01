// node --test agent/lib/volume-structure.test.js
//
// Session volume structure (owner spec, 2026-07-26): VPOC, LVN bands, value
// area, and the bullish/bearish/ranging call from where a session opens
// relative to the previous session's value area.
//
// Sessions are FX days anchored at 17:00 New York — the same fxDayOpenMs the
// daily loss cap uses, so fixtures here build bars from explicit UTC hours.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sessionSlices, sessionProfile, lowVolumeNodes, inLowVolumeNode,
  vpocMigration, marketStructure, volumeStructure, fxDayOpenMs,
} from './volume-structure.js'
import { fxDayOpenMs as riskFxDayOpenMs } from '../services/risk.js'

// 2026-07-22 (Wednesday) 21:00 UTC = 17:00 New York in July (EDT, UTC-4):
// the FX day boundary. Hours are offsets from this anchor.
const ANCHOR = Date.UTC(2026, 6, 22, 21, 0, 0)
const hoursMs = (h) => ANCHOR + h * 3_600_000

const bar = (h, { o = 100, hi = null, lo = null, c = null, v = 1000 } = {}) => {
  const close = c ?? o
  return { t: hoursMs(h), o, h: hi ?? Math.max(o, close) + 0.5, l: lo ?? Math.min(o, close) - 0.5, c: close, v }
}

// One full FX day of hourly bars clustered around `centre`: heavy volume in
// the middle of the day, light tails — a clean single-distribution profile
// whose VPOC lands at the centre.
function sessionBars(dayOffsetHours, centre, { tail = 3 } = {}) {
  const bars = []
  for (let h = 0; h < 24; h++) {
    const distFromMid = Math.abs(h - 12)
    const price = centre + (h < 12 ? -1 : 1) * Math.max(0, distFromMid - 6) * tail * 0.1
    const heavy = distFromMid <= 6
    bars.push(bar(dayOffsetHours + h, { o: price, c: price, v: heavy ? 2000 : 100 }))
  }
  return bars
}

// ---------------------------------------------------------------------------
// Session slicing.
// ---------------------------------------------------------------------------

test('bars split into FX-day sessions at the 17:00-NY boundary', () => {
  const bars = [...sessionBars(0, 100), ...sessionBars(24, 101)]
  const slices = sessionSlices(bars)
  assert.equal(slices.length, 2)
  assert.equal(slices[0].bars.length, 24)
  assert.equal(slices[1].bars.length, 24)
  assert.ok(slices[1].openMs > slices[0].openMs)
})

test('a bar exactly on the boundary opens the new session', () => {
  const bars = [bar(23), bar(24), bar(25)]
  const slices = sessionSlices(bars)
  assert.equal(slices.length, 2)
  assert.equal(slices[0].bars.length, 1)
  assert.equal(slices[1].bars.length, 2)
})

test('empty and missing input produce no sessions', () => {
  assert.deepEqual(sessionSlices([]), [])
  assert.deepEqual(sessionSlices(undefined), [])
})

// ---------------------------------------------------------------------------
// Session profile.
// ---------------------------------------------------------------------------

test('sessionProfile finds the VPOC at the heavy cluster and VAH above VAL', () => {
  const p = sessionProfile(sessionBars(0, 100))
  assert.ok(p)
  assert.ok(Math.abs(p.vpoc - 100) < 1.0, `vpoc ${p.vpoc} should sit near 100`)
  assert.ok(p.vah > p.val)
  assert.ok(p.height > 0)
})

test('a flat zero-span series is reported as null, not a shape full of nulls', () => {
  const flat = Array.from({ length: 24 }, (_, h) => ({ t: hoursMs(h), o: 100, h: 100, l: 100, c: 100, v: 500 }))
  assert.equal(sessionProfile(flat), null)
})

// ---------------------------------------------------------------------------
// LVN bands.
// ---------------------------------------------------------------------------

// A profile with two heavy clusters and a void between them: rows are
// supplied directly so the band arithmetic is exact.
function twoClusterProfile() {
  const rows = []
  for (let k = 0; k < 20; k++) {
    let volume
    if (k <= 5) volume = 900          // lower cluster
    else if (k >= 14) volume = 1000   // upper cluster (holds the POC)
    else volume = 50                  // the void
    rows.push({ price: 100 + k, volume, pct: 0 })
  }
  return { rows, vpoc: 119, vah: 119, val: 100, height: 19 }
}

test('a contiguous run of thin buckets becomes ONE band with real width', () => {
  const nodes = lowVolumeNodes(twoClusterProfile())
  assert.equal(nodes.length, 1)
  const [n] = nodes
  // Buckets 6..13 (prices 106..113), each 1.0 wide → band spans 105.5..113.5.
  assert.ok(Math.abs(n.lo - 105.5) < 1e-9)
  assert.ok(Math.abs(n.hi - 113.5) < 1e-9)
  assert.ok(n.pctOfPoc < 100 * 0.3 * 8) // sanity: it is thin relative to the POC
})

test('inLowVolumeNode answers for prices inside, outside and at the edges', () => {
  const nodes = lowVolumeNodes(twoClusterProfile())
  assert.equal(inLowVolumeNode(110, nodes), true)
  assert.equal(inLowVolumeNode(103, nodes), false)
  assert.equal(inLowVolumeNode(117, nodes), false)
  assert.equal(inLowVolumeNode(105.5, nodes), true, 'band edges are inclusive')
})

test('a thin run touching the profile edge is NOT an LVN', () => {
  // Every profile is thin at its extremes because the range ends there.
  const rows = []
  for (let k = 0; k < 10; k++) rows.push({ price: 100 + k, volume: k < 3 ? 10 : 1000, pct: 0 })
  const nodes = lowVolumeNodes({ rows })
  assert.equal(nodes.length, 0)
})

test('the threshold is a fraction of the POC bucket, and is overridable', () => {
  const p = twoClusterProfile()
  // At 30% of a 1000-volume POC the 50-volume void qualifies; at 4% it does not.
  assert.equal(lowVolumeNodes(p).length, 1)
  assert.equal(lowVolumeNodes(p, { maxPocFraction: 0.04 }).length, 0)
})

// ---------------------------------------------------------------------------
// VPOC migration.
// ---------------------------------------------------------------------------

const prof = (vpoc, height = 10) => ({ vpoc, vah: vpoc + height / 2, val: vpoc - height / 2, height, rows: [] })

test('a steady upward VPOC drift reads as institutions repositioning up', () => {
  const m = vpocMigration([prof(100), prof(103), prof(106)])
  assert.equal(m.direction, 'up')
  assert.equal(m.monotonic, true)
  assert.ok(m.driftFraction > 0)
})

test('a sub-threshold wobble is flat — the market found the same fair value', () => {
  const m = vpocMigration([prof(100), prof(100.4), prof(99.8)])
  assert.equal(m.direction, 'flat')
  assert.equal(m.monotonic, false)
})

test('a zig-zag with net drift is directional but NOT monotonic', () => {
  const m = vpocMigration([prof(100), prof(97), prof(106)])
  assert.equal(m.direction, 'up')
  assert.equal(m.monotonic, false)
})

test('fewer than two sessions cannot describe a migration', () => {
  assert.equal(vpocMigration([prof(100)]), null)
  assert.equal(vpocMigration([]), null)
})

// ---------------------------------------------------------------------------
// Market structure from the open.
// ---------------------------------------------------------------------------

test('open above prev VAH is bullish and the VAH becomes support', () => {
  const s = marketStructure(106, prof(100)) // VAH = 105
  assert.deepEqual(s, { structure: 'bullish', reference: 105, role: 'support' })
})

test('open below prev VAL is bearish and the VAL becomes resistance', () => {
  const s = marketStructure(94, prof(100)) // VAL = 95
  assert.deepEqual(s, { structure: 'bearish', reference: 95, role: 'resistance' })
})

test('open inside the value area is ranging, with NO invented reference level', () => {
  const s = marketStructure(101, prof(100))
  assert.equal(s.structure, 'ranging')
  assert.equal(s.reference, null)
})

// ---------------------------------------------------------------------------
// The assembled read.
// ---------------------------------------------------------------------------

test('volumeStructure classifies today against yesterday end to end', () => {
  // Yesterday centred at 100; today opens at yesterday's centre → ranging.
  const bars = [...sessionBars(0, 100), bar(24, { o: 100, c: 100 }), bar(25, { o: 100.2, c: 100.2 })]
  const vs = volumeStructure(bars)
  assert.ok(vs)
  assert.equal(vs.structure, 'ranging')
  assert.ok(vs.prev.vah > vs.prev.val)
  assert.equal(vs.sessionBars, 2)
})

test('one session of history is not enough — the method is relative to yesterday', () => {
  assert.equal(volumeStructure(sessionBars(0, 100)), null)
})

// The session anchor is DUPLICATED from risk.js (lib/ cannot import
// services/ without a registry-deadlocking cycle). This is the tripwire: if
// either copy ever changes alone, the daily loss cap and the volume
// structure would silently disagree about when "today" starts.
test('the local FX-day anchor agrees with risk.js at awkward instants', () => {
  const instants = [
    Date.UTC(2026, 6, 22, 20, 59, 59), // just before the July boundary (EDT)
    Date.UTC(2026, 6, 22, 21, 0, 0),   // exactly on it
    Date.UTC(2026, 6, 22, 21, 0, 1),   // just after
    Date.UTC(2026, 0, 15, 22, 0, 0),   // January — EST, boundary at 22:00 UTC
    Date.UTC(2026, 2, 8, 12, 0, 0),    // a US DST transition day
  ]
  for (const t of instants) {
    assert.equal(fxDayOpenMs(t), riskFxDayOpenMs(t), new Date(t).toISOString())
  }
})

// ---------------------------------------------------------------------------
// HVN nodes (instr/hvn-targeted-tp-spec.md §2, owner-approved 01-08-2026).
// Mirror of the LVN logic: buckets ≥ HVN_MIN_POC_FRACTION of the POC volume,
// adjacent qualifying buckets merged, volume-weighted centre + near edges.
// ---------------------------------------------------------------------------
import { hvnNodes, HVN_MIN_POC_FRACTION } from './volume-structure.js'

// 24 bars, each confined to its own price bucket of a [100,124] composite
// profile (step 1), so bucket volumes are exactly the bar volumes.
function bucketBars(volumes) {
  const lo = 100
  return volumes.map((v, i) => ({
    t: hoursMs(i), o: lo + i + 0.5, h: lo + i + 0.9, l: lo + i + 0.1, c: lo + i + 0.5, v,
  }))
}

test('T1: one obvious volume shelf → a single HVN node with correct near edges', () => {
  const vols = new Array(24).fill(100)
  vols[10] = 1000 // POC — the only qualifying bucket
  const nodes = hvnNodes(bucketBars(vols))
  assert.equal(nodes.length, 1)
  const n = nodes[0]
  // Bucket 10 of a [100,124]/24 profile spans 110..111.
  assert.ok(Math.abs(n.nearEdgeLo - 110) < 1e-9, `lo edge ${n.nearEdgeLo}`)
  assert.ok(Math.abs(n.nearEdgeHi - 111) < 1e-9, `hi edge ${n.nearEdgeHi}`)
  assert.ok(Math.abs(n.price - 110.5) < 1e-9)
  assert.equal(n.pctOfPoc, 100)
})

test('T2: adjacent qualifying buckets merge into ONE node, volume-weighted centre', () => {
  const vols = new Array(24).fill(100)
  vols[10] = 1000
  vols[11] = 900 // ≥ 70% of POC and adjacent → same node
  vols[18] = 800 // ≥ 70% but separate → its own node
  const nodes = hvnNodes(bucketBars(vols))
  assert.equal(nodes.length, 2)
  const [a, b] = nodes // ascending by price
  assert.ok(a.nearEdgeLo < b.nearEdgeLo)
  // Merged node spans buckets 10-11 → edges 110..112.
  assert.ok(Math.abs(a.nearEdgeLo - 110) < 1e-9)
  assert.ok(Math.abs(a.nearEdgeHi - 112) < 1e-9)
  // Volume-weighted centre leans toward the heavier bucket 10.
  assert.ok(a.price < 111.5 && a.price > 110.5, `centre ${a.price}`)
  assert.equal(Math.round(a.volume), 1900)
})

test('T3: flat series and empty bars → [] without throwing', () => {
  assert.deepEqual(hvnNodes([]), [])
  assert.deepEqual(hvnNodes(null), [])
  const flat = new Array(30).fill(0).map((_, i) => ({ t: hoursMs(i), o: 100, h: 100, l: 100, c: 100, v: 500 }))
  assert.ok(Array.isArray(hvnNodes(flat)))
})

test('T4: HVN and LVN thresholds are disjoint on the same fixture', () => {
  assert.ok(HVN_MIN_POC_FRACTION > LVN_MAX_POC_FRACTION)
  const vols = new Array(24).fill(500)
  vols[10] = 1000        // HVN territory
  vols[5] = 100          // LVN territory (≤30% of POC)
  const bars = bucketBars(vols)
  const hvn = hvnNodes(bars)
  const profile = sessionProfile(bars)
  const lvn = lowVolumeNodes(profile)
  // No price band can be both.
  for (const h of hvn) for (const l of lvn) {
    assert.ok(h.nearEdgeHi <= l.lo || h.nearEdgeLo >= l.hi,
      `HVN ${h.nearEdgeLo}-${h.nearEdgeHi} overlaps LVN ${l.lo}-${l.hi}`)
  }
})
