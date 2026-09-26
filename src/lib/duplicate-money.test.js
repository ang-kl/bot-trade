import { describe, it, expect } from 'vitest'
import { duplicateMoneyParts } from './duplicate-money.js'

// V3 B2-m (checker N2): the Desk duplicate card names each money part in its
// own currency or unit, and says WHY an account has no currency — a read that
// failed is "currency not read", never the false "currency not recorded".
describe('duplicate audit money parts', () => {
  const report = {
    extraByCurrency: [{ currency: 'USD', pnl: -10 }, { currency: 'SGD', pnl: null }],
    extraByAccount: [{ accountId: '46130058', currency: 'USD', pnl: -10 }, { accountId: '47790949', currency: null, pnl: 7 }],
    extraUnattributed: [{ positionId: '900', tradeIds: [5], pnl: -8 }, { positionId: null, tradeIds: [9], pnl: -1 }],
  }
  it('gives one part per currency pool, per account without a currency, and per unattributed position', () => {
    expect(duplicateMoneyParts({ ...report, currencyRead: 'read' })).toEqual([
      '−10.00 USD', 'SGD not priced',
      '+7.00 (account 47790949 units, currency not recorded)',
      '−8.00 (position 900, no account, currency unknown)', '−1.00 (row #9, no account, currency unknown)',
    ])
  })
  it('says "currency not read" when the currency read itself failed', () => {
    const parts = duplicateMoneyParts({ ...report, currencyRead: 'unavailable' })
    expect(parts).toContain('+7.00 (account 47790949 units, currency not read)')
    expect(parts.join(' ')).not.toMatch(/not recorded/)
  })
  it('an older server with no currencyRead field keeps the recorded wording, and no report gives no parts', () => {
    expect(duplicateMoneyParts(report)).toContain('+7.00 (account 47790949 units, currency not recorded)')
    expect(duplicateMoneyParts(null)).toEqual([])
  })
})
