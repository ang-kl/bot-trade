// Codex · №12,691 · 2026-10-09; codex-footprint: diagnostic-boundary-integration.
// Real SQLite, readout/emitter and controller; only timers/native transport are controlled.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { initDB, getState, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { scene } from '../test-support/hybrid-scene.js'
import { startHybridTickController, HYBRID_TICK_STATUS } from './hybrid-tick-controller.js'
import { readHybridVerdicts } from './diagnostic-readout.js'
import { readTargetedEvidence, startTargetedEvidenceReadout } from './targeted-evidence-readout.js'

const NOW = Date.parse('2026-10-09T13:40:00Z')
const settle = () => new Promise(resolve => setImmediate(resolve))
function ledger(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.exec(`INSERT INTO trades(id,symbol,side,account_id,ctrader_position_id,status,origin,intent_id)
    VALUES(1,'NAS100','BUY','43097342','701','open','manual_broker','linked')`)
  return db
}
function intent(db, id, account = '43097342', sl = 1000000) {
  db.prepare(`INSERT INTO entry_intents
    (id,account_id,environment,symbol,symbol_id,side,volume,sl,sl_units,producer_id,basis,mode_epoch,
      permit_id,permit_expires_at,state,broker_position_id,broker_order_id,created_at)
    VALUES(?,?,'demo','NAS100',12,'BUY',200,?,'relative_points','manual_order','private-basis',1,
      ?,'2026-10-09T13:40:00Z','FILLED','701','123','2026-10-09T12:00:00Z')`).run(id, account, sl, id)
}
function emitter(db, tradeIds, runId) {
  const logs = []; let callback
  const stop = startTargetedEvidenceReadout(db, { env: { OWNED_EVIDENCE_RUN_ID: runId,
    OWNED_EVIDENCE_TRADE_IDS: tradeIds.join(','), OWNED_EVIDENCE_EXPIRES_AT: new Date(NOW + 600000).toISOString() },
  now: () => NOW, log: line => logs.push(JSON.parse(line)),
  setTimer: fn => { callback = fn }, clearTimer: () => {} })
  assert.equal(typeof stop, 'function')
  const changes = db.prepare('SELECT total_changes() n').get().n
  db.pragma('query_only = ON'); callback(); db.pragma('query_only = OFF')
  assert.equal(db.prepare('SELECT total_changes() n').get().n, changes, 'the emitted assessment performs no writes')
  assert.equal(logs.at(-1).kind, 'exit'); assert.equal(logs.at(-1).value.done, true)
  return logs
}

test('owned linked fifth or later intent survives bounded private output without duplicate or foreign rows', t => {
  const db = ledger(t)
  for (const position of [1, 4, 5, 9]) {
    db.exec('DELETE FROM entry_intents')
    for (let i = 1; i <= 9; i++) intent(db, i === position ? 'linked' : `older-${i}`)
    intent(db, 'foreign', '42993489', 987654321)
    const logs = emitter(db, [1], `linked-position-${position}`)
    const risk = logs.find(r => r.kind === 'initial-risk').value
    assert.equal(risk.intents.linkedStatus, 'owned_position_join')
    assert.equal(risk.intents.status, 'truncated'); assert.equal(risk.intents.truncated, true)
    assert.equal(risk.intents.rows.length, 4)
    assert.equal(risk.intents.rows.filter(r => r.id === 'linked').length, 1, `linked ordinal ${position}`)
    assert.ok(risk.intents.rows.every(r => r.account_id === '43097342' && r.broker_position_id === '701'))
    assert.equal(risk.status, 'unverified', 'requested entry risk is not broker opening proof')
    assert.ok(!JSON.stringify(logs).includes('987654321')); assert.ok(!JSON.stringify(logs).includes('private-basis'))
  }
})

test('prioritising a linked source never admits foreign account, position, symbol or direction', t => {
  const db = ledger(t)
  for (let i = 0; i < 5; i++) intent(db, `owned-${i}`)
  intent(db, 'linked')
  for (const [column, value, reason] of [['account_id', '42993489', 'account_conflict'],
    ['broker_position_id', '702', 'position_missing_or_conflict'], ['symbol', 'GER40', 'symbol_conflict'], ['side', 'SELL', 'side_conflict']]) {
    db.prepare("UPDATE entry_intents SET account_id='43097342',broker_position_id='701',symbol='NAS100',side='BUY',sl=987654321 WHERE id='linked'").run()
    db.prepare(`UPDATE entry_intents SET ${column}=? WHERE id='linked'`).run(value)
    const risk = readTargetedEvidence(db, NOW, [1]).trades[0].initialRisk
    assert.equal(risk.intents.linkedStatus, reason)
    assert.ok(!risk.intents.rows.some(r => r.id === 'linked'))
    assert.ok(!JSON.stringify(risk).includes('987654321'))
  }
})

