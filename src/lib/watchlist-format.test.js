// The three watchlist cells the owner asked to be changed on 04-08-2026, and
// the one that was empty. Each test names the ask it comes from, because the
// asks are the specification here — there is no other authority for "ten
// characters" or "DD/MM".
import { describe, it, expect } from 'vitest'
import { ddmm, capMarker, backtestCell, quoteCurrency, describeInstrument } from './watchlist-format.js'

describe('ddmm — "last traded date DD/MM in tiny font size"', () => {
  it('formats day/month with a leading zero on both', () => {
    expect(ddmm('2026-08-04T10:30:00.000Z')).toBe('04/08')
    expect(ddmm('2026-11-21T00:00:00.000Z')).toBe('21/11')
  })

  it('reads the SQLite datetime shape the trades table stores', () => {
    // 'YYYY-MM-DD HH:MM:SS' with no zone — a space, not a T, and UTC implied.
    // Parsed as local time this silently slips a day near midnight.
    expect(ddmm('2026-08-04 23:30:00')).toBe('04/08')
  })

  it('is blank rather than wrong for anything it cannot parse', () => {
    expect(ddmm(null)).toBe('')
    expect(ddmm('')).toBe('')
    expect(ddmm('not a date')).toBe('')
  })
})

describe('capMarker — the tiny field-type marker on the CAP field', () => {
  it('says "lot", because that is what the field holds', () => {
    // The ask was "dollar or yen or numeric or integer". Max lots (cap) is a
    // cap in LOTS; a $ in front of it would read as a dollar cap and be wrong
    // on every row. The money lives in the tooltip, where it is true.
    expect(capMarker('EURUSD').mark).toBe('lot')
    expect(capMarker('XAUUSD').mark).toBe('lot')
  })

  it('names the instrument\'s own quote currency in the tooltip', () => {
    expect(capMarker('EURJPY').title).toContain('JPY')
    expect(capMarker('0066.HK').title).toContain('HKD')
    expect(capMarker('GER40').title).toContain('EUR')
  })

  it('never claims the field is money', () => {
    for (const s of ['EURUSD', 'AMD.US', 'BTCUSD', 'JPN225']) {
      expect(capMarker(s).title).toContain('not money')
    }
  })
})

describe('quoteCurrency', () => {
  it('takes an FX pair\'s quote leg', () => {
    expect(quoteCurrency('EURJPY')).toBe('JPY')
    expect(quoteCurrency('GBPUSD')).toBe('USD')
  })

  it('maps an exchange suffix or an index to its home currency', () => {
    expect(quoteCurrency('0066.HK')).toBe('HKD')
    expect(quoteCurrency('BARC.UK')).toBe('GBP')
    expect(quoteCurrency('BHP.AU')).toBe('AUD')
    expect(quoteCurrency('JPN225')).toBe('JPY')
    expect(quoteCurrency('UK100')).toBe('GBP')
  })

  it('defaults to USD, which is what this broker quotes when nothing says otherwise', () => {
    expect(quoteCurrency('AMD.US')).toBe('USD')
    expect(quoteCurrency('GEV')).toBe('USD')
  })
})

describe('backtestCell — "Backtest trade column isn\'t filled. Please check or else remove"', () => {
  it('CHECKED: the durable record fills the cell a fresh page load left empty', () => {
    // This is the whole defect. The cell read the page's in-memory `bt` state,
    // which only exists after a backtest is run in THAT tab, so it was blank
    // on every fresh load — while backtest_runs held the answer the entire
    // time. Removing the column would have thrown away real data.
    const cell = backtestCell(null, { trades: 42, runs: 3, lastRanAt: '2026-08-01T09:00:00Z' })
    expect(cell.text).toBe('42')
    expect(cell.stale).toBe(true)
    expect(cell.title).toContain('3 stored backtest run')
    expect(cell.title).toContain('01/08')
  })

  it('a run in THIS session wins over the record, and is not marked stale', () => {
    const cell = backtestCell(7, { trades: 42, runs: 3 })
    expect(cell.text).toBe('7')
    expect(cell.stale).toBe(false)
  })

  it('a symbol never backtested says so, and does not read as zero trades', () => {
    // '0' would mean "we tested it and it never triggered" — a different and
    // much more damning fact than "nobody has tested it".
    const cell = backtestCell(null, null)
    expect(cell.text).toBe('—')
    expect(cell.title).toContain('never been backtested')
  })

  it('zero from a real run is shown as zero, not as never-tested', () => {
    expect(backtestCell(0, null).text).toBe('0')
    expect(backtestCell(null, { trades: 0, runs: 2 }).text).toBe('0')
  })
})

describe('describeInstrument, through the UI barrel', () => {
  it('resolves the names the owner listed', () => {
    expect(describeInstrument('XAUUSD')).toBe('Gold')
    expect(describeInstrument('AMD.US')).toBe('AMD')
    expect(describeInstrument('GEV', { GEV: 'GE Vernova' })).toBe('GE Vernova')
  })

  it('survives the map being null — the route may have no cache yet', () => {
    expect(describeInstrument('JPN225', null)).toBe('Nikkei 225')
  })
})
