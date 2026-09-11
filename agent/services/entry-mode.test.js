// agent/services/entry-mode.test.js — the per-account entry fence (P1b).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

import { initDB, getState, setState } from '../db.js'
import { upsertAccount, syncSelectedAccount, ensureAccountRegistry, getAccountState, setAccountState } from './account-registry.js'
import { engineStatusFor, requestEntryMode, requestTickObservation, seedTickObservationFromConfig, admitEntry, entryEnginesView, ENGINE_STATUS_KEY, _resetRefusalDedupe, acknowledgeEntryEpochs, markEntryModeBlocked } from './entry-mode.js'
import * as engineModule from './entry-mode.js'
import { automaticProducers } from '../lib/entry-producers.js'
import { seedStrategyPinsFromConfig } from './stage-matrix.js'
import { seedMomentumAccountFromConfig } from './momentum-account.js'

const DEMO = '46130058', LIVE = '42993489'
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  return db
}

test('an account with no record is TIME_BASED / OFF, environment from the registry, and reading writes nothing', () => {
  const db = fresh()
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'TIME_BASED'); assert.equal(st.tickObservation, 'OFF'); assert.equal(st.environment, 'demo')
  assert.equal(engineStatusFor(db, LIVE).environment, 'live')
  assert.equal(st.stored, false)
  assert.equal(getAccountState(db, DEMO, ENGINE_STATUS_KEY), null, 'a read never writes')
  assert.equal(engineStatusFor(db, '999').effectiveEntryMode, 'TIME_BASED', 'an unknown account is not armed by omission either')
})

