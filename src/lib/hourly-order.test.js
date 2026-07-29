import { describe, it, expect } from 'vitest'
import { orderHourlyForDisplay, totalFloating } from './hourly-order.js'

const H = 3600_000
const T0 = Date.parse('2026-07-28T21:00:00Z')     // FX day open, 17:00 NY
// 24 contiguous hourly slots with a balance already carried onto them.
const slots = Array.from({ length: 24 }, (_, i) => ({
  from: T0 + i * H, to: T0 + (i + 1) * H, openBal: 1000 + i, closeBal: 1001 + i,
}))

describe('24-hour table ordering (UI-2)', () => {
  it('reads BACKWARDS from now — newest hour first', () => {
    const out = orderHourlyForDisplay(slots, T0 + 5 * H + 600_000)
    expect(out[0].from).toBe(slots[23].from)
    expect(out[out.length - 1].from).toBe(slots[0].from)
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

  it('the live row is near the TOP once reversed — that is the point of the change', () => {
    // Slot 22 of 24 is the second-newest hour, so after reversing it must be
    // the second row, not the twenty-third.
    const out = orderHourlyForDisplay(slots, T0 + 22 * H + 60_000)
    expect(out.findIndex(r => r.isLive)).toBe(1)
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

  it('marks nothing live when now falls outside every slot', () => {
    // A completed FX day (the weekend view) has no live hour at all.
    const out = orderHourlyForDisplay(slots, T0 + 48 * H)
    expect(out.some(r => r.isLive)).toBe(false)
    expect(out).toHaveLength(24)
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
