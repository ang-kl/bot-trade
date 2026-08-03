// The regression this file exists for, in the owner's own words plus the stack
// the new error boundary finally captured (03-08-2026,
// /tune?tab=pipeline&arm=fib_confluence):
//
//   TypeError: null is not an object (evaluating 'e.total.n')
//
// The client padded the strategy roster with { cells: {}, total: null } rows
// and then read `s.total.n` unconditionally. Every strategy with no closed
// trades in the window took the whole page down.
//
// These tests pin the CONTRACT the table now relies on: cells is always an
// object, total is either well-formed or null (never partial), timeframes is
// always an array. If any of those regress, the page blanks again.
import { describe, it, expect } from 'vitest'
import { strategyTfGrid } from './strategy-tf-grid.js'

const KEYS = ['fib_618_fade', 'rsi_2', 'breakout']

describe('strategyTfGrid', () => {
  it('pads the roster, and the padded rows carry a NULL total', () => {
    const g = strategyTfGrid(
      { timeframes: ['1h'], strategies: [{ strategy: 'rsi_2', cells: { '1h': { n: 3, net: 12 } }, total: { n: 3, net: 12 } }] },
      KEYS,
    )
    expect(g.rows.map(r => r.strategy).sort()).toEqual(['breakout', 'fib_618_fade', 'rsi_2'])
    const padded = g.rows.filter(r => r.strategy !== 'rsi_2')
    // null, NOT zero: no closed trades is an unknown total, not a measured
    // flat one. The table renders "—".
    expect(padded.every(r => r.total === null)).toBe(true)
    expect(padded.every(r => typeof r.cells === 'object' && r.cells !== null)).toBe(true)
  })

  it('never yields a row whose cells would throw on lookup', () => {
    const g = strategyTfGrid({ timeframes: ['1h'], strategies: [{ strategy: 'x' }, { strategy: 'y', cells: null }] }, [])
    for (const r of g.rows) expect(() => r.cells['1h']).not.toThrow()
  })

  it('treats a PARTIAL total as absent rather than half-rendering it', () => {
    const g = strategyTfGrid({
      strategies: [
        { strategy: 'a', total: { n: 4 } },          // no net
        { strategy: 'b', total: { net: 9 } },        // no n
        { strategy: 'c', total: { n: 2, net: -1 } }, // complete
      ],
    }, [])
    expect(g.rows.find(r => r.strategy === 'a').total).toBeNull()
    expect(g.rows.find(r => r.strategy === 'b').total).toBeNull()
    expect(g.rows.find(r => r.strategy === 'c').total).toEqual({ n: 2, net: -1 })
  })

  it('survives the payloads that actually crash a page: null, error object, missing keys', () => {
    for (const bad of [null, undefined, {}, { error: 'boom' }, { strategies: 'nope', timeframes: 7 }]) {
      const g = strategyTfGrid(bad, KEYS)
      expect(Array.isArray(g.timeframes)).toBe(true)
      expect(Array.isArray(g.rows)).toBe(true)
    }
  })

  it('does NOT pad when the server never sent a strategy list', () => {
    // Twelve rows of "—" under an error would read as twelve measured zeroes.
    // An empty table plus the error line is the honest render.
    expect(strategyTfGrid({ error: 'agent unreachable' }, KEYS).rows).toEqual([])
  })

  it('passes days and total_closed through, null when absent', () => {
    expect(strategyTfGrid({ days: 30, total_closed: 412, strategies: [] }, []).days).toBe(30)
    expect(strategyTfGrid({ days: 30, total_closed: 412, strategies: [] }, []).totalClosed).toBe(412)
    expect(strategyTfGrid({ strategies: [] }, []).days).toBeNull()
    expect(strategyTfGrid({ strategies: [] }, []).totalClosed).toBeNull()
  })
})