test('STOPPED refuses every automatic producer and admits manual ones; TIME_BASED refuses a tick-basis producer; epochs are monotonic', () => {
  const db = fresh()
  _resetRefusalDedupe()
  for (const p of automaticProducers()) assert.equal(admitEntry(db, { accountId: DEMO, producerId: p.id, basis: 'bar' }).ok, true, p.id)
  const r = requestEntryMode(db, DEMO, 'STOPPED', { expectedRevision: 0 })
  assert.equal(r.ok, true); assert.equal(r.status.configRevision, 1); assert.equal(r.status.modeEpoch, 1); assert.equal(r.changed, true)
  for (const p of automaticProducers()) {
    const a = admitEntry(db, { accountId: DEMO, producerId: p.id, basis: 'bar' })
    assert.equal(a.ok, false, p.id); assert.equal(a.reason, 'entry_mode_stopped'); assert.equal(a.modeEpoch, 1)
  }
  for (const id of ['route_manual_order', 'route_position_double', 'route_position_reverse', 'route_trade_now']) {
    assert.equal(admitEntry(db, { accountId: DEMO, producerId: id }).ok, true, `${id} is manual and admitted under STOPPED`)
  }
  assert.equal(admitEntry(db, { accountId: LIVE, producerId: 'scan_dispatch' }).ok, true, 'the other account is untouched')
  // one decision_log row per (account, producer, epoch), not per call
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM decision_log WHERE stage = 'entry_mode' AND account_id = ?`).get(DEMO).n
  assert.equal(rows, automaticProducers().length)
  // back to TIME_BASED: epoch 2 — WARMING with entries still stopped until
  // the gateway echoes the epoch (11-09-2026 audit, plan §3.6); acknowledged
  // → STABLE and effective; tick producers still refused there
  const back = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 1 })
  assert.equal(back.ok, true); assert.equal(back.status.modeEpoch, 2)
  assert.equal(back.status.transitionState, 'WARMING'); assert.equal(back.status.effectiveEntryMode, 'STOPPED'); assert.equal(back.status.requestedEntryMode, 'TIME_BASED')
  assert.equal(back.status.fenceAckEpoch, null, 'the ack is the sidecar\'s echo, never our own write')
  const warming = admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar' })
  assert.equal(warming.ok, false); assert.match(warming.reason, /^entry_mode_transition: WARMING/)
  assert.deepEqual(acknowledgeEntryEpochs(db, { [DEMO]: 1 }), [], 'an older epoch echoed binds nothing')
  const acked = acknowledgeEntryEpochs(db, { [DEMO]: 2, [LIVE]: 0 })
  assert.equal(acked.length, 1); assert.equal(acked[0].effectiveEntryMode, 'TIME_BASED'); assert.equal(acked[0].transitionState, 'STABLE')
  assert.equal(engineStatusFor(db, DEMO).fenceAckEpoch, 2)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar' }).ok, true)
  const tick = admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'tick' })
  assert.equal(tick.ok, false); assert.match(tick.reason, /^entry_mode_basis: TIME_BASED admits bar/)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'nope' }).ok, false)
  assert.equal(admitEntry(db, { accountId: null, producerId: 'scan_dispatch' }).reason, 'no_account')
})

test('a stale revision is refused; TICK_MOMENTUM is refused until the engine exists; an unknown mode is refused', () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED', { expectedRevision: 0 })
  const stale = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 0 })
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'revision_conflict'); assert.equal(stale.current, 1)
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'STOPPED', 'nothing changed on a conflict')
  const tick = requestEntryMode(db, DEMO, 'TICK_MOMENTUM', { expectedRevision: 1 })
  assert.equal(tick.ok, false); assert.match(tick.reason, /^tick_readiness_unavailable/, 'P6b: no readiness function → no path into tick trading')
  assert.equal(requestEntryMode(db, DEMO, 'PAUSED').ok, false)
  assert.equal(engineStatusFor(db, DEMO).configRevision, 1)
  const log = db.prepare(`SELECT body FROM action_log WHERE path = '/actions/entry-mode'`).all()
  assert.equal(log.length, 1)
  assert.equal(JSON.parse(log[0].body).to, 'STOPPED')
})

test('STOPPED survives a process restart, the boot seeds, and account selection (TM-16)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'em-'))
  const file = join(dir, 'agent.db')
  let db = initDB(file)
  upsertAccount(db, { accountId: DEMO, isLive: false })
  requestEntryMode(db, DEMO, 'STOPPED')
  db.close()
  db = initDB(file)
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'STOPPED', 'persisted across an open')
  // the boot seeds run and touch pins / momentum config, never the engine record
  setState(db, 'ctrader_account_id', DEMO)
  ensureAccountRegistry(db)
  seedStrategyPinsFromConfig(db, { getState, setState }, {})
  seedMomentumAccountFromConfig(db, {})
  syncSelectedAccount(db, DEMO, false)
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'STOPPED'); assert.equal(st.modeEpoch, 1)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'cross_sectional_book' }).ok, false)
  db.close()
})

test('AUDIT 11-09-2026: a failed gateway push leaves the account BLOCKED with entries stopped; an ack while an entry is UNKNOWN binds the fence but activates nothing', () => {
  const db = fresh()
  _resetRefusalDedupe()
  requestEntryMode(db, DEMO, 'STOPPED', { expectedRevision: 0 })
  const back = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 1 })
  assert.equal(back.status.transitionState, 'WARMING')
  const blocked = markEntryModeBlocked(db, DEMO, 'sidecar 502')
  assert.equal(blocked.changed, true); assert.equal(blocked.status.transitionState, 'BLOCKED'); assert.equal(blocked.status.effectiveEntryMode, 'STOPPED')
  const held = admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch' })
  assert.equal(held.ok, false); assert.match(held.reason, /^entry_mode_transition: BLOCKED/)
  // a later probe echoes the epoch: BLOCKED → STABLE, effective
  const acked = acknowledgeEntryEpochs(db, { [DEMO]: 2 }, { source: 'probe:test' })
  assert.equal(acked.length, 1); assert.equal(acked[0].transitionState, 'STABLE'); assert.equal(acked[0].effectiveEntryMode, 'TIME_BASED')
  assert.equal(markEntryModeBlocked(db, DEMO, 'late failure').changed, false, 'a bound, stable fence is not blocked by a stale failure report')
  // an UNKNOWN entry outcome: the ack binds the fence (fenceAckEpoch) but the engine stays off
  const s2 = requestEntryMode(db, DEMO, 'STOPPED', { expectedRevision: 2 })
  assert.equal(s2.status.modeEpoch, 3)
  const cur = engineStatusFor(db, DEMO)
  const { writeEngineStatus } = engineModule
  writeEngineStatus(db, { ...cur, entryCounts: { ...cur.entryCounts, unknown: 1 }, transitionState: 'RECONCILING' })
  const r3 = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 3 })
  assert.equal(r3.status.transitionState, 'RECONCILING'); assert.equal(r3.status.effectiveEntryMode, 'STOPPED')
  const ack3 = acknowledgeEntryEpochs(db, { [DEMO]: 4 })
  assert.equal(ack3.length, 1); assert.equal(ack3[0].transitionState, 'RECONCILING'); assert.equal(ack3[0].effectiveEntryMode, 'STOPPED')
  assert.equal(engineStatusFor(db, DEMO).fenceAckEpoch, 4, 'the fence is bound even though the unknown holds activation')
  assert.equal(acknowledgeEntryEpochs(db, { [DEMO]: 4 }).length, 0, 'an ack already bound changes nothing')
  const log = db.prepare(`SELECT method FROM action_log WHERE account_id = ? AND method IN ('ACK', 'BLOCK')`).all(DEMO).map(r => r.method)
  assert.deepEqual(log, ['BLOCK', 'ACK', 'ACK'])
})

test('a corrupt record reads as the OFF default and is reported invalid, never as armed', () => {
  const db = fresh()
  setState(db, `acct:${DEMO}:${ENGINE_STATUS_KEY}`, JSON.stringify({ requestedEntryMode: 'TICK_MOMENTUM', effectiveEntryMode: 'TICK_MOMENTUM' }))
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'TIME_BASED'); assert.ok(Array.isArray(st.invalid) && st.invalid.length > 0)
  setState(db, `acct:${DEMO}:${ENGINE_STATUS_KEY}`, '{not json')
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'TIME_BASED')
})

test('entryEnginesView lists every registry account, redacted, with resting counts and the phase note', () => {
  const db = fresh()
  requestEntryMode(db, LIVE, 'STOPPED')
  try { db.prepare(`INSERT INTO pending_orders (symbol, status, account_id) VALUES ('EURUSD', 'working', ?)`).run(LIVE) } catch { /* column absent on this schema */ }
  const v = entryEnginesView(db)
  assert.equal(v.accounts.length, 2)
  const live = v.accounts.find(a => a.environment === 'live')
  assert.equal(live.accountId, '…3489'); assert.equal(live.effectiveEntryMode, 'STOPPED'); assert.equal(live.stored, true)
  assert.ok(live.entryCounts.resting >= 0)
  assert.equal(v.accounts.find(a => a.environment === 'demo').stored, false)
  assert.match(v.note, /echoes the new epoch/)
  assert.ok(!JSON.stringify(v).includes(LIVE), 'full account ids never leave the process')
})

test('wiring pins (comments stripped): the fence is called at every Node producer, re-checked in exec-engine, and the feeder refuses to arm a STOPPED account', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'))
  assert.match(src('../lib/exec-engine.js'), /creds\?\.entryAdmission[\s\S]{0,400}ENTRY_MODE_REFUSED/, 'the last Node boundary re-checks the fence')
  assert.match(src('../lib/ctrader-creds.js'), /entryAdmission: \(\) => admitEntry\(db, \{ accountId: id, producerId, basis \}\)/)
  // P2a: every hand-built creds object goes through the one helper that
  // attaches the fence AND the ledger; a bare object can no longer place.
  assert.match(src('../loop.js'), /execPlaceOrder\(attachEntryFence\(db, \{ host, clientId, clientSecret, accessToken, accountId, execGuard \}, \{ producerId \}\)/, 'autoTrade\'s hand-built creds carry the fence and the ledger')
  assert.equal((src('../loop.js').match(/attachEntryFence\(db, \{ host: isLive \? 'live\.ctraderapi\.com' : 'demo\.ctraderapi\.com', clientId, clientSecret, accessToken, accountId \}, \{ producerId: 'closed_market_limits' \}\)/g) || []).length, 2, 'both closed-market call sites')
  assert.match(src('../loop.js'), /getCtraderCreds\(db, undefined, \{ producerId: 'pending_fib_orders' \}\)/, 'the pending pass names its producer')
  assert.ok(!/\bexecPlaceOrder\(\{ host,/.test(src('../loop.js')), 'no bare hand-built creds reach placeOrder')
  assert.match(src('../lib/ctrader-creds.js'), /entryLedger: \{[\s\S]{0,400}reserve: \(o = \{\}\) => reserveEntry\(db/, 'the ledger rides with the credentials')
  assert.match(src('./closed-market-limits.js'), /admitEntry\(db, \{ accountId: creds\.accountId, producerId: 'closed_market_limits'/)
  assert.match(src('./pending-orders.js'), /admitEntry\(db, \{ accountId: creds\.accountId, producerId: 'pending_fib_orders'/)
  assert.match(src('./vpo-feeder.js'), /admitEntry\(db, \{ accountId: String\(acct\), producerId: 'vpo_cpp_direct'/)
  assert.match(src('./momentum-book.js'), /producerId: 'cross_sectional_book'/)
  assert.match(src('./momentum-account.js'), /producerId: 'daily_momentum_account'/)
  assert.match(src('./burn-in.js'), /producerId: 'burn_in_probe'/)
  const actions = src('../routes/actions.js')
  for (const id of ['route_trade_now', 'route_validation_fill', 'route_execute_trade', 'route_manual_order', 'route_position_double', 'route_position_reverse']) {
    assert.ok(actions.includes(`producerId: '${id}'`), `${id} names itself at its creds`)
  }
  assert.ok(actions.includes("router.post('/entry-mode'"))
  assert.ok(src('../routes/state.js').includes("router.get('/entry-engines'"))
  // AUDIT 11-09-2026 (plan §3.1 / §3.6): the switch pushes the gateway NOW —
  // the guard (forced), the VPO disarm — and blocks on a failed push; the JS
  // fallback transport re-reads the fence right before its own write.
  // PR-G: the post-switch block moved to entry-mode-gateway.js so the bot's
  // pass binds the epoch the same way; the route calls it, the helper carries
  // the forced push, the disarm and the block (entry-mode-gateway.test.js).
  assert.match(actions, /router\.post\('\/entry-mode'[\s\S]{0,3000}bindEntryModeGateway\(db, String\(accountId\), mode, \{ epoch: r\.status\.modeEpoch \}\)/, 'the route binds the gateway on a switch')
  const gateway = src('./entry-mode-gateway.js')
  assert.match(gateway, /syncExecGuard\(db, d\.execMod, side, \{ reportedGuard: null, creds, force: true \}\)/, 'the helper forces the guard push on a switch')
  assert.match(gateway, /pushVpoDisarm\(db, id, /, 'the helper disarms the VPO tier on a switch')
  assert.match(gateway, /markEntryModeBlocked\(db, id, sync\.error/, 'a failed push blocks the account')
  assert.match(src('../lib/exec-engine.js'), /again = await creds\.entryAdmission\(\)[\s\S]{0,400}wsPlaceOrder\(/, 'the fallback write re-reads the fence')
  assert.match(src('./exec-guard-sync.js'), /acknowledgeEntryEpochs\(db, reportedGuard\.entryEpochs/, 'every probe acknowledges what the sidecar reports')
  assert.match(src('./exec-guard-sync.js'), /acknowledgeEntryEpochs\(db, echoed/, 'the push acknowledges what its reply echoes')
  assert.match(actions, /credsForPosition\(db, positionId, \{ producerId: 'route_position_double' \}\)/, 'a manual double acts through the position\'s own account')
  assert.match(actions, /credsForPosition\(db, positionId, \{ producerId: 'route_position_reverse' \}\)/, 'a manual reverse acts through the position\'s own account')
})

test('P3a/P4: tick observation OFF → RECORD → OFF moves the revision, never the epoch; SHADOW is admitted since P4; the fence is untouched', () => {
  const db = fresh()
  _resetRefusalDedupe()
  const r = requestTickObservation(db, DEMO, 'RECORD', { expectedRevision: 0 })
  assert.equal(r.ok, true); assert.equal(r.changed, true)
  assert.equal(r.status.tickObservation, 'RECORD'); assert.equal(r.status.configRevision, 1); assert.equal(r.status.modeEpoch, 0)
  assert.equal(engineStatusFor(db, DEMO).tickObservation, 'RECORD', 'persisted')
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'TIME_BASED', 'observation changes no entry authority')
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar' }).ok, true, 'time entries continue while observing')
  assert.equal(requestTickObservation(db, DEMO, 'RECORD', { expectedRevision: 0 }).reason, 'revision_conflict')
  const shadow = requestTickObservation(db, DEMO, 'SHADOW')
  assert.equal(shadow.ok, true, 'P4: SHADOW runs the strategy in shadow — signals only'); assert.equal(shadow.status.tickObservation, 'SHADOW'); assert.equal(shadow.status.modeEpoch, 0)
  assert.equal(requestTickObservation(db, DEMO, 'BOGUS').ok, false)
  const off = requestTickObservation(db, DEMO, 'OFF')
  assert.equal(off.ok, true); assert.equal(off.status.tickObservation, 'OFF'); assert.equal(off.status.configRevision, 3)
  const again = requestTickObservation(db, DEMO, 'OFF')
  assert.equal(again.ok, true); assert.equal(again.changed, false)
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ?`).get(DEMO).n
  assert.equal(rows, 4)
  // a STOPPED account keeps its observation setting: the two switches are independent
  requestEntryMode(db, DEMO, 'STOPPED')
  requestTickObservation(db, DEMO, 'RECORD')
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'STOPPED'); assert.equal(st.tickObservation, 'RECORD'); assert.equal(st.modeEpoch, 1)
})

