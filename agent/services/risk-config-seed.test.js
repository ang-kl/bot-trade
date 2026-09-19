import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, getState, setState } from '../db.js'
import { DEFAULT_RISK_CONFIG, LEGACY_RISK_KEYS, loadRiskConfig } from './risk.js'
import { seedRiskConfigFromFile, riskConfigSeedHash, RISK_CONFIG_SEED_KEY, RISK_CONFIG_KEY } from './risk-config-seed.js'

const CHECKED_IN = new URL('../config/risk-config.json', import.meta.url)

/**
 * The production store as read on 19-09-2026: 17 differing, 37 pinned at
 * default, one retired — in the key names of THAT day. Wave 4b folded five of
 * the pinned names (dailyLossPctMax, blockOnUnknownPnl, deriskOnDrawdown,
 * leverage, newsGateImpacts) and three of the differing ones
 * (symbolCooldownMinutes, minTradesForKelly, allowNegativeExpectancyOverride)
 * into object keys or retired them; the fixture keeps the old names with
 * their literal values, because that is what an un-seeded store holds.
 */
function productionStore() {
  const pinned = {}
  for (const k of ['dailyLossPct', 'campaign', 'dailyLossFloorUsd', 'dailyLossTierAtUsd', 'maxPositionsPerSymbol', 'nullExitMinR', 'maxRiskCapPct', 'minLotSize', 'blockedSymbols']) pinned[k] = DEFAULT_RISK_CONFIG[k]
  Object.assign(pinned, { dailyLossPctMax: null, blockOnUnknownPnl: true, deriskOnDrawdown: true, leverage: 100, newsGateImpacts: ['High'] })
  return {
    ...pinned,
    dailyLossLimit: 150, perTradeRiskPct: 0.01, maxNotionalXBalance: 4, maxConsecutiveLosses: 4,
    cooldownMinutes: 5, symbolCooldownMinutes: 5, maxOpenPositions: 16, equityStopPct: 0.15,
    minRR: 1.6, minSLDistancePct: 0.02, maxSpreadFracOfSL: 0.03, maxCurrencyExposure: 1,
    maxClusterExposure: 5, minTradesForKelly: 10, allowNegativeExpectancyOverride: true,
    maxMarginUsagePct: 0.4, marginLevelFloorPct: 200, kellyFraction: 0.5,
  }
}

function tmpSeed(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-seed-'))
  const p = join(dir, 'risk-config.json')
  writeFileSync(p, JSON.stringify(obj))
  return p
}

