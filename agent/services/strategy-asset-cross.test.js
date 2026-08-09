// node --test agent/services/strategy-asset-cross.test.js
//
// The test that matters is the one where the two MARGINS disagree with the
// CELL. That is not a contrived case — it is exactly what this account's week
// looked like, and it is why acting on either margin alone would have been
// wrong.

import test from 'node:test'
import assert from 'node:assert/strict'
import { strategyAssetCross, assetClassOf } from './strategy-asset-cross.js'

const t = (symbol, strategy, net_pnl) => ({ symbol, label_strategy: strategy, net_pnl })

test('asset classes are read off the symbol, including the ones on this watchlist', () => {
  assert.equal(assetClassOf('EURJPY'), 'fx')
  assert.equal(assetClassOf('NZDCAD'), 'fx')
  assert.equal(assetClassOf('JPN225'), 'index')
  assert.equal(assetClassOf('GER40'), 'index')
  assert.equal(assetClassOf('LHX.US'), 'stock')
  assert.equal(assetClassOf('XAUUSD'), 'metal')
  assert.equal(assetClassOf('COPPER'), 'metal')
  assert.equal(assetClassOf('NATGAS'), 'energy')
  assert.equal(assetClassOf('WHEAT'), 'soft')
  assert.equal(assetClassOf('BTCUSD'), 'crypto')
  assert.equal(assetClassOf(''), 'unknown')
  assert.equal(assetClassOf(null), 'unknown')
})

test('THE POINT: a bad strategy AT one asset, not a bad asset', () => {
  // fib_confluence loses badly on stocks. Everything else on stocks is fine,
  // and fib_confluence on fx is fine. Read either margin alone and you switch
  // off the wrong thing.
  const rows = [
    t('LHX.US', 'fib_confluence', -400), t('GD.US', 'fib_confluence', -400),
    t('LHX.US', 'fib_confluence', -400), t('GD.US', 'fib_confluence', -400),
    t('LHX.US', 'vwap_trend', 300), t('GD.US', 'vwap_trend', 300),
    t('EURJPY', 'fib_confluence', 200), t('NZDCAD', 'fib_confluence', 200),
  ]
  const x = strategyAssetCross(rows)

  assert.equal(x.worst.asset, 'stock')
  assert.equal(x.worst.strategy, 'fib_confluence')
  assert.equal(x.worst.net, -1600)
  assert.equal(x.worst.winRatePct, 0)

  // The margins each point somewhere the cell does not.
  const stock = x.byAsset.find(a => a.asset === 'stock')
  const fib = x.byStrategy.find(s => s.strategy === 'fib_confluence')
  assert.equal(stock.net, -1000, 'the asset margin blames stocks…')
  assert.equal(fib.net, -1200, '…the strategy margin blames fib_confluence…')
  // …and only the cross shows fib_confluence is PROFITABLE on fx, so killing
  // the strategy outright would discard +400.
  const fibFx = x.cells.find(c => c.asset === 'fx' && c.strategy === 'fib_confluence')
  assert.equal(fibFx.net, 400)
})

test('an unresolved P&L is counted as missing, never as a zero', () => {
  // A row whose net_pnl never resolved is not a free trade. Counting it as 0
  // is the defect that made the daily-loss total under-count.
  const rows = [t('EURJPY', 'vwap_trend', 100), t('EURJPY', 'vwap_trend', null), { symbol: 'EURJPY', net_pnl: undefined }]
  const x = strategyAssetCross(rows)
  assert.equal(x.totals.trades, 1)
  assert.equal(x.unresolved, 2)
  assert.equal(x.totals.net, 100)
})

test('no losses is a null profit factor, not an infinite edge', () => {
  const x = strategyAssetCross([t('GER40', 'vwap_trend', 50), t('GER40', 'vwap_trend', 70)])
  assert.equal(x.totals.profitFactor, null)
  assert.equal(x.totals.winRatePct, 100)
})

test("'other' is a real bucket — two thirds of this account sits in it", () => {
  const x = strategyAssetCross([{ symbol: 'EURJPY', net_pnl: -10 }])
  assert.equal(x.byStrategy[0].strategy, 'other')
  assert.equal(x.byStrategy[0].trades, 1)
})

test('an empty record answers empty rather than throwing', () => {
  const x = strategyAssetCross([])
  assert.deepEqual(x.cells, [])
  assert.equal(x.worst, null)
  assert.equal(x.totals.trades, 0)
  assert.equal(x.totals.profitFactor, null)
})
