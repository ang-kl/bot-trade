// node --test agent/services/risk-config-shape.test.js
//
// Wave 4b of docs/first-principles-audit-2026-09-19.md §K item 14: the risk
// config compressed from 66 keys to 42 with NO behaviour change — 24 scalars
// folded into object-valued keys or retired. These pin the count, the
// retired list, the one-level-deep merge that object keys need, and the
// legacy fold that keeps an old stored value from being silently lost.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { DEFAULT_RISK_CONFIG, LEGACY_RISK_KEYS, mergeRiskConfig, migrateLegacyRiskKeys, loadRiskConfig } from './risk.js'
import { RETIRED_KEYS, ungroupedKeys } from './risk-matrix.js'

const RETIRED_4B = [
  'dailyLossPctMax', 'stopTriggerMethod', 'leverage', 'maxRiskUsd',
  'newsGateEnabled', 'newsGateMinBefore', 'newsGateMinAfter', 'newsGateImpacts',
  'commissionGateEnabled', 'commissionMaxFracOfWin', 'commissionGateMinTrades',
  'slippageGateEnabled', 'slippageMaxAdversePct', 'slippageGateMinTrades',
  'carryGateEnabled', 'carryMaxNegativeSwapPoints',
  'marginRateStock', 'marginRateIndex', 'marginRateCommodity', 'marginRateCrypto',
  'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult',
  'blockOnUnknownPnl', 'unknownPnlGraceMin', 'unknownPnlMaxAgeMin', 'unknownPnlMinAttempts',
  'minTradesForKelly', 'allowNegativeExpectancyOverride',
  'limitDispatchMinTf', 'htfFreshnessMin',
  'symbolCooldownMinutes',
]

test('DEFAULT_RISK_CONFIG has exactly 42 keys; a re-introduced key turns this red', () => {
  assert.equal(Object.keys(DEFAULT_RISK_CONFIG).length, 42, Object.keys(DEFAULT_RISK_CONFIG).join(','))
  for (const k of RETIRED_4B) assert.equal(k in DEFAULT_RISK_CONFIG, false, `${k} is retired but still a default`)
  assert.deepEqual(ungroupedKeys(), [])
})

test('RETIRED_KEYS lists every Wave 4b name (33 scalars retired for a net 24-key reduction) plus kellyFraction, and LEGACY_RISK_KEYS maps the same set', () => {
  const retired = Object.keys(RETIRED_KEYS).filter(k => k !== 'kellyFraction').sort()
  assert.deepEqual(retired, [...RETIRED_4B].sort())
  assert.equal(retired.length, 33)
  assert.deepEqual(Object.keys(LEGACY_RISK_KEYS).sort(), [...RETIRED_4B].sort())
  // 33 scalars out, 9 object keys in (newsGate, commissionGate, slippageGate,
  // carryGate, marginRates, derisk, unknownPnl, kellyVeto, htfLimitDispatch):
  // 66 − 33 + 9 = 42.
  assert.equal(66 - 33 + 9, 42)
})

test('the object keys ship every value the scalars carried', () => {
  assert.deepEqual(DEFAULT_RISK_CONFIG.newsGate, { on: false, minBefore: 15, minAfter: 15, impacts: ['High'] })
  assert.deepEqual(DEFAULT_RISK_CONFIG.commissionGate, { on: false, maxFracOfWin: null, minTrades: 5 })
  assert.deepEqual(DEFAULT_RISK_CONFIG.slippageGate, { on: false, maxAdversePct: null, minTrades: 5 })
  assert.deepEqual(DEFAULT_RISK_CONFIG.carryGate, { on: false, maxNegativeSwapPoints: null })
  assert.deepEqual(DEFAULT_RISK_CONFIG.marginRates, { stock: 0.2, index: 0.05, commodity: 0.05, crypto: 0.5 })
  assert.deepEqual(DEFAULT_RISK_CONFIG.derisk, { on: true, windowHours: 24, triggerPct: 0.05, mult: 0.5 })
  assert.deepEqual(DEFAULT_RISK_CONFIG.unknownPnl, { block: true, graceMin: 15, maxAgeMin: 360, minAttempts: 6 })
  assert.deepEqual(DEFAULT_RISK_CONFIG.kellyVeto, { minTrades: 30, allowNegative: false })
  assert.deepEqual(DEFAULT_RISK_CONFIG.htfLimitDispatch, { minTf: '4h', freshnessMin: 120 })
  assert.equal(DEFAULT_RISK_CONFIG.cooldownMinutes, 60)
})

