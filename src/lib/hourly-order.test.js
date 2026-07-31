import { describe, it, expect } from 'vitest'
import { rollingHourWindows, rollingWindow, displayOrder, nextTickBoundary, totalFloating } from './hourly-order.js'
import { hourLabel, dateFlags, localDayKey } from './hour-label.js'

const H = 60 * 60 * 1000
/** 31 Jul 2026 05:45 SGT === 30 Jul 2026 21:45 UTC — the owner's worked example. */
const EXAMPLE = Date.parse('2026-07-30T21:45:00Z')

/** What Performance.jsx does: build oldest-first, carry, then reverse. */
function build(nowMs, count = 24) {
  return displayOrder(rollingHourWindows(nowMs, count))
}

describe('rollingHourWindows', () => {
  it('emits exactly 24 windows, oldest first, an hour apart', () => {
    const w = rollingHourWindows(EXAMPLE)
    expect(w).toHaveLength(24)
    for (let i = 1; i < w.length; i++) expect(w[i].at - w[i - 1].at).toBe(H)
    expect(w[w.length - 1].at).toBe(EXAMPLE)
  })

  it('labels a row with the END of its own hour', () => {
    // The 5:45 row is the hour that FINISHED at 5:45 — that is what makes the
    // live minute meaningful rather than decorative.
    const newest = rollingHourWindows(EXAMPLE).at(-1)
    expect(newest.at).toBe(newest.to)
    expect(newest.to - newest.from).toBe(H)
  })

  it('row 24 is exactly 23 hours earlier than row 1', () => {
    const rows = build(EXAMPLE)
    expect(rows[0].at - rows[23].at).toBe(23 * H)
  })

  it('derives every row from the captured now, not by accumulation', () => {
    // A minute that is not on the hour must survive all 24 rows intact.
    const rows = build(Date.parse('2026-07-30T21:45:37.412Z'))
    const minutes = new Set(rows.map(r => new Date(r.at).getUTCMinutes()))
    const seconds = new Set(rows.map(r => new Date(r.at).getUTCSeconds()))
    expect([...minutes]).toEqual([45])
    expect([...seconds]).toEqual([37])
  })

  it('refuses nonsense rather than emitting a half table', () => {
    expect(rollingHourWindows(NaN)).toEqual([])
    expect(rollingHourWindows(EXAMPLE, 0)).toEqual([])
    expect(rollingHourWindows(EXAMPLE, 1.5)).toEqual([])
  })
})

describe('displayOrder', () => {
  it('puts the newest row first and marks only it live', () => {
    const rows = build(EXAMPLE)
    expect(rows[0].at).toBe(EXAMPLE)
    expect(rows.at(-1).at).toBe(EXAMPLE - 23 * H)
    expect(rows.filter(r => r.isLive)).toHaveLength(1)
    expect(rows[0].isLive).toBe(true)
  })

  it('is strictly descending — no future rows exist in a rolling window', () => {
    const rows = build(EXAMPLE)
    for (let i = 1; i < rows.length; i++) expect(rows[i].at).toBeLessThan(rows[i - 1].at)
    expect(rows.every(r => r.to <= EXAMPLE)).toBe(true)
  })

  it('does not mutate the carried rows it is given', () => {
    const src = rollingHourWindows(EXAMPLE).map(r => ({ ...r, openBal: 100 }))
    const before = JSON.stringify(src)
    displayOrder(src)
    expect(JSON.stringify(src)).toBe(before)
  })

  it('survives empty input', () => {
    expect(displayOrder([])).toEqual([])
    expect(displayOrder(null)).toEqual([])
  })
})

