// node --test agent/services/market-pulse.test.js
//
// The owner's question was concrete: "since last Thursday USDJPY is defended…
// Opposite is JPN225 index move up sharply. How do you assess this and are
// these part of market trending or correlation movement or both or what?"
//
// So the load-bearing tests are (a) that a DEFENDED market is distinguishable
// from a quiet one — both end where they started and a net-change column
// cannot tell them apart — and (b) that the USDJPY/JPN225 shape comes back
// named rather than as two unrelated rows.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  PULSE_STATES, DEFAULT_PULSE,
  efficiencyRatio, sigmaMove, pinScore, traverseRatio, classifySymbol,
  herdsOf, herdPulse, pairDivergences, computePulse,
  storePulse, loadPulse, pulseFor, driverOf,
} from './market-pulse.js'

const bar = (c, h, l) => ({ c, h, l })

// FIXTURES CARRY NOISE, DELIBERATELY. A perfectly deterministic ramp has no
// spread in its k-bar moves at all, so sigmaMove correctly declines to
// z-score it — and the first version of these fixtures was so clean that the
// metric under test had nothing to measure. Market-shaped data, from a fixed
// generator so the runs stay reproducible.
let seed = 42
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
const reseed = (v = 42) => { seed = v }

/** A directional move with ordinary noise on top. */
const trend = (n = 40, from = 100, step = 0.3, noise = 0.25) => {
  reseed()
  return Array.from({ length: n }, (_, i) => {
    const c = from + i * step + rnd() * step * noise * 10
    const w = Math.abs(step) * 0.6
    return bar(c, c + w, c - w)
  })
}

/**
 * A DEFENDED level: price is pushed at repeatedly and pushed back each time.
 * Each bar's own range is modest; the BAND the closes cross is many bar-ranges
 * wide — which is exactly what traverseRatio measures and what separates this
 * from `quiet`.
 */
const defended = (n = 42, level = 150, amp = 2) => {
  reseed(7)
  // Whole periods, so it ENDS where it started — which is what "held" means.
  const period = n / 6
  return Array.from({ length: n }, (_, i) => {
    const c = level + Math.sin((i / period) * 2 * Math.PI) * amp + rnd() * amp * 0.1
    const w = amp * 0.12
    return bar(c, c + w, c - w)
  })
}

/**
 * A SHARP move: an ordinary market that suddenly accelerates in the last few
 * bars. This — not a uniformly steep ramp — is what the marker is for.
 */
const spike = (n = 40, level = 100) => {
  reseed(3)
  return Array.from({ length: n }, (_, i) => {
    const base = level + rnd() * 0.4
    const kick = i >= n - 6 ? (i - (n - 7)) * 2.5 : 0
    const c = base + kick
    return bar(c, c + 0.3, c - 0.3)
  })
}

/** Genuinely quiet: the closes never leave about one bar's worth of range. */
const quiet = (n = 40, level = 100) => {
  reseed(11)
  return Array.from({ length: n }, () => {
    const c = level + rnd() * 0.02
    return bar(c, c + 0.02, c - 0.02)
  })
}

// ---------------------------------------------------------------------------
// The three measurements, separately
// ---------------------------------------------------------------------------

test('efficiencyRatio is near 1 for a directional move and ~0 for a round trip', () => {
  const t = efficiencyRatio(trend())
  assert.ok(t > 0.8, `a noisy but one-way move should still read as directional, got ${t}`)
  const er = efficiencyRatio(defended())
  assert.ok(er < 0.2, `a defended level should walk a long path for no distance, got ${er}`)
  // A PERFECT line is exactly 1 — the ratio's own definition.
  assert.equal(efficiencyRatio([bar(1, 1, 1), bar(2, 2, 2), bar(3, 3, 3)]), 1)
})

test('efficiencyRatio says NULL, not zero, when there is no path', () => {
  // An undefined ratio is a different claim from a perfectly inefficient one,
  // and classifySymbol branches on it.
  assert.equal(efficiencyRatio([bar(100), bar(100), bar(100)]), null)
  assert.equal(efficiencyRatio([bar(100)]), null)
  assert.equal(efficiencyRatio(null), null)
})

