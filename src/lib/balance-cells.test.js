import { describe, it, expect } from 'vitest'
import { balanceLines, floatingText, carryText, dealBalanceReadNote } from './balance-cells.js'
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
  it('an account with no recorded deposit currency is named, and blocks a single total', () => {
    const set = currencyGroups([seen('11', 'USD', 100), { accountId: '44', currency: null, evidence: { status: 'not_stored', reason: 'deposit_currency_not_recorded' } }])
    expect(set.total).toBeNull()
    expect(balanceLines(set).map(l => l.text)).toEqual(['100.00', '1 acct currency not recorded'])
    expect(balanceLines(set)[1].title).toContain('no recorded broker deposit currency')
    expect(balanceLines(set)[1].title).toContain('Not read: account 44.')
    expect(balanceLines(currencyGroups([{ accountId: '44', currency: null, evidence: { status: 'not_stored', reason: 'deposit_currency_not_recorded' } }]))[0].text).toBe('currency not recorded')
  })
  // V3 WEB-3m: the group is the RECORDED currency passed in, never the stamp
  // an observation carries (WEB-7's one pooling rule).
  it('a read stamped in another currency is never summed into that currency, and holds its own open', () => {
    const stray = { accountId: '22', currency: 'USD', storedFrom: AT, evidence: { status: 'observed', value: 200, currency: 'SGD', at: AT, source: 'broker_trader' } }
    const set = currencyGroups([seen('11', 'USD', 100), stray, seen('33', 'SGD', 50)])
    expect(set.groups.map(g => [g.currency, g.value, g.accounts])).toEqual([['SGD', 50, 1], ['USD', null, 2]])
    expect(set.groups[1]).toMatchObject({ reason: 'observation_currency_mismatch', missingAccounts: ['22'], observedAccounts: 1 })
    expect(balanceLines(set).map(l => l.text)).toEqual(['SGD 50.00', 'USD read not in USD (1/2 accounts read)'])
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
    // The incomplete USD is marked on screen, not only in the tooltip (V3
    // WEB-3m, checker N4); no USD figure is made from the one account read.
    expect(partial.text).toBe('(SGD +1.70 float) · USD 1/2 read')
    expect(partial.text).not.toContain('-1.00')
    expect(partial.title).toContain('USD no floating read (1/2 accounts read) Not read: account 22.')
  })
})

describe('ledger carry text', () => {
  const edges = { status: 'complete', maxAgeMs: 900000,
    accounts: [{ accountId: '11', currency: 'USD', historyStartsAt: AT }],
    windows: { '1h': { 11: { in: seen('11', 'USD', 1019).evidence, out: seen('11', 'USD', 1020).evidence } },
      '30d': { 11: { in: gap('11', 'USD').evidence, out: seen('11', 'USD', 1020).evidence } } } }
  const usd = id => (id === '11' ? 'USD' : null)
  it('reads the observed edges, and labels the edge before storage', () => {
    expect(carryText(ledgerCarry(edges, '1h', '11', usd), 'in')).toBe('1019.00')
    expect(carryText(ledgerCarry(edges, '30d', '11', usd), 'in')).toBe('not stored before 22-09 17:26 UTC')
    expect(ledgerCarry(edges, '30d', '11', usd).carryIn).toBeNull()
    expect(carryText(ledgerCarry({ status: 'unavailable', reason: 'balance_history_read_failed' }, '1h', '11', usd), 'out')).toBe('—')
  })
  it('takes the currency from the reader it is given, and with none pools nothing', () => {
    expect(ledgerCarry(edges, '1h', '11', usd).carryCurrency).toBe('USD')
    const bare = ledgerCarry(edges, '1h', '11')
    expect(bare.carryIn).toBeNull()
    expect(carryText(bare, 'in')).toBe('currency not recorded')
  })
})