test('the checked-in seed: resets only tightening/inert keys, keeps every loosening override, prunes pinned defaults, drops the retired key', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify(productionStore()))
  const lines = []
  const r = seedRiskConfigFromFile(db, { file: CHECKED_IN, log: (m) => lines.push(m) })
  assert.equal(r.error, null)
  assert.equal(r.applied, true)
  assert.equal(r.storedKeys, 32)
  assert.deepEqual([...r.reset].sort(), ['allowNegativeExpectancyOverride', 'cooldownMinutes', 'maxClusterExposure', 'maxConsecutiveLosses', 'maxOpenPositions', 'minRR', 'minSLDistancePct', 'minTradesForKelly', 'symbolCooldownMinutes'])
  assert.deepEqual([...r.kept].sort(), ['dailyLossLimit', 'equityStopPct', 'marginLevelFloorPct', 'maxCurrencyExposure', 'maxMarginUsagePct', 'maxNotionalXBalance', 'maxSpreadFracOfSL', 'perTradeRiskPct'])
  // Wave 4b: the pinned legacy scalars with a successor are FOLDED (into a
  // partial object), then pruned field by field because they sit at the
  // default; the two with no successor are dropped with kellyFraction.
  assert.deepEqual([...r.folded].sort(), ['blockOnUnknownPnl', 'deriskOnDrawdown', 'newsGateImpacts'])
  assert.deepEqual([...r.dropped].sort(), ['dailyLossPctMax', 'kellyFraction', 'leverage'])
  assert.deepEqual([...r.pruned].sort(), ['blockedSymbols', 'campaign', 'dailyLossFloorUsd', 'dailyLossPct', 'dailyLossTierAtUsd', 'derisk.on', 'maxPositionsPerSymbol', 'maxRiskCapPct', 'minLotSize', 'newsGate.impacts', 'nullExitMinR', 'unknownPnl.block'], 'every pinned default pruned, the folded ones per field')
  const stored = JSON.parse(getState(db, RISK_CONFIG_KEY))
  assert.deepEqual(Object.keys(stored).sort(), ['dailyLossLimit', 'equityStopPct', 'marginLevelFloorPct', 'maxCurrencyExposure', 'maxMarginUsagePct', 'maxNotionalXBalance', 'maxSpreadFracOfSL', 'perTradeRiskPct'], 'only real, kept overrides remain — no empty object left behind')
  const eff = loadRiskConfig(db)
  assert.equal(eff.maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions)
  assert.equal(eff.cooldownMinutes, DEFAULT_RISK_CONFIG.cooldownMinutes)
  assert.equal(eff.kellyVeto.allowNegative, false)
  assert.equal(eff.kellyVeto.minTrades, 30)
  assert.equal(eff.perTradeRiskPct, 0.01, 'the half-risk scale is NOT loosened by the seed')
  assert.equal(eff.dailyLossLimit, 150, 'the owner\'s cap is NOT touched by the seed')
  assert.equal(eff.equityStopPct, 0.15)
  assert.ok(!('kellyFraction' in eff))
  assert.ok(lines.some(l => /maxOpenPositions 16 → default 5/.test(l)))
  const rec = JSON.parse(getState(db, RISK_CONFIG_SEED_KEY))
  assert.equal(rec.hash, riskConfigSeedHash(JSON.parse(readFileSync(CHECKED_IN, 'utf8'))))
})

test('applied once per content: a human change after the seed stands; a content change re-applies; the _note does not', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 16, cooldownMinutes: 5 }))
  const p = tmpSeed({ _note: 'a', reset: ['maxOpenPositions'], keep: [], prunePinnedDefaults: true, dropRetired: true })
  let r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual(r.reset, ['maxOpenPositions'])
  // the human puts it back
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 12, cooldownMinutes: 5 }))
  r = seedRiskConfigFromFile(db, { file: p })
  assert.equal(r.applied, false)
  assert.equal(loadRiskConfig(db).maxOpenPositions, 12, 'the seed does not fight the human')
  // only the note changes → still nothing
  writeFileSync(p, JSON.stringify({ _note: 'b', reset: ['maxOpenPositions'], keep: [], prunePinnedDefaults: true, dropRetired: true }))
  r = seedRiskConfigFromFile(db, { file: p })
  assert.equal(r.applied, false)
  // the operative content changes → re-applied for the NEW key only; the
  // key reset under the earlier content is the human's now (12 stands)
  writeFileSync(p, JSON.stringify({ reset: ['maxOpenPositions', 'cooldownMinutes'], keep: [], prunePinnedDefaults: true, dropRetired: true }))
  r = seedRiskConfigFromFile(db, { file: p })
  assert.equal(r.applied, true)
  assert.deepEqual(r.reset, ['cooldownMinutes'])
  assert.equal(loadRiskConfig(db).maxOpenPositions, 12)
  assert.equal(loadRiskConfig(db).cooldownMinutes, DEFAULT_RISK_CONFIG.cooldownMinutes)
})