test('each distinct missing explicit target emits an unverified result before the open-population detail', t => {
  const db = ledger(t)
  db.exec("UPDATE trades SET status='closed' WHERE id=1")
  const put = db.prepare("INSERT INTO trades(id,symbol,side,account_id,ctrader_position_id,status) VALUES(?,'NAS100','BUY','43097342',?,'open')")
  db.transaction(() => { for (let id = 2; id <= 70; id++) put.run(id, String(700 + id)) })()
  const logs = emitter(db, [1, 901, 902, 901, 903, 904, 905, 906], 'missing-explicit-targets')
  const risk = logs.filter(r => r.kind === 'initial-risk')
  assert.deepEqual(risk.map(r => r.value.tradeId).sort((a, b) => a - b), [1, 901, 902, 903, 904, 905, 906])
  for (const r of risk.filter(r => r.value.tradeId !== 1)) {
    assert.equal(r.value.status, 'unverified'); assert.equal(r.value.reason, 'trade_missing')
    assert.equal(r.value.source, 'stored_rows_only'); assert.equal(r.value.owner, null)
    assert.ok(logs.indexOf(r) < logs.findIndex(x => x.kind === 'movement-range'))
  }
  assert.ok(logs.filter(r => r.kind === 'owned-position').every(r => r.value.owner.id < 901))
  assert.equal(logs.at(-1).value.dropped, 0)
  assert.ok(logs.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) <= 256 * 1024)
  assert.equal(startTargetedEvidenceReadout(db, { env: { OWNED_EVIDENCE_RUN_ID: 'missing-explicit-targets',
    OWNED_EVIDENCE_TRADE_IDS: '901', OWNED_EVIDENCE_EXPIRES_AT: new Date(NOW + 600000).toISOString() }, now: () => NOW }), null,
  'existing durable claim still prevents replay')
})

test('real recovered SQLite status failure remains visible through both operator readout paths', async t => {
  const f = scene(t, { path: join(tempDir('diagnostic-recovery-'), 'ledger.db') })
  const timers = [], stop = startHybridTickController(f.db, { now: () => f.at, credsFor: () => f.creds,
    transports: f.transports, log: () => {}, setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer }, clearTimer: () => {},
    transport: { configure: async () => {}, events: async () => ({ ready: true, events: [] }), acknowledge: async () => {} } })
  t.after(stop); await settle(); f.db.pragma('busy_timeout=25')
  const peer = new Database(f.db.name, { fileMustExist: true, timeout: 0 }); t.after(() => peer.close())
  peer.exec('BEGIN IMMEDIATE'); peer.prepare("INSERT INTO agent_state(key,value) VALUES('fixture_writer','held')").run()
  f.at += 1000; const failedAt = f.at
  timers.shift().fn(); await settle(); peer.exec('ROLLBACK')
  timers.shift().fn(); await settle(); f.at += 1000
  for (const timer of timers.splice(0)) timer.fn()
  await settle()
  const raw = JSON.parse(getState(f.db, HYBRID_TICK_STATUS))
  const [host, value] = Object.entries(raw.hosts).find(([, h]) => h.lastError)
  assert.equal(value.error, null); assert.deepEqual(value.lastError, { at: failedAt, stage: 'status_write', storageCode: 'SQLITE_BUSY' })
  const direct = readHybridVerdicts(f.db).hybrid_tick_controller_json.hosts.find(h => h.host === host)
  const logs = emitter(f.db, [], 'recovered-status-readout')
  const emitted = logs.find(r => r.kind === 'summary').value.verdicts.hybrid_tick_controller_json.hosts.find(h => h.host === host)
  assert.deepEqual(direct.lastError, value.lastError); assert.deepEqual(emitted.lastError, value.lastError)
  assert.equal(emitted.error, null); assert.equal(f.closes.length, 0)
})

test('retained-error projection is bounded, nullable and never exposes arbitrary error fields or payloads', t => {
  const db = ledger(t)
  setState(db, HYBRID_TICK_STATUS, JSON.stringify({ at: NOW, hosts: {
    'valid.example': { error: null, lastError: { at: NOW - 10, stage: 'events_read', storageCode: 'SQLITE_IOERR', secret: 'must-not-leak' } },
    'malformed.example': { error: null, lastError: { at: 'must-not-leak', stage: 'must-not-leak', storageCode: 'must-not-leak', query: 'must-not-leak' } },
    'absent.example': { error: null }, 'array.example': { lastError: ['must-not-leak'] },
    'capped.example': { lastError: { at: NOW, stage: 'event_process', storageCode: 'SQLITE_BUSY' } },
  } }))
  const logs = emitter(db, [], 'redacted-last-error'), r = logs.find(x => x.kind === 'summary').value.verdicts.hybrid_tick_controller_json
  assert.equal(r.hosts.length, 4); assert.equal(r.truncatedHosts, true)
  assert.deepEqual(r.hosts[0].lastError, { at: NOW - 10, stage: 'events_read', storageCode: 'SQLITE_IOERR' })
  assert.equal(r.hosts[1].lastError.at, null); assert.equal(r.hosts[1].lastError.stage, null)
  assert.equal(r.hosts[1].lastError.storageCode, 'unclassified_error_redacted')
  assert.equal(r.hosts[2].lastError, null); assert.equal(r.hosts[3].lastError, null)
  assert.ok(!JSON.stringify(logs).includes('must-not-leak'))
})
