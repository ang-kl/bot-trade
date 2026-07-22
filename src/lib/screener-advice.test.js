import { describe, it, expect } from 'vitest'
import { screenerAdvice } from './screener-advice.js'

describe('screenerAdvice', () => {
  it('is null when never scanned or the scan found no setup (never invented)', () => {
    expect(screenerAdvice({ bias: null, confidence: null, atrPct: null })).toBeNull()
    expect(screenerAdvice({ bias: 'skip', confidence: 5, atrPct: 1 })).toBeNull()
  })

  it('flags high volatility ahead of the bias, regardless of confidence', () => {
    const r = screenerAdvice({ bias: 'long', confidence: 9, atrPct: 4 })
    expect(r.label).toMatch(/high volatility/)
    expect(r.tone).toBe('warning')
  })

  it('reads high confidence + long as Aggressive Buy', () => {
    const r = screenerAdvice({ bias: 'long', confidence: 8, atrPct: 0.5 })
    expect(r.label).toBe('Aggressive Buy')
    expect(r.tone).toBe('up')
  })

  it('reads high confidence + short as Aggressive Sell', () => {
    const r = screenerAdvice({ bias: 'short', confidence: 7, atrPct: 0.5 })
    expect(r.label).toBe('Aggressive Sell')
    expect(r.tone).toBe('down')
  })

  it('reads moderate confidence as plain Buy/Sell', () => {
    expect(screenerAdvice({ bias: 'long', confidence: 4, atrPct: 0.5 }).label).toBe('Buy')
    expect(screenerAdvice({ bias: 'short', confidence: 4, atrPct: 0.5 }).label).toBe('Sell')
  })

  it('still gives a Buy/Sell read when confidence is unknown but bias exists', () => {
    expect(screenerAdvice({ bias: 'long', confidence: null, atrPct: 0.5 }).label).toBe('Buy')
  })
})
