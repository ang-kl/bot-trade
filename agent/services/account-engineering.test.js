// node --test agent/services/account-engineering.test.js
//
// The per-account engineering view behind Desk's status panel. Owner: "The desk
// page should display the underlying engineering status for each account you are
// trading or not trading … Will the system still attempt to scan, analyze, or
// auto-trade those accounts? I am serious about avoiding unnecessary effort and
// expenses."
//
// The tests worth having here are the ones about NOT LYING: an unknown sidecar
// roster must not read as "not authorised", one account's reconcile must not be
// reported as another's, and a legacy NULL-account position must not be counted
// against every account at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { engineeringView, sidecarRoster, lastReconcileAt } from './account-engineering.js'
import { setAccountPhases } from './account-phases.js'

function db_() {
  const db = initDB(':memory:')
  const ins = db.prepare(
    'INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login,leverage,base_currency) VALUES (?,?,?,?,?,?,?)')
  ins.run('46130058', 0, 1, 'active', '5203012', 200, 'USD')
  ins.run('46979908', 0, 0, 'manage_only', '5268549', 200, 'USD')
  ins.run('42993489', 1, 0, 'manage_only', '1251247', 200, 'SGD')
  setState(db, 'ctrader_account_id', '46130058')
  setState(db, 'scan_enabled', 'true')
  setState(db, 'analyze_enabled', 'true')
  setState(db, 'autotrade_enabled', 'true')
  return db
}
const find = (v, id) => v.accounts.find(a => a.accountId === id)

test('every registry row appears, with mode and enabled as stored', () => {
  const v = db_()
  const out = engineeringView(v)
  assert.equal(out.accounts.length, 3)
  assert.equal(find(out, '46130058').enabled, true)
  assert.equal(find(out, '46130058').mode, 'active')
  assert.equal(find(out, '46130058').selected, true)
  assert.equal(find(out, '46979908').enabled, false)
  assert.equal(find(out, '46979908').mode, 'manage_only')
  assert.equal(find(out, '42993489').isLive, true)
  assert.equal(find(out, '42993489').selected, false)
})

test('phases are the EFFECTIVE ones, not the master flags', () => {
  const db = db_()
  setAccountPhases(db, '46979908', { autotrade: false })
  const out = engineeringView(db)
  assert.equal(out.master.autotrade, true)
  assert.equal(find(out, '46130058').phases.autotrade, true)
  assert.equal(find(out, '46979908').phases.autotrade, false)
  // 'capability' since the per-account autotrade flag was folded into
  // accounts.mode — one store for "may this account enter".
  assert.equal(find(out, '46979908').phases.source.autotrade, 'capability')
})

test('an UNKNOWN sidecar roster reports null, never false', () => {
  // "We have not been told" and "this account is not authorised" are different
  // facts, and one of them would send the owner hunting for a fault that is not
  // there. Nothing has persisted cpp_exec_health_json yet.
  const out = engineeringView(db_())
  assert.equal(out.sidecar.rosterKnown, false)
  assert.equal(out.sidecar.accounts, null)
  for (const a of out.accounts) assert.equal(a.sidecarAuthorised, null, a.accountId)
})

test('a KNOWN roster reports true/false per account', () => {
  const db = db_()
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['46130058'], connected: true, ok: true, at: '2026-07-30T05:00:00.000Z',
  }))
  const out = engineeringView(db)
  assert.equal(out.sidecar.rosterKnown, true)
  assert.equal(out.sidecar.connected, true)
  assert.equal(out.sidecar.at, '2026-07-30T05:00:00.000Z')
  assert.equal(find(out, '46130058').sidecarAuthorised, true)
  assert.equal(find(out, '46979908').sidecarAuthorised, false)
  assert.equal(find(out, '42993489').sidecarAuthorised, false)
})