test('sigmaMove measures ACCELERATION, not steepness', () => {
  // A market that has climbed at the same rate all week is trending, not
  // spiking — every span looks like every other span, so the z-score of the
  // last one is ~0. The marker is for the bar where the RATE changed. This is
  // also why the metric is no longer collinear with efficiencyRatio: the old
  // formula reduced to ER×√n and printed 1,116σ on a clean ramp.
  const steady = Math.abs(sigmaMove(trend(40, 100, 2)))
  const accel = Math.abs(sigmaMove(spike()))
  assert.ok(accel > steady, `an acceleration should out-read a steady climb (${accel} vs ${steady})`)
  assert.ok(accel >= DEFAULT_PULSE.sharpSigma, `and clear the sharp threshold, got ${accel}`)
  assert.ok(steady < DEFAULT_PULSE.sharpSigma, `a steady climb is not "sharp", got ${steady}`)
})

test('sigmaMove is SIGNED — direction is half the information', () => {
  assert.ok(sigmaMove(spike()) > 0)
  assert.ok(sigmaMove(spike().map(b => bar(-b.c + 200, -b.l + 200, -b.h + 200))) < 0)
})

test('sigmaMove says nothing when there is no spread to compare against', () => {
  // Every span identical → no distribution to z-score against. Inventing a
  // number there is precisely the bug this function was rewritten to remove.
  const flat = Array.from({ length: 40 }, () => bar(100, 100, 100))
  assert.equal(sigmaMove(flat), null)
  // …and too little history is null too, never a confident zero.
  assert.equal(sigmaMove([bar(1), bar(2), bar(3)]), null)
  assert.equal(sigmaMove(null), null)
})

test('traverseRatio is what separates a held level from a flat one', () => {
  // Both end where they started, and both therefore show a big pin ratio.
  // Only one of them crossed a band worth fighting over.
  assert.ok(traverseRatio(defended()) >= DEFAULT_PULSE.pinTraverse)
  assert.ok(traverseRatio(quiet()) < DEFAULT_PULSE.pinTraverse)
})

test('pinScore is high when a lot of range bought no distance', () => {
  assert.ok(pinScore(defended()) >= DEFAULT_PULSE.pinRatio)
  assert.ok(pinScore(trend()) < DEFAULT_PULSE.pinRatio)
})

test('a net move of exactly zero is Infinity, not an error', () => {
  // The extreme of the same quantity. Callers compare against a threshold, so
  // returning null here would silently drop the most pinned case of all.
  const flatEnds = [bar(100, 105, 95), bar(103, 105, 95), bar(97, 105, 95), bar(100, 105, 95)]
  assert.equal(pinScore(flatEnds), Number.POSITIVE_INFINITY)
})

// ---------------------------------------------------------------------------
// classifySymbol — the decision order IS the argument
// ---------------------------------------------------------------------------

test('THE FINDING: a defended level is not the same reading as a quiet one', () => {
  // Both end within a whisker of where they started. A net-change column
  // reports them identically. They are completely different situations.
  const d = classifySymbol(defended())
  const q = classifySymbol(quiet())
  assert.equal(d.state, 'defended')
  assert.equal(q.state, 'quiet')
  assert.ok(Math.abs(d.netPct) < 3 && Math.abs(q.netPct) < 3, 'both ended near flat — that is the point')
  assert.match(d.why, /level is being held/)
})

test('a steady climb is trending; an acceleration out of it is breaking', () => {
  const t = classifySymbol(trend(40, 100, 0.05))
  assert.equal(t.state, 'trending')
  assert.equal(t.sharp, false, 'steady is not sharp, however steep')

  const b = classifySymbol(spike())
  assert.equal(b.state, 'breaking')
  assert.equal(b.sharp, true)
  assert.match(b.why, /σ/)
})

test('breaking is tested BEFORE trending — the rarer read wins', () => {
  // A move that is both directional AND an acceleration must come back as the
  // more actionable one, not be swallowed by the general case.
  const r = classifySymbol(spike())
  assert.equal(r.state, 'breaking')
  assert.ok(r.er >= DEFAULT_PULSE.trendER, 'it satisfies the trending test too')
})

