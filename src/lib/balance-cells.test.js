import { describe, it, expect } from 'vitest'
import { balanceLines, floatingText, carryText } from './balance-cells.js'
import { currencyGroups, ledgerCarry } from '../../agent/shared/balance-carry.js'

const AT = Date.UTC(2026, 8, 22, 17, 26)
const seen = (accountId, currency, value, at = AT) => ({ accountId, currency, storedFrom: AT, evidence: { status: 'observed', value, currency, at, source: 'broker_trader' } })
const gap = (accountId, currency, reason = 'before_balance_history') => ({ accountId, currency, storedFrom: AT, evidence: { status: 'not_stored', reason } })

describe('observed balances are shown per currency and a missing edge is never a zero', () => {
  it('one account: the amount, with its read time in the title', () => {
    const [line] = balanceLines(currencyGroups([seen('11', 'USD', 1029)]))
    expect(line.text).toBe('1029.00')
    expect(line.title).toContain('22-09 17:26 UTC')
    expect(line.missing).toBe(false)
  })
  it('before storage began: says so with the date, not "0"', () => {
    const [line] = balanceLines(currencyGroups([gap('11', 'USD')]))
    expect(line.text).toBe('not stored before 22-09 17:26 UTC')
    expect(line.missing).toBe(true)
    expect(line.text).not.toMatch(/\b0(\.00)?\b/)
  })
  it('all accounts in two currencies: one line per currency, no cross-currency sum', () => {
    const lines = balanceLines(currencyGroups([seen('11', 'USD', 100), seen('22', 'USD', 200), seen('33', 'SGD', 50)]))
    expect(lines.map(l => l.text)).toEqual(['SGD 50.00', 'USD 300.00'])
    expect(lines.some(l => l.text.includes('350'))).toBe(false)
  })
  it('a currency with one account unread shows how many were read instead of a partial sum', () => {
    const lines = balanceLines(currencyGroups([seen('11', 'USD', 100), gap('22', 'USD', 'no_observation_near_edge'), seen('33', 'SGD', 50)]))
    expect(lines.map(l => l.text)).toEqual(['SGD 50.00', 'USD no broker read near edge (1/2 accounts read)'])
    expect(lines.some(l => l.text.includes('100'))).toBe(false)
    // The tooltip names the account that holds the USD total open (e.g. one
    // disabled later), not only the count.
    expect(lines[1].title).toContain('Not read: account 22.')
    expect(lines[0].title).not.toContain('Not read')
  })
  it('an account with no stored currency is named, and blocks a single total', () => {
    const set = currencyGroups([seen('11', 'USD', 100), { accountId: '44', currency: null, evidence: { status: 'not_stored', reason: 'no_balance_stored' } }])
    expect(set.total).toBeNull()
    expect(balanceLines(set).map(l => l.text)).toEqual(['100.00', '1 acct not stored'])
    expect(balanceLines(set)[1].title).toContain('Not read: account 44.')
  })
  it('a malformed or absent server payload reads as unavailable', () => {
    expect(balanceLines(null)[0]).toMatchObject({ text: '—', missing: true })
    expect(balanceLines({ groups: [{ currency: 'USD', accounts: 1, value: 'NaN' }], unknownCurrencyAccounts: 0 })[0].text).toBe('—')
  })
})

describe('floating per hour', () => {
  it('shows the last reading per currency and nothing when there is none', () => {
    expect(floatingText(currencyGroups([seen('11', 'USD', -2.25)]))).toMatchObject({ text: '(-2.25 float)' })
    expect(floatingText(currencyGroups([seen('11', 'USD', -164.9), seen('33', 'SGD', 1.7)])).text).toBe('(SGD +1.70 · USD -164.90 float)')
    expect(floatingText(currencyGroups([gap('11', 'USD', 'no_floating_reading')]))).toBeNull()
    const partial = floatingText(currencyGroups([seen('33', 'SGD', 1.7), seen('11', 'USD', -1), gap('22', 'USD', 'no_floating_reading')]))
    expect(partial.text).toBe('(SGD +1.70 float)')
    expect(partial.title).toContain('USD no floating read (1/2 accounts read) Not read: account 22.')
  })
})

describe('ledger carry text', () => {
  const edges = { status: 'complete', maxAgeMs: 900000,
    accounts: [{ accountId: '11', currency: 'USD', historyStartsAt: AT }],
    windows: { '1h': { 11: { in: seen('11', 'USD', 1019).evidence, out: seen('11', 'USD', 1020).evidence } },
      '30d': { 11: { in: gap('11', 'USD').evidence, out: seen('11', 'USD', 1020).evidence } } } }
  it('reads the observed edges, and labels the edge before storage', () => {
    expect(carryText(ledgerCarry(edges, '1h', '11'), 'in')).toBe('1019.00')
    expect(carryText(ledgerCarry(edges, '30d', '11'), 'in')).toBe('not stored before 22-09 17:26 UTC')
    expect(ledgerCarry(edges, '30d', '11').carryIn).toBeNull()
    expect(carryText(ledgerCarry({ status: 'unavailable', reason: 'balance_history_read_failed' }, '1h', '11'), 'out')).toBe('—')
  })
})
