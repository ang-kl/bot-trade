// node --test agent/services/trade-gate-resolver.test.js
//
// Owner, 05-08-2026: "make sure all the strategies display on the UI are not
// conflicting with duplicate switches and result in no trading."
//
// Nine ANDed switches across four screens. The load-bearing tests are the ones
// that prove this resolver names the FIRST blocker and keeps naming the same
// one no matter how many gates below it are also off — because the tour of the
// UI that used to be required was the actual complaint.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { tradeGateChain, tradeGateMatrix, gateLine, GATE_WHERE } from './trade-gate-resolver.js'

let db
const io = { getState, setState }
const ACCT = '46130058'

// Every switch ON, so each test turns off exactly the one it is about.
//
// The trade column is armed EXPLICITLY rather than trusted to a default: only
// `defaultOn` strategies are trade-armed on a fresh database, so a fixture that
// assumed "fresh means open" would have been testing the registry's defaults
// instead of the resolver. Caught by this file's own first run.
function allOn(db) {
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
  setState(db, 'autotrade_enabled', 'true')
  for (const s of STRATEGY_REGISTRY) {
    setStage(db, { kind: 'strategy', key: s.key, stage: 'trade', on: true }, io)
  }
}

beforeEach(() => { db = initDB(':memory:'); allOn(db) })

const chain = (opts) => tradeGateChain(db, { strategy: 'fib_618_fade', ...opts })

test('with every switch on, the chain is open and names no blocker', () => {
  const r = chain()
  assert.equal(r.ok, true, gateLine(r))
  assert.equal(r.blockedBy, null)
  assert.equal(r.reason, null)
  assert.ok(r.gates.length >= 5, 'the global chain still reports every global gate')
})

test('THE NINE ARE ALL REPORTED for an account — no switch is invisible', () => {
  // The complaint was that no screen held all of them. This is that list.
  const keys = chain({ accountId: ACCT }).gates.map(g => g.key)
  assert.deepEqual(keys, [
    'registry_enabled', 'account_mode',
    'master_scan', 'master_analyze', 'master_autotrade',
    'account_scan', 'account_analyze',
    'matrix_scan', 'matrix_trade',
  ])
  // …and every one says where to go, which is the half a verdict usually omits.
  for (const g of chain({ accountId: ACCT }).gates) {
    assert.ok(GATE_WHERE[g.key], `${g.key} must name a screen`)
    assert.equal(g.where, GATE_WHERE[g.key])
  }
})

// ---------------------------------------------------------------------------
// Each switch, on its own
// ---------------------------------------------------------------------------

test('each master switch blocks on its own, and is named', () => {
  for (const [key, gate] of [
    ['scan_enabled', 'master_scan'],
    ['analyze_enabled', 'master_analyze'],
    ['autotrade_enabled', 'master_autotrade'],
  ]) {
    db = initDB(':memory:'); allOn(db)
    setState(db, key, 'false')
    const r = chain()
    assert.equal(r.ok, false, `${key} off must block`)
    assert.equal(r.blockedBy, gate)
    assert.match(r.reason, /Sidebar/)
  }
})

test('a matrix TRADE cell blocks, and points at the Pipeline', () => {
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: false }, io)
  const r = chain()
  assert.equal(r.blockedBy, 'matrix_trade')
  assert.match(r.reason, /Auto Trade & Open/)
})

test('a matrix SCAN cell blocks BEFORE the trade cell — order is the point', () => {
  // Scan runs first, so a scan-off strategy never reaches the trade gate. A
  // resolver that reported the trade cell here would send the owner to change
  // a switch that changes nothing.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'scan', on: false }, io)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: false }, io)
  const r = chain()
  assert.equal(r.blockedBy, 'matrix_scan')
})

test('THE FIRST BLOCKER WINS even when everything below it is also off', () => {
  // Turning off the master used to make every downstream readout look broken
  // too. One answer, and it is the one worth acting on.
  setState(db, 'scan_enabled', 'false')
  setState(db, 'autotrade_enabled', 'false')
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: false }, io)
  const r = chain()
  assert.equal(r.blockedBy, 'master_scan')
  assert.equal(r.gates.filter(g => !g.pass).length, 3, 'the others are still visible, just not the answer')
})

// ---------------------------------------------------------------------------
// Master beats account — the kill switch stays a kill switch
// ---------------------------------------------------------------------------

test("an account override cannot defeat a master OFF, and is not blamed for it", () => {
  // account-phases ANDs master in, so with the master off the account row is
  // meaningless. Reporting it as the blocker would point at a switch that
  // cannot fix anything.
  setState(db, 'scan_enabled', 'false')
  setState(db, `acct:${ACCT}:scan_enabled`, 'true')
  const r = chain({ accountId: ACCT })
  assert.equal(r.blockedBy, 'master_scan')
  assert.equal(r.gates.find(g => g.key === 'account_scan').pass, true,
    'the account gate is not the failure here')
})

test('an account override blocks on its own when the master is on', () => {
  setState(db, `acct:${ACCT}:scan_enabled`, 'false')
  const r = chain({ accountId: ACCT })
  assert.equal(r.blockedBy, 'account_scan')
  assert.match(r.gates.find(g => g.key === 'account_scan').detail, /switched off for this account/)
})

// ---------------------------------------------------------------------------
// Per-account matrix — the column that used to disagree with its neighbours
// ---------------------------------------------------------------------------

test('the matrix gates read the ACCOUNT scope, not the global one', () => {
  // Global armed, this account's cell pinned off.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true }, io)
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: false, accountId: ACCT }, io)
  assert.equal(chain().ok, true, 'global still trades it')
  assert.equal(chain({ accountId: ACCT }).blockedBy, 'matrix_trade', 'this account does not')
})

// ---------------------------------------------------------------------------
// The matrix view — what the two cards will both read
// ---------------------------------------------------------------------------

test('the matrix counts tradable vs blocked and names the top blocker', () => {
  setState(db, 'autotrade_enabled', 'false')
  const m = tradeGateMatrix(db, { accountId: ACCT })
  assert.equal(m.tradable, 0)
  assert.ok(m.blocked > 0)
  assert.equal(m.topBlocker.gate, 'master_autotrade')
  assert.equal(m.topBlocker.strategies, m.blocked, 'one switch, every strategy')
  assert.match(m.topBlocker.where, /Sidebar/)
})

test('topBlocker is the switch stopping the MOST strategies, not the first row', () => {
  // One strategy blocked by its own cell, everything else open. The headline
  // must be that one cell, not a global scare.
  setStage(db, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: false }, io)
  const m = tradeGateMatrix(db, {})
  assert.equal(m.topBlocker.gate, 'matrix_trade')
  assert.equal(m.topBlocker.strategies, 1, 'exactly the one cell that was turned off')
  assert.equal(m.blocked, 1)
  assert.ok(m.tradable > 0, 'the rest still trade')
})

test('an unknown strategy is an error, not a silent all-clear', () => {
  const r = tradeGateChain(db, { strategy: 'no_such_strategy' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown strategy/)
})

test('the line reads as an answer either way', () => {
  assert.match(gateLine(chain()), /all \d+ gates open/)
  setState(db, 'autotrade_enabled', 'false')
  assert.match(gateLine(chain({ accountId: ACCT })), /blocked at Master Autotrade is OFF — Sidebar/)
})
