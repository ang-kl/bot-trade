import { describe, it, expect } from 'vitest'
import { dailyBarAge, dailyBarNote, dailyBarsSummary, latencyLine, costLines, quoteFreshnessLine, dailyCapLine } from './data-feed.js'

const OPEN = Date.parse('2026-09-24T21:00:00Z') // current broker day open
const NOW = Date.parse('2026-09-25T12:00:00Z')

describe('dailyBarAge', () => {
  it('names a bar from before the current broker-day open as an earlier day', () => {
    const a = dailyBarAge(Date.parse('2026-09-23T21:00:00Z'), OPEN, NOW)
    expect(a).toEqual({ status: 'earlier', ageHours: 39, days: 1 })
    expect(dailyBarNote(a)).toBe("previous broker day, started 39 h ago — not today's forming bar")
    expect(dailyBarNote(dailyBarAge(Date.parse('2026-09-21T21:00:00Z'), OPEN, NOW))).toMatch(/^3 broker days back/)
  })
  it('names the current day as current', () => {
    const a = dailyBarAge(OPEN, OPEN, NOW)
    expect(a.status).toBe('current')
    expect(dailyBarNote(a)).toBe('current broker day')
  })
  it('does not guess a day when the anchor or the bar time is missing', () => {
    expect(dailyBarAge(OPEN, null, NOW).status).toBe('unverified')
    expect(dailyBarAge(null, OPEN, NOW).status).toBe('unverified')
    expect(dailyBarNote(dailyBarAge(OPEN, null, NOW))).toBe('broker day unverified')
  })
  it('summarises how many retained bars are from an earlier day', () => {
    const rows = [{ day: { t: Date.parse('2026-09-23T21:00:00Z') } }, { day: { t: OPEN } }, { day: null }]
    expect(dailyBarsSummary(rows, OPEN, NOW)).toBe('2 retained daily bars for scoped open positions · 1 from an earlier broker day')
    expect(dailyBarsSummary(null, OPEN, NOW)).toBe('Feed freshness unavailable')
    expect(dailyBarsSummary([], OPEN, NOW)).toBe('No retained daily bars for scoped open positions')
    expect(dailyBarsSummary(rows, null, NOW)).toContain('2 with the day unverified')
  })
})

describe('latencyLine', () => {
  it('prints the measured percentiles with their coverage', () => {
    expect(latencyLine({ measured: 154, of: 300, p50Ms: 312, p90Ms: 1480 }))
      .toBe('entry latency p50 312 ms · p90 1,480 ms · measured on 154 of 300 closes (submit → execution event)')
  })
  it('says not measured instead of printing a dash or a zero', () => {
    expect(latencyLine({ measured: 0, of: 12, p50Ms: null, p90Ms: null })).toBe('entry latency not measured on any of the latest 12 closes')
    expect(latencyLine(null)).toMatch(/unavailable/)
    expect(latencyLine({ measured: 0, of: 0 })).toMatch(/no recorded closes/)
  })
})

describe('costLines', () => {
  it('prints one line per currency and never a cross-currency total', () => {
    const lines = costLines({ window: { closes: 5 }, costs: [
      { currency: 'SGD', closes: 2, commissionKnown: 2, commission: -7, swapKnown: 1, swap: 0.5 },
      { currency: 'USD', closes: 2, commissionKnown: 2, commission: -1234.5, swapKnown: 0, swap: null },
      { currency: null, closes: 1, commissionKnown: 1, commission: -1, swapKnown: 1, swap: -1 },
    ] })
    expect(lines).toEqual([
      'SGD · commission -7.00 (2/2 recorded) · swap 0.50 (1/2 recorded)',
      'USD · commission -1,234.50 (2/2 recorded) · swap not recorded on 2 closes',
      'currency unverified · commission -1.00 (1/1 recorded) · swap -1.00 (1/1 recorded)',
    ])
    expect(lines.join(' ')).not.toMatch(/-1,242/)
  })
  it('says unavailable or empty instead of drawing zeros', () => {
    expect(costLines(null)).toEqual(['fees and swap unavailable — the data-feed report did not load'])
    expect(costLines({ window: { closes: 0 }, costs: [] })).toEqual(['fees and swap: no recorded closes in this scope'])
  })
})

describe('quoteFreshnessLine', () => {
  it('prints the 10-minute quote sources with the record age', () => {
    expect(quoteFreshnessLine({ status: 'measured', ageMs: 4_400, window10m: { passes: 12, fromSidecar: 4, fromBroker: 31, stale: 31 } }))
      .toBe('quotes, last 10 min (12 priced passes): sidecar 4 · broker 31 (stale 31) · record 4 s old')
  })
  it('names the missing record', () => {
    expect(quoteFreshnessLine({ status: 'unavailable', reason: 'no fast-monitor pass record' })).toBe('quote freshness not recorded (no fast-monitor pass record)')
    expect(quoteFreshnessLine({ status: 'no_priced_pass', ageMs: 1000, window10m: null })).toBe('quote freshness: no priced pass in the last 10 min · record 1 s old')
    expect(quoteFreshnessLine(null)).toMatch(/did not load/)
  })
})

describe('dailyCapLine', () => {
  const pct = { status: 'computed', capUsd: 1200.1744, binding: 'pct', pct: 0.04, gateBalanceUsd: 30004.36, remainingUsd: 1200.1744, uncapped: false, blocked: false }
  it('prints the enforced cap and what binds, not the configured base %', () => {
    const { text, note } = dailyCapLine(pct)
    expect(text).toBe('daily loss limit 1,200.17 USD/day enforced — the % of balance binds (4% of 30,004.36) · 1,200.17 left today')
    expect(text).not.toContain('3%')
    expect(note).toBeNull()
  })
  it('names the floor and the flat cap when those bind', () => {
    expect(dailyCapLine({ ...pct, capUsd: 200, binding: 'floor', remainingUsd: 200 }).text).toContain('200.00 USD/day enforced — the USD floor binds')
    expect(dailyCapLine({ ...pct, capUsd: 150, binding: 'usd', remainingUsd: 14.64 }).text).toContain('150.00 USD/day enforced — the flat USD cap binds · 14.64 left today')
  })
  it('says when entries are blocked, and when nothing caps the day', () => {
    expect(dailyCapLine({ ...pct, blocked: true, remainingUsd: 0 }).text).toContain('entries blocked now')
    expect(dailyCapLine({ status: 'computed', uncapped: true, capUsd: null }).text).toMatch(/none in force/)
  })
  it('flags a non-USD deposit currency instead of converting silently', () => {
    expect(dailyCapLine(pct, { depositCurrency: 'SGD' }).note).toBe("This account deposits in SGD; the gate's figure is USD-named and is not converted.")
    expect(dailyCapLine(pct, { depositCurrency: 'USD' }).note).toBeNull()
  })
  it('does not print a number for the all-accounts view or a missing gate figure', () => {
    expect(dailyCapLine(pct, { allAccounts: true }).text).toMatch(/per account/)
    const missing = dailyCapLine(null)
    expect(missing.text).toBe('daily loss limit unavailable')
    expect(dailyCapLine({ status: 'unavailable', reason: 'no account named or selected' }).note).toMatch(/no account named/)
  })
})