describe('the owner worked example — 5:45 AM SGT / 21:45 UTC', () => {
  const rows = build(EXAMPLE)

  it('reads 5:45 AM then 4:45 AM then 3:45 AM', () => {
    expect(rows.slice(0, 3).map(r => hourLabel(r.at).local)).toEqual(['5:45 AM', '4:45 AM', '3:45 AM'])
  })

  it('pairs each SGT time with its UTC line', () => {
    expect(hourLabel(rows[0].at).utc).toBe('21:45 UTC')
    expect(hourLabel(rows[1].at).utc).toBe('20:45 UTC')
    expect(hourLabel(rows[5].at).utc).toBe('16:45 UTC')
  })

  it('crosses local midnight at row 7 — 12:45 AM then 11:45 PM', () => {
    expect(hourLabel(rows[5].at).local).toBe('12:45 AM')
    expect(hourLabel(rows[6].at).local).toBe('11:45 PM')
  })

  it('ends on 6:45 AM of the previous local day', () => {
    expect(hourLabel(rows[23].at).local).toBe('6:45 AM')
    expect(hourLabel(rows[23].at).utc).toBe('22:45 UTC')
    expect(hourLabel(rows[23].at).date).toBe('30 Jul')
  })
})

describe('the bracketed date', () => {
  it('appears on the first row of the earlier day and on the oldest row only', () => {
    const rows = build(EXAMPLE)
    const flags = dateFlags(rows)
    expect(flags[0]).toBe(false)                    // the NOW row never carries it
    expect(flags.indexOf(true)).toBe(6)             // 11:45 PM — first row of 30 Jul
    expect(flags[23]).toBe(true)                    // the oldest row, always
    expect(flags.filter(Boolean)).toHaveLength(2)   // and nowhere else
  })

  it('always marks the oldest row, whatever the anchor', () => {
    // A 24-hour window necessarily spans two local dates, so the interesting
    // guarantee is the unconditional one: the window boundary is never
    // ambiguous, even when the day change already flagged a row above it.
    for (const iso of ['2026-07-30T04:00:00Z', '2026-07-30T16:00:00Z', '2026-07-30T23:59:00Z']) {
      expect(dateFlags(build(Date.parse(iso))).at(-1)).toBe(true)
    }
  })

  it('handles UTC sitting on a different calendar date from SGT', () => {
    // 00:30 SGT on 1 Aug is 16:30 UTC on 31 Jul — the two zones disagree about
    // both the day AND the month.
    const t = Date.parse('2026-07-31T16:30:00Z')
    expect(localDayKey(t)).toBe('2026-08-01')
    expect(hourLabel(t).local).toBe('12:30 AM')
    expect(hourLabel(t).utc).toBe('16:30 UTC')
    expect(hourLabel(t).date).toBe('1 Aug')
  })
})

describe('rollovers', () => {
  it('month end — 1 Aug 00:20 SGT reaches back into 31 Jul', () => {
    const rows = build(Date.parse('2026-07-31T16:20:00Z'))   // 1 Aug 00:20 SGT
    expect(hourLabel(rows[0].at).date).toBe('1 Aug')
    expect(hourLabel(rows[1].at).date).toBe('31 Jul')
    expect(hourLabel(rows[23].at).date).toBe('31 Jul')
    expect(hourLabel(rows[23].at).local).toBe('1:20 AM')
  })

  it('year end — 1 Jan 00:20 SGT reaches back into 31 Dec of the prior year', () => {
    const rows = build(Date.parse('2026-12-31T16:20:00Z'))   // 1 Jan 2027 00:20 SGT
    expect(localDayKey(rows[0].at)).toBe('2027-01-01')
    expect(localDayKey(rows[1].at)).toBe('2026-12-31')
    expect(localDayKey(rows[23].at)).toBe('2026-12-31')
    expect(hourLabel(rows[1].at).date).toBe('31 Dec')
  })

  it('leap day — 1 Mar 2028 00:20 SGT reaches back into 29 Feb', () => {
    const rows = build(Date.parse('2028-02-29T16:20:00Z'))   // 1 Mar 2028 00:20 SGT
    expect(localDayKey(rows[0].at)).toBe('2028-03-01')
    expect(localDayKey(rows[1].at)).toBe('2028-02-29')
    expect(hourLabel(rows[1].at).date).toBe('29 Feb')
  })

  it('midnight — the 12 AM / 11 PM boundary reads in 12-hour form, not 0:xx', () => {
    const t = Date.parse('2026-07-30T16:05:00Z')             // 31 Jul 00:05 SGT
    expect(hourLabel(t).local).toBe('12:05 AM')
    expect(hourLabel(t - H).local).toBe('11:05 PM')
    expect(hourLabel(t + 12 * H).local).toBe('12:05 PM')     // noon, not 0:05
  })

  it('the label is timezone-aware, not a fixed +8 offset', () => {
    // Same instant, two zones: proof the formatter is doing the conversion.
    // This is also the DST guarantee — a zone that shifts is handled by Intl,
    // not by arithmetic this file would have to get right itself.
    expect(hourLabel(EXAMPLE, 'UTC').local).toBe('9:45 PM')
    expect(hourLabel(EXAMPLE, 'Asia/Singapore').local).toBe('5:45 AM')
    // America/New_York on this date is EDT (UTC−4), not EST (−5).
    expect(hourLabel(EXAMPLE, 'America/New_York').local).toBe('5:45 PM')
    expect(hourLabel(Date.parse('2026-01-15T21:45:00Z'), 'America/New_York').local).toBe('4:45 PM')
  })
})

