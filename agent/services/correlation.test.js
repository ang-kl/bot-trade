// node --test agent/services/correlation.test.js
//
// Correlation-cluster exposure gate (owner: "did you check pair and
// correlation?"). Catches instruments that move together WITHOUT sharing a
// currency leg — gold vs USDJPY, WTI vs Brent, the US indices.

import test from 'node:test'
import assert from 'node:assert/strict'
import { clusterExposure, correlationVeto, CORRELATION_CLUSTERS } from './correlation.js'

test('clusterExposure: a long USDJPY and a short EURUSD are the SAME long-USD bet', () => {
  // USDJPY beta +1 long → +1; EURUSD beta -1 short → (-1)(-1) = +1. Net +2.
  const ex = clusterExposure(
    [{ symbol: 'USDJPY', side: 'BUY' }, { symbol: 'EURUSD', side: 'SELL' }],
    null,
  )
  assert.equal(ex.usd_strength.net, 2)
})

test('clusterExposure: a hedge nets toward zero', () => {
  // Long EURUSD (-1) and long USDJPY (+1) partly offset in usd_strength.
  const ex = clusterExposure(
    [{ symbol: 'EURUSD', side: 'BUY' }, { symbol: 'USDJPY', side: 'BUY' }],
    null,
  )
  assert.equal(ex.usd_strength.net, 0)
})

test('correlationVeto: a third correlated long past the cap is vetoed', () => {
  // Two US-equity longs (net +2) already at the cap; a NAS100 long → +3.
  const held = [{ symbol: 'US30', side: 'BUY' }, { symbol: 'US500', side: 'BUY' }]
  const v = correlationVeto(held, { symbol: 'NAS100', side: 'BUY' }, 2)
  assert.ok(v)
  assert.equal(v.cluster, 'us_equity')
  assert.equal(v.net, 3)
  assert.deepEqual(v.others.sort(), ['US30 +', 'US500 +'])
})

test('correlationVeto: gold vs USDJPY caught even though they share no currency code', () => {
  // Short XAUUSD (beta -1 → +1) + long USDJPY (+1) + long USDCHF (+1) = +3
  // "long USD" with no shared currency leg the currency gate would see.
  const held = [{ symbol: 'XAUUSD', side: 'SELL' }, { symbol: 'USDJPY', side: 'BUY' }]
  const v = correlationVeto(held, { symbol: 'USDCHF', side: 'BUY' }, 2)
  assert.ok(v)
  assert.equal(v.cluster, 'usd_strength')
})

test('correlationVeto: a HEDGING proposal is never vetoed', () => {
  // Held net +2 long USD; proposing a LONG EURUSD (beta -1 → -1) reduces it.
  const held = [{ symbol: 'USDJPY', side: 'BUY' }, { symbol: 'USDCHF', side: 'BUY' }]
  const v = correlationVeto(held, { symbol: 'EURUSD', side: 'BUY' }, 2)
  assert.equal(v, null)
})

test('correlationVeto: uncorrelated symbol passes; disabled cap passes', () => {
  const held = [{ symbol: 'US30', side: 'BUY' }, { symbol: 'US500', side: 'BUY' }]
  assert.equal(correlationVeto(held, { symbol: 'NATGAS', side: 'BUY' }, 2), null) // NatGas in no cluster
  assert.equal(correlationVeto(held, { symbol: 'NAS100', side: 'BUY' }, 0), null)  // check disabled
})

test('clusters are well-formed: betas are ±1', () => {
  for (const c of CORRELATION_CLUSTERS) {
    for (const beta of Object.values(c.members)) {
      assert.ok(beta === 1 || beta === -1, `${c.key} beta must be ±1, got ${beta}`)
    }
  }
})
