// Classification › Group › Symbol — the shape both watchlist trees are built
// from (Tune › Watchlist and Connect › Compare & Copy). One module rather than
// two, because two trees that disagreed about what "Forex" contains would be
// worse than the one flat list they replaced.
import { describe, it, expect } from 'vitest'
import { buildClassTree, classLabel, groupLabel, symbolsOfBand, UNGROUPED, CLASS_ORDER } from './asset-class.js'

const wl = (...specs) => specs.map(([symbol, group]) => (group ? { symbol, group } : { symbol }))

describe('buildClassTree', () => {
  it('THE BUG: an untagged FX cross lands under Forex, not with the equities', () => {
    // Owner 02-08-2026: "some of the forex are in the single stock". They were
    // in a bucket labelled "Singles" meaning UNGROUPED, next to MSFT.
    const bands = buildClassTree(wl(['EURJPY'], ['AUDPLN'], ['MSFT.US']))
    const by = Object.fromEntries(bands)
    expect([...by.fx.get('FX crosses')].map(i => i.symbol)).toEqual(['EURJPY'])
    expect([...by.fx.get('FX exotics')].map(i => i.symbol)).toEqual(['AUDPLN'])
    expect([...by.stock.get('United States equities')].map(i => i.symbol)).toEqual(['MSFT.US'])
  })

  it('an untagged symbol gets a DERIVED sub-group, never an Ungrouped drawer', () => {
    // Owner 04-08-2026: "properly classify them into groupings, sub-groups."
    // "Ungrouped" was the name of the complaint, so nothing may land in it.
    const bands = buildClassTree(wl(['EURUSD', 'Majors'], ['GBPJPY', 'Minors'], ['AUDPLN'], ['JPN225'], ['BTCUSD']))
    const by = Object.fromEntries(bands)
    // An owner's own tag still wins — it is a set they deliberately chose.
    expect([...by.fx.keys()]).toEqual(['Majors', 'Minors', 'FX exotics'])
    expect([...by.index.keys()]).toEqual(['Japan indices'])
    expect([...by.crypto.keys()]).toEqual(['Crypto 24/7'])
    for (const [cls, byGroup] of bands) {
      expect(cls).not.toBe(UNGROUPED)
      for (const g of byGroup.keys()) expect(g).not.toBe(UNGROUPED)
    }
  })

  it('drops empty classifications — eight headings over four symbols is worse', () => {
    const bands = buildClassTree(wl(['EURUSD'], ['BTCUSD']))
    expect(bands.map(([c]) => c)).toEqual(['fx', 'crypto'])
  })

  it('keeps a stable, useful order regardless of input order', () => {
    const bands = buildClassTree(wl(['MSFT.US'], ['BTCUSD'], ['EURUSD'], ['XAUUSD']))
    const order = bands.map(([c]) => c)
    expect(order).toEqual(['fx', 'crypto', 'metal', 'stock'])
    // …which is the declared display order, filtered.
    expect(order).toEqual(CLASS_ORDER.filter(c => order.includes(c)))
  })

  it('classifies against the ENGINE, so metals do not become currency pairs', () => {
    const by = Object.fromEntries(buildClassTree(wl(['XAUUSD'], ['XAGUSD'], ['USDJPY'])))
    expect([...by.metal.get('Precious metals')].map(i => i.symbol)).toEqual(['XAUUSD', 'XAGUSD'])
    expect([...by.fx.get('FX majors')].map(i => i.symbol)).toEqual(['USDJPY'])
  })

  it('survives junk without throwing', () => {
    expect(buildClassTree([])).toEqual([])
    expect(buildClassTree(null)).toEqual([])
    expect(buildClassTree([{ symbol: '' }, { }, null])).toEqual([])
  })

  it('carries the whole item through, not just the ticker', () => {
    // The copy panel reads maxVolume/enabled off these rows to render settings
    // and to decide what travels on a copy.
    const [[, byGroup]] = buildClassTree([{ symbol: 'EURUSD', group: 'Majors', maxVolume: 0.5, enabled: false }])
    expect(byGroup.get('Majors')[0]).toMatchObject({ symbol: 'EURUSD', maxVolume: 0.5, enabled: false })
  })
})

describe('labels and band helpers', () => {
  it('names classifications for humans and falls back to the key', () => {
    expect(classLabel('fx')).toBe('Forex')
    expect(classLabel('stock')).toBe('Stocks')
    expect(classLabel('something_new')).toBe('something_new')
  })

  it('renders the ungrouped sentinel as a word, never as the sentinel', () => {
    expect(groupLabel(UNGROUPED)).toBe('Ungrouped')
    expect(groupLabel('Majors')).toBe('Majors')
  })

  it('symbolsOfBand flattens every group under a classification, for select-all', () => {
    const by = Object.fromEntries(buildClassTree(wl(['EURUSD', 'Majors'], ['GBPJPY', 'Minors'], ['AUDPLN'])))
    expect(symbolsOfBand(by.fx).sort()).toEqual(['AUDPLN', 'EURUSD', 'GBPJPY'])
  })
})