test('an EMPTY roster is known and means authorised for nothing', () => {
  const db = db_()
  setState(db, 'cpp_exec_health_json', JSON.stringify({ accounts: [], connected: true, ok: true }))
  const out = engineeringView(db)
  assert.equal(out.sidecar.rosterKnown, true)
  for (const a of out.accounts) assert.equal(a.sidecarAuthorised, false, a.accountId)
})

test('TWO sidecars: each account is judged against its OWN side roster', () => {
  // THE PRODUCTION FALSE NEGATIVE, 2026-08-06. With a second sidecar deployed,
  // the live process's roster carries only the live account — so reading it for
  // a demo account answers "not authorised" for four accounts that are, at that
  // moment, connected and trading. Before this fix every demo row rendered
  // `false` while the demo sidecar reported accountCount 4, hasCredentials true.
  const db = db_()
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['42993489'], connected: true, ok: true, at: '2026-08-06T03:04:39.626Z',
  }))
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({
    accounts: ['46130058'], connected: true, ok: true, at: '2026-08-06T03:05:11.000Z',
  }))
  const out = engineeringView(db)
  assert.equal(find(out, '46130058').sidecarAuthorised, true, 'demo acct on the DEMO roster')
  assert.equal(find(out, '42993489').sidecarAuthorised, true, 'live acct on the LIVE roster')
  // And the split stays honest in the negative direction: a demo account absent
  // from the demo roster is still false, and the live roster cannot rescue it.
  assert.equal(find(out, '46979908').sidecarAuthorised, false)
  assert.equal(out.sidecarDemo.rosterKnown, true)
  assert.equal(out.sidecarDemo.at, '2026-08-06T03:05:11.000Z')
})

test('ONE sidecar: the demo block is absent and every account reads the live roster', () => {
  // The migration property. No demo key = today's single-process deployment,
  // and nothing about the answer changes.
  const db = db_()
  setState(db, 'cpp_exec_health_json', JSON.stringify({
    accounts: ['46130058', '42993489'], connected: true, ok: true,
  }))
  const out = engineeringView(db)
  assert.equal(out.sidecarDemo.rosterKnown, false)
  assert.equal(out.sidecarDemo.accounts, null)
  assert.equal(find(out, '46130058').sidecarAuthorised, true)
  assert.equal(find(out, '42993489').sidecarAuthorised, true)
  assert.equal(find(out, '46979908').sidecarAuthorised, false)
})

test('a demo roster that is KNOWN but EMPTY still overrides the live one', () => {
  // "The demo sidecar is up and authorised for nothing" is a real, reportable
  // state — a restart mid-recovery looks exactly like this. Falling back to the
  // live roster here would paper over it.
  const db = db_()
  setState(db, 'cpp_exec_health_json', JSON.stringify({ accounts: ['46130058'], ok: true }))
  setState(db, 'cpp_exec_demo_health_json', JSON.stringify({ accounts: [], connected: false, ok: true }))
  const out = engineeringView(db)
  assert.equal(find(out, '46130058').sidecarAuthorised, false, 'demo acct judged by the demo roster')
  assert.equal(out.sidecarDemo.connected, false)
})

test('sidecarRoster survives junk without throwing', () => {
  const db = db_()
  for (const junk of ['not json', '{"accounts":"nope"}', '[]', 'null']) {
    setState(db, 'cpp_exec_health_json', junk)
    const r = sidecarRoster(db)
    assert.ok(r.accounts === null || Array.isArray(r.accounts), `junk=${junk}`)
  }
})

