// PRICE·R tape de-overlap — the last known cockpit defect from the design
// handoff's acceptance pass (measured: 3-6 pairs of adjacent numeric labels
// overlapping by 2-3px).
//
// Two causes, both source-derivable:
//
//  1. The neighbour filter never fired. `Array.prototype.filter` hands the
//     callback the ORIGINAL array, so `arr[i - 1]` was always the pre-filter
//     neighbour — 11.5 apart by construction, so the spacing check always
//     passed and dropping a tick next to a rail could never make its
//     neighbours re-check. These tests pin the running last-KEPT semantics.
//
//  2. The thresholds were below the label's own height at the shortest tape
//     the variants render.

import { describe, it, expect } from 'vitest'
import { thinTicks } from './cockpit-data.js'

const ticksAt = (...tops) => tops.map(top => ({ top, v: String(top) }))
const tops = arr => arr.map(t => t.top)

describe('thinTicks', () => {
  it('keeps every tick when they already clear each other', () => {
    expect(tops(thinTicks(ticksAt(10, 30, 50, 70), []))).toEqual([10, 30, 50, 70])
  })

  it('drops a tick that sits closer than the gap to the one BEFORE IT', () => {
    // 22 kept · 33.5 too close · 45 clears 22 by 23 · and so on.
    expect(tops(thinTicks(ticksAt(22, 33.5, 45, 56.5, 68, 79.5, 91), [])))
      .toEqual([22, 45, 68, 91])
  })

  it('measures against the last KEPT tick, not the previous candidate', () => {
    // The old filter compared against the source array, so a run of tightly
    // spaced ticks after a dropped one all slipped through. Here 12, 14 and 16
    // are each 2 from their predecessor: only 10 and 24 may survive.
    expect(tops(thinTicks(ticksAt(10, 12, 14, 16, 24), [])))
      .toEqual([10, 24])
  })

  it('clears rail labels', () => {
    // A rail at 50 removes 45 and 56 (both within 13) and nothing else.
    expect(tops(thinTicks(ticksAt(10, 30, 45, 56, 70, 90), [50])))
      .toEqual([10, 30, 70, 90])
  })

  it('clears every rail, not just the first', () => {
    expect(tops(thinTicks(ticksAt(10, 30, 50, 70, 90), [30, 70])))
      .toEqual([10, 50, 90])
  })

  it('a rail clears its whole neighbourhood, not just the nearest tick', () => {
    // The rail label has height too, so a rail at 34 takes out everything
    // within 13 of it: 22 (12 away) and 34 itself. 48 is 14 away and survives.
    // (A rail drop can never make a LATER tick fail spacing — it is the
    // spacing cascade above that the broken filter got wrong, because ticks
    // are ascending, so a dropped tick is always nearer than the one before.)
    expect(tops(thinTicks(ticksAt(22, 34, 48), [34]))).toEqual([48])
  })

  it('the guarantee holds: no two kept ticks are closer than the gap', () => {
    const kept = thinTicks(ticksAt(0, 5, 9, 13, 18, 22, 27, 31, 40, 41, 55), [26])
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].top - kept[i - 1].top).toBeGreaterThanOrEqual(13)
    }
  })

  it('the gap is overridable, so a taller tape can show more ticks', () => {
    expect(tops(thinTicks(ticksAt(0, 6, 12, 18), [], 6))).toEqual([0, 6, 12, 18])
    expect(tops(thinTicks(ticksAt(0, 6, 12, 18), [], 7))).toEqual([0, 12])
  })

  it('survives empty and missing input', () => {
    expect(thinTicks([], [])).toEqual([])
    expect(thinTicks(undefined, [])).toEqual([])
    expect(thinTicks(ticksAt(10, 30), undefined).length).toBe(2)
  })
})
