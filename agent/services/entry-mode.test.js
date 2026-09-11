// agent/services/entry-mode.test.js — the per-account entry fence (P1b).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

import { initDB, getState, setState } from '../db.js'
import { upsertAccount, syncSelectedAccount, ensureAccountRegistry, getAccountState } from './account-registry.js'
import { engineStatusFor, requestEntryMode, requestTickObservation, seedTickObservationFromConfig, admitEntry, entryEnginesView, ENGINE_STATUS_KEY, _resetRefusalDedupe } from './entry-mode.js'
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
  // back to TIME_BASED: epoch 2, tick producers still refused there
  const back = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 1 })
  assert.equal(back.ok, true); assert.equal(back.status.modeEpoch, 2)
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
  assert.equal(tick.ok, false); assert.match(tick.reason, /^tick_engine_not_built/)
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
  assert.match(v.note, /fenced at arming only/)
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
})

test('P3a: tick observation OFF → RECORD → OFF moves the revision, never the epoch; SHADOW is refused until P4; the fence is untouched', () => {
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
  assert.equal(shadow.ok, false); assert.match(shadow.reason, /^tick_strategy_not_built/)
  assert.equal(requestTickObservation(db, DEMO, 'BOGUS').ok, false)
  const off = requestTickObservation(db, DEMO, 'OFF')
  assert.equal(off.ok, true); assert.equal(off.status.tickObservation, 'OFF'); assert.equal(off.status.configRevision, 2)
  const again = requestTickObservation(db, DEMO, 'OFF')
  assert.equal(again.ok, true); assert.equal(again.changed, false)
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/actions/tick-observation' AND account_id = ?`).get(DEMO).n
  assert.equal(rows, 3)
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
  assert.deepEqual(r.applied, [`…${DEMO.slice(-4)}:RECORD`])
  assert.equal(engineStatusFor(db, DEMO).tickObservation, 'RECORD')
  assert.equal(engineStatusFor(db, LIVE).tickObservation, 'OFF', 'SHADOW is refused until P4')
  assert.ok(r.skipped.some(s => s.includes('not in the registry')) && r.skipped.some(s => s.includes('tick_strategy_not_built')))
  assert.equal(r.symbols, 2)
  assert.deepEqual(JSON.parse(getState(db, 'tick_symbols_json')), ['EURUSD', 'AAPL.US'])
  assert.equal(lines.length, 1)
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
  // the checked-in file names the momentum account and the momentum universe, and boot wires the seed
  const cfg = JSON.parse(readFileSync(new URL('../config/tick-observation.json', import.meta.url), 'utf8'))
  assert.equal(cfg.accounts['46979908'], 'RECORD'); assert.equal(cfg.symbols, 'momentum-universe')
  const boot = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(boot, /seedTickObservationFromConfig\(db, \{ log/)
})