test('keep wins over reset; unknown keys are skipped and named; an unreadable file changes nothing', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ perTradeRiskPct: 0.01, maxOpenPositions: 16 }))
  const p = tmpSeed({ reset: ['perTradeRiskPct', 'noSuchKey', 'maxOpenPositions'], keep: ['perTradeRiskPct'], prunePinnedDefaults: false, dropRetired: false })
  const r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual(r.reset, ['maxOpenPositions'])
  assert.deepEqual(r.kept, ['perTradeRiskPct'])
  assert.ok(r.skipped.some(s => /noSuchKey: not a risk key/.test(s)))
  assert.ok(r.skipped.some(s => /perTradeRiskPct: also in keep/.test(s)))
  assert.equal(loadRiskConfig(db).perTradeRiskPct, 0.01)
  const db2 = initDB(':memory:')
  setState(db2, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 16 }))
  const bad = seedRiskConfigFromFile(db2, { file: join(tmpdir(), 'does-not-exist.json') })
  assert.match(bad.error, /cannot read/)
  assert.equal(loadRiskConfig(db2).maxOpenPositions, 16)
  assert.equal(getState(db2, RISK_CONFIG_SEED_KEY), null)
})

test('per-account overlays are never touched', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 16 }))
  setState(db, 'acct:46130058:risk_config_json', JSON.stringify({ maxOpenPositions: 9 }))
  seedRiskConfigFromFile(db, { file: CHECKED_IN })
  assert.equal(loadRiskConfig(db).maxOpenPositions, DEFAULT_RISK_CONFIG.maxOpenPositions)
  assert.equal(loadRiskConfig(db, '46130058').maxOpenPositions, 9)
})

test('the checked-in file names no loosening reset: every reset key is tighter-or-equal at default than the production value, or inert', () => {
  const cfg = JSON.parse(readFileSync(CHECKED_IN, 'utf8'))
  const prod = productionStore()
  // keys where a HIGHER value is looser. minTradesForKelly is one of them:
  // the Kelly check is a VETO that is skipped below the threshold, so a
  // higher threshold lets more losing records through (checker, Wave 4a).
  const higherIsLooser = ['maxOpenPositions', 'maxClusterExposure', 'maxConsecutiveLosses', 'minTradesForKelly']
  // keys where a LOWER value is looser
  const lowerIsLooser = ['cooldownMinutes', 'symbolCooldownMinutes', 'minRR', 'minSLDistancePct']
  // the one reset that is looser on its own, and allowed only as a PAIR
  const pairedOnly = { minTradesForKelly: 'allowNegativeExpectancyOverride' }
  // A legacy name in `reset` (Wave 4b) compares against its SUCCESSOR's default.
  const defaultOf = (k) => {
    if (k in DEFAULT_RISK_CONFIG) return DEFAULT_RISK_CONFIG[k]
    assert.ok(k in LEGACY_RISK_KEYS, `${k}: neither a risk key nor a legacy name`)
    // symbolCooldownMinutes has no successor (dropped, not folded); the
    // per-symbol lock it governed now reads cooldownMinutes, so that is the
    // default its reset is measured against.
    if (k === 'symbolCooldownMinutes') return DEFAULT_RISK_CONFIG.cooldownMinutes
    const t = LEGACY_RISK_KEYS[k]
    assert.ok(t, `${k}: retired with no successor — classify it by hand`)
    return DEFAULT_RISK_CONFIG[t[0]][t[1]]
  }
  for (const k of cfg.reset) {
    if (k in pairedOnly) { assert.ok(cfg.reset.includes(pairedOnly[k]), `${k} loosens on its own; it may be reset only together with ${pairedOnly[k]}`); continue }
    if (higherIsLooser.includes(k)) assert.ok(defaultOf(k) <= prod[k], `${k}: default ${defaultOf(k)} must not exceed stored ${prod[k]}`)
    else if (lowerIsLooser.includes(k)) assert.ok(defaultOf(k) >= prod[k], `${k}: default ${defaultOf(k)} must not sit below stored ${prod[k]}`)
    else if (k === 'allowNegativeExpectancyOverride') assert.equal(defaultOf(k), false)
    else assert.fail(`${k}: not classified — classify it before resetting it`)
  }
  for (const k of ['perTradeRiskPct', 'dailyLossLimit', 'maxNotionalXBalance', 'maxMarginUsagePct', 'marginLevelFloorPct', 'maxCurrencyExposure', 'maxSpreadFracOfSL', 'equityStopPct']) {
    assert.ok(cfg.keep.includes(k), `${k} loosens on reset and must stay in keep until the owner orders it`)
  }
})

