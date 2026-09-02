// node --test agent/services/housekeeping-wiring.test.js
//
// PINS THE CALL SITES (failure mode #4: a repair that nothing calls). Three
// exported, tested functions sat with zero callers — sweepUnresolvable,
// pruneSessions, pruneRiskConfigChanges — each a pruner or a repair with no
// trigger. The owner's order (01-09-2026): wire it so it fires, or delete it.
// They are wired into loop.js's housekeeping pass, and this file is what
// stops a refactor dropping them again in silence: the call site is invisible
// from each module's own tests.
//
// Comments are stripped before every assertion (failure mode #2): the block
// above each step in loop.js names the function it calls, so a raw-source
// scan would stay green with the call itself deleted.
//
// The behaviour of each function is pinned in its own test file; what is
// pinned HERE is that the loop reaches them, inside runHousekeepingSteps (so a
// throw in one cannot cancel the others), with the module thresholds and with
// the write-off's dry-run OFF — a sweep wired with dryRun:true would report a
// plan every eight hours and mark nothing, which is the exact dead shape this
// replaces.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { sweepUnresolvable } from './mark-unresolvable.js'
import { exhaustedTradeIds, LIVE_GAP_MAX_ATTEMPTS } from './pnl-backfill.js'
import { unresolvedPnlSince } from './unresolved-pnl.js'

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))

/** The housekeeping step list: from the runHousekeepingSteps call to its closing `], { log })`. */
function housekeepingSteps() {
  const start = loop.indexOf('await runHousekeepingSteps([')
  assert.ok(start > 0, 'loop.js must run housekeeping through runHousekeepingSteps')
  const end = loop.indexOf('], { log })', start)
  assert.ok(end > start, 'the step list must close with `], { log })`')
  return loop.slice(start, end)
}

test('the three steps are INSIDE the isolated housekeeping step list, by name', () => {
  const steps = housekeepingSteps()
  for (const name of ['prune-browser-sessions', 'prune-risk-config-history', 'write-off-unresolvable']) {
    assert.equal((steps.match(new RegExp(`name: '${name}'`, 'g')) || []).length, 1, `step '${name}' once, inside runHousekeepingSteps`)
  }
})

test('pruneSessions is called with the module default retention', () => {
  const steps = housekeepingSteps()
  assert.match(steps, /import\('\.\/services\/browser-sessions\.js'\)\)\.pruneSessions\(db\)/,
    'pruneSessions(db) — no override of the 30-day keepRevokedMs the module defines')
})

test('pruneRiskConfigChanges is called for the global map AND every per-account map', () => {
  const steps = housekeepingSteps()
  assert.match(steps, /pruneRiskConfigChanges\(db, valid, \{ accountId: null \}\)/, 'global scope')
  assert.match(steps, /pruneRiskConfigChanges\(db, valid, \{ accountId \}\)/, 'per-account scope')
  assert.match(steps, /Object\.keys\(DEFAULT_RISK_CONFIG\)/, 'the valid set is the declared schema, not a hand-typed list')
  assert.match(steps, /LIKE 'acct:%:risk_config_changed_json'/, 'the per-account maps are discovered from agent_state, not from a list that can go stale')
})

