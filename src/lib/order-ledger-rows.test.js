import { describe, it, expect } from 'vitest'
import { orderStrategy, orderTimeframe, orderStatusLabel, orderTriggerPrice, isoWeek } from './order-ledger-rows.js'

describe('orderStrategy', () => {
  it('extracts the strategy code from a structured bot label', () => {
    expect(orderStrategy('AP|v1|VP|HI|LDN|4h|REGT')).toBe('VP')
    expect(orderStrategy('AP|v1|FIB|-|-|-|-')).toBe('FIB')
  })
  it('returns null for a placeholder, manual, or empty label', () => {
    expect(orderStrategy('AP|v1|-|-|-|-|-')).toBeNull()
    expect(orderStrategy('manual')).toBeNull()
    expect(orderStrategy('')).toBeNull()
    expect(orderStrategy(null)).toBeNull()
  })
  it('normalizes label codes that differ from the open-positions short code (owner: fix the discrepancy)', () => {
    expect(orderStrategy('AP|v1|DON|-|-|-|-')).toBe('BRK')   // donchian_breakout
    expect(orderStrategy('AP|v1|CUP|-|-|-|-')).toBe('C&H')  // cup_handle
    expect(orderStrategy('AP|v1|RSIM|-|-|-|-')).toBe('RSI') // rsi_meanrev
  })
})

describe('orderTimeframe', () => {
  it('extracts the timeframe segment from a structured bot label', () => {
    expect(orderTimeframe('AP|v1|VP|HI|LDN|4h|REGT')).toBe('4h')
    expect(orderTimeframe('AP|v1|FIB|HI|LDN|H1|REGT')).toBe('H1')
  })
  it('returns null for a placeholder, manual, or empty label', () => {
    expect(orderTimeframe('AP|v1|VP|-|-|-|-')).toBeNull()
    expect(orderTimeframe('manual')).toBeNull()
    expect(orderTimeframe('')).toBeNull()
    expect(orderTimeframe(null)).toBeNull()
  })
})

describe('orderStatusLabel', () => {
  it('labels working vs gone honestly', () => {
    expect(orderStatusLabel({ status: 'working' })).toBe('working')
    expect(orderStatusLabel({ status: 'gone' })).toBe('filled / cancelled')
    expect(orderStatusLabel(null)).toBe('—')
  })
})

describe('orderTriggerPrice', () => {
  it('prefers limit, falls back to stop, else null', () => {
    expect(orderTriggerPrice({ limit_price: 1.1, stop_price: 1.2 })).toBe(1.1)
    expect(orderTriggerPrice({ limit_price: null, stop_price: 1.2 })).toBe(1.2)
    expect(orderTriggerPrice({ limit_price: null, stop_price: null })).toBeNull()
    expect(orderTriggerPrice(null)).toBeNull()
  })
})

describe('isoWeek', () => {
  it('computes ISO week numbers', () => {
    expect(isoWeek(new Date(Date.UTC(2026, 6, 21)))).toBe(30)  // Tue 21 Jul 2026
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1)))).toBe(1)
  })
})
