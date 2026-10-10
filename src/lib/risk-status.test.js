// vitest — Claude · № 12,812 10-Oct: the status card orders accounts most at
// risk first and flags a daily stop larger than the balance it guards.
import { describe, it, expect } from 'vitest'
import { statusRows, usedBand } from './risk-status.js'

const ds = (cap, pct, balanceUsed) => ({ status: 'in_force', capUsd: cap, currency: 'USD', balanceUsed, unitsComparable: true,
  lossCapUsed: { status: 'measured', pct, consumed: cap * pct / 100 } })

describe('statusRows', () => {
  const overview = [
    { accountId: '1', currency: 'USD', balance: 30000, openPnl: 5, dailyStop: ds(1200, 0, 30000) },
    { accountId: '2', currency: 'USD', balance: 40000, openPnl: -10, dailyStop: ds(1700, 1, 40000) },
    { accountId: '3', currency: 'SGD', balance: 51, openPnl: 0, dailyStop: ds(200, 0, 40.1) },
    { accountId: '4', currency: 'USD', balance: 0, openPnl: 0, dailyStop: ds(200, 0, 0) },
    { accountId: '5', currency: 'USD', balance: 700, openPnl: 1, dailyStop: ds(200, 80, 700) },
  ]
  const registry = [1, 2, 3, 5].map(n => ({ account_id: n, enabled: 1, is_live: n === 3 ? 1 : 0 })).concat([{ account_id: 4, enabled: 0, is_live: 1 }])
  const rows = statusRows(overview, registry)
  it('puts the most-used stop first and dormant accounts last', () => {
    expect(rows.map(r => r.id)).toEqual(['5', '2', '3', '1', '4'])
    expect(rows.at(-1).dormant).toBe(true)
  })
  it('flags a stop larger than the balance it guards, in the same unit only', () => {
    expect(rows.find(r => r.id === '3').stopExceedsBalance).toBe(true)
    expect(rows.find(r => r.id === '1').stopExceedsBalance).toBe(false)
    const notComparable = statusRows([{ accountId: '9', balance: 10, dailyStop: { ...ds(200, 0, 10), unitsComparable: false } }], [])
    expect(notComparable[0].stopExceedsBalance).toBe(false)
  })
  it('reads the badge from the registry and the band from the engine reading', () => {
    expect(rows.find(r => r.id === '3').tag).toBe('LIVE')
    expect(usedBand(80)).toBe('breach'); expect(usedBand(50)).toBe('warn'); expect(usedBand(1)).toBe('ok'); expect(usedBand(null)).toBe('unknown')
  })
})
