// node --test agent/services/phase-trace.test.js
//
// The ironclad layer for the S.A.T. flags (owner 01-08). Three claims under
// test: (1) EVERY physical change to a phase key leaves a phase_flag_trace
// row, whoever wrote it; (2) a write that bypassed setPhaseFlag is logged as
// PHASE_RAW_WRITE with the caller's stack, while setPhaseFlag's own writes
// are not; (3) phaseTraceView ties the two together and names the
// unattributed changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB, getState, setState } from '../db.js'
import { setPhaseFlag, phaseTraceView } from './phase-audit.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phasetrace-')), 'agent.db'))
const traceRows = (db, key) =>
  db.prepare('SELECT * FROM phase_flag_trace WHERE key = ? ORDER BY id').all(key)
const rawRows = (db) =>
  db.prepare("SELECT * FROM action_log WHERE method = 'PHASE_RAW_WRITE' ORDER BY id").all()

test('DB trigger records every change to a master flag, with old and new', () => {
  const db = tmpDb()
  // Seeding already inserted autotrade_enabled='false' → one insert-trace row.
  const seeded = traceRows(db, 'autotrade_enabled')
  assert.equal(seeded.length, 1)
  assert.equal(seeded[0].new_value, 'false')

  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'owner-ui', via: '/actions/autotrade-toggle' })
  const rows = traceRows(db, 'autotrade_enabled')
  assert.equal(rows.length, 2)
  assert.equal(rows[1].old_value, 'false')
  assert.equal(rows[1].new_value, 'true')
})

test('an unchanged write leaves NO trace row — the trail stays signal, not noise', () => {
  const db = tmpDb()
  const before = traceRows(db, 'autotrade_enabled').length
  setPhaseFlag(db, 'autotrade_enabled', 'false', { actor: 'owner-ui' }) // already false
  assert.equal(traceRows(db, 'autotrade_enabled').length, before)
})

test('the trigger catches a RAW SQL update that touches no JS at all', () => {
  const db = tmpDb()
  db.prepare("UPDATE agent_state SET value = 'true' WHERE key = 'autotrade_enabled'").run()
  const rows = traceRows(db, 'autotrade_enabled')
  assert.equal(rows[rows.length - 1].new_value, 'true', 'no writer can dodge a trigger under the table')
})

test('per-account override keys are traced too', () => {
  const db = tmpDb()
  setPhaseFlag(db, 'acct:46130058:autotrade_enabled', 'false', { actor: 'owner-ui', accountId: '46130058' })
  const rows = traceRows(db, 'acct:46130058:autotrade_enabled')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].new_value, 'false')
})

test('raw setState on a phase key is logged with the caller stack; setPhaseFlag is not', () => {
  const db = tmpDb()
  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'owner-ui' })
  assert.equal(rawRows(db).length, 0, 'the authorized path must not flag itself')

  setState(db, 'autotrade_enabled', 'false') // the bypass this exists to catch
  const raw = rawRows(db)
  assert.equal(raw.length, 1)
  const body = JSON.parse(raw[0].body)
  assert.equal(body.from, 'true')
  assert.equal(body.to, 'false')
  assert.match(body.stack, /phase-trace\.test\.js/, 'the stack names the caller')
  assert.equal(getState(db, 'autotrade_enabled'), 'false', 'the write itself still lands — tracing never blocks')
})

test('raw setState that changes nothing is not logged', () => {
  const db = tmpDb()
  setState(db, 'autotrade_enabled', 'false') // seeded value — no change
  assert.equal(rawRows(db).length, 0)
})

test('non-phase keys pass through setState untouched', () => {
  const db = tmpDb()
  setState(db, 'loop_count', '7')
  assert.equal(rawRows(db).length, 0)
  assert.equal(traceRows(db, 'loop_count').length, 0)
})

test('phaseTraceView: audited flip attributed, raw flip named, nothing silent', () => {
  const db = tmpDb()
  setPhaseFlag(db, 'autotrade_enabled', 'true', { actor: 'profit_ratchet', reason: 'test flip' })
  setState(db, 'scan_enabled', 'false') // raw bypass

  const v = phaseTraceView(db)
  assert.equal(v.current.autotrade_enabled, 'true')
  assert.equal(v.current.scan_enabled, 'false')

  const audited = v.changes.find(c => c.key === 'autotrade_enabled' && c.new_value === 'true')
  assert.equal(audited.source, 'audited')
  assert.equal(audited.actor, 'profit_ratchet')
  assert.equal(audited.reason, 'test flip')

  const raw = v.changes.find(c => c.key === 'scan_enabled' && c.new_value === 'false')
  assert.equal(raw.source, 'raw_write')
  assert.match(raw.stack, /phase-trace\.test\.js/)
  assert.equal(v.unattributed, 0)
})

test('phaseTraceView: a trigger-only change (raw SQL) reads UNATTRIBUTED — the smoking gun', () => {
  const db = tmpDb()
  db.prepare("UPDATE agent_state SET value = 'true' WHERE key = 'autotrade_enabled'").run()
  const v = phaseTraceView(db)
  const row = v.changes.find(c => c.key === 'autotrade_enabled' && c.new_value === 'true')
  assert.equal(row.source, 'UNATTRIBUTED')
  assert.ok(v.unattributed >= 1)
})
