import { describe, it, expect } from 'vitest'
import { orderStrategy, orderTimeframe, orderStatusLabel, orderTriggerPrice, orderTpSlDistance, orderPendingMs, fmtDuration, expiresLabel, isoWeek } from './order-ledger-rows.js'

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

describe('orderTpSlDistance', () => {
  it('computes plain distances from the trigger price — no live price needed', () => {
    expect(orderTpSlDistance({ limit_price: 1.10, tp: 1.20, sl: 1.05 })).toEqual({ toTp: expect.closeTo(0.10, 6), toSl: expect.closeTo(0.05, 6) })
  })
  it('falls back to stop_price and returns nulls for unset levels', () => {
    expect(orderTpSlDistance({ stop_price: 100, tp: 110, sl: null })).toEqual({ toTp: 10, toSl: null })
    expect(orderTpSlDistance({ limit_price: null, stop_price: null, tp: 10, sl: 5 })).toEqual({ toTp: null, toSl: null })
    expect(orderTpSlDistance(null)).toEqual({ toTp: null, toSl: null })
  })
})

describe('fmtDuration', () => {
  it('scales m -> h -> d as it grows', () => {
    expect(fmtDuration(30 * 60_000)).toBe('30m')
    expect(fmtDuration(90 * 60_000)).toBe('1h 30m')
    expect(fmtDuration(50 * 60 * 60_000)).toBe('2d 2h')
  })
  it('returns an em dash for invalid input', () => {
    expect(fmtDuration(null)).toBe('—')
    expect(fmtDuration(-5)).toBe('—')
  })
})

describe('expiresLabel', () => {
  const now = Date.parse('2026-07-22T12:00:00Z')
  it('shows a countdown for a future expiry, not "0s"', () => {
    expect(expiresLabel('2026-07-22T13:30:00Z', { nowMs: now })).toBe('in 1h 30m')
    expect(expiresLabel('2026-07-25T12:00:00Z', { nowMs: now })).toBe('in 3d')
  })
  it('shows elapsed time once the expiry has actually passed', () => {
    expect(expiresLabel('2026-07-22T10:00:00Z', { nowMs: now })).toBe('2h ago')
  })
  it('returns null for missing/unparseable input', () => {
    expect(expiresLabel(null)).toBe(null)
    expect(expiresLabel('not-a-date')).toBe(null)
  })
})

describe('orderPendingMs', () => {
  it('measures first_seen -> gone_at when gone', () => {
    const ms = orderPendingMs({ first_seen: '2026-07-20T10:00:00Z', gone_at: '2026-07-20T12:30:00Z' }, { gone: true })
    expect(ms).toBe(2.5 * 60 * 60_000)
  })
  it('falls back to last_seen when gone_at is missing', () => {
    const ms = orderPendingMs({ first_seen: '2026-07-20T10:00:00Z', last_seen: '2026-07-20T11:00:00Z' }, { gone: true })
    expect(ms).toBe(60 * 60_000)
  })
  it('returns null for an unparsable first_seen', () => {
    expect(orderPendingMs({ first_seen: null }, { gone: true })).toBeNull()
  })
})

describe('isoWeek', () => {
  it('computes ISO week numbers', () => {
    expect(isoWeek(new Date(Date.UTC(2026, 6, 21)))).toBe(30)  // Tue 21 Jul 2026
    expect(isoWeek(new Date(Date.UTC(2026, 0, 1)))).toBe(1)
  })
})
