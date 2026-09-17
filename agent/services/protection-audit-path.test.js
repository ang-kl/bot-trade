// node --test agent/services/protection-audit-path.test.js
//
// PROTECTION HAS ITS OWN PATH — Operating Goal Plan §43.
//
//   "A position must never be considered safely managed merely because the
//    main strategy loop is running. Protection, active management, broker
//    reconciliation and emergency authority must each have their own
//    functioning and observable path."
//
// It did not have one. The audit lived inside the loop's per-account reconcile
// block, sharing that phase with order_monitor, and on 2026-08-04 both went
// stalled at the same instant — 961s old against a 314s expectation. For
// sixteen minutes nothing checked whether open positions still had stops at
// the broker.
//
// These tests hold down the properties that make the second path real rather
// than decorative: it sweeps EVERY enabled account against that account's OWN
// broker truth, one account's failure does not silence the others, and it
// beats its own heartbeat so the panel reflects THIS path and not only the
// loop's.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { runProtectionAuditAllAccounts, lastProtectionAudit } from './naked-position-guard.js'
import { makeTargetApplier as realMakeTargetApplier } from './tp-suggest.js'

let db
const A = '43097342'
const B = '46130058'

beforeEach(() => {
  db = initDB(':memory:')
  for (const [id, login] of [[A, '5067353'], [B, '5203012']]) {
    db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,0,1,?,?)')
      .run(id, 'active', login)
  }
})

/** One active position on `acct`, linked to a trade with a broker position id. */
function seedPosition(acct, symbol, posId, sl) {
  const t = db.prepare(
    'INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)'
  ).run(symbol, 'long', 'open', acct, posId)
  db.prepare(
    'INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,source) VALUES (?,?,?,?,?,?)'
  ).run(t.lastInsertRowid, symbol, 'active', acct, sl, 'bot')
}

const creds = { ready: true, isLive: false, accountId: A }

// AN INERT APPLIER FOR EVERY TEST THAT IS NOT ABOUT APPLYING (16-09-2026,
// review). Without it these tests run the REAL makeTargetSuggester and
// makeTargetApplier: the suggester returns null here only because
// `Number(bp.tradeData?.openPrice ?? bp.price)` is NaN on a fake snapshot, so
// adding one field to any fixture would put a unit test one step from
// `exec-engine.amendPosition` — under EXEC_ENGINE=cpp, an HTTP POST to a
// sidecar. Vacuous coverage AND a live edge; injected shut.
const inertTp = {
  makeTargetSuggester: () => async () => null,
  makeTargetApplier: () => async () => ({ ok: false, error: 'inert in test' }),
}