test('P3b: the tick-observation seed applies once per file content, leaves a later operator switch alone, and re-applies when the file changes', () => {
  const db = fresh()
  const dir = mkdtempSync(join(tmpdir(), 'tick-obs-'))
  const file = join(dir, 'tick-observation.json')
  const universe = join(dir, 'momentum-universe.json')
  writeFileSync(universe, JSON.stringify({ _note: 'x', fx: ['EURUSD', 'eurusd'], stock: ['AAPL.US'] }))
  writeFileSync(file, JSON.stringify({ accounts: { [DEMO]: 'RECORD', 999: 'RECORD', [LIVE]: 'SHADOW' }, symbols: 'momentum-universe' }))
  const lines = []
  const r = seedTickObservationFromConfig(db, { file, universeFile: universe, log: (m) => lines.push(m) })
  assert.equal(r.error, null)
  assert.equal(engineStatusFor(db, DEMO).tickObservation, 'RECORD')
  assert.equal(engineStatusFor(db, LIVE).tickObservation, 'SHADOW', 'P4: SHADOW is a valid declaration (signals only)')
  assert.ok(r.skipped.some(s => s.includes('not in the registry')))
  assert.deepEqual([...r.applied].sort(), [`…${DEMO.slice(-4)}:RECORD`, `…${LIVE.slice(-4)}:SHADOW`].sort())
  assert.equal(r.symbols, 2)
  assert.deepEqual(JSON.parse(getState(db, 'tick_symbols_json')), ['EURUSD', 'AAPL.US'])
  assert.equal(lines.length, 2, 'one boot line per applied account')
  // the operator switches it off; the same file on the next boot does not re-apply
  assert.equal(requestTickObservation(db, DEMO, 'OFF').ok, true)
  setState(db, 'tick_symbols_json', JSON.stringify(['XAUUSD']))
  const again = seedTickObservationFromConfig(db, { file, universeFile: universe })
  assert.deepEqual(again.applied, []); assert.ok(again.unchanged.includes(DEMO))
  assert.equal(engineStatusFor(db, DEMO).tickObservation, 'OFF', 'seed once: the operator\'s OFF stands')
  assert.deepEqual(JSON.parse(getState(db, 'tick_symbols_json')), ['XAUUSD'], 'and so does the operator\'s symbol list')
  // the file changes: applied again
  writeFileSync(file, JSON.stringify({ accounts: { [DEMO]: 'RECORD' }, symbols: ['gbpusd', 'bad symbol!'] }))
  const third = seedTickObservationFromConfig(db, { file, universeFile: universe })
  assert.deepEqual(third.applied, [`…${DEMO.slice(-4)}:RECORD`])
  assert.deepEqual(JSON.parse(getState(db, 'tick_symbols_json')), ['GBPUSD'])
  // the checked-in file names EVERY account (PR-B, principle 9) and the momentum universe, and boot wires the seed
  const cfg = JSON.parse(readFileSync(new URL('../config/tick-observation.json', import.meta.url), 'utf8'))
  assert.deepEqual(cfg.accounts, { _all: 'SHADOW' }, 'PR-H: every enabled account observes in SHADOW'); assert.equal(cfg.symbols, 'momentum-universe')
  const boot = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(boot, /seedTickObservationFromConfig\(db, \{ log/)
})

test('PR-B (owner principle 9): accounts._all seeds every ENABLED registry account, a per-id key still wins, a disabled account is left alone, and an account enabled after the first boot is seeded on its next boot', () => {
  const db = fresh()
  const THIRD = '46979908', OFF = '47790949', LATER = '43097342'
  upsertAccount(db, { accountId: THIRD, isLive: true })
  upsertAccount(db, { accountId: OFF, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  db.prepare(`UPDATE accounts SET enabled = 0 WHERE account_id = '${OFF}'`).run()
  const dir = mkdtempSync(join(tmpdir(), 'tick-obs-all-'))
  const file = join(dir, 'tick-observation.json')
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'RECORD', [LIVE]: 'SHADOW' }, symbols: ['EURUSD'] }))
  const r = seedTickObservationFromConfig(db, { file })
  assert.equal(r.error, null)
  assert.deepEqual([...r.applied].sort(), [`…${DEMO.slice(-4)}:RECORD`, `…${LIVE.slice(-4)}:SHADOW`, `…${THIRD.slice(-4)}:RECORD`].sort(), 'every enabled account, the explicit key winning for its id')
  assert.equal(engineStatusFor(db, OFF).tickObservation, 'OFF', 'a disabled account is not seeded')
  assert.equal(engineStatusFor(db, LIVE).tickObservation, 'SHADOW')
  // The operator switches one off; the same file on the next boot leaves it.
  requestTickObservation(db, THIRD, 'OFF')
  const again = seedTickObservationFromConfig(db, { file })
  assert.deepEqual(again.applied, []); assert.equal(engineStatusFor(db, THIRD).tickObservation, 'OFF', 'seed once still holds under _all')
  // A NEW account joins the registry (enabled) after the file was applied: seeded on its first boot, nothing else touched.
  upsertAccount(db, { accountId: LATER, isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '${LATER}'`).run()
  const late = seedTickObservationFromConfig(db, { file })
  assert.deepEqual(late.applied, [`…${LATER.slice(-4)}:RECORD`], 'RED if the content hash alone decides and the late account is skipped')
  assert.equal(engineStatusFor(db, THIRD).tickObservation, 'OFF', 'the operator\'s OFF still stands')
  assert.equal(engineStatusFor(db, LATER).tickObservation, 'RECORD')
  assert.deepEqual(seedTickObservationFromConfig(db, { file }).applied, [], 'and it is reached only once')
  assert.deepEqual(JSON.parse(getState(db, 'tick_observation_seed_json')).reached.sort(), [DEMO, LIVE, THIRD, LATER].sort())
})

test('PR-H: the file moving _all RECORD → SHADOW re-applies at the next boot to EVERY enabled account — one the operator had switched OFF included — a per-id key still winning, and the seed record moves to the new content', () => {
  const db = fresh()
  const THIRD = '1003', OFF = '1004'
  upsertAccount(db, { accountId: THIRD, isLive: true })
  upsertAccount(db, { accountId: OFF, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  db.prepare(`UPDATE accounts SET enabled = 0 WHERE account_id = '${OFF}'`).run()
  const dir = mkdtempSync(join(tmpdir(), 'tick-obs-shadow-'))
  const file = join(dir, 'tick-observation.json')
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'RECORD' }, symbols: ['EURUSD'] }))
  assert.equal(seedTickObservationFromConfig(db, { file }).error, null)
  for (const id of [DEMO, LIVE, THIRD]) assert.equal(engineStatusFor(db, id).tickObservation, 'RECORD')
  const before = JSON.parse(getState(db, 'tick_observation_seed_json'))
  // the operator switches one off; a LIVE id gets its own key
  requestTickObservation(db, THIRD, 'OFF')
  assert.deepEqual(seedTickObservationFromConfig(db, { file }).applied, [], 'same content: the operator\'s OFF stands')
  // PR-H: the file changes RECORD → SHADOW under _all
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'SHADOW', [LIVE]: 'RECORD' }, symbols: ['EURUSD'] }))
  const lines = []
  const r = seedTickObservationFromConfig(db, { file, log: (m) => lines.push(m) })
  assert.equal(r.error, null)
  assert.deepEqual([...r.applied].sort(), [`…${DEMO.slice(-4)}:SHADOW`, `…${THIRD.slice(-4)}:SHADOW`].sort(), 'RED if a reached account is skipped on a content change (the seed-once rule must yield to the new declaration)')
  assert.equal(engineStatusFor(db, DEMO).tickObservation, 'SHADOW')
  assert.equal(engineStatusFor(db, THIRD).tickObservation, 'SHADOW', 'the operator\'s OFF is overridden by the new declaration — the file is the owner\'s word')
  assert.equal(engineStatusFor(db, LIVE).tickObservation, 'RECORD', 'the per-id key wins over _all')
  assert.equal(engineStatusFor(db, OFF).tickObservation, 'OFF', 'a disabled account is not under _all')
  const after = JSON.parse(getState(db, 'tick_observation_seed_json'))
  assert.notEqual(after.hash, before.hash, 'the seed record carries the new content hash')
  // each switch is on the action log as the file's own actor (tick-validation shadowWindow reads these rows; a switch BEFORE the profile pin does not open the window — the pin does, see tick-validation.test.js)
  const rows = db.prepare(`SELECT account_id, body FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ? ORDER BY id`).all(DEMO)
  const last = JSON.parse(rows[rows.length - 1].body)
  assert.equal(last.to, 'SHADOW'); assert.equal(last.actor, 'config/tick-observation.json')
  // the same content again: nothing re-applied
  assert.deepEqual(seedTickObservationFromConfig(db, { file }).applied, [])
  // the checked-in file IS that declaration
  const cfg = JSON.parse(readFileSync(new URL('../config/tick-observation.json', import.meta.url), 'utf8'))
  assert.deepEqual(cfg.accounts, { _all: 'SHADOW' })
})

test('P6b / PR-B: TICK_MOMENTUM is admitted on ANY account whose injected readiness is clean — readiness is the only gate, a live account is not refused on its environment; the tick producer is then admitted and bar producers are not', async () => {
  const db = fresh()
  const notReady = () => ({ ready: false, blockedReasons: ['recorder_recording', 'validation_stage'] })
  const ready = () => ({ ready: true, blockedReasons: [] })
  const boom = () => { throw new Error('status table missing') }
  const r1 = requestEntryMode(db, DEMO, 'TICK_MOMENTUM', { readiness: notReady })
  assert.equal(r1.ok, false); assert.equal(r1.reason, 'tick_not_ready: recorder_recording, validation_stage'); assert.deepEqual(r1.blockedReasons, ['recorder_recording', 'validation_stage'])
  // PR-B (owner principle 1): the live account with the same evidence is
  // admitted the same way — WARMING until the gateway acks. RED if the old
  // `tick_live_refused` environment test comes back.
  const { profileHashFull: phf, DEFAULT_PARAMS: dp } = await import('../lib/tick-strategy.js')
  engineModule.writeEngineStatus(db, { ...engineStatusFor(db, LIVE), profileHash: phf(dp), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: 1, updatedAt: new Date().toISOString() })
  const r2 = requestEntryMode(db, LIVE, 'TICK_MOMENTUM', { readiness: ready })
  assert.equal(r2.ok, true, `live admitted on readiness alone: ${r2.reason}`)
  assert.equal(r2.status.requestedEntryMode, 'TICK_MOMENTUM'); assert.equal(r2.status.transitionState, 'WARMING')
  assert.doesNotMatch(JSON.stringify(r2), /tick_live_refused/)
  const liveNotReady = requestEntryMode(db, LIVE, 'TIME_BASED')
  assert.equal(liveNotReady.ok, true)
  const r2b = requestEntryMode(db, LIVE, 'TICK_MOMENTUM', { readiness: notReady })
  assert.equal(r2b.ok, false); assert.match(r2b.reason, /^tick_not_ready/, 'a live account is refused ONLY by readiness')
  const r3 = requestEntryMode(db, DEMO, 'TICK_MOMENTUM', { readiness: boom })
  assert.equal(r3.ok, false); assert.match(r3.reason, /^tick_readiness_error: status table missing/)
  assert.equal(engineStatusFor(db, DEMO).requestedEntryMode, 'TIME_BASED', 'three refusals wrote nothing')
  // The contract (P0) refuses an effective TICK_MOMENTUM without a pinned
  // profile and SHADOW_PASSED — readiness would have refused too; pin them.
  const { profileHashFull, DEFAULT_PARAMS } = await import('../lib/tick-strategy.js')
  engineModule.writeEngineStatus(db, { ...engineStatusFor(db, DEMO), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: 1, updatedAt: new Date().toISOString() })
  const ok = requestEntryMode(db, DEMO, 'TICK_MOMENTUM', { readiness: ready })
  assert.equal(ok.ok, true)
  assert.equal(ok.status.requestedEntryMode, 'TICK_MOMENTUM')
  assert.equal(ok.status.effectiveEntryMode, 'STOPPED', 'active modes wait for the gateway ack')
  assert.equal(ok.status.transitionState, 'WARMING')
  // the sidecar echoes the epoch → STABLE, effective TICK_MOMENTUM
  acknowledgeEntryEpochs(db, { [DEMO]: ok.status.modeEpoch })
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'TICK_MOMENTUM'); assert.equal(st.transitionState, 'STABLE')
  _resetRefusalDedupe()
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'tick_momentum', basis: 'tick' }).ok, true, 'the tick producer is admitted under TICK_MOMENTUM')
  const bar = admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar' })
  assert.equal(bar.ok, false); assert.match(bar.reason, /^entry_mode_basis/)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'route_manual_order' }).ok, true, 'manual keeps its own attribution under any mode')
  // and the tick producer is refused everywhere else
  assert.equal(admitEntry(db, { accountId: LIVE, producerId: 'tick_momentum', basis: 'tick' }).ok, false)
})

// ---------------------------------------------------------------------------
// PR-G (owner principle 2): the switch policy — manual | auto per account.
// ---------------------------------------------------------------------------
test('PR-G: the policy defaults to manual, is exposed by the view, and requestEntryModePolicy moves only the revision (409 on a stale one)', () => {
  const db = fresh()
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'manual')
  assert.equal(entryEnginesView(db).accounts.find(a => a.accountId.endsWith(DEMO.slice(-4))).entryModePolicy, 'manual')
  const r = engineModule.requestEntryModePolicy(db, DEMO, 'AUTO', { expectedRevision: 0 })
  assert.equal(r.ok, true); assert.equal(r.status.entryModePolicy, 'auto'); assert.equal(r.status.configRevision, 1); assert.equal(r.status.modeEpoch, 0, 'no epoch moves: the policy is not a mode')
  assert.equal(r.changed, true)
  assert.equal(entryEnginesView(db).accounts.find(a => a.accountId.endsWith(DEMO.slice(-4))).entryModePolicy, 'auto')
  const stale = engineModule.requestEntryModePolicy(db, DEMO, 'manual', { expectedRevision: 0 })
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'revision_conflict'); assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'auto')
  assert.equal(engineModule.requestEntryModePolicy(db, DEMO, 'sometimes').ok, false)
  const row = db.prepare(`SELECT body FROM action_log WHERE path = '/actions/entry-mode-policy' ORDER BY id DESC LIMIT 1`).get()
  assert.deepEqual(JSON.parse(row.body), { accountId: DEMO, from: 'manual', to: 'auto', revision: 1, actor: 'owner' })
  // a record stored before the field existed reads as manual
  const stored = JSON.parse(getAccountState(db, LIVE, ENGINE_STATUS_KEY) || 'null')
  assert.equal(stored, null)
  const { entryModePolicy, ...legacy } = engineStatusFor(db, DEMO) // eslint-disable-line no-unused-vars
  delete legacy.stored; delete legacy.invalid
  setAccountState(db, DEMO, ENGINE_STATUS_KEY, JSON.stringify(legacy))
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'manual', 'absent field → manual, never auto by omission')
})

test('PR-G: an actor auto:* is refused on a manual account (policy_manual) and admitted on an auto one; a human is admitted on both', () => {
  const db = fresh()
  const ready = () => ({ ready: true, blockedReasons: [], side: 'cpp_exec_demo' })
  const refused = requestEntryMode(db, DEMO, 'STOPPED', { actor: 'auto:readiness' })
  assert.equal(refused.ok, false); assert.equal(refused.reason, 'policy_manual'); assert.equal(refused.policy, 'manual')
  assert.equal(engineStatusFor(db, DEMO).requestedEntryMode, 'TIME_BASED', 'nothing written')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/entry-mode'`).get().n, 0)
  assert.equal(requestEntryMode(db, DEMO, 'STOPPED', { actor: 'owner' }).ok, true, 'the human is admitted on a manual account')
  engineModule.requestEntryModePolicy(db, LIVE, 'auto')
  const tick = requestEntryMode(db, LIVE, 'TICK_MOMENTUM', { actor: 'auto:readiness', readiness: ready, detail: { tickShadow: 3, timeApprovals: 1 } })
  assert.equal(tick.ok, true); assert.equal(tick.status.requestedEntryMode, 'TICK_MOMENTUM')
  const row = JSON.parse(db.prepare(`SELECT body FROM action_log WHERE path = '/actions/entry-mode' AND account_id = ? ORDER BY id DESC LIMIT 1`).get(LIVE).body)
  assert.equal(row.actor, 'auto:readiness'); assert.deepEqual(row.detail, { tickShadow: 3, timeApprovals: 1 }, 'the counts travel on the action row')
  assert.equal(requestEntryMode(db, LIVE, 'TIME_BASED', { actor: 'owner' }).ok, true, 'the human is admitted on an auto account too')
})

