// The 4 × 7 matrix's placement rules. The load-bearing test is the LAST one:
// that an instrument we cannot place is reported rather than dropped into the
// nearest plausible cell. Everything else is the two axes doing their job.
import { describe, it, expect } from 'vitest'
import {
  MATRIX_COLUMNS, MATRIX_ROWS, COLUMN_KEYS, ROW_KEYS,
  cellFor, buildMatrix, cellKey, tradingViewUrl, sectorFromDescription,
  rowOpenNow, rowMatchesSessionFilter,
} from './instrument-matrix.js'

const at = (h) => new Date(Date.UTC(2026, 7, 5, h))   // a Wednesday

describe('the grid the owner specified', () => {
  it('is four columns by seven rows, in the order given', () => {
    expect(COLUMN_KEYS).toHaveLength(4)
    expect(ROW_KEYS).toHaveLength(7)
    expect(MATRIX_COLUMNS.map(c => c.label)).toEqual([
      'Risk-On / High Beta Growth',
      'Defensive / Cash Flow / Yield',
      'Commodity / Hard Asset Linked',
      'Global Regional Exchanges',
    ])
    expect(MATRIX_ROWS.map(r => r.label)).toEqual([
      '24/5 Continuous Liquidity',
      'Asian Session Blocks',
      'European Session Blocks',
      'US RTH: Tech & Semiconductor Herd',
      'US RTH: Financials, Cyclicals & Value',
      'US RTH: Defensives, Energy & Industrials',
      'Global Thematic & Cross-Asset ETFs',
    ])
  })
})

describe('the row axis is WHEN it trades', () => {
  it('crypto, FX and hard assets are the continuous row', () => {
    for (const s of ['BTCUSD', 'EURUSD', 'XAUUSD', 'NATGAS', 'COFFEE', 'CORN']) {
      expect(cellFor(s).row).toBe('continuous')
    }
  })

  it('a foreign listing sits in its own session block, not a US one', () => {
    expect(cellFor('0066.HK')).toMatchObject({ col: 'regional', row: 'asia' })
    expect(cellFor('JPN225')).toMatchObject({ col: 'regional', row: 'asia' })
    expect(cellFor('GER40')).toMatchObject({ col: 'regional', row: 'europe' })
    expect(cellFor('BARC.UK')).toMatchObject({ col: 'regional', row: 'europe' })
    expect(cellFor('BHP.AU')).toMatchObject({ col: 'regional', row: 'asia' })
  })
})

describe('the column axis is WHAT KIND of exposure', () => {
  it('an FX pair lands on the trade it actually expresses', () => {
    expect(cellFor('AUDUSD').col).toBe('commodity')   // iron ore with a ticker
    expect(cellFor('USDCAD').col).toBe('commodity')   // oil with a ticker
    expect(cellFor('USDJPY').col).toBe('defensive')   // the haven leg
    expect(cellFor('EURGBP').col).toBe('growth')
  })

  it('US equities go by sector', () => {
    expect(cellFor('NVDA')).toMatchObject({ col: 'growth', row: 'us_tech' })
    expect(cellFor('JPM')).toMatchObject({ col: 'defensive', row: 'us_value' })
    expect(cellFor('TSLA')).toMatchObject({ col: 'growth', row: 'us_value' })
    expect(cellFor('XOM')).toMatchObject({ col: 'commodity', row: 'us_defensive' })
    expect(cellFor('KO')).toMatchObject({ col: 'defensive', row: 'us_defensive' })
    // "GEV is GE Vernova" — the owner's own example, curated as an industrial.
    expect(cellFor('GEV')).toMatchObject({ row: 'us_defensive' })
  })

  it('the broker suffix does not stop a US ticker resolving', () => {
    // The catalogue writes AMD.US, the sector table is keyed on AMD.
    expect(cellFor('AMD.US')).toMatchObject({ col: 'growth', row: 'us_tech' })
  })

  it('US index CFDs go by what they track, not by being American', () => {
    expect(cellFor('NAS100')).toMatchObject({ col: 'growth', row: 'us_tech' })
    expect(cellFor('US30')).toMatchObject({ col: 'defensive', row: 'us_defensive' })
    expect(cellFor('VIX').col).toBe('defensive')
  })

  it('ETFs take the seventh row whatever they hold', () => {
    for (const s of ['SPY', 'QQQ', 'GLD', 'XLE', 'ARKK']) {
      expect(cellFor(s).row).toBe('thematic')
    }
  })
})

