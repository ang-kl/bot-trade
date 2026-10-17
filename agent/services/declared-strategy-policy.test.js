// node --test agent/services/declared-strategy-policy.test.js
//
// Claude · № 15,286 17-Oct (owner: "A: OFF policy on runtime enable";
// independent audit finding A / Codex P1 on #1392; claude-builder).
//
// Expected outcomes are grounded in production and the owner's order, not in
// this design: the arming log of 16-10 shows the nightly autopilot re-arming
// ema_pullback GLOBALLY at 18:54Z after the owner's Set B switched it OFF
// (config/strategy-pins.json `_off`), and the two archived live accounts
// 43002148 / 43069009 carry no false cell. Enabling one of them at runtime must
// not trade ema_pullback. The repo's real strategy-pins.json is the policy.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { armedTradeKeys, setStage } from './stage-matrix.js'
import { setAccountEnabled, syncSelectedAccount } from './account-registry.js'
import { unarchiveAccount } from './account-capabilities.js'
import { applyDeclaredStrategyPolicy } from './declared-strategy-policy.js'
import { setAccountArmed } from './account-arming.js'

const ARCHIVED = '43002148'
const RUNNING = '46130058'
let db

beforeEach(() => {
  db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,1,0,'archived')").run(ARCHIVED)
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(RUNNING)
  // Boot: the declared policy reaches the accounts enabled at that moment only.
  applyDeclaredStrategyPolicy(db, { reason: 'boot', log: () => {} })
  // Production 16-10 18:54Z: the autopilot re-arms ema_pullback globally.
  const global = new Set(JSON.parse(getState(db, 'enabled_strategies_json') || '[]'))
  global.add('ema_pullback'); global.add('vwap_trend')
  setState(db, 'enabled_strategies_json', JSON.stringify([...global]))
})

test('RED before: an archived account enabled through the registry follows the global list without the policy', () => {
  // The audit's condition, reproduced: no seed after the enable.
  db.prepare("UPDATE accounts SET enabled = 1, mode = 'active' WHERE account_id = ?").run(ARCHIVED)
  assert.ok(armedTradeKeys(db, getState, ARCHIVED).has('ema_pullback'), 'the bare enable inherits the global ON')
})

test('registry enable at runtime applies the declared OFF: ema_pullback, vwap_trend and fvg_retrace are not traded', () => {
  const out = setAccountEnabled(db, ARCHIVED, true, 'active')
  assert.equal(out.ok, true)
  const armed = armedTradeKeys(db, getState, ARCHIVED)
  for (const k of ['ema_pullback', 'vwap_trend', 'fvg_retrace']) assert.equal(armed.has(k), false, `${k} OFF on the enabled account`)
  assert.ok(armed.has('donchian_breakout'), 'the declared _all pins arrive too')
})

test('selection, unarchive and arm enable paths apply the same policy', () => {
  syncSelectedAccount(db, ARCHIVED, true)
  assert.equal(armedTradeKeys(db, getState, ARCHIVED).has('ema_pullback'), false, 'selection')
  db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,1,0,'archived')").run(ARCHIVED)
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback', 'donchian_breakout']))
  assert.equal(unarchiveAccount(db, ARCHIVED, 'active').ok, true)
  assert.equal(armedTradeKeys(db, getState, ARCHIVED).has('ema_pullback'), false, 'unarchive')
  db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,1,0,'manage_only')").run(ARCHIVED)
  setState(db, 'enabled_strategies_json', JSON.stringify(['ema_pullback', 'donchian_breakout']))
  assert.equal(setAccountArmed(db, ARCHIVED, true, { actor: 'test' }).ok, true)
  assert.equal(armedTradeKeys(db, getState, ARCHIVED).has('ema_pullback'), false, 'arm')
})

test('a later owner decision on an already-seeded account is not undone by another enable', () => {
  // The owner turns ema_pullback back ON for the running account after boot.
  setStage(db, { kind: 'strategy', key: 'ema_pullback', stage: 'trade', on: true, accountId: RUNNING, actor: 'owner_route' }, { getState, setState })
  setAccountEnabled(db, ARCHIVED, true, 'active') // some other account enabled: the seed runs again
  assert.equal(armedTradeKeys(db, getState, RUNNING).has('ema_pullback'), true, 'seed-once: the owner cell stands')
})
