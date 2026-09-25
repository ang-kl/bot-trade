// PR-U: the owner's "arm tsmom_long globally" order, carried out from the repo
// because the route needs a token that has answered 401 since 07-09.
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB, getState, setState } from '../db.js'
import { armedTradeKeys } from './stage-matrix.js'
import { armingHistory } from './arming-log.js'
import { seedGlobalStrategiesFromConfig, GLOBAL_SEED_STATE_KEY } from './global-strategy-seed.js'

const io = { getState, setState }
const freshDb = () => initDB(join(mkdtempSync(join(tmpdir(), 'gseed-')), 'test.db'))
function cfgFile(body) {
  const f = join(mkdtempSync(join(tmpdir(), 'gcfg-')), 'global-strategies.json')
  writeFileSync(f, JSON.stringify(body))
  return f
}

test('the checked-in config carries the owner order', () => {
  // The order is data, and the test reads the real file — not a fixture — so
  // deleting the entry fails here rather than silently at the next boot.
  const cfg = JSON.parse(readFileSync(new URL('../config/global-strategies.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(cfg.arm))
  assert.ok(cfg.arm.includes('tsmom_long'), 'the 17-09 order is tsmom_long')
})

test('it arms the strategy globally, and the book can then reach an account with no cell', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  assert.equal(armedTradeKeys(db, getState, null).has('tsmom_long'), false, 'off before')
  // An account with NO overlay cell: it follows the global, which is the
  // population this order is for.
  assert.equal(armedTradeKeys(db, getState, '9001').has('tsmom_long'), false)

  const r = seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long'] }) })
  assert.deepEqual(r.armed, ['tsmom_long'])
  assert.equal(armedTradeKeys(db, getState, null).has('tsmom_long'), true, 'on globally')
  assert.equal(armedTradeKeys(db, getState, '9001').has('tsmom_long'), true, 'and the cell-less account follows it')
})

test('it is additive — nothing already armed is removed', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion', 'vwap_trend']))
  seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long'] }) })
  const armed = armedTradeKeys(db, getState, null)
  for (const k of ['rsi2_reversion', 'vwap_trend', 'tsmom_long']) assert.ok(armed.has(k), `${k} armed`)
})

test('the arm is recorded in the arming ledger with the order as its reason', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify([]))
  seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long'] }) })
  const [row] = armingHistory(db, { scope: null, key: 'tsmom_long' })
  assert.equal(row.actor, 'boot_seed')
  assert.equal(row.to, 'true')
  assert.match(row.reason, /owner order: arm tsmom_long globally/)
})

test('SEED-ONCE: a later disarm is NOT undone at the next boot', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify([]))
  const file = cfgFile({ arm: ['tsmom_long'] })
  seedGlobalStrategiesFromConfig(db, io, { file })
  assert.equal(armedTradeKeys(db, getState, null).has('tsmom_long'), true)

  // The edge watchdog disarms it globally on measured evidence.
  setState(db, 'enabled_strategies_json', JSON.stringify([]))

  // Next boot. The seed must leave it OFF: an arm that reasserts itself every
  // boot is a guard whose trigger can never hold, and the owner ordered an
  // arm, not an exemption from the risk controls.
  const r = seedGlobalStrategiesFromConfig(db, io, { file })
  assert.deepEqual(r.armed, [])
  assert.deepEqual(r.seeded, ['tsmom_long'])
  assert.equal(armedTradeKeys(db, getState, null).has('tsmom_long'), false, 'stays off')
})

test('a strategy already armed is reported present and is NOT marked seeded', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['tsmom_long']))
  const r = seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long'] }) })
  assert.deepEqual(r.present, ['tsmom_long'])
  assert.deepEqual(r.armed, [])
  // Not recorded as seeded, so the order still stands if it is later disarmed
  // and re-issued — the seed record means "this boot spent the order", and
  // this boot did not.
  assert.equal(getState(db, GLOBAL_SEED_STATE_KEY) ?? null, null)
})

test('a suffixed entry re-arms once more after a disarm', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify([]))
  seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long'] }) })
  setState(db, 'enabled_strategies_json', JSON.stringify([]))   // disarmed again
  const r = seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['tsmom_long', 'tsmom_long:2'] }) })
  assert.deepEqual(r.seeded, ['tsmom_long'], 'the first record is spent')
  assert.deepEqual(r.armed, ['tsmom_long:2'], 'the second is a fresh order')
  assert.equal(armedTradeKeys(db, getState, null).has('tsmom_long'), true)
})

test('an unknown strategy is named and skipped, and the good ones still land', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify([]))
  const r = seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ arm: ['not_a_strategy', 'tsmom_long'] }) })
  assert.match(r.skipped[0], /unknown strategy 'not_a_strategy'/)
  assert.deepEqual(r.armed, ['tsmom_long'])
})

test('an unreadable or malformed config reports and changes nothing', () => {
  const db = freshDb()
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  const missing = seedGlobalStrategiesFromConfig(db, io, { file: '/nonexistent/global-strategies.json' })
  assert.match(missing.error, /unreadable/)
  const malformed = seedGlobalStrategiesFromConfig(db, io, { file: cfgFile({ nope: true }) })
  assert.match(malformed.error, /no `arm` array/)
  assert.deepEqual([...armedTradeKeys(db, getState, null)], ['rsi2_reversion'], 'untouched')
})

test('boot calls it — the wiring, not just the function', () => {
  // CLAUDE.md failure mode #4: a repair that nothing calls. An order carried
  // out by a function nobody invokes is an order not carried out.
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert.match(src, /seedGlobalStrategiesFromConfig\(db, \{ getState, setState \}/)
})
