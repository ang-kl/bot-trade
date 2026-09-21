// node --test agent/services/observation-safety.test.js
//
// §1 (21-09-2026). Option 2 turns tick OBSERVATION on for a broker side that
// has never had it. The whole safety claim is that observation admits no
// entries — and before this file that claim was true only BY CONSTRUCTION and
// covered PIECEWISE: one test asserted the mode does not move, another that
// the guard push sets tickRecord, a third that the roster filter reads
// `admittedBases`. Nobody asserted the property itself, in one place, over all
// of its consequences at once. A claim assembled from three half-tests is the
// shape this repo's CLAUDE.md calls a guard whose trigger never fires.
//
// Every case here is behavioural: real services, a real in-memory database,
// real prepared statements. Nothing greps source.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, setState } from '../db.js'
import { requestTickObservation, engineStatusFor, basesFor, admitEntry } from './entry-mode.js'
import { desiredGuardFor } from './exec-guard-sync.js'
import { tickReadinessFor } from './tick-readiness.js'

const DEMO = '46979908'

function dbWithAccount({ isLive = 0 } = {}) {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id, enabled, is_live, mode) VALUES (?, 1, ?, ?)').run(DEMO, isLive, 'active')
  return db
}

const side = (isLive) => ({ isLive: !!isLive })

// ───────────────────────────────────────────────────────────────────────────
// THE PROPERTY, in one assertion
// ───────────────────────────────────────────────────────────────────────────

test('SHADOW admits NOTHING: not a basis, not the placing roster, not a permit', () => {
  const db = dbWithAccount()
  const before = engineStatusFor(db, DEMO)
  assert.deepEqual(basesFor(before), ['bar'], 'precondition: bar only')

  const out = requestTickObservation(db, DEMO, 'SHADOW')
  assert.equal(out.ok, true)

  const after = engineStatusFor(db, DEMO)
  const guard = desiredGuardFor(db, side(false), Date.now())
  const intents = db.prepare("SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = 'tick_momentum'").get().n

  assert.deepEqual({
    bases: basesFor(after),
    effectiveEntryMode: after.effectiveEntryMode,
    admittedBases: after.admittedBases,
    modeEpoch: after.modeEpoch,
    placingRoster: guard.tickEntryAccounts,
    tickIntents: intents,
    tickRefusal: admitEntry(db, { accountId: DEMO, producerId: 'tick_momentum', basis: 'tick' }).reason,
  }, {
    bases: ['bar'],
    effectiveEntryMode: 'TIME_BASED',
    admittedBases: null,
    modeEpoch: before.modeEpoch,
    placingRoster: [],
    tickIntents: 0,
    tickRefusal: 'entry_mode_basis: TIME_BASED admits bar producers, tick_momentum is tick',
  }, 'observation moves the observation switch and nothing else')
})

test('SHADOW does turn the recorder switch on — the one thing it IS allowed to do', () => {
  // Stated as its own case so the assertion above cannot be read as "SHADOW
  // changes nothing at all". `OBSERVATION_MODES` has no shadow-without-record,
  // so enabling shadow on a side necessarily starts disk writes there. That is
  // the fact the Option 2 rollout has to plan storage around.
  const db = dbWithAccount()
  assert.equal(desiredGuardFor(db, side(false), Date.now()).tickRecord, false)
  requestTickObservation(db, DEMO, 'SHADOW')
  const g = desiredGuardFor(db, side(false), Date.now())
  assert.deepEqual([g.tickRecord, g.tickShadow, g.tickEntryAccounts], [true, true, []])
})

// ───────────────────────────────────────────────────────────────────────────
// The rollout's expected steady state, asserted rather than hoped for
// ───────────────────────────────────────────────────────────────────────────

test('a sidecar with no TICK_SPOOL_PATH is named as such, and never reads as "ready"', () => {
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at: new Date().toISOString(),
    status: { enabled: false, reason: 'TICK_SPOOL_PATH not set' },
  }))
  const rd = tickReadinessFor(db, DEMO)
  assert.equal(rd.recorderDestination.state, 'NO_SPOOL_PATH')
  assert.match(rd.recorderDestination.reason, /TICK_SPOOL_PATH/)
  assert.equal(rd.ready, false, 'nothing about a missing spool path may read as ready')
  assert.ok(rd.shadowBlockers.includes('shadow_strategy_running'), 'and the shadow is honestly blocked')
})

