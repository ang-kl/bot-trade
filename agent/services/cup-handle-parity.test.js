// node --test agent/services/cup-handle-parity.test.js
//
// PARITY, on identical bars. The audit reported 1,777 diagnostic traces
// clearing every gate against zero production `cup_handle` signals over the
// comparable period — but the two numbers came from two code paths fed
// different windows at different times, so the comparison could not tell
// "the twin's gates differ" from "the twin sees different bars" from
// "production fired and something downstream dropped it".
//
// These tests remove the ambiguity the only way it can be removed: one array
// of bars, both paths, one verdict.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cupHandleParity, parityScan, UNTRACED_GATES } from './cup-handle-parity.js'

const HOUR = 3_600_000
const bar = (i, o, h, l, c, v) => ({ t: i * HOUR, o, h, l, c, v })

/** The textbook positive control from cup-handle.test.js, kept in step with it. */
function cupHandleBars() {
  const bars = []
  let i = 0
  let p = 50
  for (; i < 185; i++) { p += 50 / 185; bars.push(bar(i, p - 0.1, p + 0.3, p - 0.4, p, 1000)) }
  for (let k = 0; k < 12; k++, i++) { p -= 2.0; bars.push(bar(i, p + 2.0, p + 2.2, p - 0.3, p, 1600 - k * 60)) }
  for (let k = 0; k < 8; k++, i++) { bars.push(bar(i, p, p + 0.4, p - 0.25, p + 0.1, 500)) }
  for (let k = 0; k < 12; k++, i++) { p += 2.0; bars.push(bar(i, p - 2.0, p + 0.4, p - 2.1, p, 1200 + k * 40)) }
  for (let k = 0; k < 5; k++, i++) { const hp = p - 0.5 * (k + 1) / 2; bars.push(bar(i, hp + 0.2, hp + 0.5, hp - 0.3, hp, 600)) }
  bars.push(bar(i, p - 1, p + 2.2, p - 1.2, p + 2, 1400))
  return bars
}

/** The mirror image — inverted cup, breakdown bar. */
function invCupHandleBars() {
  return cupHandleBars().map(b => ({ t: b.t, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c, v: b.v }))
}

/**
 * Deterministic pseudo-random walk. `Math.random` is banned here for the
 * ordinary reason — a parity harness whose inputs change per run reports a
 * different truth every time it is asked, which is the failure mode this whole
 * workstream exists to remove.
 */
function walk(seed, n = 260, start = 100) {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const bars = []
  let p = start
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.45) * 2
    p = Math.max(1, p + drift)
    const h = p + rnd() * 1.5
    const l = p - rnd() * 1.5
    bars.push(bar(i, p, h, Math.max(0.5, l), p + (rnd() - 0.5), Math.round(400 + rnd() * 1600)))
  }
  return bars
}

// ---------------------------------------------------------------------------
// Positive controls — both directions, through the complete production path
// ---------------------------------------------------------------------------

test('the textbook cup & handle fires in production AND the twin agrees', () => {
  const r = cupHandleParity(cupHandleBars(), '1d')
  assert.equal(r.productionSignal, true, 'positive control must fire')
  assert.equal(r.diagnosticWouldFire, true, 'and the twin must say so')
  assert.equal(r.agree, true)
  assert.equal(r.firstDivergence, null)
  assert.equal(r.strategy, 'cup_handle')
})

test('the inverted pattern has its own positive control, and it also agrees', () => {
  const r = cupHandleParity(invCupHandleBars(), '1d', { dir: -1 })
  assert.equal(r.strategy, 'inv_cup_handle')
  assert.equal(r.productionSignal, true)
  assert.equal(r.diagnosticWouldFire, true)
  assert.equal(r.agree, true)
})

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

test('a flat series fires in neither path — agreement is not only about firing', () => {
  const flat = Array.from({ length: 260 }, (_, i) => bar(i, 100, 100.2, 99.8, 100, 1000))
  const r = cupHandleParity(flat, '1d')
  assert.equal(r.productionSignal, false)
  assert.equal(r.diagnosticWouldFire, false)
  assert.equal(r.agree, true)
})

test('too few bars is a null in both paths, not a crash', () => {
  const r = cupHandleParity(cupHandleBars().slice(-100), '1d')
  assert.equal(r.productionSignal, false)
  assert.equal(r.diagnosticWouldFire, false)
  assert.equal(r.agree, true)
})

// ---------------------------------------------------------------------------
// THE MEASUREMENT the audit could not make
// ---------------------------------------------------------------------------

/**
 * The textbook fixture, parameterised. Random walks almost never contain a
 * cup, so they exercise the first gate and little else; these variants are
 * built to STOP at different gates — shallow/deep cups, handles too short and
 * too long, breakout volume above and below the threshold, bottoms too
 * V-shaped to be round. That is where a divergence between two copies of one
 * search loop would actually live.
 */