test('it sweeps EVERY enabled account, each against its own broker snapshot', async () => {
  seedPosition(A, 'EURUSD', '111', 1.05)
  seedPosition(B, 'GBPUSD', '222', 1.25)
  const asked = []
  const exec = {
    reconcile: async (c) => {
      asked.push(String(c.accountId))
      // Each account's snapshot contains ONLY its own position — auditing one
      // account's rows against another's truth marks the rest `unmatched`,
      // which staging once reported as "all protected" over four unaudited
      // positions.
      return String(c.accountId) === A
        ? { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
        : { position: [{ positionId: '222', stopLoss: null, takeProfit: null }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.deepEqual(asked.sort(), [A, B].sort(), 'both accounts asked')
  assert.equal(out.accounts, 2)
  assert.equal(out.naked, 1, 'the account whose broker holds no stop is reported naked')
})

test('one account failing does not silence the others', async () => {
  seedPosition(A, 'EURUSD', '111', 1.05)
  seedPosition(B, 'GBPUSD', '222', 1.25)
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === A) throw new Error('broker timeout')
      return { position: [{ positionId: '222', stopLoss: null, takeProfit: null }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.errors.length, 1, 'the failure is reported, not swallowed')
  assert.match(out.errors[0], /broker timeout/)
  assert.equal(out.accounts, 1, 'and the other account was still audited')
  assert.equal(out.naked, 1, 'including its missing stop')
})

test('an account clean on both sides is counted, not skipped', async () => {
  const exec = { exec: null, reconcile: async () => ({ position: [] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 2)
  assert.equal(out.naked, 0)
  assert.equal(out.errors.length, 0)
})

test('a BROKER position with no local row still gets audited', async () => {
  // The reverse of the usual case, and the one a "skip when we have no rows"
  // shortcut would hide: the broker holds a position the bot does not know
  // about. That is exactly what the audit is for.
  const exec = {
    reconcile: async () => ({ position: [{ positionId: '999', stopLoss: null, takeProfit: null }] }),
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 2, 'both swept despite zero local rows')
  assert.equal(out.errors.length, 0)
})

test('not-ready credentials do nothing at all — never a false all-clear', async () => {
  seedPosition(A, 'EURUSD', '111', null)
  let called = false
  const exec = { reconcile: async () => { called = true; return { position: [] } } }
  const out = await runProtectionAuditAllAccounts(db, { ready: false }, { tpSuggest: inertTp, exec })
  assert.equal(called, false)
  assert.equal(out.accounts, 0, 'zero accounts audited, not zero problems found')
})

test('only the SAME side is swept — a demo token cannot read a live account', async () => {
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,1,1,?,?)')
    .run('42993489', 'manage_only', '1251247')
  const asked = []
  const exec = {
    reconcile: async (c) => { asked.push(String(c.accountId)); return { position: [] } },
  }
  await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.ok(!asked.includes('42993489'), 'the live account is not swept with demo credentials')
})

test('an UNAUDITABLE account is reported apart from a real failure', async () => {
  // Demo 5268549's token does not cover it, so every pass returned
  // CH_ACCESS_TOKEN_INVALID and the first deploy of this path parked
  // protection_audit permanently in `error`. A controller that is always red
  // is a controller nobody reads — the same defect fixed in the health panel
  // hours earlier, reintroduced here.
  //
  // "The broker will not let us look" is a fact about ACCESS. "We looked and
  // it went wrong" is a fact about PROTECTION. Only the second should fail the
  // sweep.
  seedPosition(A, 'EURUSD', '111', 1.05)
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === B) throw new Error('cTrader error: CH_ACCESS_TOKEN_INVALID — Invalid access token')
      return { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.errors.length, 0, 'an unreachable account is not an audit failure')
  assert.equal(out.unauditable.length, 1)
  assert.match(out.unauditable[0], new RegExp(B))
  assert.equal(out.accounts, 1, 'and the reachable account was still audited')
})

test('a NON-auth failure on a reachable account still fails the sweep', async () => {
  // The safe default: anything not a recognised authorisation refusal means
  // we tried to check and could not, which is a protection question.
  const exec = { reconcile: async () => { throw new Error('socket hang up') } }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.unauditable.length, 0)
  assert.equal(out.errors.length, 2, 'both accounts report a real failure')
})

// ---------------------------------------------------------------------------
// CANT_ROUTE_REQUEST (08-08-2026). Owner, reading the panel: "Position
// protection audit — WARN, 42993489: cTrader error: CANT_ROUTE_REQUEST".
//
// 42993489 is the DISABLED live account, and it is still swept on purpose:
// `manage_only` accounts hold open positions, and dropping them from the audit
// would stop checking whether those positions have stops. So the refusal has to
// be classified, not routed around.
// ---------------------------------------------------------------------------

test('CANT_ROUTE_REQUEST is an access fact, so it does not fail the sweep', async () => {
  seedPosition(A, 'EURUSD', '111', 1.05)
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === B) throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request')
      return { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.errors.length, 0, 'the broker refusing to route is not a protection finding')
  assert.equal(out.unauditable.length, 1)
  assert.equal(out.accounts, 1, 'the reachable account was still audited')
  assert.equal(out.blind, false, 'a real audit with a named gap')
})

test('THE COUNTERWEIGHT: a sweep that reached NO account is blind, not clean', async () => {
  // The price of the widening above. If the whole sidecar session goes down,
  // every account returns CANT_ROUTE_REQUEST and every one lands in
  // `unauditable` — and green on this controller means "your positions are
  // protected". Reaching none of them verified nothing and must say so.
  seedPosition(A, 'EURUSD', '111', 1.05)
  seedPosition(B, 'GBPUSD', '222', 1.25)
  const exec = {
    reconcile: async () => { throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request') },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 0)
  assert.equal(out.unauditable.length, 2)
  assert.equal(out.errors.length, 0, 'still not per-account failures')
  assert.equal(out.blind, true, 'but the SWEEP failed — it checked nothing')
})

test('blind is about reaching nothing, not about finding nothing', async () => {
  // Two clean accounts is the healthiest possible outcome and must never be
  // confused with the case above.
  const exec = { reconcile: async () => ({ position: [] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 2)
  assert.equal(out.blind, false)
})

test('blind is measured against the enabled roster, not against the id list', async () => {
  // REVIEW FINDING, 08-08. `ids` prepends `primary` with no enabled test, so a
  // disabled selected account can be the ONLY entry. Against an implicit `ids`
  // denominator that read as blind — the fast monitor beating failed every 60s
  // for ever, on the same account and the same error this PR set out to stop
  // reporting as a breakage. The counterweight would have undone the fix.
  db.prepare('UPDATE accounts SET enabled = 0').run()          // nothing enabled → roster []
  const exec = {
    reconcile: async () => { throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request') },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 0)
  assert.equal(out.unauditable.length, 1, 'only the selected account was in the sweep')
  assert.equal(out.blind, false, 'there was nothing we were obliged to reach')
})

test('and an enabled roster that is wholly unreachable is STILL blind', async () => {
  // The half that must survive the narrowing above.
  const exec = {
    reconcile: async () => { throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request') },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.blind, true)
})

test('an unauditable account leaves a named gap in the work product, not just a console line', async () => {
  // REVIEW FINDING, 08-08. Reclassifying CANT_ROUTE_REQUEST stops it holding
  // the controller red — right — but `unauditable` reached only a console.warn,
  // so the PARTIAL case rendered as a plain green with the gap named nowhere.
  // `blind` cannot catch it: it fires only when EVERY account is refused.
  const { protectionFreshnessFrom } = await import('./protection-freshness.js')
  seedPosition(A, 'EURUSD', '111', 1.05)
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === B) throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request')
      return { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.blind, false, 'the sweep really did verify an account')

  const rec = JSON.parse(db.prepare('SELECT value v FROM agent_state WHERE key = ?')
    .get(`acct:${B}:protection_audit_last_json`).v)
  assert.equal(rec.lastAttemptOk, false)
  assert.match(rec.lastAttemptError, /CANT_ROUTE_REQUEST/)

  // And it reaches the reader the panel actually renders.
  const f = protectionFreshnessFrom(db, { lastAudit: rec })
  assert.match(f.summary, /CANT_ROUTE_REQUEST/)
})

test('a fresh reading still names an account it could not reach', async () => {
  // "verified 2m ago" is the most reassuring sentence this module produces. It
  // must not be printed over a gap. `fresh` is unchanged, so no new alert fires.
  const { protectionFreshness } = await import('./protection-freshness.js')
  const now = Date.parse('2026-08-08T12:00:00Z')
  const f = protectionFreshness({
    at: new Date(now - 120_000).toISOString(),
    lastAttemptError: '42993489: cTrader error: CANT_ROUTE_REQUEST',
    nowMs: now,
  })
  assert.equal(f.fresh, true, 'the reading IS current — it is just not complete')
  assert.match(f.summary, /verified 2m ago/)
  assert.match(f.summary, /42993489/)
})

test('THE ONE-SHORT CASE: a reachable non-roster account must not defeat blind', async () => {
  // REVIEW FINDING, 08-08. `out.accounts` counted any id in `ids`, but `ids`
  // prepends the selected account with no enabled test. So a disabled-but-
  // selected account reconciling fine, while EVERY enabled account is refused,
  // read as a successful sweep — green on a controller whose green means "your
  // positions are protected", having verified nothing it was obliged to verify.
  const SELECTED = '99999999'
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === SELECTED) return { position: [] }   // reachable, NOT enabled
      throw new Error('cTrader error: ACCOUNT_NOT_AUTHORIZED')        // every enabled one refused
    },
  }
  const out = await runProtectionAuditAllAccounts(db, { ...creds, accountId: SELECTED }, { tpSuggest: inertTp, exec })
  assert.equal(out.accounts, 1, 'one account did reconcile')
  assert.equal(out.unauditable.length, 2, 'but both obliged accounts were refused')
  assert.equal(out.blind, true, 'so the sweep is blind — this returned false before the fix')
})

test('and a reached ROSTER account still clears blind', async () => {
  const SELECTED = '99999999'
  const exec = {
    reconcile: async (c) => {
      if (String(c.accountId) === A) throw new Error('cTrader error: ACCOUNT_NOT_AUTHORIZED')
      return { position: [] }
    },
  }
  const out = await runProtectionAuditAllAccounts(db, { ...creds, accountId: SELECTED }, { tpSuggest: inertTp, exec })
  assert.equal(out.blind, false, 'B is enabled and was audited')
})

test('a GENUINE failure stamps the record — lastAttemptAt moves every pass', async () => {
  // The defect this pins (measured 2026-08-16): a reachable account failing on
  // a 502 every ~50s for 20,492 passes while /state/protection-audit presented
  // a six-day-old lastAttemptAt as current. The unauditable branch stamped the
  // per-account record; the GENUINE failure — the worse one — never did, so
  // the panel said the controller had stopped when only its record had.
  seedPosition(A, 'EURUSD', '111', 1.05)
  const T0 = Date.parse('2026-08-22T04:00:00Z')
  const exec = { reconcile: async () => { throw new Error('sidecar 502 Bad Gateway') } }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec, auditOpts: { nowMs: T0 } })
  assert.equal(out.errors.length, 2, 'still a real audit failure for both accounts')

  const rec = lastProtectionAudit(db, { accountId: A, nowMs: T0 })
  assert.equal(rec.lastAttemptAt, new Date(T0).toISOString(),
    'the failing pass is on the record, not just in the return value')
  assert.match(String(rec.lastAttemptError), /502/)

  // And the NEXT failing pass moves it — the stamp is per-pass, not one-shot.
  await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec, auditOpts: { nowMs: T0 + 50_000 } })
  const rec2 = lastProtectionAudit(db, { accountId: A, nowMs: T0 + 50_000 })
  assert.equal(rec2.lastAttemptAt, new Date(T0 + 50_000).toISOString())
})

test('the genuine-failure stamp PRESERVES the last successful reading', async () => {
  // recordAuditUnavailable's contract: the last success is the only thing
  // worth reporting during an outage, and the failure must not destroy it.
  // The stamp added for genuine failures has to honour the same contract.
  seedPosition(A, 'EURUSD', '111', 1.05)
  const T0 = Date.parse('2026-08-22T04:00:00Z')
  const okExec = {
    reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }),
  }
  await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: okExec, auditOpts: { nowMs: T0 } })
  const before = lastProtectionAudit(db, { accountId: A, nowMs: T0 })
  assert.equal(before.ok, true)

  const badExec = { reconcile: async () => { throw new Error('sidecar 502 Bad Gateway') } }
  await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec: badExec, auditOpts: { nowMs: T0 + 50_000 } })
  const after = lastProtectionAudit(db, { accountId: A, nowMs: T0 + 50_000 })
  assert.equal(after.at, before.at, 'the successful reading survives the failure')
  assert.equal(after.lastAttemptOk, false)
  assert.equal(after.lastAttemptAt, new Date(T0 + 50_000).toISOString())
})