test('wiring pin: the boot applies the seed after the entry-mode policy seed', () => {
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const src = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  const i = src.indexOf("seedRiskConfigFromFile(db, { log")
  assert.ok(i > 0, 'the boot calls the seed')
  assert.ok(src.indexOf('seedEntryModePolicyFromConfig(db') < i, 'placed after the policy seed (the pins/watchlist adjacency budget)')
})

test('a content change applies the DELTA: a key reset under an earlier hash and changed by a human since is not reset again (checker F6)', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 16, cooldownMinutes: 5 }))
  const p = tmpSeed({ reset: ['maxOpenPositions'], keep: [], prunePinnedDefaults: false, dropRetired: false })
  let r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual(r.reset, ['maxOpenPositions'])
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ maxOpenPositions: 9, cooldownMinutes: 5 }))  // the human raises it
  writeFileSync(p, JSON.stringify({ reset: ['maxOpenPositions', 'cooldownMinutes'], keep: [], prunePinnedDefaults: false, dropRetired: false }))
  r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual(r.reset, ['cooldownMinutes'], 'only the new key')
  assert.ok(r.skipped.some(s => /maxOpenPositions: applied under an earlier content/.test(s)))
  const eff = loadRiskConfig(db)
  assert.equal(eff.maxOpenPositions, 9, 'the human\'s value stands')
  assert.equal(eff.cooldownMinutes, DEFAULT_RISK_CONFIG.cooldownMinutes)
  assert.deepEqual(JSON.parse(getState(db, RISK_CONFIG_SEED_KEY)).resetEver, ['cooldownMinutes', 'maxOpenPositions'])
})

test('Wave 4b: a stored legacy scalar the seed does not reset is FOLDED into its successor before dropRetired, never silently lost; a legacy name in reset is reset', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ deriskMult: 0.25, marginRateStock: 0.3, minTradesForKelly: 10, maxRiskUsd: 300 }))
  const p = tmpSeed({ reset: ['minTradesForKelly'], keep: [], prunePinnedDefaults: true, dropRetired: true })
  const r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual(r.reset, ['minTradesForKelly'], 'a legacy name in reset is honoured as a reset')
  assert.deepEqual([...r.folded].sort(), ['deriskMult', 'marginRateStock'])
  assert.deepEqual(r.dropped, ['maxRiskUsd'], 'no successor → dropped, and said so')
  const stored = JSON.parse(getState(db, RISK_CONFIG_KEY))
  assert.deepEqual(stored, { derisk: { mult: 0.25 }, marginRates: { stock: 0.3 } })
  const eff = loadRiskConfig(db)
  assert.equal(eff.derisk.mult, 0.25)
  assert.equal(eff.derisk.on, true)
  assert.equal(eff.marginRates.stock, 0.3)
  assert.equal(eff.kellyVeto.minTrades, 30, 'reset to the default, not folded to 10')
  assert.deepEqual(JSON.parse(getState(db, RISK_CONFIG_SEED_KEY)).resetEver, ['minTradesForKelly'])
})

test('Wave 4b: prunePinnedDefaults is one level deep on object keys — a field at its default leaves, a real override stays, an emptied object goes', () => {
  const db = initDB(':memory:')
  setState(db, RISK_CONFIG_KEY, JSON.stringify({ derisk: { on: true, mult: 0.4 }, newsGate: { on: false, impacts: ['High'] }, minRR: 2 }))
  const p = tmpSeed({ reset: [], keep: [], prunePinnedDefaults: true, dropRetired: false })
  const r = seedRiskConfigFromFile(db, { file: p })
  assert.deepEqual([...r.pruned].sort(), ['derisk.on', 'newsGate.impacts', 'newsGate.on'])
  assert.deepEqual(JSON.parse(getState(db, RISK_CONFIG_KEY)), { derisk: { mult: 0.4 }, minRR: 2 })
})