test('PAUSED_RESERVE — the expected live steady state — leaves the shadow ready and trading blocked', () => {
  // A container filesystem cannot satisfy the compiled-in 2 GiB reserve, so
  // the live recorder is expected to park at PAUSED_RESERVE while the shadow
  // runs off the raw tap. That must read as shadow-ready and trade-blocked,
  // not as a fault and not as permission.
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  setState(db, 'tick_symbols_json', JSON.stringify(['ETHUSD']))
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at: new Date().toISOString(),
    status: {
      enabled: true, recording: true, state: 'PAUSED_RESERVE', spoolDir: '/data/tick',
      disk: { usagePct: 40, availBytes: 1e9 }, events: { gaps: 0, dropped: 0 },
      strategy: { shadow: true, profileHash: 'abc' },
    },
  }))
  const rd = tickReadinessFor(db, DEMO)
  assert.equal(rd.recorderDestination.state, 'PAUSED_RESERVE')
  assert.equal(rd.recorderDestination.path, '/data/tick')
  assert.equal(rd.shadowReady, true, 'the shadow runs off the tap, not the file')
  assert.equal(rd.ready, false)
  assert.ok(rd.blockedReasons.includes('disk_reserve_clear'), 'and the arming fail-safe holds')
})

test('a stale status is not a silent pass — a side that stopped answering blocks', () => {
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at: new Date(Date.now() - 60 * 60_000).toISOString(),
    status: { enabled: true, recording: true, state: 'RECORDING', strategy: { shadow: true } },
  }))
  const rd = tickReadinessFor(db, DEMO)
  assert.ok(rd.shadowBlockers.includes('recorder_status_fresh'), 'an hour-old reading is not a reading')
  assert.equal(rd.shadowReady, false)
  assert.equal(rd.ready, false)
})

test('no status at all is reported as no status, never as a healthy default', () => {
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  const rd = tickReadinessFor(db, DEMO)
  assert.equal(rd.recorderDestination.state, 'NO_STATUS')
  assert.equal(rd.recorderDestination.path, null)
  assert.equal(rd.ready, false)
})

// ───────────────────────────────────────────────────────────────────────────
// Restart
// ───────────────────────────────────────────────────────────────────────────

test('a restart re-reads the same record: still TIME_BASED, still no roster', () => {
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  // A sidecar restart shows up as a fresh status with a new boot and zeroed
  // counters. Nothing about it may widen what the account admits.
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at: new Date().toISOString(),
    status: { enabled: true, recording: false, state: 'IDLE', events: { gaps: 0, dropped: 0 }, strategy: { shadow: false } },
  }))
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.effectiveEntryMode, 'TIME_BASED')
  assert.equal(st.admittedBases, null)
  assert.deepEqual(desiredGuardFor(db, side(true), Date.now()).tickEntryAccounts, [])
  assert.equal(tickReadinessFor(db, DEMO).ready, false)
})

// ───────────────────────────────────────────────────────────────────────────
// The corrected remedy — the one thing this PR argues about, now falsifiable
// ───────────────────────────────────────────────────────────────────────────

test('the spool-path remedy does not tell the operator a volume is needed for shadow', () => {
  // It said one was. It is not: TickRecorder::start() needs a creatable
  // directory and a flock, the shadow reads the raw feed tap rather than the
  // spool file, and a full spool stops only writeRecord. A volume matters
  // before ARMING, because disk_reserve_clear is a PAUSE_CHECK. Without this
  // case the old wording could be restored verbatim and every test stays green
  // — which is what an independent check of the first draft demonstrated.
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at: new Date().toISOString(), status: { enabled: false, reason: 'TICK_SPOOL_PATH not set' },
  }))
  const remedy = tickReadinessFor(db, DEMO).readiness.find(c => c.check === 'shadow_strategy_running').remedy
  assert.doesNotMatch(remedy, /a volume is needed/i, 'the false claim must not come back')
  assert.match(remedy, /VOLUME is not needed for shadow/i)
  assert.match(remedy, /restarts the sidecar/i, 'and the operator is told what the change costs')
})

test('a stale reading is reported as STALE, never present-tense RECORDING', () => {
  // Every other value in the payload carries an `at`. A destination that did
  // not would present an hour-old record as the sidecar's current state.
  const db = dbWithAccount({ isLive: 1 })
  requestTickObservation(db, DEMO, 'SHADOW')
  const at = new Date(Date.now() - 60 * 60_000).toISOString()
  setState(db, 'cpp_exec_tick_json', JSON.stringify({
    at, status: { enabled: true, recording: true, state: 'RECORDING', spoolDir: '/data/tick', strategy: { shadow: true } },
  }))
  const rd = tickReadinessFor(db, DEMO).recorderDestination
  assert.equal(rd.state, 'STALE', 'not RECORDING — the sidecar may have died an hour ago')
  assert.equal(rd.stale, true)
  assert.equal(rd.at, at, 'and the reading carries when it was taken')
  assert.match(rd.reason, /too old/)
})
