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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.errors.length, 1, 'the failure is reported, not swallowed')
  assert.match(out.errors[0], /broker timeout/)
  assert.equal(out.accounts, 1, 'and the other account was still audited')
  assert.equal(out.naked, 1, 'including its missing stop')
})

test('an account clean on both sides is counted, not skipped', async () => {
  const exec = { exec: null, reconcile: async () => ({ position: [] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.accounts, 2, 'both swept despite zero local rows')
  assert.equal(out.errors.length, 0)
})

test('not-ready credentials do nothing at all — never a false all-clear', async () => {
  seedPosition(A, 'EURUSD', '111', null)
  let called = false
  const exec = { reconcile: async () => { called = true; return { position: [] } } }
  const out = await runProtectionAuditAllAccounts(db, { ready: false }, { exec })
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
  await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.errors.length, 0, 'an unreachable account is not an audit failure')
  assert.equal(out.unauditable.length, 1)
  assert.match(out.unauditable[0], new RegExp(B))
  assert.equal(out.accounts, 1, 'and the reachable account was still audited')
})

test('a NON-auth failure on a reachable account still fails the sweep', async () => {
  // The safe default: anything not a recognised authorisation refusal means
  // we tried to check and could not, which is a protection question.
  const exec = { reconcile: async () => { throw new Error('socket hang up') } }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.accounts, 0)
  assert.equal(out.unauditable.length, 2)
  assert.equal(out.errors.length, 0, 'still not per-account failures')
  assert.equal(out.blind, true, 'but the SWEEP failed — it checked nothing')
})

test('blind is about reaching nothing, not about finding nothing', async () => {
  // Two clean accounts is the healthiest possible outcome and must never be
  // confused with the case above.
  const exec = { reconcile: async () => ({ position: [] }) }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
  assert.equal(out.accounts, 0)
  assert.equal(out.unauditable.length, 1, 'only the selected account was in the sweep')
  assert.equal(out.blind, false, 'there was nothing we were obliged to reach')
})

test('and an enabled roster that is wholly unreachable is STILL blind', async () => {
  // The half that must survive the narrowing above.
  const exec = {
    reconcile: async () => { throw new Error('cTrader error: CANT_ROUTE_REQUEST — Cannot route request') },
  }
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, { ...creds, accountId: SELECTED }, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, { ...creds, accountId: SELECTED }, { exec })
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
  const out = await runProtectionAuditAllAccounts(db, creds, { exec, auditOpts: { nowMs: T0 } })
  assert.equal(out.errors.length, 2, 'still a real audit failure for both accounts')

  const rec = lastProtectionAudit(db, { accountId: A, nowMs: T0 })
  assert.equal(rec.lastAttemptAt, new Date(T0).toISOString(),
    'the failing pass is on the record, not just in the return value')
  assert.match(String(rec.lastAttemptError), /502/)

  // And the NEXT failing pass moves it — the stamp is per-pass, not one-shot.
  await runProtectionAuditAllAccounts(db, creds, { exec, auditOpts: { nowMs: T0 + 50_000 } })
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
  await runProtectionAuditAllAccounts(db, creds, { exec: okExec, auditOpts: { nowMs: T0 } })
  const before = lastProtectionAudit(db, { accountId: A, nowMs: T0 })
  assert.equal(before.ok, true)

  const badExec = { reconcile: async () => { throw new Error('sidecar 502 Bad Gateway') } }
  await runProtectionAuditAllAccounts(db, creds, { exec: badExec, auditOpts: { nowMs: T0 + 50_000 } })
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
    exec,
    restoreOpts: { amend: async () => { throw new Error('broker said no') } },
  })
  assert.equal(out.targetless, 1, 'the audit still reported')
  assert.equal(out.targetsRestored, 0)
  assert.match(out.errors.join(' '), /target restore/)
})