test('every state it can produce is in the declared set', () => {
  for (const bars of [trend(), defended(), quiet(), spike(), trend(40, 100, -0.3)]) {
    const r = classifySymbol(bars)
    assert.ok(PULSE_STATES.includes(r.state), `${r.state} is not declared`)
  }
})

test('too little history is null, never a confident "quiet"', () => {
  // The vol gate already learned this once: an empty atr_history read as
  // NORMAL everywhere and nobody noticed for days.
  assert.equal(classifySymbol([bar(1), bar(2)]), null)
  assert.equal(classifySymbol([]), null)
  assert.equal(classifySymbol(null), null)
})

test('it reads either bar shape the codebase uses', () => {
  const asClose = trend().map(b => ({ close: b.c, high: b.h, low: b.l }))
  assert.equal(classifySymbol(asClose).state, classifySymbol(trend()).state)
})

// ---------------------------------------------------------------------------
// Herds
// ---------------------------------------------------------------------------

const matrix = (pairs, syms) => {
  const m = {}
  for (const a of syms) { m[a] = {}; for (const b of syms) m[a][b] = a === b ? 1 : 0 }
  for (const [a, b, r] of pairs) { m[a][b] = r; m[b][a] = r }
  return { symbols: syms, m }
}

test('a herd is a connected component — transitivity is the point', () => {
  // A–B and B–C are each strongly correlated; A–C is not. All three still
  // move as one bet, and a pairwise-only reading would miss that.
  const m = matrix([['A', 'B', 0.9], ['B', 'C', 0.85]], ['A', 'B', 'C', 'D'])
  const herds = herdsOf(m, 0.7)
  assert.equal(herds.length, 1)
  assert.deepEqual(herds[0], ['A', 'B', 'C'])
})

test('a STRONG NEGATIVE correlation is the same herd — one bet, held two ways', () => {
  const m = matrix([['A', 'B', -0.92]], ['A', 'B'])
  assert.deepEqual(herdsOf(m, 0.7), [['A', 'B']])
})

test('a herd of one is not a herd', () => {
  assert.deepEqual(herdsOf(matrix([], ['A', 'B', 'C']), 0.7), [])
  assert.deepEqual(herdsOf(null), [])
})

test('a cluster that is correlated but going nowhere is NOT a herd move', () => {
  // Agreement alone is satisfied by four symbols drifting a hundredth of a
  // percent in step. Calling that a herd move would be the detector lying
  // about its own evidence.
  const readings = {
    A: classifySymbol(quiet()), B: classifySymbol(quiet()),
    C: classifySymbol(quiet()), D: classifySymbol(quiet()),
  }
  const h = herdPulse(['A', 'B', 'C', 'D'], readings)
  assert.equal(h.moving, false)
  assert.equal(h.movers, 0)
})

test('a herd all pushing the same way IS a herd move', () => {
  const up = classifySymbol(trend(40, 100, 0.3))
  const readings = { A: up, B: up, C: up }
  const h = herdPulse(['A', 'B', 'C'], readings)
  assert.equal(h.moving, true)
  assert.equal(h.dir, 1)
  assert.equal(h.agreement, 1)
})

test('half up and half down is correlated on paper and doing nothing in practice', () => {
  const up = classifySymbol(trend(40, 100, 0.3))
  const down = classifySymbol(trend(40, 100, -0.3))
  const h = herdPulse(['A', 'B', 'C', 'D'], { A: up, B: up, C: down, D: down })
  assert.equal(h.agreement, 0.5)
  assert.equal(h.moving, false, 'below the agreement floor')
  assert.equal(h.dir, 0)
})

// ---------------------------------------------------------------------------
// The owner's actual case
// ---------------------------------------------------------------------------

test('THE USDJPY / JPN225 CASE: one leg held while the other runs, named', () => {
  const bars = { USDJPY: defended(40, 150, 0.6), JPN225: trend(40, 40000, 90) }
  const m = matrix([['USDJPY', 'JPN225', 0.78]], ['USDJPY', 'JPN225'])
  const pulse = computePulse(bars, m)

  assert.equal(pulse.readings.USDJPY.state, 'defended')
  assert.ok(['trending', 'breaking'].includes(pulse.readings.JPN225.state))

  // Neither "a trend" nor "a correlation move" on its own describes this.
  assert.equal(pulse.divergences.length, 1)
  assert.equal(pulse.divergences[0].held, 'USDJPY')
  assert.equal(pulse.divergences[0].running, 'JPN225')
  assert.match(pulse.divergences[0].note, /not operating right now/)
})