test('PR-G: seedEntryModePolicyFromConfig expands _all to every enabled account, a per-id key wins, applies once per content, and a later route change stands', () => {
  const db = fresh()
  db.prepare('UPDATE accounts SET enabled = 1').run()
  upsertAccount(db, { accountId: '55555555', isLive: false })
  db.prepare(`UPDATE accounts SET enabled = 0 WHERE account_id = '55555555'`).run()
  const dir = mkdtempSync(join(tmpdir(), 'emp-'))
  const file = join(dir, 'entry-mode-policy.json')
  writeFileSync(file, JSON.stringify({ _note: 'x', accounts: { _all: 'auto', [LIVE]: 'manual', '77777777': 'auto' } }))
  const first = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.equal(first.error, null)
  assert.deepEqual(first.applied.sort(), [`…${DEMO.slice(-4)}:auto`])
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'auto', '_all reached the enabled account')
  assert.equal(engineStatusFor(db, LIVE).entryModePolicy, 'manual', 'the per-id key wins over _all')
  assert.equal(engineStatusFor(db, '55555555').entryModePolicy, 'manual', 'a disabled account is not under _all')
  assert.ok(first.skipped.some(s => /7777: not in the registry/.test(s)))
  assert.equal(engineModule.requestEntryModePolicy(db, DEMO, 'manual').ok, true, 'the operator flips it back through the route')
  const again = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(again.applied, [], 'same content: nothing re-applied')
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'manual', 'the route change stands across boots')
  // an account enabled later is seeded on its next boot under _all
  db.prepare(`UPDATE accounts SET enabled = 1 WHERE account_id = '55555555'`).run()
  const late = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(late.applied, ['…5555:auto'])
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'manual', 'the already-reached account keeps what the operator did')
  // new content re-applies
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'manual' } }))
  const changed = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(changed.applied.sort(), ['…5555:manual'])
  assert.equal(engineStatusFor(db, '55555555').entryModePolicy, 'manual')
  // the checked-in file is the manual default for every account
  const shipped = JSON.parse(readFileSync(new URL('../config/entry-mode-policy.json', import.meta.url), 'utf8'))
  assert.deepEqual(shipped.accounts, { _all: 'manual' })
})

