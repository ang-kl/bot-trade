import { describe, it, expect } from 'vitest'
import { orderStrategy, orderStatusLabel, orderTriggerPrice } from './order-ledger-rows.js'

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