test('the sweep RESTORES a lost target, not just reports it', async () => {
  // services/target-restore.js is pure and every one of its own tests would
  // stay green if the sweep never called it — failure mode #4, the shape that
  // left reconcileTradePricesToBroker reachable only from a route nobody runs.
  // This exercises the real sweep and asserts the amend actually went out.
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES ('EURUSD','long','open',?,'777')"
  ).run(A)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(t.lastInsertRowid, 'EURUSD', 'active', A, 1.09, 1.15, 'long', 1.10, 'bot')

  const amends = []
  const exec = {
    // A stop, no target — exactly what the four amend paths used to leave.
    reconcile: async () => ({ position: [{ positionId: '777', stopLoss: 1.09, takeProfit: null }] }),
  }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    tpSuggest: inertTp,
    exec,
    restoreOpts: { amend: async (_c, args) => { amends.push(args); return { executionType: 'OK' } } },
  })
  assert.equal(out.targetless, 1, 'the fault is still reported')
  assert.equal(out.targetsRestored, 1, 'and it was actually repaired')
  assert.equal(amends.length, 1)
  assert.equal(amends[0].takeProfit, 1.15)
  assert.equal(amends[0].stopLoss, 1.09, 'the stop must be re-sent or the repair creates a naked position')
})

test('a targetless position with NO recorded target is reported and left alone', async () => {
  // The suggester owns that case under its own rules. This must not guess.
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES ('GBPUSD','long','open',?,'888')"
  ).run(A)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(t.lastInsertRowid, 'GBPUSD', 'active', A, 1.29, null, 'long', 1.30, 'external')

  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '888', stopLoss: 1.29, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    tpSuggest: inertTp,
    exec,
    restoreOpts: { amend: async (_c, args) => { amends.push(args); return { executionType: 'OK' } } },
  })
  assert.equal(out.targetless, 1)
  assert.equal(out.targetsRestored, 0)
  assert.equal(amends.length, 0, 'nothing on record means nothing sent')
})

