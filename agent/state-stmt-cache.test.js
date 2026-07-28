// getState/setState prepared-statement cache.
//
// The cache is keyed by Database handle in a WeakMap, which is the part worth
// testing: get it wrong and one DB's statements run against another's file —
// in a process that opens a fresh DB per test, and where agent_state holds the
// account id, the arm state and every risk toggle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, getState, setState } from './db.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-')), 'agent.db'))

test('reads and writes still round-trip', () => {
  const db = tmpDb()
  assert.equal(getState(db, 'nope'), null)
  setState(db, 'k', 'v1')
  assert.equal(getState(db, 'k'), 'v1')
  setState(db, 'k', 'v2')
  assert.equal(getState(db, 'k'), 'v2')
  setState(db, 'k', null)
  assert.equal(getState(db, 'k'), null)
})

test('two open databases never share state through the cache', () => {
  const a = tmpDb()
  const b = tmpDb()
  setState(a, 'ctrader_account_id', '43097342')
  setState(b, 'ctrader_account_id', '46979908')

  assert.equal(getState(a, 'ctrader_account_id'), '43097342')
  assert.equal(getState(b, 'ctrader_account_id'), '46979908')

  // And a key written to only one of them must not appear in the other.
  setState(a, 'autotrade_enabled', 'true')
  assert.equal(getState(b, 'autotrade_enabled'), 'false') // b keeps its seeded default
})

test('the cache survives interleaved use of many handles', () => {
  const dbs = [tmpDb(), tmpDb(), tmpDb()]
  dbs.forEach((db, i) => setState(db, 'marker', `db${i}`))
  // Interleave reads so a single shared cache slot would be caught.
  for (let round = 0; round < 3; round++) {
    dbs.forEach((db, i) => assert.equal(getState(db, 'marker'), `db${i}`))
  }
})

test('writes inside a transaction still commit through the cached statement', () => {
  const db = tmpDb()
  db.transaction(() => {
    setState(db, 'a', '1')
    setState(db, 'b', '2')
  })()
  assert.equal(getState(db, 'a'), '1')
  assert.equal(getState(db, 'b'), '2')
})

test('a rolled-back transaction leaves no value behind', () => {
  const db = tmpDb()
  setState(db, 'k', 'before')
  assert.throws(() => db.transaction(() => {
    setState(db, 'k', 'during')
    throw new Error('rollback')
  })())
  assert.equal(getState(db, 'k'), 'before')
})
