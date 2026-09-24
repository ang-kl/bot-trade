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
import { setStage, tradeStageGate } from './stage-matrix.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'
import { admitEntry } from './entry-mode.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { tradeGateChain, tradeGateMatrix, gateLine, GATE_WHERE } from './trade-gate-resolver.js'

let db
const io = { getState, setState }
const ACCT = '46130058'
// The existing nine-switch regressions use the surviving momentum producer.
// Retired scan strategies have a separate structural failure, tested below.
const retiredCount = STRATEGY_REGISTRY.filter(s => s.family !== 'momentum').length

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

const chain = (opts) => tradeGateChain(db, { strategy: 'tsmom_long', ...opts })

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
    'producer_available',
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
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false }, io)
  const r = chain()
  assert.equal(r.blockedBy, 'matrix_trade')
  assert.match(r.reason, /Auto Trade & Open/)
})

test('a matrix SCAN cell blocks BEFORE the trade cell — order is the point', () => {
  // Scan runs first, so a scan-off strategy never reaches the trade gate. A
  // resolver that reported the trade cell here would send the owner to change
  // a switch that changes nothing.
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'scan', on: false }, io)
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false }, io)
  const r = chain()
  assert.equal(r.blockedBy, 'matrix_scan')
})

test('THE FIRST BLOCKER WINS even when everything below it is also off', () => {
  // Turning off the master used to make every downstream readout look broken
  // too. One answer, and it is the one worth acting on.
  setState(db, 'scan_enabled', 'false')
  setState(db, 'autotrade_enabled', 'false')
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false }, io)
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
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: true }, io)
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false, accountId: ACCT }, io)
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
  assert.equal(m.retired, retiredCount)
  assert.equal(m.topBlocker.gate, 'producer_available')
  assert.equal(m.topBlocker.strategies, retiredCount)
  assert.match(m.topBlocker.where, /owner-approved/)
  assert.equal(m.rows.find(r => r.strategy === 'tsmom_long').blockedBy, 'master_autotrade')
  assert.equal(m.rows.find(r => r.strategy === 'tsmom_long').gates.find(g => g.key === 'master_autotrade').pass, false)
})

test('the matrix separates retired paths from an active strategy with a switch off', () => {
  const before = tradeGateMatrix(db, {})
  assert.equal(before.retired, retiredCount)
  assert.equal(before.tradable, STRATEGY_REGISTRY.length - retiredCount)
  // Turning off the surviving strategy does not reclassify retirement as a
  // switch problem, or silently restore the old retired paths.
  setStage(db, { kind: 'strategy', key: 'tsmom_long', stage: 'trade', on: false }, io)
  const m = tradeGateMatrix(db, {})
  assert.equal(m.topBlocker.gate, 'producer_available')
  assert.equal(m.topBlocker.strategies, retiredCount)
  assert.equal(m.blocked, STRATEGY_REGISTRY.length)
  assert.equal(m.tradable, 0)
  assert.equal(m.rows.find(r => r.strategy === 'tsmom_long').blockedBy, 'matrix_trade')
})

test('an unknown strategy is an error, not a silent all-clear', () => {
  const r = tradeGateChain(db, { strategy: 'no_such_strategy' })
  assert.equal(r.ok, false)
  assert.match(r.error, /unknown strategy/)
})

test('the line reads as an answer either way', () => {
  assert.match(gateLine(chain()), /all \d+ configuration\/producer checks open/)
  setState(db, 'autotrade_enabled', 'false')
  assert.match(gateLine(chain({ accountId: ACCT })), /blocked at Master Autotrade is OFF — Sidebar/)
})


test('all switches ON cannot make a retired ordinary producer look tradable', () => {
  const before = db.prepare('SELECT * FROM agent_state ORDER BY key').all()
  const canonical = ENTRY_PRODUCERS.find(p => p.id === 'scan_dispatch')
  assert.ok(canonical.retired, 'this regression exercises the recorded retirement, not a mock flag')
  for (const s of STRATEGY_REGISTRY.filter(s => s.family !== 'momentum')) {
    const r = tradeGateChain(db, { accountId: ACCT, strategy: s.key })
    assert.equal(tradeStageGate(db, getState, { accountId: ACCT, strategy: s.key }).ok, true)
    assert.equal(r.configurationOpen, true)
    assert.equal(r.ok, false)
    assert.equal(r.blockedBy, 'producer_available')
    assert.equal(r.producer.state, 'retired')
    assert.equal(r.reason, `scan_dispatch: ${canonical.retired}`)
    assert.equal(r.scope, 'automatic_bar_configuration')
    assert.match(gateLine(r), /retired/)
  }
  // The unchanged real admission fence independently rejects this producer.
  const admission = admitEntry(db, { accountId: ACCT, producerId: 'scan_dispatch' })
  assert.equal(admission.ok, false)
  assert.match(admission.reason, /producer_retired/)
  assert.deepEqual(db.prepare('SELECT * FROM agent_state ORDER BY key').all(), before,
    'read-model and admission checks cannot arm a strategy or mutate state')
})

test('fib_618_fade readout includes its retired pending-order producer', () => {
  const r = tradeGateChain(db, { accountId: ACCT, strategy: 'fib_618_fade' })
  assert.equal(r.blockedBy, 'producer_available')
  assert.deepEqual(r.producer.producers.map(p => p.id), ['scan_dispatch', 'pending_fib_orders'])
  assert.equal(r.producer.producers.every(p => p.retired === true), true)
  assert.match(r.reason, /pending_fib_orders:/)
})

test('a retired path stays visible even under an OFF master', () => {
  setState(db, 'autotrade_enabled', 'false')
  const r = tradeGateChain(db, { accountId: ACCT, strategy: 'fib_confluence' })
  assert.equal(r.blockedBy, 'producer_available')
  assert.equal(r.configurationOpen, false)
  assert.equal(r.gates.find(g => g.key === 'master_autotrade').pass, false)
  assert.match(r.gates[0].where, /owner-approved/)
})

test('available momentum is labelled configuration, not live trade or tick readiness', () => {
  const r = chain()
  assert.equal(r.ok, true)
  assert.equal(r.producer.state, 'available')
  assert.equal(r.scope, 'automatic_bar_configuration')
  assert.match(gateLine(r), /not an entry approval/)
  assert.match(r.note, /Manual and tick entry paths are separate/)
  const m = tradeGateMatrix(db, {})
  assert.equal(m.scope, r.scope)
  assert.match(m.note, /not live order approval/)
})
