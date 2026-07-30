import { describe, it, expect } from 'vitest'
import { orderHourlyForDisplay, totalFloating, nextHourBoundary } from './hourly-order.js'

const H = 3600_000
const T0 = Date.parse('2026-07-28T21:00:00Z')     // FX day open, 17:00 NY
// 24 contiguous hourly slots with a balance already carried onto them.
const slots = Array.from({ length: 24 }, (_, i) => ({
  from: T0 + i * H, to: T0 + (i + 1) * H, openBal: 1000 + i, closeBal: 1001 + i,
}))

describe('24-hour table ordering (UI-2)', () => {
  // Owner, 2026-07-30: "you should always show the current time as the top row
  // and the past hour below it, currently is static." A plain reverse put the
  // last hour of the FX DAY on top, which for most of the day has not happened
  // yet — mid-afternoon the top rows were dashed future hours and the live hour
  // sat seven rows down. Reversed is not the same as "now first".
  it('leads with the CURRENT hour, then the past descending', () => {
    const out = orderHourlyForDisplay(slots, T0 + 5 * H + 600_000)
    expect(out[0].from).toBe(slots[5].from)
    expect(out[0].isLive).toBe(true)
    expect(out[1].from).toBe(slots[4].from)
    expect(out[2].from).toBe(slots[3].from)
    expect(out[5].from).toBe(slots[0].from)   // oldest past row
  })

  it('keeps the hours still to come, below the history rather than above it', () => {
    const out = orderHourlyForDisplay(slots, T0 + 5 * H + 600_000)
    // All 24 survive — the owner asked for the full day ("where are the 24
    // hours"); the future ones just stop crowding out the live row.
    expect(out).toHaveLength(24)
    const past = out.slice(0, 6).map(r => r.from)
    const future = out.slice(6).map(r => r.from)
    expect(future[0]).toBe(slots[6].from)              // soonest first
    expect(future[future.length - 1]).toBe(slots[23].from)
    // Nothing later than the live hour appears above it.
    expect(Math.max(...past)).toBe(slots[5].from)
  })

  it('marks exactly one row live, and it is the hour containing now', () => {
    const now = T0 + 5 * H + 600_000          // 10 minutes into slot 5
    const out = orderHourlyForDisplay(slots, now)
    const live = out.filter(r => r.isLive)
    expect(live).toHaveLength(1)
    expect(live[0].from).toBe(slots[5].from)
    expect(now).toBeGreaterThanOrEqual(live[0].from)
    expect(now).toBeLessThan(live[0].to)
  })

  it('the live row is row ZERO wherever in the day it falls', () => {
    // The old assertion allowed "near the top", which is how a live hour could
    // sit seven rows down and still pass. It is now row 0, always.
    for (const i of [0, 1, 5, 12, 22, 23]) {
      const out = orderHourlyForDisplay(slots, T0 + i * H + 60_000)
      expect(out.findIndex(r => r.isLive), `live hour ${i}`).toBe(0)
    }
  })

  it('every slot appears exactly once, whatever the ordering', () => {
    // The reordering slices the array in three; an off-by-one would duplicate
    // or drop an hour, and a duplicated hour would double-count on screen.
    for (const i of [0, 7, 23]) {
      const out = orderHourlyForDisplay(slots, T0 + i * H + 60_000)
      expect(new Set(out.map(r => r.from)).size).toBe(24)
    }
  })

  it('does NOT reorder or recompute the balances it was handed', () => {
    // The carry runs oldest→newest before this function; reversing the source
    // before the carry would invert every balance on the page. Each row must
    // keep the balances it arrived with.
    const out = orderHourlyForDisplay(slots, T0)
    for (const r of out) {
      const src = slots.find(s => s.from === r.from)
      expect(r.openBal).toBe(src.openBal)
      expect(r.closeBal).toBe(src.closeBal)
    }
  })

  it('does not mutate the array it was given', () => {
    const copy = slots.map(s => ({ ...s }))
    orderHourlyForDisplay(slots, T0 + 3 * H)
    expect(slots).toEqual(copy)
    expect(slots.some(s => 'isLive' in s)).toBe(false)
  })

  it('marks nothing live when now falls outside every slot, and falls back to newest-first', () => {
    // A completed FX day (the weekend view) has no live hour at all, so there
    // is no "now" to lead with and every row is history.
    const out = orderHourlyForDisplay(slots, T0 + 48 * H)
    expect(out.some(r => r.isLive)).toBe(false)
    expect(out).toHaveLength(24)
    expect(out[0].from).toBe(slots[23].from)
    expect(out[out.length - 1].from).toBe(slots[0].from)
  })

  it('handles an empty day without throwing', () => {
    expect(orderHourlyForDisplay([], Date.now())).toEqual([])
    expect(orderHourlyForDisplay(null, Date.now())).toEqual([])
  })
})

describe('floating total', () => {
  it('sums every bucket, because "live now" ignores which table a position sits in', () => {
    expect(totalFloating(12.4, -5.9, 3.5)).toBeCloseTo(10.0)
  })

  it('ignores buckets that reported nothing rather than treating them as zero', () => {
    expect(totalFloating(12.4, null, undefined)).toBeCloseTo(12.4)
  })

  it('returns null when NOTHING reported — a dash, not a confident $0.00', () => {
    // "no open positions" and "P&L we could not read" must not look the same.
    expect(totalFloating(null, null)).toBe(null)
    expect(totalFloating()).toBe(null)
  })

  it('a real zero is still zero, not null', () => {
    expect(totalFloating(0)).toBe(0)
  })
})

describe('nextHourBoundary', () => {
  it('is the next exact hour, strictly after now', () => {
    const t = Date.parse('2026-07-30T14:37:12.345Z')
    expect(nextHourBoundary(t)).toBe(Date.parse('2026-07-30T15:00:00Z'))
    expect(nextHourBoundary(t)).toBeGreaterThan(t)
  })

  it('moves on even when called exactly ON the hour', () => {
    // Returning "now" here would schedule a zero-delay timer that fires
    // forever, so this case has to advance a full hour.
    const t = Date.parse('2026-07-30T14:00:00Z')
    expect(nextHourBoundary(t)).toBe(Date.parse('2026-07-30T15:00:00Z'))
  })

  it('crosses midnight and the year end', () => {
    expect(nextHourBoundary(Date.parse('2026-07-30T23:10:00Z')))
      .toBe(Date.parse('2026-07-31T00:00:00Z'))
    expect(nextHourBoundary(Date.parse('2026-12-31T23:59:59Z')))
      .toBe(Date.parse('2027-01-01T00:00:00Z'))
  })
})
