import { describe, it, expect } from 'vitest'
import { VERDICT_ORDER, rankVerdict, visibleRows, tallyVerdicts } from './backtest-rows.js'

// The page's own classifier, reduced to what these helpers need.
const stateOf = (r) => r.state

const rows = [
  ['15m', { state: 'nogo' }],
  ['1h', { state: 'go' }],
  ['4h', { state: 'thin' }],
  ['1d', { error: 'no bars' }],
]

describe('rankVerdict', () => {
  it('orders go above thin above nogo', () => {
    expect(rankVerdict('go')).toBeGreaterThan(rankVerdict('thin'))
    expect(rankVerdict('thin')).toBeGreaterThan(rankVerdict('nogo'))
  })

  it('returns null for anything it does not recognise, rather than guessing', () => {
    // A guessed rank would order a row it does not understand as if it did.
    for (const v of [null, undefined, '', 'GO', 'maybe', 42, {}]) {
      expect(rankVerdict(v)).toBeNull()
    }
  })

  it('is not fooled by inherited Object properties', () => {
    expect(rankVerdict('constructor')).toBeNull()
    expect(rankVerdict('toString')).toBeNull()
  })

  it('exposes the order so a caller cannot drift from it', () => {
    expect(VERDICT_ORDER).toEqual({ go: 3, thin: 2, nogo: 1 })
  })
})

describe('visibleRows', () => {
  it('keeps only the allowed verdicts', () => {
    const out = visibleRows(rows, { allowed: new Set(['go']), stateOf })
    // The errored row rides along — see below.
    expect(out.map(([tf]) => tf)).toEqual(['1h', '1d'])
  })

  it('ALWAYS shows an errored row: a hidden failure reads as a pass', () => {
    for (const allowed of [['go'], ['thin'], ['nogo'], ['go', 'thin', 'nogo']]) {
      expect(visibleRows(rows, { allowed, stateOf }).some(([tf]) => tf === '1d')).toBe(true)
    }
  })

  it('treats an empty allow-list as show-everything, never show-nothing', () => {
    // An emptied table would read as "the backtest found no timeframes", which
    // is a different and much worse statement than "you filtered them out".
    expect(visibleRows(rows, { allowed: new Set(), stateOf })).toHaveLength(rows.length)
    expect(visibleRows(rows, { stateOf })).toHaveLength(rows.length)
  })

  it('accepts an array as well as a Set', () => {
    expect(visibleRows(rows, { allowed: ['thin'], stateOf }).map(([tf]) => tf)).toEqual(['4h', '1d'])
  })

  it('does not mutate the input', () => {
    const before = [...rows]
    visibleRows(rows, { allowed: ['go'], stateOf })
    expect(rows).toEqual(before)
  })

  it('survives no rows at all', () => {
    expect(visibleRows(undefined, { allowed: ['go'], stateOf })).toEqual([])
    expect(visibleRows([], { allowed: ['go'], stateOf })).toEqual([])
  })
})

describe('tallyVerdicts', () => {
  it('counts every row, including the ones a filter would hide', () => {
    expect(tallyVerdicts(rows, stateOf)).toEqual({ go: 1, thin: 1, nogo: 1, errored: 1 })
  })

  it('ignores a state it does not know instead of inventing a bucket', () => {
    expect(tallyVerdicts([['1h', { state: 'huh' }]], stateOf))
      .toEqual({ go: 0, thin: 0, nogo: 0, errored: 0 })
  })

  it('survives no rows at all', () => {
    expect(tallyVerdicts(null, stateOf)).toEqual({ go: 0, thin: 0, nogo: 0, errored: 0 })
  })
})
