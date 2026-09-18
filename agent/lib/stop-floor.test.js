// node --test agent/lib/stop-floor.test.js
//
// E·1 (owner 18-09-2026): the hourly-ATR stop floor — the pure maths, the
// registered ATR sources, and the wiring pins that keep the gate's
// `stop_override` applied on every order path (a repair nothing calls is
// CLAUDE.md failure mode #4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stopFloor, atrFromBars, registerAtrSource, clearAtrSources, hourlyAtrFor } from './stop-floor.js'

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = (p) => strip(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'))

test('stopFloor: a stop tighter than mult × ATR is widened on its own side of entry', () => {
  // long: stop below entry
  assert.deepEqual(stopFloor({ entry: 1.1, sl: 1.097, atr: 0.006, mult: 1 }), { sl: 1.094, from: 1.097, floor: 0.006 })
  // short: stop above entry
  assert.deepEqual(stopFloor({ entry: 2.9, sl: 2.905, atr: 0.03, mult: 1, digits: 3 }), { sl: 2.93, from: 2.905, floor: 0.03 })
  // multiple honoured
  assert.equal(stopFloor({ entry: 100, sl: 99, atr: 1, mult: 1.5, digits: 2 }).sl, 98.5)
})

test('stopFloor: a stop already at or beyond the floor is untouched (null)', () => {
  assert.equal(stopFloor({ entry: 1.1, sl: 1.094, atr: 0.006, mult: 1 }), null)
  assert.equal(stopFloor({ entry: 1.1, sl: 1.08, atr: 0.006, mult: 1 }), null)
})

test('stopFloor: unjudgeable inputs apply no floor', () => {
  assert.equal(stopFloor({ entry: 1.1, sl: 1.097, atr: null, mult: 1 }), null)
  assert.equal(stopFloor({ entry: 1.1, sl: 1.097, atr: 0.006, mult: 0 }), null)
  assert.equal(stopFloor({ entry: 1.1, sl: 1.1, atr: 0.006, mult: 1 }), null)
  assert.equal(stopFloor({ entry: 'x', sl: 1.097, atr: 0.006, mult: 1 }), null)
})

test('atrFromBars: Wilder ATR over 14 periods; too few bars → null', () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ h: 101 + i, l: 99 + i, c: 100 + i }))
  // every true range = max(2, |h−prevC|=2, |l−prevC|=0) = 2 → ATR 2
  assert.equal(atrFromBars(bars), 2)
  assert.equal(atrFromBars(bars.slice(0, 10)), null)
  assert.equal(atrFromBars(null), null)
})

test('hourlyAtrFor: the first registered source that answers wins; none → null, never a throw', () => {
  clearAtrSources()
  const db = { prepare: () => ({ get: () => ({ value: JSON.stringify({ NATGAS: 42 }) }) }) }
  assert.deepEqual(hourlyAtrFor(db, 'NatGas'), { atr: null, source: null })
  registerAtrSource('throws', () => { throw new Error('cache read failed') })
  registerAtrSource('empty', () => null)
  const seen = []
  registerAtrSource('scan_1h', (d, symbol, symbolId) => { seen.push([symbol, symbolId]); return 0.031 })
  registerAtrSource('keeper_cache', () => 0.02)
  assert.deepEqual(hourlyAtrFor(db, 'NatGas'), { atr: 0.031, source: 'scan_1h' })
  // the symbol id came from symbol_id_map, upper-cased
  assert.deepEqual(seen, [['NatGas', 42]])
  clearAtrSources('scan_1h')
  assert.deepEqual(hourlyAtrFor(db, 'NatGas'), { atr: 0.02, source: 'keeper_cache' })
  clearAtrSources()
})

test('wiring: both ATR owners register a source, and every order path applies stop_override', () => {
  assert.match(src('agent/services/fib-strategy.js'), /registerAtrSource\('scan_1h'/)
  assert.match(src('agent/services/profit-keeper.js'), /registerAtrSource\('keeper_cache'/)
  assert.match(src('agent/services/risk.js'), /hourlyAtrFor\(db, proposal\.symbol\)/)
  assert.match(src('agent/services/risk.js'), /stop_override: stopOverride/)
  assert.match(src('agent/loop.js'), /synth = \{ \.\.\.synth, sl: so\.sl/)
  assert.match(src('agent/services/pending-orders.js'), /signal = \{ \.\.\.signal, sl: riskResult\.stop_override\.sl \}/)
  assert.match(src('agent/services/closed-market-limits.js'), /synth = \{ \.\.\.synth, sl: riskResult\.stop_override\.sl \}/)
})

test('wiring (E·2): the dispatcher counts the shared accounts once per signal and hands the count to the gate', () => {
  const loop = src('agent/loop.js')
  assert.match(loop, /const sharedAccountsForSignal = apAccounts\.reduce/)
  assert.match(loop, /autoTrade\(db, sym, synth, acctItem, acct, \{ sharedAccounts: sharedAccountsForSignal \}\)/)
  assert.match(loop, /sharedAccounts: opts\.sharedAccounts \?\? accountOverride\?\.sharedAccounts \?\? null/, 'the count reaches the gate from the dispatcher (opts) and from the book (accountOverride)')
})
