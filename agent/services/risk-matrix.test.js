// node --test agent/services/risk-matrix.test.js
//
// Every risk setting, global and per account, side by side.
//
// The fact this table exists to carry is not the numbers — the page could
// already show one account's numbers. It is WHERE each number comes from. Two
// accounts showing 1.00% for different reasons behave differently the moment a
// default or the global value moves, and a grid that renders both the same way
// hides exactly the thing an operator opened it to see.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { setState } from '../db.js'
import { buildRiskMatrix, originOf, ungroupedKeys, RISK_GROUPS, groupOf } from './risk-matrix.js'
import { DEFAULT_RISK_CONFIG } from './risk.js'
import { noteRiskConfigChanges } from './risk-config-history.js'

function seeded() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?,?,?)').run('42993489', 1, 1)
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?,?,?)').run('5203012', 0, 1)
  return db
}

test('EVERY risk setting belongs to a declared group', () => {
  // A key in no group vanishes from the table. Silent omission on a page of
  // money limits is the worst possible failure mode for it.
  assert.deepEqual(ungroupedKeys(), [])
})

test('no key is claimed by two groups', () => {
  const seen = new Map()
  for (const g of RISK_GROUPS) {
    for (const k of g.keys) {
      assert.equal(seen.has(k), false, `${k} is in both ${seen.get(k)} and ${g.id}`)
      seen.set(k, g.id)
    }
  }
})

test('groupOf and the group list agree', () => {
  assert.equal(groupOf('dailyLossPct'), 'day')
  assert.equal(groupOf('marginLevelFloorPct'), 'day')
  assert.equal(groupOf('not_a_setting'), 'other')
})

test('a fresh database shows defaults everywhere and no overrides', () => {
  const m = buildRiskMatrix(seeded())
  assert.deepEqual(m.global.overridden, [])
  assert.equal(m.global.values.dailyLossPct, DEFAULT_RISK_CONFIG.dailyLossPct)
  assert.equal(m.accounts.length, 2)
  for (const a of m.accounts) assert.deepEqual(a.overridden, [])
})

test('the LIVE account leads, so the riskiest row is not buried', () => {
  const m = buildRiskMatrix(seeded())
  assert.equal(m.accounts[0].accountId, '42993489')
  assert.equal(m.accounts[0].isLive, true)
})

test('an account overlay shows as that ACCOUNT\'s value, and only there', () => {
  const db = seeded()
  setState(db, 'risk_config_json', JSON.stringify({ perTradeRiskPct: 0.01 }))
  setState(db, 'acct:5203012:risk_config_json', JSON.stringify({ perTradeRiskPct: 0.05 }))
  const m = buildRiskMatrix(db)
  const live = m.accounts.find(a => a.accountId === '42993489')
  const demo = m.accounts.find(a => a.accountId === '5203012')
  assert.equal(demo.values.perTradeRiskPct, 0.05)
  assert.equal(live.values.perTradeRiskPct, 0.01, 'the other account still inherits the global value')
  assert.deepEqual(demo.overridden, ['perTradeRiskPct'])
  assert.deepEqual(live.overridden, [])
})

test('OVERRIDDEN means WRITTEN HERE, not "differs from the default"', () => {
  // A value deliberately set to the default IS an override: it stops
  // following future default changes. Rendering it as inherited would
  // misrepresent what happens the day the default moves.
  const db = seeded()
  setState(db, 'risk_config_json', JSON.stringify({ minRR: DEFAULT_RISK_CONFIG.minRR }))
  const m = buildRiskMatrix(db)
  assert.deepEqual(m.global.overridden, ['minRR'])
})

test('origin separates account, global and default — the whole point of the grid', () => {
  const o = { accountOverridden: ['a'], globalOverridden: ['a', 'b'] }
  assert.equal(originOf('a', o), 'account', 'the account overlay wins')
  assert.equal(originOf('b', o), 'global')
  assert.equal(originOf('c', o), 'default')
  assert.equal(originOf('x'), 'default', 'no lists at all is still an answer')
})

test('the change stamps ride along, and stay in their own scope', () => {
  // Same "last changed" fact the proposal rows show, available per cell. A
  // global stamp must not appear under an account that never changed it.
  const db = seeded()
  noteRiskConfigChanges(db, { minRR: 1 }, { minRR: 1.5 }, { at: '2026-08-04T00:00:00Z' })
  noteRiskConfigChanges(db, { minRR: 1 }, { minRR: 2 }, { accountId: '5203012', by: 'reassess' })
  const m = buildRiskMatrix(db)
  assert.equal(m.global.changed.minRR.to, 1.5)
  assert.equal(m.accounts.find(a => a.accountId === '5203012').changed.minRR.to, 2)
  assert.deepEqual(m.accounts.find(a => a.accountId === '42993489').changed, {})
})

test('a database with no accounts table still answers for the global config', () => {
  // Fail soft: a missing registry must not blank the page.
  const db = initDB(':memory:')
  db.exec('DROP TABLE accounts')
  const m = buildRiskMatrix(db)
  assert.deepEqual(m.accounts, [])
  assert.ok(m.global.values.dailyLossPct != null)
})

test('a malformed overlay reads as no overlay rather than throwing', () => {
  const db = seeded()
  setState(db, 'acct:5203012:risk_config_json', '{not json')
  const m = buildRiskMatrix(db)
  assert.deepEqual(m.accounts.find(a => a.accountId === '5203012').overridden, [])
})