test('PR-G (checker minor 9): a content change re-applies only the ids whose declaration changed — an operator\'s route-set policy on an untouched id stands', () => {
  const db = fresh()
  db.prepare('UPDATE accounts SET enabled = 1').run()
  const dir = mkdtempSync(join(tmpdir(), 'emp2-'))
  const file = join(dir, 'entry-mode-policy.json')
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'manual' } }))
  engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.equal(engineModule.requestEntryModePolicy(db, DEMO, 'auto').ok, true, 'the operator puts one account under the bot')
  // the owner edits the OTHER account's key: the operator's auto must stand
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'manual', [LIVE]: 'auto' } }))
  const r = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(r.applied, [`…${LIVE.slice(-4)}:auto`])
  assert.equal(engineStatusFor(db, DEMO).entryModePolicy, 'auto', 'not flipped back by an edit to another key')
  assert.equal(engineStatusFor(db, LIVE).entryModePolicy, 'auto')
  // changing _all itself reaches the id with no own key — and only that one
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'auto', [LIVE]: 'auto' } }))
  const r2 = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(r2.applied, [], 'DEMO is already auto: unchanged; LIVE\'s own key did not move')
  writeFileSync(file, JSON.stringify({ accounts: { _all: 'manual', [LIVE]: 'auto' } }))
  const r3 = engineModule.seedEntryModePolicyFromConfig(db, { file })
  assert.deepEqual(r3.applied, [`…${DEMO.slice(-4)}:manual`], '_all changed: the id under _all is re-applied, the keyed id is not')
})

