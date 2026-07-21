import { describe, it, expect } from 'vitest'
import { describeRiskCriteria } from './risk-criteria.js'

describe('describeRiskCriteria', () => {
  it('surfaces every evaluated criterion, not just the veto reason', () => {
    // A late (exposure) veto still passed daily-loss, streak, positions, R:R, SL.
    const checks = {
      balance: 47000, leverage: 25, daily_pnl: -120, daily_cap_usd: 2350,
      loss_streak: 1, open_positions: 14, rr: 2.1, sl_pct: 0.42,
      exposure: { USD: -3, EUR: 1 },
    }
    const rows = describeRiskCriteria(checks, 'overexposed_USD=-3')
    const keys = rows.map(r => r.key)
    // more than one criterion is shown
    expect(keys).toEqual(expect.arrayContaining(['balance', 'daily', 'streak', 'positions', 'rr', 'slPct', 'exposure']))
    expect(rows.length).toBeGreaterThan(5)
    // the failing criterion is flagged, others are not
    expect(rows.find(r => r.key === 'exposure').failed).toBe(true)
    expect(rows.find(r => r.key === 'rr').failed).toBe(false)
  })

  it('flags the margin criterion on an insufficient_margin veto', () => {
    const checks = { balance: 47000, margin_used_usd: 29000, margin_required_usd: 800, margin_cap_usd: 23500 }
    const rows = describeRiskCriteria(checks, 'insufficient_margin total=29800 (used=29000 + new=800) cap=23500 leverage=25')
    const margin = rows.find(r => r.key === 'margin')
    expect(margin).toBeTruthy()
    expect(margin.failed).toBe(true)
    expect(margin.value).toContain('used')
  })

  it('marks nothing failed for an approved decision', () => {
    const rows = describeRiskCriteria({ balance: 1000, rr: 3 }, null)
    expect(rows.every(r => r.failed === false)).toBe(true)
  })

  it('skips null/absent fields', () => {
    const rows = describeRiskCriteria({ balance: null, rr: 2 }, null)
    expect(rows.find(r => r.key === 'balance')).toBeUndefined()
    expect(rows.find(r => r.key === 'rr')).toBeTruthy()
  })
})
