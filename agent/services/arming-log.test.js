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
import { setStage, disarmStrategyEverywhere, unpinTradeStageEverywhere, armedTradeKeys, migrateTradeOverlay } from './stage-matrix.js'

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

// ---------------------------------------------------------------------------
// The checker's findings (17-09-2026). Each of these went red before its fix.
// ---------------------------------------------------------------------------

test('B1: a held decision repeated every cycle is recorded ONCE, not every cycle', () => {
  const db = freshDb()
  db.prepare('INSERT INTO accounts (account_id, is_live, enabled) VALUES (?, 0, 1)').run('4101')
  setStage(db, { kind: 'strategy', key: 'rsi2_reversion', stage: 'trade', on: true, accountId: '4101', actor: 'owner_route' }, io)
  setStage(db, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: true, accountId: '4101', actor: 'owner_route' }, io)

  // The edge watchdog stamps its once-per-trade marker only after a REAL
  // disarm, so when every remaining scope is a hand pin the block re-runs every
  // loop cycle. Measured before the fix: one held row per pinned account per
  // cycle, ~10,000 rows/day/strategy at the production interval.
  const opts = { exemptHandPinned: true, actor: 'edge_watchdog', reason: 'no edge: PF 0.49 over 31 closes', evidence: { profitFactor: 0.49, trades: 31 } }
  for (let i = 0; i < 20; i++) disarmStrategyEverywhere(db, io, 'rsi2_reversion', opts)

  const held = armingHistory(db, { scope: '4101', key: 'rsi2_reversion' }).filter(r => r.decision === 'held')
  assert.equal(held.length, 1, `20 identical cycles must leave ONE held row, left ${held.length}`)

  // …but a CHANGED verdict is news and is recorded.
  disarmStrategyEverywhere(db, io, 'rsi2_reversion', { ...opts, reason: 'no edge: PF 0.31 over 44 closes', evidence: { profitFactor: 0.31, trades: 44 } })
  const after = armingHistory(db, { scope: '4101', key: 'rsi2_reversion' }).filter(r => r.decision === 'held')
  assert.equal(after.length, 2, 'a moved verdict is a new decision')
  assert.match(after[0].reason, /PF 0\.31/)
})

test('B2: held rows can never bury the set row that explains the cell', () => {
  const db = freshDb()
  recordArmingChange(db, { scope: '4102', kind: 'strategy', key: 'tsmom_long', stage: 'trade', from: true, to: false, actor: 'adaptive_breaker', reason: 'loss streak 4 >= 3' })
  // Far more than the 50-row window the first version read. Each is a distinct
  // held decision (different evidence), so the dedupe above does not hide them.
  for (let i = 0; i < 80; i++) {
    recordArmingChange(db, { scope: '4102', kind: 'strategy', key: 'tsmom_long', stage: 'trade', from: true, to: true, decision: 'held', actor: 'edge_watchdog', reason: `cycle ${i}` })
  }
  const why = whyCell(db, { scope: '4102', key: 'tsmom_long', current: false })
  assert.equal(why.verdict, 'recorded', 'the explanation is still found — it is selected in SQL, not filtered from a window')
  assert.equal(why.lastSet.actor, 'adaptive_breaker')
  assert.match(why.lastSet.reason, /streak 4/)
})