describe('sectorFromDescription — the tail the curated table cannot reach', () => {
  it('is ordered most specific first', () => {
    // "Semiconductor" must beat "Technology", or every chipmaker whose
    // description mentions both lands in the generic tech bucket.
    expect(sectorFromDescription('Semiconductor Technology Inc')).toBe('semis')
    expect(sectorFromDescription('Regional Bank Holding Corp')).toBe('financial')
    expect(sectorFromDescription('Pharmaceutical and Life Sciences')).toBe('health')
    expect(sectorFromDescription('Oil & Gas Exploration')).toBe('energy')
    expect(sectorFromDescription('Copper Mining Company')).toBe('materials')
  })

  it('says nothing rather than guessing', () => {
    expect(sectorFromDescription('')).toBe(null)
    expect(sectorFromDescription(null)).toBe(null)
    expect(sectorFromDescription('Acme Holdings Limited')).toBe(null)
  })

  it('reaches a symbol the curated table has never heard of', () => {
    expect(cellFor('ZZZZ', { ZZZZ: 'Zeta Semiconductor Corp' }))
      .toMatchObject({ col: 'growth', row: 'us_tech' })
  })
})

describe('buildMatrix', () => {
  it('places every symbol it can and NAMES the ones it cannot', () => {
    // THE LOAD-BEARING TEST. A US listing with no establishable sector must
    // not be swept into the biggest cell to make the counts look complete —
    // a confidently wrong cell in a trading UI is worse than a named gap.
    const { cells, unplaced, total, placed } = buildMatrix(
      ['NVDA', 'EURUSD', 'BTCUSD', '0066.HK', 'WHOKNOWS', 'ALSOMYSTERY'])
    expect(total).toBe(6)
    expect(unplaced).toEqual(['ALSOMYSTERY', 'WHOKNOWS'])
    expect(placed).toBe(4)
    expect(cells.get(cellKey('growth', 'us_tech'))).toEqual(['NVDA'])
    expect(cells.get(cellKey('regional', 'asia'))).toEqual(['0066.HK'])
    // …and the unplaced appear in NO cell.
    const everywhere = [...cells.values()].flat()
    expect(everywhere).not.toContain('WHOKNOWS')
    expect(placed + unplaced.length).toBe(total)
  })

  it('starts with all 28 cells present, so the grid never has holes', () => {
    const { cells } = buildMatrix([])
    expect(cells.size).toBe(28)
    for (const arr of cells.values()) expect(arr).toEqual([])
  })

  it('de-duplicates — a catalogue can list the same name twice', () => {
    const { total, cells } = buildMatrix(['NVDA', 'nvda', 'NVDA'])
    expect(total).toBe(1)
    expect(cells.get(cellKey('growth', 'us_tech'))).toEqual(['NVDA'])
  })

  it('sorts within a cell, so the same input always reads the same way', () => {
    const { cells } = buildMatrix(['MSFT', 'AAPL', 'NVDA'])
    expect(cells.get(cellKey('growth', 'us_tech'))).toEqual(['AAPL', 'MSFT', 'NVDA'])
  })

  it('survives junk', () => {
    expect(buildMatrix(null).total).toBe(0)
    expect(buildMatrix(['', null, undefined]).total).toBe(0)
  })
})

describe('tradingViewUrl', () => {
  it('strips the broker suffix TradingView does not use', () => {
    // A link to AMD.US resolves to nothing on TradingView.
    expect(tradingViewUrl('AMD.US')).toContain('symbol=AMD')
    expect(tradingViewUrl('AMD.US')).not.toContain('.US')
  })

  it('routes FX and crypto to a venue that actually carries them', () => {
    expect(decodeURIComponent(tradingViewUrl('EURUSD'))).toContain('FX:EURUSD')
    expect(decodeURIComponent(tradingViewUrl('XAUUSD'))).toContain('FX:XAUUSD')
    expect(decodeURIComponent(tradingViewUrl('BTCUSD'))).toContain('BINANCE:BTCUSDT')
  })
})

describe('the Active Now / Closed toggle', () => {
  it('asks the gate about a representative symbol rather than keeping its own clock', () => {
    expect(rowOpenNow('asia', at(2))).toBe(true)      // 11:00 Tokyo
    expect(rowOpenNow('asia', at(18))).toBe(false)
    expect(rowOpenNow('europe', at(10))).toBe(true)
    expect(rowOpenNow('us_tech', at(16))).toBe(true)
    expect(rowOpenNow('us_tech', at(2))).toBe(false)
    expect(rowOpenNow('continuous', at(2))).toBe(true)
  })

  it('"All" shows everything; the other two split it exactly', () => {
    const open = ROW_KEYS.filter(k => rowMatchesSessionFilter(k, 'open', (r) => rowOpenNow(r, at(2))))
    const closed = ROW_KEYS.filter(k => rowMatchesSessionFilter(k, 'closed', (r) => rowOpenNow(r, at(2))))
    expect(ROW_KEYS.every(k => rowMatchesSessionFilter(k, 'all'))).toBe(true)
    expect(open.length + closed.length).toBe(ROW_KEYS.length)
    expect(open).toContain('asia')
    expect(closed).toContain('us_tech')
  })

  it('an unknown row reads as open rather than vanishing from every filter', () => {
    expect(rowOpenNow('nonexistent')).toBe(true)
  })
})