test('PR-G (checker blocker 1): a HUMAN requestEntryMode zeroes the bot\'s streak and records the override; the bot\'s own does not', () => {
  const db = fresh()
  engineModule.writeAutoState(db, DEMO, { readyStreak: 5, blockedCycles: 1 })
  const h = requestEntryMode(db, DEMO, 'STOPPED', { actor: 'owner', now: new Date('2026-09-11T06:00:00Z') })
  assert.equal(h.ok, true)
  assert.deepEqual(engineModule.readAutoState(db, DEMO), { readyStreak: 0, lastEval: null, lastAction: null, blockedCycles: 0, humanOverride: { mode: 'STOPPED', at: '2026-09-11T06:00:00.000Z', epoch: 1, actor: 'owner' } })
  engineModule.requestEntryModePolicy(db, DEMO, 'auto')
  engineModule.writeAutoState(db, DEMO, { readyStreak: 3 })
  const ready = () => ({ ready: true, blockedReasons: [], side: 'cpp_exec' })
  assert.equal(requestEntryMode(db, DEMO, 'TICK_MOMENTUM', { actor: 'auto:readiness', readiness: ready }).ok, true)
  assert.equal(engineModule.readAutoState(db, DEMO).readyStreak, 3, 'the bot\'s switch leaves the streak to the pass')
  assert.equal(engineModule.readAutoState(db, DEMO).humanOverride, null)
})