test('whyCell without the current value says so rather than claiming a verdict', () => {
  const db = freshDb()
  recordArmingChange(db, { scope: '4103', kind: 'strategy', key: 'tsmom_long', stage: 'trade', from: false, to: true, actor: 'owner_route' })
  const why = whyCell(db, { scope: '4103', key: 'tsmom_long' })
  assert.equal(why.verdict, 'unverified')
  assert.match(why.note, /did not supply the cell's current value/)
})

test('M-a: unpinning an un-migrated account records, and the legacy list is an arming change', () => {
  const db = freshDb()
  // An account still on the legacy wholesale list, armed for a strategy the
  // global list does not carry: effectively armed by the list alone.
  setState(db, 'acct:4104:enabled_strategies_json', JSON.stringify(['vwap_trend']))
  setState(db, 'enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  assert.equal(armedTradeKeys(db, getState, '4104').has('vwap_trend'), true)

  unpinTradeStageEverywhere(db, io, 'vwap_trend')
  assert.equal(armedTradeKeys(db, getState, '4104').has('vwap_trend'), false, 'the unpin disarmed it')
  const rows = armingHistory(db, { scope: '4104', key: 'vwap_trend' })
  assert.equal(rows.length, 1, 'and the ledger says so — before the fix this branch recorded nothing')
  assert.equal(rows[0].to, 'unset')
})

test('M-b: the overlay migration records that the cell became a hand pin', () => {
  const db = freshDb()
  setState(db, 'acct:4105:enabled_strategies_json', JSON.stringify(['rsi2_reversion']))
  // Effective arming does not move across the migration — but the AUTHORITY
  // does: an explicit cell is a hand pin, and a hand pin outvotes both the
  // breaker and the watchdog. Rule 1 cannot see it, because the boolean is
  // unchanged, which is why it is written as a `held` decision.
  migrateTradeOverlay(db, io, '4105')
  const rows = armingHistory(db, { scope: '4105', key: 'rsi2_reversion' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor, 'migration')
  assert.equal(rows[0].evidence.nowHandPinned, true)
  assert.match(rows[0].reason, /exempt from the breaker and the watchdog/)
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
// COMMENTS ARE STRIPPED INCLUDING TRAILING ONES (checker, 17-09-2026). The
// first version only matched line comments that BEGIN a line, so replacing the
// watchdog's real attribution with `neverZero: true, // actor: 'edge_watchdog'`
// left it with no actor at all and the suite green — CLAUDE.md failure mode #2,
// live in the test written to prevent it.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')

/**
 * The text of ONE call to `fn` starting at `from`, delimited by matching
 * parentheses.
 *
 * WHY NOT A REGEX (checker, 17-09-2026). The first version used
 * `fn\(...[\s\S]*?actor: 'x'` — an unbounded lazy span. When the intended
 * `actor:` was deleted the match simply walked forward to the next occurrence
 * of the same string elsewhere in the file, so deleting the BREAKER'S DISARM
 * attribution — the exact site whose absence caused the 17-09 investigation —
 * left all eleven tests green. A pin that survives the mutation it exists to
 * catch is not a pin.
 */
function callBlock(src, fn, from = 0) {
  const start = src.indexOf(fn + '(', from)
  if (start === -1) return null
  // A DECLARATION IS NOT A CALL. `export function disarmStrategyEverywhere(…
  // actor = 'unattributed' …)` is where the default is DEFINED; treating it as
  // a call site made the test demand the definition not have a default, which
  // is the opposite of the intent.
  if (/\bfunction\s+$/.test(src.slice(Math.max(0, start - 30), start))) {
    let j = src.indexOf('(', start); let d = 0
    for (; j < src.length; j++) { if (src[j] === '(') d++; else if (src[j] === ')') { d--; if (d === 0) break } }
    return callBlock(src, fn, j + 1)
  }
  let i = src.indexOf('(', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') { depth--; if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 } }
  }
  return null
}

/** Every call to `fn` in `src`, each as its own bounded block. */
function allCalls(src, fn) {
  const out = []
  let from = 0
  for (;;) {
    const b = callBlock(src, fn, from)
    if (!b) return out
    out.push(b.text)
    from = b.end
  }
}

test('every production caller that can change an arming cell names its actor', () => {
  // Each row is ONE bounded call that must carry the actor. Deleting the actor
  // from any of them fails this test and cannot be satisfied by another call
  // elsewhere in the same file.
  const sites = [
    ['services/adaptive-breaker.js', 'disarmStrategyEverywhere', "actor: 'adaptive_breaker'"],
    ['services/adaptive-breaker.js', 'setStage', "actor: 'adaptive_breaker'"],
    ['services/edge-watchdog.js', 'disarmStrategyEverywhere', "actor: 'edge_watchdog'"],
    ['services/stage-matrix.js', 'setStage', "actor: 'boot_seed'"],
    ['services/stage-matrix.js', 'recordArmingChange', "actor: 'migration'"],
    ['services/strategy-autopilot.js', 'recordArmingChange', "actor: 'strategy_autopilot'"],
    ['services/telegram-control.js', 'recordArmingChange', "actor: 'telegram'"],
    ['services/rsi2-seed.js', 'recordArmingChange', "actor: 'boot_seed'"],
    ['routes/actions.js', 'setStage', "actor: 'owner_route'"],
    ['routes/actions.js', 'recordArmingChange', "actor: 'owner_route'"],
  ]
  for (const [file, fn, actor] of sites) {
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    const calls = allCalls(src, fn)
    assert.ok(calls.length > 0, `${file}: found no ${fn}( call at all — the scan broke, which would make this test pass on nothing`)
    assert.ok(calls.some(c => c.includes(actor)), `${file}: no ${fn}( call carries ${actor}`)
  }
})

test('every call that writes an arming cell carries an actor — none takes the default', () => {
  // The site list above says "at least one call names the actor". This one is
  // the complement: NO call may be left without one. Between them, deleting an
  // actor from any single call site is caught.
  const FILES = [
    'services/adaptive-breaker.js', 'services/edge-watchdog.js', 'services/stage-matrix.js',
    'services/strategy-autopilot.js', 'services/telegram-control.js', 'services/rsi2-seed.js',
    'routes/actions.js',
  ]
  let checked = 0
  for (const file of FILES) {
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    for (const fn of ['recordArmingChange', 'disarmStrategyEverywhere']) {
      for (const call of allCalls(src, fn)) {
        // Three forms carry an actor and all three count: a literal
        // (`actor: 'edge_watchdog'`), a variable (`actor,` — stage-matrix.js
        // defines the forwarding and passes its own parameter through), and
        // the spread of the attribution object setStage builds
        // (`...attribution`, which is `{ actor, reason, evidence }`). What
        // must not appear is a call carrying none of them, because that one
        // silently records 'unattributed' forever while looking healthy.
        assert.match(call, /actor[,:]|\.\.\.attribution/, `${file}: a ${fn}( call takes the default actor:\n${call.slice(0, 400)}`)
        checked++
      }
    }
  }
  assert.ok(checked >= 10, `expected to inspect the production arming calls, inspected ${checked}`)
})

test('a new writer of the global arming list must record — the census', () => {
  // THE CENSUS (checker, 17-09-2026). Six writers of `enabled_strategies_json`
  // and the filter state keys were missed by the first draft: both Telegram arm
  // paths, the rsi2 boot seed, and the three legacy filter routes. Each one
  // guarantees a later 'disagrees' verdict pointing at a phantom defect.
  //
  // This test is the thing that would have caught them. It counts the files
  // that write an arming state key and requires each to import the ledger. A
  // new writer in a new file fails here rather than in six weeks, in a log.
  const ARMING_KEYS = /'(enabled_strategies_json|cup_handle_enabled|fib_(rsi|vwap|fvg)_filter)'/
  const WRITE = /setState\(\s*db\s*,\s*('(?:enabled_strategies_json|cup_handle_enabled|fib_(?:rsi|vwap|fvg)_filter)'|[A-Za-z_$][\w$]*)/
  const files = [
    'services/stage-matrix.js', 'services/strategy-autopilot.js', 'services/telegram-control.js',
    'services/rsi2-seed.js', 'routes/actions.js', 'services/adaptive-breaker.js', 'services/edge-watchdog.js',
  ]
  const writers = []
  for (const file of files) {
    const src = stripComments(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    if (!ARMING_KEYS.test(src)) continue
    if (!WRITE.test(src)) continue
    writers.push(file)
    assert.match(
      src, /from '\.\.?\/(?:services\/)?arming-log\.js'/,
      `${file} writes an arming state key but does not import arming-log.js — every writer records, or the ledger answers 'unrecorded' for a cell something did change`,
    )
  }
  assert.ok(writers.length >= 5, `expected to find the arming writers, found ${writers.length}: ${writers.join(', ')}`)
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