test('mergeRiskConfig patches an object key ONE LEVEL DEEP: { derisk: { mult: 0.4 } } keeps the other three fields', () => {
  const out = mergeRiskConfig(DEFAULT_RISK_CONFIG, { derisk: { mult: 0.4 } })
  assert.deepEqual(out.derisk, { on: true, windowHours: 24, triggerPct: 0.05, mult: 0.4 })
  // the base is not mutated
  assert.equal(DEFAULT_RISK_CONFIG.derisk.mult, 0.5)
  // scalars and arrays REPLACE
  assert.deepEqual(mergeRiskConfig(DEFAULT_RISK_CONFIG, { blockedSymbols: ['X'] }).blockedSymbols, ['X'])
  assert.deepEqual(mergeRiskConfig(DEFAULT_RISK_CONFIG, { newsGate: { impacts: ['Medium'] } }).newsGate, { on: false, minBefore: 15, minAfter: 15, impacts: ['Medium'] })
  assert.equal(mergeRiskConfig(DEFAULT_RISK_CONFIG, { minRR: 2 }).minRR, 2)
  // a null patch over an object replaces (an operator can clear a key)
  assert.equal(mergeRiskConfig(DEFAULT_RISK_CONFIG, { derisk: null }).derisk, null)
})

test('loadRiskConfig merges a stored partial object over the default and an overlay partial over that, field by field', () => {
  const db = initDB(':memory:')
  setState(db, 'risk_config_json', JSON.stringify({ derisk: { mult: 0.4 }, unknownPnl: { graceMin: 20 } }))
  setState(db, 'acct:A:risk_config_json', JSON.stringify({ derisk: { windowHours: 48 } }))
  const g = loadRiskConfig(db)
  assert.deepEqual(g.derisk, { on: true, windowHours: 24, triggerPct: 0.05, mult: 0.4 })
  assert.deepEqual(g.unknownPnl, { block: true, graceMin: 20, maxAgeMin: 360, minAttempts: 6 })
  const a = loadRiskConfig(db, 'A')
  assert.deepEqual(a.derisk, { on: true, windowHours: 48, triggerPct: 0.05, mult: 0.4 }, 'the overlay field lands on the GLOBAL patch, not on the default')
  assert.deepEqual(a.unknownPnl, g.unknownPnl)
})

test('migrateLegacyRiskKeys folds EVERY retired scalar into its successor and deletes the legacy key', () => {
  const legacy = {
    newsGateEnabled: true, newsGateMinBefore: 30, newsGateMinAfter: 10, newsGateImpacts: ['High', 'Medium'],
    commissionGateEnabled: true, commissionMaxFracOfWin: 0.5, commissionGateMinTrades: 7,
    slippageGateEnabled: true, slippageMaxAdversePct: 0.1, slippageGateMinTrades: 9,
    carryGateEnabled: true, carryMaxNegativeSwapPoints: -10,
    marginRateStock: 0.25, marginRateIndex: 0.06, marginRateCommodity: 0.07, marginRateCrypto: 0.6,
    deriskOnDrawdown: false, deriskWindowHours: 48, deriskTriggerPct: 0.1, deriskMult: 0.25,
    blockOnUnknownPnl: false, unknownPnlGraceMin: 20, unknownPnlMaxAgeMin: 100, unknownPnlMinAttempts: 3,
    minTradesForKelly: 10, allowNegativeExpectancyOverride: true,
    limitDispatchMinTf: '1d', htfFreshnessMin: 60,
    symbolCooldownMinutes: 5, dailyLossPctMax: 0.18, stopTriggerMethod: 'OPPOSITE', leverage: 500, maxRiskUsd: 300,
    minRR: 2, // an untouched live key rides through
  }
  const out = migrateLegacyRiskKeys({ ...legacy })
  for (const k of RETIRED_4B) assert.equal(k in out, false, `${k} survived the fold`)
  assert.deepEqual(out, {
    newsGate: { on: true, minBefore: 30, minAfter: 10, impacts: ['High', 'Medium'] },
    commissionGate: { on: true, maxFracOfWin: 0.5, minTrades: 7 },
    slippageGate: { on: true, maxAdversePct: 0.1, minTrades: 9 },
    carryGate: { on: true, maxNegativeSwapPoints: -10 },
    marginRates: { stock: 0.25, index: 0.06, commodity: 0.07, crypto: 0.6 },
    derisk: { on: false, windowHours: 48, triggerPct: 0.1, mult: 0.25 },
    unknownPnl: { block: false, graceMin: 20, maxAgeMin: 100, minAttempts: 3 },
    kellyVeto: { minTrades: 10, allowNegative: true },
    htfLimitDispatch: { minTf: '1d', freshnessMin: 60 },
    minRR: 2,
  })
})