test('a failing restore does NOT take down the audit that found the fault', async () => {
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES ('EURUSD','long','open',?,'999')"
  ).run(A)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(t.lastInsertRowid, 'EURUSD', 'active', A, 1.09, 1.15, 'long', 1.10, 'bot')

  const exec = { reconcile: async () => ({ position: [{ positionId: '999', stopLoss: 1.09, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    tpSuggest: inertTp,
    exec,
    restoreOpts: { amend: async () => { throw new Error('broker said no') } },
  })
  assert.equal(out.targetless, 1, 'the audit still reported')
  assert.equal(out.targetsRestored, 0)
  assert.match(out.errors.join(' '), /target restore/)
})

test('the sweep CORRECTS a stop disagreement, not just reports it', async () => {
  // stop-adopt.js is pure and all of its own tests would stay green if the
  // sweep never called it (failure mode #4).
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES ('EURUSD','long','open',?,'555')"
  ).run(A)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(t.lastInsertRowid, 'EURUSD', 'active', A, 1.09, 1.15, 'long', 1.10, 'bot')

  // The broker holds a TIGHTER stop than the book — adoptable.
  const exec = { reconcile: async () => ({ position: [{ positionId: '555', stopLoss: 1.095, takeProfit: 1.15 }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.phantom, 1, 'the disagreement is still reported')
  assert.equal(out.stopsAdopted, 1, 'and the book was corrected')
  const after = db.prepare('SELECT current_sl FROM monitored_positions WHERE trade_id = ?').get(t.lastInsertRowid)
  assert.equal(after.current_sl, 1.095)
})

test('the sweep does NOT adopt a wider broker stop — the alert must survive', async () => {
  const t = db.prepare(
    "INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES ('EURUSD','long','open',?,'556')"
  ).run(A)
  db.prepare(
    "INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(t.lastInsertRowid, 'EURUSD', 'active', A, 1.09, 1.15, 'long', 1.10, 'bot')

  const exec = { reconcile: async () => ({ position: [{ positionId: '556', stopLoss: 1.085, takeProfit: 1.15 }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec })
  assert.equal(out.phantom, 1)
  assert.equal(out.stopsAdopted, 0, 'a wider stop is real unresolved exposure — it stays reported')
  const after = db.prepare('SELECT current_sl FROM monitored_positions WHERE trade_id = ?').get(t.lastInsertRowid)
  assert.equal(after.current_sl, 1.09, 'the book must keep disagreeing')
})

test('a CLEAN account (nothing open, nothing at the broker) still gets its per-account record (02-09-2026)', async () => {
  // The clean branch used to `continue` without writing the record, so once
  // the whole-book merge began naming stale accounts, an account with nothing
  // open read as "NOT audited for 12h" — production showed exactly that for
  // ACCT-DEMO-2 and ACCT-DEMO-3 while their sweeps ran every minute.
  seedPosition(A, 'EURUSD', '111', 1.05)
  const exec = {
    reconcile: async (c) => (String(c.accountId) === A
      ? { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: 1.09 }] }
      : { position: [] }),
  }
  const T = Date.parse('2026-09-02T02:00:00Z')
  const out = await runProtectionAuditAllAccounts(db, creds, { tpSuggest: inertTp, exec, nowMs: T })
  assert.equal(out.accounts, 2)
  const recB = lastProtectionAudit(db, { accountId: B, nowMs: T + 60_000 })
  assert.equal(recB.hasRun, true, 'the clean account was audited and must say so')
  assert.equal(recB.checked, 0)
  assert.equal(recB.ageSec, 60)
  const all = lastProtectionAudit(db, { nowMs: T + 60_000 })
  assert.equal(all.accountsStale, 0, 'a clean account is not a stale account')
})

// ---------------------------------------------------------------------------
// THE SECOND PATH HAD THE FACT AND NOT THE HAND (16-09-2026)
//
// Measured in production: `17 targetless` every pass, stable for 4.5 days, and
// exactly ONE `target SET` line across 12-09 → 16-09. This sweep runs from the
// fast monitor every ~60s and reaches every enabled account; the loop pass that
// carried suggestTarget/applyTarget runs every ~3–5 min. No production caller
// ever set `deps.auditOpts` — grep found it in tests only — so the faster and
// wider path called the audit with no way to act on what it found, while still
// consuming the shared six-hour mute window. §43 asks protection to have its
// own FUNCTIONING path; reporting is not functioning.
// ---------------------------------------------------------------------------

/** A targetless position: the broker holds a stop and no take profit. */
const targetlessOn = (acct, symbol, posId, sl, extra = {}) => {
  const t = db.prepare(
    'INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id) VALUES (?,?,?,?,?)'
  ).run(symbol, 'long', 'open', acct, posId)
  db.prepare(
    `INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(t.lastInsertRowid, symbol, 'active', acct, sl,
    extra.current_tp ?? null, 'long', extra.entry_price ?? null, extra.source ?? 'bot')
}

const oneAccount = () => { db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run(B) }

test('THE WIRING: this sweep now carries the applier, and the target lands on the position', async () => {
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05)
  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN volume node, 1.6R' }),
      makeTargetApplier: () => async (f, s) => { amends.push([f.positionId, s.tp, f.brokerSl]); return { ok: true } },
    },
  })
  assert.equal(out.targetless, 1, 'the fault is still reported')
  assert.deepEqual(amends, [['111', 1.13, 1.05]], 'and acted on, by THIS path')
  assert.equal(out.targetsSet, 1)
})

test('the suggester and applier are built against THIS account, never the selected one', async () => {
  // The amend must not be able to land on another account's position. `creds`
  // in the sweep is `{...baseCreds, accountId: id}`; a suggester built from
  // baseCreds would fetch bars for A while amending B.
  targetlessOn(B, 'GBPUSD', '222', 1.25)
  const builtFor = []
  const exec = {
    reconcile: async (c) => (String(c.accountId) === B
      ? { position: [{ positionId: '222', stopLoss: 1.25, takeProfit: null }] }
      : { position: [] }),
  }
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: (_db, c) => { builtFor.push(['suggest', String(c.accountId)]); return async () => null },
      makeTargetApplier: (_db, c) => { builtFor.push(['apply', String(c.accountId)]); return async () => ({ ok: true }) },
    },
  })
  assert.ok(builtFor.some(([k, id]) => k === 'apply' && id === B), JSON.stringify(builtFor))
  assert.ok(!builtFor.some(([, id]) => id !== A && id !== B), JSON.stringify(builtFor))
})

test('the raw broker snapshot reaches the suggester, not the flattened one', async () => {
  // `brokerSl` drops `tradeData`, and tp-suggest reads the open price off it.
  // Passing the flattened list would make every suggestion null — an applier
  // wired to a suggester that can never suggest is the same dead path again.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05)
  let seen = null
  const exec = {
    reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null, tradeData: { openPrice: 1.09 } }] }),
  }
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: (_db, _c, positions) => { seen = positions; return async () => null },
      makeTargetApplier: () => async () => ({ ok: true }),
    },
  })
  assert.equal(seen?.[0]?.tradeData?.openPrice, 1.09, 'tradeData survived to the suggester')
})

test('a position whose BOOK target can be restored is not amended twice in one sweep', async () => {
  // target-restore puts back the target the bot itself recorded, which beats a
  // fresh structural guess. Both firing on the same position in the same sweep
  // means two amends, the second silently overwriting the first.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05, { current_tp: 1.12, entry_price: 1.09 })
  const amends = []
  const restored = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: () => async (f, s) => { amends.push([f.positionId, s.tp]); return { ok: true } },
    },
    targetRestore: {
      restoreMissingTargets: async (_db, _c, findings) => {
        for (const f of findings) restored.push(f.positionId)
        return { restored: findings.length, skipped: [], errors: [] }
      },
    },
  })
  assert.deepEqual(amends, [], 'the structural applier stands down')
  assert.deepEqual(restored, ['111'], 'the recorded target is what goes back')
  assert.equal(out.targetsSet, 0)
})

test('a position with NO recorded target is exactly the one this fix reaches', async () => {
  // The complement of the test above, and the production population: adopted /
  // externally-sourced rows that never carried a target to restore.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05) // current_tp NULL
  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
    },
  })
  assert.deepEqual(amends, ['111'])
})

test('an externally-opened position is still never touched by this path', async () => {
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05, { source: 'external' })
  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
    },
  })
  assert.deepEqual(amends, [], "the owner's own trade keeps the owner's own exit")
  assert.equal(out.targetless, 1, 'still reported')
})

test('a momentum-book row is still never touched by this path', async () => {
  oneAccount()
  targetlessOn(A, '0005.HK', '111', 159.6)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
              VALUES (1, ?, '0005.HK', '111', 'long', 160, 159.642, '2026-09-08T01:33:00Z', 'open')`).run(A)
  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 159.6, takeProfit: null }] }) }
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 175, basis: 'HVN' }),
      makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
    },
  })
  assert.deepEqual(amends, [], 'the book exits by the trail; a 1.5R floor caps the right tail')
})

