// Frontend mirror of agent/lib/timeframes.js — parse rules must stay
// IDENTICAL to the agent twin (what the UI accepts, the agent can serve).
import { describe, it, expect } from 'vitest'
import { parseTimeframe, tfMs } from './timeframes.js'

describe('parseTimeframe (mirror of agent twin)', () => {
  it('passes native labels through', () => {
    expect(parseTimeframe('4h')).toEqual({ label: '4h', ms: 14_400_000 })
  })
  it('normalises spellings: 15min→15m, 1M→1mo', () => {
    expect(parseTimeframe('15min')).toEqual({ label: '15m', ms: 900_000 })
    expect(parseTimeframe('1M')).toEqual({ label: '1mo', ms: 2_592_000_000 })
  })
  it('allows decimals from hours up, rejects decimal minutes', () => {
    expect(parseTimeframe('1.5h')).toEqual({ label: '1.5h', ms: 5_400_000 })
    expect(parseTimeframe('0.25d')?.ms).toBe(21_600_000)
    expect(parseTimeframe('1.5m')).toBeNull()
  })
  it('canonicalises exact native durations (24h→1d)', () => {
    expect(parseTimeframe('24h')?.label).toBe('1d')
  })
  it('rejects junk and non-whole-minute values', () => {
    expect(parseTimeframe('banana')).toBeNull()
    expect(parseTimeframe('0.001h')).toBeNull()
  })
})

describe('tfMs', () => {
  it('reads native, custom, and junk', () => {
    expect(tfMs('1d')).toBe(86_400_000)
    expect(tfMs('90m')).toBe(5_400_000)
    expect(tfMs('nope')).toBe(0)
  })
})
