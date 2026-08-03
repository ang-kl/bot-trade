// node --test agent/services/fx-coverage.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { fxCoverage, missingLegsFor } from './fx-coverage.js'
import { usdLossPerLot } from '../lib/contracts.js'

// The production shape: the selected account watchlists GBPUSD and USDJPY,
// and the crosses being vetoed come from ANOTHER account's watchlist. AUD,
// CAD and PLN then have no USD major anywhere in the map.
const PROD_LIKE = {
  GBPUSD: 1.27, USDJPY: 150.0,
  AUDPLN: 2.61, AUDCAD: 0.90, EURGBP: 0.85, EURJPY: 162.0,
}

test('a cross resolves when its quote currency has a scanned USD major', () => {
  const out = fxCoverage(PROD_LIKE, ['EURGBP', 'EURJPY'])
  const gbp = out.probes.find(p => p.symbol === 'EURGBP')
  const jpy = out.probes.find(p => p.symbol === 'EURJPY')
  assert.equal(gbp.sizeable, true, 'GBP resolves via GBPUSD')
  assert.equal(jpy.sizeable, true, 'JPY resolves via USDJPY')
})

test('THE BUG: a cross whose quote currency has no USD major anywhere is unsizeable', () => {
  const out = fxCoverage(PROD_LIKE, ['AUDPLN', 'AUDCAD'])
  for (const sym of ['AUDPLN', 'AUDCAD']) {
    const p = out.probes.find(x => x.symbol === sym)
    assert.equal(p.sizeable, false, `${sym} must report unsizeable`)
    assert.equal(p.rate, null)
  }
  // PLN's only map pair is AUDPLN, and AUD itself has no USD major, so the
  // single permitted hop has nothing to land on. Chaining a second derived
  // rate is exactly what usdRate refuses to do.
  assert.ok(out.unresolvable.includes('PLN'))
  assert.ok(out.unresolvable.includes('AUD'))
  assert.ok(out.unresolvable.includes('CAD'))
})

test('the report AGREES with the sizer — same verdict, same input', () => {
  // If these two ever disagreed the report would be worse than nothing.
  for (const sym of ['AUDPLN', 'EURGBP']) {
    const sizeable = Number.isFinite(usdLossPerLot(sym, 0.01, 2.61, PROD_LIKE))
    const reported = fxCoverage(PROD_LIKE, [sym]).probes[0].sizeable
    assert.equal(reported, sizeable, `${sym}: report and sizer must agree`)
  }
})

test('a non-FX symbol needs no conversion and is never a false alarm', () => {
  const out = fxCoverage(PROD_LIKE, ['US30', 'XAUUSD', 'NATGAS'])
  for (const p of out.probes) assert.equal(p.sizeable, true, `${p.symbol} is USD-denominated`)
})

test('adding ONE major fixes a whole family', () => {
  const fixed = { ...PROD_LIKE, AUDUSD: 0.66 }
  const out = fxCoverage(fixed, ['AUDPLN', 'AUDCAD'])
  // AUD→USD is now direct, so PLN and CAD each resolve in one hop through
  // the cross the map already held.
  assert.equal(out.probes.find(p => p.symbol === 'AUDPLN').sizeable, true)
  assert.equal(out.probes.find(p => p.symbol === 'AUDCAD').sizeable, true)
})

test('the fix is NAMED, not left as "PLN does not resolve"', () => {
  const legs = missingLegsFor('PLN', PROD_LIKE)
  assert.deepEqual(legs.direct, ['PLNUSD', 'USDPLN'])
  const hop = legs.hops.find(h => h.via === 'AUDPLN')
  assert.ok(hop, 'the map already holds AUDPLN — say so')
  assert.deepEqual(hop.needs, ['AUDUSD', 'USDAUD'])
})

test('an empty map reports everything unresolvable rather than throwing', () => {
  const out = fxCoverage(null, ['EURGBP'])
  assert.equal(out.symbols, 0)
  assert.equal(out.probes[0].sizeable, false)
})