test('migrateLegacyRiskKeys: symbolCooldownMinutes is DROPPED, never folded — a stored per-symbol 5 cannot rewrite a streak window of 120 (checker, 19-09-2026); a value already at a destination wins', () => {
  assert.deepEqual(migrateLegacyRiskKeys({ symbolCooldownMinutes: 5 }), {})
  assert.deepEqual(migrateLegacyRiskKeys({ cooldownMinutes: 120, symbolCooldownMinutes: 5 }), { cooldownMinutes: 120 })
  assert.equal(LEGACY_RISK_KEYS.symbolCooldownMinutes, null)
  const db = initDB(':memory:')
  setState(db, 'risk_config_json', JSON.stringify({ cooldownMinutes: 120, symbolCooldownMinutes: 5 }))
  assert.equal(loadRiskConfig(db).cooldownMinutes, 120)
  assert.equal('symbolCooldownMinutes' in loadRiskConfig(db), false)
  const both = migrateLegacyRiskKeys({ deriskMult: 0.25, derisk: { mult: 0.4 } })
  assert.deepEqual(both, { derisk: { mult: 0.4 } })
  // non-objects pass through untouched
  assert.equal(migrateLegacyRiskKeys(null), null)
  assert.deepEqual(migrateLegacyRiskKeys([1]), [1])
})

test('loadRiskConfig applies the fold to the stored global AND to each overlay before merging, so an old save is honoured (mutation: drop the migrate call and this goes red)', () => {
  const db = initDB(':memory:')
  setState(db, 'risk_config_json', JSON.stringify({ deriskMult: 0.25, newsGateEnabled: true }))
  setState(db, 'acct:A:risk_config_json', JSON.stringify({ unknownPnlGraceMin: 5, marginRateStock: 0.3 }))
  const g = loadRiskConfig(db)
  assert.equal(g.derisk.mult, 0.25)
  assert.equal(g.derisk.on, true, 'the other derisk fields keep their defaults')
  assert.equal(g.newsGate.on, true)
  assert.equal('deriskMult' in g, false)
  assert.equal('newsGateEnabled' in g, false)
  const a = loadRiskConfig(db, 'A')
  assert.equal(a.unknownPnl.graceMin, 5)
  assert.equal(a.marginRates.stock, 0.3)
  assert.equal(a.marginRates.index, 0.05)
  assert.equal(a.derisk.mult, 0.25, 'the global fold is still under the overlay')
  assert.equal('unknownPnlGraceMin' in a, false)
})

test('mergeRiskConfig replaces `campaign` WHOLESALE — a new percentage does not inherit the previous campaign\'s startEquity/startAt', () => {
  const base = { ...DEFAULT_RISK_CONFIG, campaign: { maxDrawdownPct: 0.08, startEquity: 1983, startAt: '2026-08-07T00:00:00Z', label: 'old' } }
  assert.deepEqual(mergeRiskConfig(base, { campaign: { maxDrawdownPct: 0.05 } }).campaign, { maxDrawdownPct: 0.05 })
  assert.equal(mergeRiskConfig(base, { campaign: null }).campaign, null)
})

// ---------------------------------------------------------------------------
// THE RAW-STORE READ AT THE ORDER BOUNDARY (latent defect fixed in Wave 4b).
// loop.js re-checks maxPositionsPerSymbol immediately before the order leaves,
// and used to parse the raw global `risk_config_json` itself — so an account's
// overlay value, and a changed default, were honoured by the gate and ignored
// at the submission boundary. It now reads loadRiskConfig(db, accountId).
// ---------------------------------------------------------------------------
test('loop.js order boundary: the per-symbol cap is read through loadRiskConfig for THIS account, not from the raw global store (comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const at = src.indexOf("checkSymbolCap(db, { accountId, symbol, cap: capCfg })")
  assert.ok(at > 0, 'the boundary check exists')
  const block = src.slice(Math.max(0, at - 700), at)
  assert.ok(block.includes('const rc = loadRiskConfig(db, accountId)'), 'reads the effective config for the account')
  assert.ok(block.includes('rc.maxPositionsPerSymbol'))
  assert.equal(block.includes("getState(db, 'risk_config_json')"), false, 'the raw-store read is gone')
  // and what that call returns honours an overlay
  const db = initDB(':memory:')
  setState(db, 'acct:B:risk_config_json', JSON.stringify({ maxPositionsPerSymbol: 1 }))
  assert.equal(loadRiskConfig(db, 'B').maxPositionsPerSymbol, 1)
  assert.equal(loadRiskConfig(db, 'C').maxPositionsPerSymbol, DEFAULT_RISK_CONFIG.maxPositionsPerSymbol)
})