function variant({ declineStep = 2.0, handleBars = 5, breakoutVol = 1400, bottomBars = 8 } = {}) {
  const bars = []
  let i = 0, p = 50
  for (; i < 185; i++) { p += 50 / 185; bars.push(bar(i, p - 0.1, p + 0.3, p - 0.4, p, 1000)) }
  for (let k = 0; k < 12; k++, i++) { p -= declineStep; bars.push(bar(i, p + declineStep, p + declineStep + 0.2, p - 0.3, p, 1600 - k * 60)) }
  for (let k = 0; k < bottomBars; k++, i++) { bars.push(bar(i, p, p + 0.4, p - 0.25, p + 0.1, 500)) }
  for (let k = 0; k < 12; k++, i++) { p += declineStep; bars.push(bar(i, p - declineStep, p + 0.4, p - declineStep - 0.1, p, 1200 + k * 40)) }
  for (let k = 0; k < handleBars; k++, i++) { const hp = p - 0.5 * (k + 1) / 2; bars.push(bar(i, hp + 0.2, hp + 0.5, hp - 0.3, hp, 600)) }
  bars.push(bar(i, p - 1, p + 2.2, p - 1.2, p + 2, breakoutVol))
  return bars
}

test('production and the twin agree across 500 structured variants — the measurement the audit could not make', () => {
  const series = []
  for (const declineStep of [1.2, 1.6, 2.0, 2.4, 2.8])
    for (const handleBars of [3, 5, 8, 12, 18])
      for (const breakoutVol of [700, 900, 1200, 1400, 2000])
        for (const bottomBars of [3, 6, 8, 12])
          series.push({
            name: `d${declineStep}-h${handleBars}-v${breakoutVol}-b${bottomBars}`,
            bars: variant({ declineStep, handleBars, breakoutVol, bottomBars }),
          })

  const scan = parityScan(series)
  assert.equal(scan.n, 500)
  assert.deepEqual(
    scan.disagreements.map(d => `${d.name}:${d.firstDivergence}`), [],
    'a divergence here IS the 1,777-vs-0 explanation; an empty list means it is not in the gates',
  )
  // Discriminating power, asserted rather than assumed: a suite where nothing
  // fires and nothing reaches a late gate would pass while proving nothing.
  assert.ok(scan.fired > 100, `only ${scan.fired} of 500 fired — too few to compare`)
  assert.equal(scan.twinWouldFire, scan.fired)
  assert.ok(scan.byGate.breakout_volume > 0, 'variants must reach a LATE gate, not just the first')
})

test('production and the twin agree across 200 deterministic series', () => {
  const series = Array.from({ length: 200 }, (_, i) => ({ name: `walk-${i}`, bars: walk(i * 7919 + 13) }))
  const scan = parityScan(series)

  assert.equal(scan.n, 200)
  assert.deepEqual(
    scan.disagreements.map(d => `${d.name}:${d.firstDivergence}`), [],
    'any entry here is a real divergence between the detector and its diagnostic twin',
  )
  // The funnel is reported in gate order, so a small count cannot be misread
  // as "this gate rarely blocks" when it means "almost nothing reaches it".
  assert.ok(Object.keys(scan.byGate).length > 0, 'the scan must say WHERE candidates stopped')
})

test('the same series, run twice, produces the same verdict', () => {
  // Determinism is a precondition for every claim above it. `scanned_at` moves
  // between runs; the verdict must not.
  const bars = walk(4242)
  assert.deepEqual(cupHandleParity(bars, '1d'), cupHandleParity(bars, '1d'))
})

// ---------------------------------------------------------------------------
// The blind spots, named rather than left implicit
// ---------------------------------------------------------------------------

test('the VWAP filter is invisible to the twin, and the harness says so', () => {
  // Production takes `opts.vwapFilter` and returns null on the wrong side of
  // VWAP. traceDirection takes no opts at all, so with the filter on, a setup
  // production refuses still reads "would have fired" in the diagnostic. That
  // is a live explanation for a diagnostic-high / production-zero gap, and it
  // is a property of the twin, not of the market.
  assert.ok(UNTRACED_GATES.includes('vwap_filter'))
  const bars = cupHandleBars()
  const withFilter = cupHandleParity(bars, '1d', { opts: { vwapFilter: true } })
  if (!withFilter.agree) {
    assert.equal(withFilter.firstDivergence, 'vwap_filter',
      'a VWAP-caused divergence must be attributed to VWAP, not left unexplained')
  }
})

test('parityScan discloses what it did not compare', () => {
  const scan = parityScan([{ bars: cupHandleBars() }])
  assert.deepEqual(scan.untracedGates, UNTRACED_GATES)
  assert.equal(scan.fired, 1)
  assert.equal(scan.twinWouldFire, 1)
})