// ---------------------------------------------------------------------------
// BOTH CALLERS, PINNED IN SOURCE.
//
// A source-text test is a last resort and this is the case it is for: the two
// call sites live in agent/loop.js, which this change does not own, and the
// defect being pinned is precisely "one of two callers was missing an
// argument" — invisible from inside the module under test and droppable by a
// refactor in silence (recurring failure mode #4).
//
// Comments are STRIPPED before asserting (recurring failure mode #2): the word
// `applyTarget` appears in prose in both files, so an un-stripped scan would
// stay green with every call site gutted.
// ---------------------------------------------------------------------------
test('EVERY production caller of runProtectionAudit passes an applyTarget', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const agentRoot = path.resolve(here, '..')

  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(p)
    }
  }
  walk(agentRoot)

  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')

  // THE MUTATION GUARD FOR THE STRIPPER ITSELF. If `strip` ever stops working,
  // every assertion below passes for the wrong reason.
  assert.equal(strip('a // applyTarget\nb').includes('applyTarget'), false)
  assert.equal(strip('/* applyTarget */ x').includes('applyTarget'), false)

  const sites = []
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'))
    const re = /\brunProtectionAudit\s*\(/g
    let m
    while ((m = re.exec(src))) {
      // Walk to the matching close paren so the scan reads THIS call's
      // arguments and cannot borrow an `applyTarget` from the next one.
      let depth = 0, i = m.index + m[0].length - 1
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')') { depth--; if (depth === 0) break }
      }
      sites.push({ file: path.relative(agentRoot, f), args: src.slice(m.index, i + 1) })
    }
  }

  // The declaration in this module is not a call site.
  const calls = sites.filter(s => !/^runProtectionAudit\s*\(db, openRows, brokerPositions,/.test(s.args))
  assert.ok(calls.length >= 3,
    `expected the loop's two call sites plus this module's sweep, found ${calls.length}: ${calls.map(c => c.file).join(', ')}`)
  for (const c of calls) {
    assert.match(c.args, /\bapplyTarget\s*:/, `${c.file}: a caller with no applyTarget can only report, never repair`)
    assert.match(c.args, /\bsuggestTarget\s*:/, `${c.file}: an applier with no suggester has nothing to apply`)
  }
})

