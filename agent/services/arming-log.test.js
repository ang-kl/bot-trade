// PR-S: the arming ledger. These tests pin the four rules in the module
// header, and — the one that matters most — the wiring: that every production
// path which can change an arming cell actually supplies an actor, because a
// default nobody is forced off is a default everybody keeps.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB, getState, setState } from '../db.js'
import { recordArmingChange, armingHistory, whyCell, armingLogView, ARMING_ACTORS, _resetArmingWriteFailuresForTests } from './arming-log.js'
import { setStage, disarmStrategyEverywhere, unpinTradeStageEverywhere, armedTradeKeys } from './stage-matrix.js'

const io = { getState, setState }
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'arming-log-'))
  return initDB(join(dir, 'test.db'))
}

test('rule 1: a write that changes nothing is not a row', () => {
  const db = freshDb()
  // The breaker and the boot seeds rewrite unchanged cells every cycle. If
  // those became rows the ledger would hold tens of thousands of non-events
  // and the four that matter would be unfindable.
  assert.equal(recordArmingChange(db, { scope: '111', kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', from: true, to: true, actor: 'boot_seed' }), null)
  assert.equal(recordArmingChange(db, { scope: '111', kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', from: false, to: false, actor: 'boot_seed' }), null)
  assert.equal(armingHistory(db, {}).length, 0)
  // A real change is.
  assert.ok(recordArmingChange(db, { scope: '111', kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', from: true, to: false, actor: 'adaptive_breaker', reason: 'streak 4' }))
  assert.equal(armingHistory(db, {}).length, 1)
})

test('an absent cell and a false cell are different facts', () => {
  const db = freshDb()
  // `unset` → `false` IS a change: the cell stops following the global and
  // starts refusing on its own. Collapsing the two would lose that.
  assert.ok(recordArmingChange(db, { scope: '111', kind: 'strategy', key: 'vwap_trend', stage: 'trade', from: undefined, to: false, actor: 'adaptive_breaker' }))
  const [r] = armingHistory(db, {})
  assert.equal(r.from, 'unset')
  assert.equal(r.to, 'false')
})

test('rule 2: a pin that outvoted a disarm verdict is recorded as held', () => {
  const db = freshDb()
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, 0, 1)').run('4001')
  // Two strategies armed, so never-go-dark does not hold the disarm for us,
  // and an explicit owner pin on the one we are disarming.
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: '4001', actor: 'owner_route' }, io)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: true, accountId: '4001', actor: 'owner_route' }, io)

  const scopes = disarmStrategyEverywhere(db, io, 'rsi2_reversion', {
    exemptHandPinned: true, actor: 'adaptive_breaker', reason: 'loss streak 4 >= 3', evidence: { streak: 4 },
  })
  assert.ok((scopes.held || []).includes('4001'), 'the pin held the disarm on this account')

  const held = armingHistory(db, { scope: '4001', key: 'rsi2_reversion' }).find(r => r.decision === 'held')
  assert.ok(held, 'the held decision is on the record, not only in the return value')
  assert.equal(held.actor, 'adaptive_breaker')
  assert.match(held.reason, /streak 4/)
  assert.match(held.reason, /HELD by the owner's pin/)
  assert.equal(held.evidence.streak, 4)
  // Still armed — the ledger records the decision, it does not change it.
  assert.ok(armedTradeKeys(db, getState, '4001').has('rsi2_reversion'))
})

test('rule 3: a cell with no row reads unrecorded, never a guess', () => {
  const db = freshDb()
  // This is the 17-09 case exactly: a cell that is false, and nothing says why.
  setState(db, 'acct:4002:stage_matrix_json', JSON.stringify({ strategy: { tsmom_long: { trade: false } } }))
  const why = whyCell(db, { scope: '4002', key: 'tsmom_long', current: false })
  assert.equal(why.verdict, 'unrecorded')
  assert.equal(why.lastSet, null)
  assert.match(why.note, /not evidence that nobody changed it/)
})

test('a cell that disagrees with its last recorded decision is reported, not smoothed over', () => {
  const db = freshDb()
  recordArmingChange(db, { scope: '4003', kind: 'strategy', key: 'tsmom_long', stage: 'trade', from: false, to: true, actor: 'owner_route' })
  // Something wrote the cell false without recording. The ledger's own blind
  // spot is worth more than a shrug — it names the defect to find.
  const why = whyCell(db, { scope: '4003', key: 'tsmom_long', current: false })
  assert.equal(why.verdict, 'disagrees')
  assert.equal(why.lastSet.to, 'true')
  assert.match(why.note, /wrote it without recording/)
})

test('rule 4: a ledger failure never blocks the arming change it describes', () => {
  const db = freshDb()
  _resetArmingWriteFailuresForTests()
  db.exec('DROP TABLE arming_log')
  // The write must still land even though the ledger cannot record it.
  assert.doesNotThrow(() => setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '4004', actor: 'adaptive_breaker' }, io))
  assert.equal(armedTradeKeys(db, getState, '4004').has('vwap_trend'), false, 'the disarm landed')
  assert.ok(armingLogView(db).writeFailures > 0, 'and the failure is counted, not swallowed')
})

test('the breaker and the watchdog write their own figures onto the row', () => {
  const db = freshDb()
  setStage(db, {
    kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false, accountId: '4005',
    actor: 'edge_watchdog', reason: 'no edge: expectancy -53.85, PF 0.49 over 31 closes',
    evidence: { expectancy: -53.85, profitFactor: 0.49, trades: 31 },
  }, io)
  const why = whyCell(db, { scope: '4005', key: 'vwap_trend', current: false })
  assert.equal(why.verdict, 'recorded')
  assert.equal(why.lastSet.actor, 'edge_watchdog')
  assert.equal(why.lastSet.evidence.profitFactor, 0.49)
  assert.match(why.lastSet.reason, /31 closes/)
})

test('an unpin is a change to unset, not to false', () => {
  const db = freshDb()
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: '4006', actor: 'owner_route' }, io)
  unpinTradeStageEverywhere(db, io, 'rsi2_reversion')
  const [r] = armingHistory(db, { scope: '4006', key: 'rsi2_reversion' })
  assert.equal(r.to, 'unset', 'the cell now follows the global again — that is not the same as an explicit false')
  assert.equal(r.actor, 'owner_route')
})

test('the view reports an actor it does not know rather than hiding it', () => {
  const db = freshDb()
  recordArmingChange(db, { scope: null, kind: 'strategy', key: 'vwap_trend', stage: 'trade', from: true, to: false, actor: 'some_new_path' })
  const view = armingLogView(db)
  assert.deepEqual(view.unknownActors, ['some_new_path'])
  assert.equal(view.byActor.some_new_path, 1)
})

// ---------------------------------------------------------------------------
// THE WIRING PIN (CLAUDE.md failure mode #4: a repair that nothing calls).
//
// `actor` defaults to 'unattributed' so that no existing caller breaks. That
// default is exactly how this change could rot: a new arming path lands, omits
// the actor, and the ledger records 'unattributed' forever while looking
// healthy. This test reads the production call sites and fails if any of them
// stops naming an actor.
// ---------------------------------------------------------------------------
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('every production caller that can change an arming cell names its actor', () => {
  const sites = [
    ['services/adaptive-breaker.js', /disarmStrategyEverywhere\(db, io, key, \{[\s\S]*?actor: 'adaptive_breaker'/],
    ['services/adaptive-breaker.js', /setStage\(db, \{[\s\S]*?actor: 'adaptive_breaker'/],
    ['services/edge-watchdog.js', /disarmStrategyEverywhere\(db, io, key, \{[\s\S]*?actor: 'edge_watchdog'/],
    ['services/stage-matrix.js', /setStage\(db, \{[\s\S]*?actor: 'boot_seed'/],
    ['services/strategy-autopilot.js', /recordArmingChange\(db, \{[\s\S]*?actor: 'strategy_autopilot'/],
    ['routes/actions.js', /setStage\(db, \{[\s\S]*?actor: 'owner_route'/],
  ]
  for (const [file, re] of sites) {
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    assert.match(src, re, `${file} must name its arming actor`)
  }
})

test('every actor the production call sites use is declared in ARMING_ACTORS', () => {
  // Otherwise the view's `unknownActors` would flag our own code, which would
  // train a reader to ignore the field that exists to catch a new writer.
  //
  // SCOPED TO THE THREE ARMING ENTRY POINTS on purpose. The first draft of
  // this test matched every `actor:` in the file and failed on
  // `requestEntryMode`'s unrelated `actor: 'owner'` (P1b's entry-mode record,
  // a different vocabulary in the same routes file). A test that goes red for
  // a reason it does not name is worse than no test: the next person deletes
  // it instead of reading it.
  const CALLS = /(?:setStage|disarmStrategyEverywhere|recordArmingChange)\s*\([\s\S]{0,700}?\)/g
  let found = 0
  for (const file of ['services/adaptive-breaker.js', 'services/edge-watchdog.js', 'services/stage-matrix.js', 'services/strategy-autopilot.js', 'routes/actions.js']) {
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    for (const call of src.match(CALLS) || []) {
      for (const m of call.matchAll(/actor: '([a-z_:]+)'/g)) {
        found++
        assert.ok(ARMING_ACTORS.includes(m[1]), `${file} passes actor '${m[1]}' to an arming call, and it is not in ARMING_ACTORS`)
      }
    }
  }
  assert.ok(found >= 5, `expected to find the production arming actors, found ${found} — the scan stopped matching, which would make this test pass on nothing`)
})
