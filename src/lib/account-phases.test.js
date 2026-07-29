import { describe, it, expect } from 'vitest'
import { offSummary, PHASES } from './account-phases.js'

describe('offSummary', () => {
  it('says nothing when every phase is on', () => {
    expect(offSummary({ scan: true, analyze: true, autotrade: true })).toBe(null)
  })

  it('says "All off" when none run', () => {
    expect(offSummary({ scan: false, analyze: false, autotrade: false })).toBe('All off')
  })

  it('names a single off phase', () => {
    expect(offSummary({ scan: false, analyze: true, autotrade: true })).toBe('Scan off')
    expect(offSummary({ scan: true, analyze: true, autotrade: false })).toBe('Autotrade off')
  })

  it('joins two off phases in pipeline order, per the owner\'s example', () => {
    expect(offSummary({ scan: true, analyze: false, autotrade: false }))
      .toBe('Analyze & Autotrade off')
    // Order follows PHASES, not the order the keys happen to be written in.
    expect(offSummary({ autotrade: false, analyze: true, scan: false }))
      .toBe('Scan & Autotrade off')
  })

  it('stays silent until health has answered', () => {
    expect(offSummary(null)).toBe(null)
    expect(offSummary(undefined)).toBe(null)
    // A phase not yet known is NOT reported off — only explicit false counts.
    expect(offSummary({})).toBe(null)
    expect(offSummary({ scan: undefined, analyze: false, autotrade: true })).toBe('Analyze off')
  })

  it('covers exactly the three phases the sidebar draws dots for', () => {
    expect(PHASES.map(p => p.key)).toEqual(['scan', 'analyze', 'autotrade'])
  })
})
