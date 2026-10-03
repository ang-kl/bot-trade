// node --test agent/services/mae-chandelier-observe.test.js
//
// What survives of the MAE/Chandelier module after the observer was removed
// (03-10-2026, owner: "remove all three"): Wilder's ATR and the since-entry
// trail spec the profit keeper pushes to the sidecar's TrailEngine.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as mod from './mae-chandelier-observe.js'
import { wilderAtr, sinceEntryTrailSpec, DEFAULT_ATR_PERIOD, DEFAULT_ATR_MULT } from './mae-chandelier-observe.js'

function barsFrom(closes) {
  return closes.map(c => ({ h: c + 1, l: c - 1, c }))
}

test('wilderAtr: null below period + 1 bars or on a bad bar, the smoothed range otherwise', () => {
  assert.equal(wilderAtr(null), null)
  assert.equal(wilderAtr(barsFrom(Array.from({ length: 22 }, () => 100))), null, '22 bars give 21 true ranges: one short')
  const flat = barsFrom(Array.from({ length: 30 }, () => 100))
  assert.ok(Math.abs(wilderAtr(flat) - 2) < 1e-12, 'a constant 2-point range is a 2-point ATR')
  const bad = barsFrom(Array.from({ length: 30 }, () => 100))
  bad[5] = { h: 'x', l: 99, c: 100 }
  assert.equal(wilderAtr(bad), null)
  const climbing = barsFrom(Array.from({ length: 30 }, (_, i) => 100 + 3 * i))
  assert.ok(wilderAtr(climbing) > 2, 'a 3-point close-to-close gap widens the true range past the 2-point bar range')
  assert.equal(wilderAtr(barsFrom(Array.from({ length: 12 }, () => 100)), 10) > 0, true, 'period is a parameter')
})

test('sinceEntryTrailSpec: 3 × ATR behind a peak seeded at the entry; missing digits, ATR or entry drop the row', () => {
  const bars = barsFrom(Array.from({ length: 30 }, () => 100))
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'LONG', entry: 100, bars, digits: undefined }), null)
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'LONG', entry: 100, bars: [], digits: 5 }), null)
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'LONG', entry: 0, bars, digits: 5 }), null)
  const spec = sinceEntryTrailSpec({ positionId: '1', accountId: '2', symbolId: 3, side: 'LONG', entry: 100, bars, digits: 5, currentSl: 90 })
  assert.equal(spec.positionId, 1)
  assert.equal(spec.ctidTraderAccountId, 2)
  assert.equal(spec.dir, 1)
  assert.equal(spec.digits, 5)
  assert.equal(spec.peakPrice, 100)
  assert.equal(spec.entryPrice, 100, 'the sidecar needs the entry to judge profit lock')
  assert.equal(spec.currentSl, 90)
  assert.equal(spec.currentTp, null)
  assert.ok(Math.abs(spec.trailDistance - DEFAULT_ATR_MULT * wilderAtr(bars, DEFAULT_ATR_PERIOD)) < 1e-12)
  assert.equal(spec.source, 'mae_chandelier_since_entry')
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'SELL', entry: 100, bars, digits: 5 }).dir, -1)
  assert.equal(sinceEntryTrailSpec({ positionId: 1, accountId: 2, symbolId: 3, side: 'short', entry: 100, bars, digits: 5 }).dir, -1)
})

test('the observer is gone: the module exports only the ATR and the trail spec', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['DEFAULT_ATR_MULT', 'DEFAULT_ATR_PERIOD', 'sinceEntryTrailSpec', 'wilderAtr'])
  for (const gone of ['observePosition', 'decideAdjust', 'recordObserve', 'recordAmendReceipt', 'maeChandelierView', 'storeBars', 'cachedBars', 'noteMid', 'freshMid', 'OBSERVE_STATE_KEY', 'startMaeChandelierObserve']) {
    assert.equal(gone in mod, false, `${gone} was removed with the observer on 03-10-2026`)
  }
})