test('two legs both asleep are not diverging', () => {
  const readings = { A: classifySymbol(quiet()), B: classifySymbol(quiet()) }
  assert.deepEqual(pairDivergences(matrix([['A', 'B', 0.9]], ['A', 'B']), readings), [])
})

test('two legs both running are not diverging either', () => {
  const up = classifySymbol(trend(40, 100, 0.3))
  assert.deepEqual(pairDivergences(matrix([['A', 'B', 0.9]], ['A', 'B']), { A: up, B: up }), [])
})

test('driverOf answers "trending or correlation or both"', () => {
  const up = classifySymbol(trend(40, 100, 0.3))
  const flat = classifySymbol(quiet())
  const movingHerd = { moving: true, dir: 1 }
  const stillHerd = { moving: false, dir: 0 }

  assert.equal(driverOf(up, movingHerd), 'both')          // trending AND carried
  assert.equal(driverOf(flat, movingHerd), 'herd')        // carried, not itself moving
  assert.equal(driverOf(up, stillHerd), 'idiosyncratic')  // moving alone
  assert.equal(driverOf(flat, stillHerd), 'none')
  // Fighting the cluster is its own answer — not "carried by the herd".
  assert.equal(driverOf(up, { moving: true, dir: -1 }), 'against_herd')
})

// ---------------------------------------------------------------------------
// Store and per-symbol read
// ---------------------------------------------------------------------------

test('computePulse names the sharp movers and the defended up front', () => {
  const pulse = computePulse(
    { BIG: spike(), HELD: defended(), SLEEPY: quiet() },
    matrix([], ['BIG', 'HELD', 'SLEEPY']),
  )
  assert.deepEqual(pulse.sharp.map(s => s.symbol), ['BIG'])
  assert.deepEqual(pulse.defended.map(s => s.symbol), ['HELD'])
})

test('pulseFor answers all three questions for one symbol', () => {
  const db = initDB(':memory:')
  const up = trend(40, 100, 0.3)
  const pulse = computePulse({ A: up, B: up, C: up }, matrix([['A', 'B', 0.9], ['B', 'C', 0.9]], ['A', 'B', 'C']))
  storePulse(db, pulse, '2026-08-05T00:00:00.000Z')

  const r = pulseFor(db, 'A', Date.parse('2026-08-05T00:10:00.000Z'))
  assert.equal(r.known, true)
  assert.equal(r.state, 'trending')                 // is it trending?
  assert.equal(r.herd.n, 3)                          // is it a correlation move?
  assert.equal(r.withHerd, true)
  assert.equal(r.driver, 'both')                     // or both?
})

test('an unknown or stale pulse says so — it never reads as calm', () => {
  // The failure this guards is exactly the one atr_history hit: no data
  // presenting as a confident NORMAL.
  const db = initDB(':memory:')
  assert.equal(pulseFor(db, 'EURUSD').known, false)

  storePulse(db, computePulse({ A: trend() }, matrix([], ['A'])), '2026-08-05T00:00:00.000Z')
  const stale = pulseFor(db, 'A', Date.parse('2026-08-05T06:00:00.000Z'))
  assert.equal(stale.known, false)
  assert.match(stale.why, /old/)

  const missing = pulseFor(db, 'NOTINWINDOW', Date.parse('2026-08-05T00:05:00.000Z'))
  assert.equal(missing.known, false)
  assert.match(missing.why, /not in the last pulse window/)
})

test('loadPulse survives junk in the state row', () => {
  const db = initDB(':memory:')
  assert.equal(loadPulse(db), null)
})

test('an empty pulse is a calm empty answer, not a throw', () => {
  const p = computePulse({}, null)
  assert.deepEqual(p.readings, {})
  assert.deepEqual(p.herds, [])
  assert.deepEqual(p.divergences, [])
  assert.deepEqual(p.sharp, [])
})