// V3 WEB-8-m (checker nit 4). A deal-proven edge's time is the close the
// broker reported that balance after — possibly weeks before the edge — not a
// read at the edge, so its tooltip says so. A real read keeps its wording.
describe('carry tooltip: a read is a read, a deal-proven balance is not', () => {
  const D = 24 * 3600_000
  const proven = (accountId, currency, value, at, source) => ({ accountId, currency, storedFrom: AT,
    evidence: { status: 'observed', value, currency, at, source } })
  it('a real read keeps "read <time>" exactly', () => {
    expect(balanceLines(currencyGroups([seen('11', 'USD', 1029)]))[0].title).toBe('USD broker balance · read 22-09 17:26 UTC · broker_trader')
    expect(balanceLines(currencyGroups([seen('11', 'USD', 100), seen('22', 'USD', 200, AT + 60_000)]))[0].title)
      .toBe('USD broker balance (sum of 2 accounts) · oldest read 22-09 17:26 UTC, newest 22-09 17:27 UTC · broker_trader')
  })
  it('broker_deal, broker_cashflow and broker_statement: "reported after the … at <time>, held until the next stored event"', () => {
    const cases = [['broker_deal', 'deal'], ['broker_cashflow', 'cashflow'], ['broker_statement', 'statement deal']]
    for (const [source, noun] of cases) {
      const [line] = balanceLines(currencyGroups([proven('11', 'USD', 900, AT - 10 * D, source)]))
      expect(line.text).toBe('900.00')
      expect(line.title).toBe(`USD broker balance · reported after the ${noun} at 12-09 17:26 UTC, held until the next stored event · ${source}`)
      expect(line.title).not.toContain('read 12-09')
    }
    const two = balanceLines(currencyGroups([proven('11', 'USD', 900, AT - 10 * D, 'broker_deal'), proven('22', 'USD', 100, AT - 3 * D, 'broker_deal')]))[0]
    expect(two.title).toBe('USD broker balance (sum of 2 accounts) · reported after the deals, oldest 12-09 17:26 UTC, newest 19-09 17:26 UTC, each held until the next stored event · broker_deal')
  })
  it('a read and a deal-proven balance in one currency: each worded with its own time', () => {
    const [line] = balanceLines(currencyGroups([proven('11', 'USD', 900, AT - 10 * D, 'broker_deal'), seen('22', 'USD', 200)]))
    expect(line.text).toBe('1100.00')
    expect(line.title).toBe('USD broker balance (sum of 2 accounts) · read 22-09 17:26 UTC · broker_trader · reported after the deal at 12-09 17:26 UTC, held until the next stored event · broker_deal')
  })
})