// ---------------------------------------------------------------------------
// THE REVIEW ROUND (16-09-2026), at the sweep level.
// ---------------------------------------------------------------------------

test('the sweep re-reads the stop from the broker immediately before each amend', async () => {
  // `positions` is captured by the FIRST reconcile, before the bar fetches.
  // The profit keeper's ratchet runs on its own band and can tighten a stop in
  // that window; amend REPLACES, so the snapshot value would widen it back.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05)
  // THE SNAPSHOT AND THE RE-READ MUST COME FROM DIFFERENT PLACES (17-09-2026).
  // The first version of this test drove both through `exec.reconcile`, which
  // is exactly the defect: in cpp mode that is the sidecar's 30-second cache,
  // so the "fresh" read returns the snapshot it is meant to doubt. Here
  // `exec.reconcile` is the sidecar-style cache (frozen at 1.05) and
  // `deps.wsReconcile` is the live broker (already ratcheted to 1.07).
  let live = 0
  const exec = {
    reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }),
  }
  const wsReconcile = async () => {
    live++
    // The live read carries the broker's own trade side: the applier reads
    // direction rather than inferring it from geometry.
    return { position: [{ positionId: '111', stopLoss: 1.07, takeProfit: null, tradeData: { tradeSide: 1 } }] }
  }
  let sawStop = null
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    wsReconcile,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      // The REAL applier, given the sweep's readPosition, so the wiring is
      // exercised rather than stubbed past.
      makeTargetApplier: (d, c, o) => realMakeTargetApplier(d, c, {
        ...o,
        amendPosition: async (_c, a) => { sawStop = a.stopLoss; return { executionType: 'OK' } },
        recordEvent: () => {},
      }),
    },
  })
  assert.equal(sawStop, 1.07, 'the ratcheted stop, not the cache it started from')
  assert.ok(live >= 1, 'the LIVE path was used, not exec.reconcile')
})