describe('pagination across all 24 rows', () => {
  // PagedRows slices with pageSize 8 — 3 pages. The property that matters is
  // that slicing cannot reorder or drop a row, and that the date flag rides ON
  // the row so page 2 cannot be shown page 1's flags.
  const rows = build(EXAMPLE)
  const flags = dateFlags(rows)
  const stamped = rows.map((r, i) => ({ ...r, showDate: flags[i] }))
  const pages = [stamped.slice(0, 8), stamped.slice(8, 16), stamped.slice(16, 24)]

  it('is exactly 3 pages of 8', () => {
    expect(pages.map(p => p.length)).toEqual([8, 8, 8])
  })

  it('concatenating the pages restores the exact display order', () => {
    expect(pages.flat().map(r => r.at)).toEqual(rows.map(r => r.at))
  })

  it('keeps NOW on page 1 row 1 and the oldest row on page 3', () => {
    expect(pages[0][0].isLive).toBe(true)
    expect(pages.flat().filter(r => r.isLive)).toHaveLength(1)
    expect(pages[2].at(-1).at).toBe(EXAMPLE - 23 * H)
  })

  it('carries each row its own date flag onto whatever page it lands on', () => {
    expect(pages[0][6].showDate).toBe(true)      // 11:45 PM (30 Jul), page 1
    expect(pages[0][0].showDate).toBe(false)
    expect(pages[2].at(-1).showDate).toBe(true)  // the oldest row, page 3
  })
})