// V3 WEB-8-m (checker nit 3). When the stored deal balances could not be
// read, an edge the reads leave open shows the reads' own reason; the page
// must also say, in words, that the deals were not read.
describe('a failed read of the stored deal balances is stated, not hidden', () => {
  const unread = { status: 'unavailable', reason: 'deal_balance_read_failed' }
  const failedEdges = { status: 'complete', maxAgeMs: 900000, dealBalances: 'deal_balance_read_failed',
    accounts: [{ accountId: '11', historyStartsAt: AT }],
    windows: { '1h': { 11: { in: seen('11', 'USD', 1019).evidence, out: seen('11', 'USD', 1020).evidence } },
      '30d': { 11: { in: { ...gap('11', 'USD').evidence, dealBalance: unread }, out: seen('11', 'USD', 1020).evidence } } } }
  const usd = id => (id === '11' ? 'USD' : null)
  const win = (edges, key) => ({ key, ...ledgerCarry(edges, key, '11', usd) })
  it('the carry cell\'s title names the account whose deal balances were not read', () => {
    const [line] = balanceLines(win(failedEdges, '30d').carry.in)
    // V3 WEB-8b: the failed read is marked on screen too, not only in the title.
    expect(line.text).toBe('not stored before 22-09 17:26 UTC · deals unread')
    expect(line.title).toContain('Deal balances unread for account 11: the broker balances stored on deals and cashflows could not be read, so this edge was not checked against them.')
    // An edge the reads answered was not a fallback: nothing to say there.
    expect(balanceLines(win(failedEdges, '1h').carry.in)[0].title).not.toContain('Deal balances unread')
  })
  it('the ledger note says it once, in words; a report whose deals were read has none', () => {
    const note = dealBalanceReadNote([win(failedEdges, '1h'), win(failedEdges, '30d')])
    expect(note).toContain('Deal balances unread')
    expect(note).toContain('(account 11)')
    expect(note).toContain('it is not zero and nothing is estimated')
    // The report-level flag alone is enough (no edge fell back to the deals).
    expect(dealBalanceReadNote([win(failedEdges, '1h')])).toContain('could not be read for this report, so no carry edge')
    // Only one account's read failed (the report's deals were read): named.
    const oneFailed = { ...failedEdges, dealBalances: 'read' }
    expect(dealBalanceReadNote([win(oneFailed, '30d')])).toContain('could not be read for account 11, so that account’s carry edges were not checked against them')
    const read = { ...failedEdges, dealBalances: 'read', windows: { '30d': { 11: { in: gap('11', 'USD').evidence, out: seen('11', 'USD', 1020).evidence } } } }
    expect(dealBalanceReadNote([win(read, '30d')])).toBeNull()
    expect(dealBalanceReadNote(null)).toBeNull()
  })
  // V3 WEB-8b (WEB-3m's N4 precedent: gaps are marked on screen). The mark is
  // on the line's own text, so the carry cell, the phone card (carryText) and
  // copy-as-text all carry it. Words, not colour.
  it('the missing line\'s on-screen text says "deals unread"; a gap whose deals were read does not', () => {
    const failedIn = win(failedEdges, '30d')
    expect(carryText(failedIn, 'in')).toBe('not stored before 22-09 17:26 UTC · deals unread')
    // The observed side of the same window has nothing to mark.
    expect(carryText(failedIn, 'out')).toBe('1020.00')
    // The same gap with the deals read: the reads' own label and nothing more.
    const read = { ...failedEdges, dealBalances: 'read', windows: { '30d': { 11: { in: gap('11', 'USD').evidence, out: seen('11', 'USD', 1020).evidence } } } }
    const [plain] = balanceLines(win(read, '30d').carry.in)
    expect(plain.text).toBe('not stored before 22-09 17:26 UTC')
    expect(plain.text).not.toContain('deals unread')
    expect(carryText(win(read, '30d'), 'in')).toBe('not stored before 22-09 17:26 UTC')
    // The note names the on-screen mark, so the reader can find it.
    expect(dealBalanceReadNote([failedIn])).toContain('marked “deals unread”')
  })
  it('all accounts in two currencies: only the currency whose account went unread is marked, with its partial count', () => {
    const edges = { status: 'complete', maxAgeMs: 900000, dealBalances: 'read',
      accounts: [{ accountId: '11', historyStartsAt: AT }, { accountId: '22', historyStartsAt: AT }, { accountId: '33', historyStartsAt: AT }],
      windows: { '30d': {
        11: { in: { ...gap('11', 'USD').evidence, dealBalance: unread }, out: seen('11', 'USD', 1020).evidence },
        22: { in: seen('22', 'USD', 500).evidence, out: seen('22', 'USD', 501).evidence },
        33: { in: gap('33', 'SGD').evidence, out: seen('33', 'SGD', 50).evidence } } } }
    const ccy = id => ({ 11: 'USD', 22: 'USD', 33: 'SGD' })[id]
    const w = { key: '30d', ...ledgerCarry(edges, '30d', 'all', ccy) }
    const lines = balanceLines(w.carry.in)
    expect(lines.map(l => l.text)).toEqual(['SGD not stored before 22-09 17:26 UTC', 'USD not stored before 22-09 17:26 UTC (1/2 accounts read) · deals unread'])
    expect(carryText(w, 'in')).toBe('SGD not stored before 22-09 17:26 UTC · USD not stored before 22-09 17:26 UTC (1/2 accounts read) · deals unread')
    // No partial USD sum appears beside the mark.
    expect(carryText(w, 'in')).not.toContain('500')
  })
})