test('a position target-restore will NOT repair is taken by the applier, not starved', async () => {
  // Measured against the real target-restore: `target_restore_enabled=false`
  // starved 3 of 3; a NULL entry_price, 1 of 1; a recorded target on the wrong
  // side of entry, 1 of 1. All three are permanent, not a delay — nothing
  // about them changes next sweep. `current_tp > 0` was the wrong question.
  const { setState } = await import('../db.js')
  const cases = [
    ['restore switched off', () => setState(db, 'target_restore_enabled', 'false'), { current_tp: 1.12, entry_price: 1.09 }],
    ['no entry price on record', () => {}, { current_tp: 1.12, entry_price: null }],
    ['recorded target on the wrong side of entry', () => {}, { current_tp: 1.02, entry_price: 1.09 }],
  ]
  for (const [name, setup, extra] of cases) {
    db = initDB(':memory:')
    for (const [id, login] of [[A, '5067353'], [B, '5203012']]) {
      db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,0,1,?,?)').run(id, 'active', login)
    }
    oneAccount()
    setup()
    targetlessOn(A, 'EURUSD', '111', 1.05, extra)
    const amends = []
    const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
    await runProtectionAuditAllAccounts(db, creds, {
      exec,
      tpSuggest: {
        makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
        makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
      },
    })
    assert.deepEqual(amends, ['111'], `${name}: somebody must repair it`)
  }
})

test('a position target-restore WILL repair is still deferred to it', async () => {
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05, { current_tp: 1.12, entry_price: 1.09 })
  const amends = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
    },
    restoreOpts: { amend: async () => ({ executionType: 'OK' }) },
  })
  assert.deepEqual(amends, [], 'the recorded target is the more faithful repair')
  assert.equal(out.targetsRestored, 1)
})

test('the deferred set gets an OUTCOME line, so neither log line over-claims', async () => {
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05, { current_tp: 1.12, entry_price: 1.09 })
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')) }
  try {
    await runProtectionAuditAllAccounts(db, creds, {
      exec,
      tpSuggest: { makeTargetSuggester: () => async () => null, makeTargetApplier: () => async () => ({ ok: true }) },
      restoreOpts: { amend: async () => { throw new Error('broker said no') } },
    })
  } finally { console.log = orig }
  assert.ok(lines.some(l => /1 bot-owned \(deferred to target-restore\)/.test(l)), lines.join('\n'))
  assert.ok(lines.some(l => /1 deferred to target-restore — 0 restored, 1 still without a target/.test(l)), lines.join('\n'))
})