test('open positions are counted per account; a NULL-account row is NOT charged to everyone', () => {
  const db = db_()
  const ins = db.prepare(
    `INSERT INTO monitored_positions (symbol, side, entry_price, status, account_id)
     VALUES (?, 'long', 1, 'active', ?)`)
  ins.run('Corn', '46130058')
  ins.run('EURUSD', '46130058')
  ins.run('XAUUSD', '46979908')
  ins.run('LEGACY', null)
  db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, status, account_id)
              VALUES ('OLD', 'long', 1, 'closed', '46130058')`).run()
  const out = engineeringView(db)
  assert.equal(find(out, '46130058').openPositions, 2, 'closed rows excluded')
  assert.equal(find(out, '46979908').openPositions, 1)
  assert.equal(find(out, '42993489').openPositions, 0)
  // Reported once, globally — attributing it to all three would triple-count
  // one position and make the totals disagree with the Positions page.
  assert.equal(out.legacyOpenPositions, 1)
})

test('last reconcile: the per-account key wins for every account', () => {
  const db = db_()
  setState(db, 'acct:46979908:last_reconcile_at', '2026-07-30T04:00:00.000Z')
  const out = engineeringView(db)
  assert.equal(find(out, '46979908').lastReconcileAt, '2026-07-30T04:00:00.000Z')
  assert.equal(find(out, '46979908').lastReconcileSource, 'account')
})

test('last reconcile: the GLOBAL key fills in ONLY for the selected account', () => {
  const db = db_()
  // The selected account's reconcile writes the global key (loop.js passes a
  // plain setState for it); every other account writes acct:<id>:…. Applying
  // the global fallback to all accounts would report the selected account's
  // sweep as though the others had been reconciled too.
  setState(db, 'last_reconcile_at', '2026-07-30T05:00:00.000Z')
  const out = engineeringView(db)
  assert.equal(find(out, '46130058').lastReconcileAt, '2026-07-30T05:00:00.000Z')
  assert.equal(find(out, '46130058').lastReconcileSource, 'global')
  assert.equal(find(out, '46979908').lastReconcileAt, null, 'must NOT inherit the selected account\'s sweep')
  assert.equal(find(out, '42993489').lastReconcileAt, null)
})

test('lastReconcileAt is exported and honours the same rule directly', () => {
  const db = db_()
  setState(db, 'last_reconcile_at', '2026-07-30T05:00:00.000Z')
  assert.equal(lastReconcileAt(db, '46130058', '46130058').source, 'global')
  assert.equal(lastReconcileAt(db, '46979908', '46130058').at, null)
})

test('last decision takes the NEWEST of decision_log and risk_events', () => {
  const db = db_()
  db.prepare(`INSERT INTO decision_log (account_id, symbol, stage, decision, reason, created_at)
              VALUES (?,?,?,?,?,?)`)
    .run('46130058', 'EURUSD', 'account_autotrade', 'skip', 'autotrade off', '2026-07-30T03:00:00Z')
  db.prepare(`INSERT INTO risk_events (account_id, symbol, side, approved, created_at)
              VALUES (?,?,?,?,?)`)
    .run('46130058', 'Corn', 'long', 1, '2026-07-30T04:00:00Z')
  const out = engineeringView(db)
  const a = find(out, '46130058')
  assert.equal(a.lastDecisionAt, '2026-07-30T04:00:00Z', 'the risk_events row is newer')
  assert.equal(a.lastDecisionStage, 'risk_gate')
  assert.equal(a.lastDecision, 'approved')
  // An account with no rows reports null rather than borrowing another's.
  assert.equal(find(out, '46979908').lastDecisionAt, null)
})

test('a MISSING balance is null, never 0 — 0 means wiped out', () => {
  const db = db_()
  setState(db, 'acct:46130058:account_balance_usd', '51531.56')
  const out = engineeringView(db)
  assert.equal(find(out, '46130058').balance, 51531.56)
  // Number(null) is 0 and 0 is finite, so the naive guard reports an account
  // with no recorded balance as holding nothing.
  assert.equal(find(out, '46979908').balance, null)
  // A genuine zero must still survive as zero.
  setState(db, 'acct:42993489:account_balance_usd', '0')
  assert.equal(find(engineeringView(db), '42993489').balance, 0)
})

test('an empty registry returns a shaped answer, not a throw', () => {
  const db = initDB(':memory:')
  const out = engineeringView(db)
  assert.deepEqual(out.accounts, [])
  assert.equal(out.sidecar.rosterKnown, false)
  assert.equal(out.legacyOpenPositions, 0)
})