describe("the owner's reconciliation ruling — one window for the whole card", () => {
  // "The hourly rows and Closed Trades section must cover precisely the same
  // period. Their closed-trade counts and totals must reconcile."
  const rows = build(EXAMPLE)
  const win = rollingWindow(EXAMPLE)

  it('the card window is exactly the union of the 24 hourly windows', () => {
    expect(win.from).toBe(EXAMPLE - 24 * H)
    expect(win.to).toBe(EXAMPLE)
    expect(win.from).toBe(Math.min(...rows.map(r => r.from)))
    expect(win.to).toBe(Math.max(...rows.map(r => r.to)))
  })

  it('the 24 intervals are contiguous — no gaps, no overlaps', () => {
    const oldestFirst = [...rows].reverse()
    for (let i = 1; i < oldestFirst.length; i++) {
      expect(oldestFirst[i].from).toBe(oldestFirst[i - 1].to)
    }
  })

  it('every trade in the card window lands in exactly one hourly row', () => {
    // Boundary-heavy sample: on the edges, one millisecond either side, the
    // first and last instants of the period, and one outside each end.
    const stamps = [
      win.from, win.from + 1, win.from - 1,
      EXAMPLE - 12 * H, EXAMPLE - 12 * H - 1,
      win.to - 1, win.to, win.to + 1,
    ]
    for (const t of stamps) {
      const hits = rows.filter(r => t >= r.from && t < r.to)
      const inCardWindow = t >= win.from && t < win.to
      expect(hits).toHaveLength(inCardWindow ? 1 : 0)
    }
  })

  it('summing the hourly buckets equals the card-window count', () => {
    // A trade every 17 minutes across three days — far more than the window
    // holds, so this also proves nothing outside the period leaks in.
    const trades = []
    for (let t = EXAMPLE - 48 * H; t <= EXAMPLE + 12 * H; t += 17 * 60_000) trades.push(t)

    const perRow = rows.map(r => trades.filter(t => t >= r.from && t < r.to).length)
    const inWindow = trades.filter(t => t >= win.from && t < win.to).length

    expect(perRow.reduce((a, b) => a + b, 0)).toBe(inWindow)
    expect(inWindow).toBeGreaterThan(0)
    // And nothing was double-counted: each row's slice is disjoint.
    expect(new Set(rows.flatMap(r => trades.filter(t => t >= r.from && t < r.to))).size).toBe(inWindow)
  })

  it('the acceptance-test period is 30 Jul 05:45 SGT inclusive to 31 Jul 05:45 SGT exclusive', () => {
    expect(hourLabel(win.from).local).toBe('5:45 AM')
    expect(localDayKey(win.from)).toBe('2026-07-30')
    expect(hourLabel(win.to).local).toBe('5:45 AM')
    expect(localDayKey(win.to)).toBe('2026-07-31')
    // The oldest ROW is labelled 6:45 AM — its window STARTS at 5:45, and the
    // label is the end. That is the distinction the owner spelled out.
    expect(hourLabel(rows[23].at).local).toBe('6:45 AM')
    expect(rows[23].from).toBe(win.from)
  })

  it('degenerates safely rather than inventing a period', () => {
    expect(rollingWindow(EXAMPLE, 0)).toEqual({ from: EXAMPLE, to: EXAMPLE })
  })
})

describe('nextTickBoundary', () => {
  it('lands on the next aligned ten-minute mark, strictly ahead', () => {
    const t = Date.parse('2026-07-30T14:23:12Z')
    expect(nextTickBoundary(t)).toBe(Date.parse('2026-07-30T14:30:00Z'))
    expect(nextTickBoundary(t)).toBeGreaterThan(t)
  })

  it('moves forward a whole step when already exactly on one', () => {
    const t = Date.parse('2026-07-30T14:30:00Z')
    expect(nextTickBoundary(t)).toBe(Date.parse('2026-07-30T14:40:00Z'))
  })

  it('crosses the hour, the day and the year', () => {
    expect(nextTickBoundary(Date.parse('2026-07-30T14:52:00Z')))
      .toBe(Date.parse('2026-07-30T15:00:00Z'))
    expect(nextTickBoundary(Date.parse('2026-07-30T23:55:00Z')))
      .toBe(Date.parse('2026-07-31T00:00:00Z'))
    expect(nextTickBoundary(Date.parse('2026-12-31T23:59:59Z')))
      .toBe(Date.parse('2027-01-01T00:00:00Z'))
  })

  it('falls back to ten minutes on a nonsense step rather than looping', () => {
    const t = Date.parse('2026-07-30T14:23:12Z')
    expect(nextTickBoundary(t, 0)).toBe(Date.parse('2026-07-30T14:30:00Z'))
    expect(nextTickBoundary(t, NaN)).toBe(Date.parse('2026-07-30T14:30:00Z'))
  })
})

describe('totalFloating', () => {
  it('sums what it knows and returns null when it knows nothing', () => {
    expect(totalFloating(1.5, -0.5, null)).toBe(1)
    expect(totalFloating(null, undefined)).toBe(null)
    expect(totalFloating(0, null)).toBe(0)
  })
})