test('a partially stubbed target-restore still uses the REAL deciders', async () => {
  // A stub that supplies only `restoreMissingTargets` must not silently change
  // which repair path a position takes.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05, { current_tp: 1.12, entry_price: 1.09 })
  const amends = []
  const seen = []
  const exec = { reconcile: async () => ({ position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] }) }
  await runProtectionAuditAllAccounts(db, creds, {
    exec,
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: () => async (f) => { amends.push(f.positionId); return { ok: true } },
    },
    targetRestore: {
      restoreMissingTargets: async (_d, _c, findings) => { seen.push(...findings.map(f => f.positionId)); return { restored: 1, skipped: [], errors: [] } },
    },
  })
  assert.deepEqual(amends, [], 'the real planTargetRestore still decided this one')
  assert.deepEqual(seen, ['111'])
})

test('NO SWEEP TEST MAY REACH THE REAL APPLIER', async () => {
  // Without an injected tpSuggest these tests run the real suggester and
  // applier. The suggester returns null here only because
  // `Number(bp.tradeData?.openPrice ?? bp.price)` is NaN on a fake snapshot —
  // one added field and a unit test is one step from exec-engine.amendPosition,
  // which under EXEC_ENGINE=cpp is an HTTP POST to a sidecar. So the coverage
  // is vacuous AND one field from dangerous; this pins it shut.
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// runProtectionAuditAllAccounts'), false, 'comment stripper works')

  const re = /runProtectionAuditAllAccounts\s*\(/g
  let m, sites = 0
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) break }
    }
    const args = src.slice(m.index, i + 1)
    // The not-ready-credentials test never gets as far as building one.
    if (/ready:\s*false/.test(args)) continue
    sites++
    assert.match(args, /\btpSuggest\s*:/, `a sweep call with no tpSuggest can reach the real broker amend:\n${args}`)
  }
  assert.ok(sites >= 25, `expected the whole file scanned, found ${sites} call sites`)
})

test('the sweep never re-reads through exec.reconcile — that is the sidecar cache', async () => {
  // The whole of BLOCKER 1. `exec.reconcile` produced the snapshot; in cpp mode
  // it is `lastReconcileJson`, refreshed only by the sidecar's own 30s loop and
  // never by an amend. Counting the calls is the test: the snapshot costs ONE,
  // and the freshness check must not add another to the same source.
  oneAccount()
  targetlessOn(A, 'EURUSD', '111', 1.05)
  let cacheReads = 0, liveReads = 0
  await runProtectionAuditAllAccounts(db, creds, {
    exec: { reconcile: async () => { cacheReads++; return { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null }] } } },
    wsReconcile: async () => { liveReads++; return { position: [{ positionId: '111', stopLoss: 1.05, takeProfit: null, tradeData: { tradeSide: 1 } }] } },
    tpSuggest: {
      makeTargetSuggester: () => async () => ({ tp: 1.13, basis: 'HVN' }),
      makeTargetApplier: (d, c, o) => realMakeTargetApplier(d, c, {
        ...o, amendPosition: async () => ({ executionType: 'OK' }), recordEvent: () => {},
      }),
    },
  })
  assert.equal(cacheReads, 1, 'one snapshot for the pass, and no freshness check through it')
  assert.equal(liveReads, 1, 'the freshness check went to the live path')
})

test('NO SWEEP TEST MAY REACH A REAL SOCKET', async () => {
  // Found the hard way: after the re-read moved to wsReconcile, one test in
  // this file started dialling out — `[wsReconcile] retry 1/2 — getaddrinfo
  // ENOTFOUND undefined`. A unit test that can reach the network is a test
  // whose result depends on the network. Any sweep call that drives the REAL
  // applier must inject `wsReconcile` as well as `tpSuggest`.
  const fs = await import('node:fs')
  const url = await import('node:url')
  const src = fs.readFileSync(url.fileURLToPath(import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.equal(src.includes('// realMakeTargetApplier'), false, 'comment stripper works')

  const re = /runProtectionAuditAllAccounts\s*\(/g
  let m, checked = 0
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') { depth--; if (depth === 0) break }
    }
    const args = src.slice(m.index, i + 1)
    if (!/realMakeTargetApplier/.test(args)) continue
    checked++
    // `wsReconcile,` (shorthand) and `wsReconcile:` are both an injection.
    assert.match(args, /\bwsReconcile\s*[,:]/,
      `a sweep call driving the real applier with no injected wsReconcile will dial the broker:\n${args}`)
  }
  assert.ok(checked >= 2, `expected the real-applier call sites to be scanned, found ${checked}`)
})