test('sweepUnresolvable is called with dryRun OFF and BOTH evidence sources', () => {
  const steps = housekeepingSteps()
  assert.match(steps, /sweepUnresolvable\(db, \{ exhaustedAccounts: accounts, dryRun: false \}\)/,
    'dryRun: false — a sweep that only plans is the dead shape this replaces')
  assert.doesNotMatch(steps, /dryRun: true/)
  assert.match(steps, /exhaustedTradeIds\(db, \{ minAttempts: LIVE_GAP_MAX_ATTEMPTS/,
    'the durable per-row evidence, at the backfill\'s own threshold')
  assert.match(steps, /\.\.\.exhaustedAccounts\(\)/, 'unioned with the in-memory ladder, as /state/unresolvable-plan does')
  // The module's age rule is NOT overridden: no horizonDays is passed, so the
  // module's own DEFAULT_UNRESOLVABLE_HORIZON_DAYS decides.
  assert.doesNotMatch(steps, /horizonDays/)
})

test('what was written off is LOGGED, row by row, and persisted with the pass result', () => {
  assert.match(loop, /UNKNOWN P&L WRITTEN OFF: trade \$\{r\.id\}/, 'one line per row')
  assert.match(loop, /unresolvableWriteOff: writeOff/, 'the outcome rides in housekeeping_last_result_json')
})

// ---------------------------------------------------------------------------
// The composition the step performs, run for real against a database: the
// production shape — a row the backfill has tried thousands of times over
// nearly two weeks — is written off, and a fresh row on the same account is
// NOT, however many attempts it carries.
// ---------------------------------------------------------------------------

function closed(db, { daysAgo, attempts, account = 'ACCT-1' }) {
  return db.prepare(`
    INSERT INTO trades (symbol, side, status, net_pnl, account_id, pnl_attempts, opened_at, closed_at)
    VALUES ('EURUSD', 'BUY', 'closed', NULL, ?, ?, datetime('now', ?), datetime('now', ?))
  `).run(account, attempts, `-${daysAgo + 1} days`, `-${daysAgo} days`).lastInsertRowid
}

test('the composition: a 13-day row at 4,690 attempts is written off; a fresh row on the same account is not', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'ACCT-1')
  const old = closed(db, { daysAgo: 13, attempts: 4690 })
  const fresh = closed(db, { daysAgo: 0, attempts: 4690 })
  const untried = closed(db, { daysAgo: 30, attempts: 0, account: 'ACCT-2' })

  // Exactly what the step does with the two functions it imports.
  const exhaustedRows = exhaustedTradeIds(db, { minAttempts: LIVE_GAP_MAX_ATTEMPTS, limit: 1000 })
  const accounts = [...new Set(exhaustedRows.map(r => r.account_id).filter(a => a != null).map(String))]
  assert.deepEqual(accounts, ['ACCT-1'], 'ACCT-2 has never been given up on — it is not evidence of anything')
  const out = sweepUnresolvable(db, { exhaustedAccounts: accounts, dryRun: false })

  assert.equal(out.dryRun, false)
  assert.deepEqual(out.rows.map(r => r.id), [old], 'age AND exhaustion: only the old row on the exhausted account')
  const row = (id) => db.prepare('SELECT net_pnl, pnl_unresolvable, pnl_unresolvable_reason FROM trades WHERE id = ?').get(id)
  assert.equal(row(old).pnl_unresolvable, 1)
  assert.equal(row(old).net_pnl, null, 'NOTHING is computed — net_pnl stays NULL')
  assert.match(row(old).pnl_unresolvable_reason, /exhausted its retries on account ACCT-1/)
  assert.equal(row(fresh).pnl_unresolvable, 0, 'a fresh close is UNKNOWN, not unknowable, whatever its attempt count')
  assert.equal(row(untried).pnl_unresolvable, 0, 'age alone is not evidence')

  // Audited, by the module itself.
  const audit = db.prepare(`SELECT body FROM action_log WHERE method = 'PNL_UNRESOLVABLE'`).all()
  assert.equal(audit.length, 1)
  assert.deepEqual(JSON.parse(audit[0].body).ids, [old])

  // And the written-off row has left the reconciliation ledger's unresolved set
  // for good — it is no longer re-attempted or re-counted.
  assert.deepEqual(exhaustedTradeIds(db, { minAttempts: LIVE_GAP_MAX_ATTEMPTS }).map(r => r.id), [fresh])
  // dayStartSql is bound as a VALUE, so it must be a timestamp, not an expression.
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  const veto = unresolvedPnlSince(db, monthAgo, { maxAgeMin: null, minAttempts: null })
  assert.equal(veto.unresolvableCount, 1, 'the veto names the write-off separately rather than counting it as blocking')

  // A second pass is a no-op: nothing is marked twice, nothing is re-audited.
  const again = sweepUnresolvable(db, { exhaustedAccounts: accounts, dryRun: false })
  assert.equal(again.marked, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = 'PNL_UNRESOLVABLE'`).get().n, 1)
})
