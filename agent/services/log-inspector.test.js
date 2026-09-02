// node --test agent/services/log-inspector.test.js
//
// The speech-act supervisor (owner invariants 2-4, 31-08-2026). What must
// hold: every SPEECH_ACTS entry has an EXECUTABLE success predicate (a
// classification that cannot be checked is decoration — the house rule
// applied to the inspector's own table); each inspection fires on its
// fixture and dedupes structurally; code_change findings can NEVER reach an
// actuator; falsifiers resolve honestly, including 'expired' on absent
// evidence; and a falsified disarm is NOT reverted (re-arming is never the
// inspector's call).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import {
  SPEECH_ACTS, INSPECTIONS, INSPECTOR_DEFAULTS,
  loadInspectorConfig, runLogInspector, applyPrinciple, evalFalsifierMetric, inspectorView,
} from './log-inspector.js'

const NOW = Date.parse('2026-08-31T06:00:00Z')

test('every SPEECH_ACTS entry has an executable success predicate', () => {
  const db = initDB(':memory:')
  for (const entry of SPEECH_ACTS) {
    assert.equal(typeof entry.successPredicate, 'function', `${entry.source}/${entry.match}: no predicate`)
    assert.ok(entry.speech_act && entry.doing, `${entry.source}: classification incomplete`)
    // Executable against an empty DB without throwing — the answer may be
    // false, but "cannot even run" is the decoration this test forbids.
    const out = entry.successPredicate(db, {
      effectKey: 'x', sinceMs: NOW, sinceIso: new Date(NOW).toISOString(),
      positionId: '1', method: 'WATCHDOG', path: '/edge',
    })
    assert.ok(out === true || out === false, `${entry.source}: predicate did not return a boolean`)
  }
})

test('config: defaults and junk degrade', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadInspectorConfig(db), { ...INSPECTOR_DEFAULTS })
  setState(db, 'inspector_config_json', '{"refusalAtScaleMin":-4,"on":')
  assert.deepEqual(loadInspectorConfig(db), { ...INSPECTOR_DEFAULTS })
})

function seedRefusalAtScale(db, n = 60) {
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at) VALUES ('EURUSD','BUY',0,?,?)`)
  for (let i = 0; i < n; i++) ins.run('bad_rr 1.50<3', new Date(NOW - i * 60_000).toISOString())
}

test('refusal-at-scale: fires, dedupes structurally, and stays proposed (never auto)', () => {
  const db = initDB(':memory:')
  seedRefusalAtScale(db)
  const r1 = runLogInspector(db, { now: NOW })
  assert.equal(r1.errors.length, 0, r1.errors.join(' · '))
  const rows = db.prepare(`SELECT * FROM inspection_findings WHERE subject_key LIKE 'refusal_at_scale:%'`).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].speech_act, 'refusal')
  assert.equal(rows[0].status, 'proposed')
  assert.match(rows[0].finding, /question nobody asks/)
  const fal = JSON.parse(rows[0].falsifier)
  assert.ok(fal.prediction && fal.metric.kind === 'veto_count_at_least' && fal.deadlineMs > NOW)
  // Second run: the partial unique index holds — no second live row.
  runLogInspector(db, { now: NOW + 60_000 })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM inspection_findings`).get().n, rows.length)
})

test('broken commissive: trail_armed + favourable MFE + no tightening → finding', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (id, symbol, side, status) VALUES (42, '0016.HK', 'SELL', 'open')`).run()
  db.prepare(`INSERT INTO trades (id, symbol, side, status) VALUES (43, 'AAPL.US', 'BUY', 'open')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, status, mfe_r) VALUES ('0016.HK', 42, 'short', 'active', 2.3)`).run()
  db.prepare(`INSERT INTO position_events (position_id, trade_id, symbol, kind, at) VALUES ('999', 42, '0016.HK', 'trail_armed', ?)`)
    .run(new Date(NOW - 3 * 3_600_000).toISOString())
  const r = runLogInspector(db, { now: NOW })
  assert.equal(r.errors.length, 0, r.errors.join(' · '))
  const row = db.prepare(`SELECT * FROM inspection_findings WHERE subject_key LIKE 'broken_commissive:%'`).get()
  assert.ok(row, 'expected the broken-promise finding')
  assert.equal(row.speech_act, 'commissive')
  assert.match(row.finding, /promise with no keeping/)
  // A tightening event suppresses it for a NEW position (kept promise).
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, status, mfe_r) VALUES ('AAPL.US', 43, 'long', 'active', 1.5)`).run()
  db.prepare(`INSERT INTO position_events (position_id, trade_id, symbol, kind, at) VALUES ('1000', 43, 'AAPL.US', 'trail_armed', ?)`)
    .run(new Date(NOW - 3 * 3_600_000).toISOString())
  db.prepare(`INSERT INTO position_events (position_id, trade_id, symbol, kind, at) VALUES ('1000', 43, 'AAPL.US', 'trail_tightened', ?)`)
    .run(new Date(NOW - 1 * 3_600_000).toISOString())
  runLogInspector(db, { now: NOW + 1000 })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM inspection_findings WHERE subject_key LIKE '%:1000'`).get().n, 0, 'kept promises produce no finding')
})

test('code_change findings NEVER reach an actuator (absence asserted)', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, disposition, disposition_at, created_at) VALUES ('EURUSD','BUY',1,NULL,'dropped',?,?)`)
    .run(new Date(NOW - 3_600_000).toISOString(), new Date(NOW - 3_600_000).toISOString())
  let actuated = 0
  const io = { disarmStrategyEverywhere: () => { actuated++; return ['global'] }, getState, setState }
  const r = runLogInspector(db, { now: NOW, io })
  assert.equal(r.errors.length, 0, r.errors.join(' · '))
  const row = db.prepare(`SELECT * FROM inspection_findings WHERE subject_key = 'silent_gap:dropped_approvals'`).get()
  assert.ok(row)
  assert.equal(row.principle_kind, 'code_change')
  assert.equal(row.status, 'proposed', 'code_change must land as a proposal')
  assert.equal(actuated, 0, 'the actuator must never fire for code_change')
})

test('applyPrinciple bounds: timing allowlist enforced; only disarms auto-apply', () => {
  const db = initDB(':memory:')
  const cfg = { ...INSPECTOR_DEFAULTS }
  // Non-whitelisted timing key → proposed, no write.
  const t1 = applyPrinciple(db, { principle_kind: 'timing_change', principle_params: { key: 'perTradeRiskPct', value: 99 } }, cfg)
  assert.equal(t1.applied, false)
  assert.equal(getState(db, 'perTradeRiskPct') ?? null, null, 'refused key must never be written')
  // Whitelisted timing key applies and carries revert_to.
  setState(db, 'monitor_interval_min', '1')
  const t2 = applyPrinciple(db, { principle_kind: 'timing_change', principle_params: { key: 'monitor_interval_min', value: 2, revert_to: '1' } }, cfg)
  assert.equal(t2.applied, true)
  assert.equal(getState(db, 'monitor_interval_min'), '2')
  // strategy_tweak NEVER applies (02-09-2026): the inspector reports, the
  // live evaluators act. Even with an actuator handed in, nothing is called.
  const calls = []
  const io = { disarmStrategyEverywhere: (_db, _io, key) => { calls.push(key); return ['global'] }, getState, setState }
  assert.equal(applyPrinciple(db, { principle_kind: 'strategy_tweak', principle_params: { strategy: 'x', action: 'arm' } }, cfg, io).applied, false)
  const dis = applyPrinciple(db, { principle_kind: 'strategy_tweak', principle_params: { strategy: 'x', action: 'disarm' } }, cfg, io)
  assert.equal(dis.applied, false)
  assert.equal(dis.status, 'proposed')
  assert.deepEqual(calls, [], 'no actuator reachable from the inspector')
  assert.equal('autoApplyToggles' in INSPECTOR_DEFAULTS, false, 'the dial is gone with the branch')
})

test('falsifier pass: confirmed, falsified, and expired-on-absent-evidence', () => {
  const db = initDB(':memory:')
  const ins = db.prepare(
    `INSERT INTO inspection_findings (source, subject_key, speech_act, said, doing, finding, principle_kind, principle_params, falsifier, status)
     VALUES ('risk_events', ?, 'refusal', 's', 'd', 'f', 'none', '{}', ?, 'proposed')`
  )
  // CONFIRMED: predicted ≥5 more vetoes; seed 6 after sinceMs.
  ins.run('refusal_at_scale:bad_rr', JSON.stringify({ prediction: 'p', metric: { kind: 'veto_count_at_least', guard: 'bad_rr', sinceMs: NOW - 10, min: 5 }, deadlineMs: NOW - 1 }))
  const seed = db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, created_at) VALUES ('E','BUY',0,'bad_rr 1.5<3',?)`)
  for (let i = 0; i < 6; i++) seed.run(new Date(NOW - 5).toISOString())
  // FALSIFIED: same metric, min 50 — not reached.
  ins.run('refusal_at_scale:other', JSON.stringify({ prediction: 'p2', metric: { kind: 'veto_count_at_least', guard: 'other_guard', sinceMs: NOW - 10, min: 50 }, deadlineMs: NOW - 1 }))
  // EXPIRED: unknown metric kind = unevaluable.
  ins.run('weird:subject', JSON.stringify({ prediction: 'p3', metric: { kind: 'no_such_metric' }, deadlineMs: NOW - 1 }))

  const r = runLogInspector(db, { now: NOW })
  assert.equal(r.confirmed, 1)
  assert.equal(r.falsified, 1)
  assert.equal(r.expired, 1)
  const st = Object.fromEntries(db.prepare(`SELECT subject_key, status FROM inspection_findings`).all().map(x => [x.subject_key, x.status]))
  assert.equal(st['refusal_at_scale:bad_rr'], 'confirmed')
  assert.equal(st['refusal_at_scale:other'], 'falsified')
  assert.equal(st['weird:subject'], 'expired')
  const exp = db.prepare(`SELECT resolution FROM inspection_findings WHERE subject_key = 'weird:subject'`).get()
  assert.match(exp.resolution, /never confirmed on absent evidence/)
})

test('a falsified auto DISARM is not reverted — re-arming is never the inspector\'s call', () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO inspection_findings (source, subject_key, speech_act, said, doing, finding, principle_kind, principle_params, falsifier, status)
     VALUES ('risk_events', 'refusal_at_scale:x', 'refusal', 's', 'd', 'f', 'strategy_tweak', ?, ?, 'auto_applied')`
  ).run(JSON.stringify({ strategy: 'x', action: 'disarm' }),
        JSON.stringify({ prediction: 'p', metric: { kind: 'veto_count_at_least', guard: 'x', sinceMs: NOW - 10, min: 999 }, deadlineMs: NOW - 1 }))
  const notes = []
  const r = runLogInspector(db, { now: NOW, notify: (t) => notes.push(t) })
  assert.equal(r.falsified, 1)
  assert.match(notes[0] || '', /left in the safe state/)
})

test('inspectorView renders findings, tallies and audit history', () => {
  const db = initDB(':memory:')
  seedRefusalAtScale(db)
  runLogInspector(db, { now: NOW })
  db.prepare(`INSERT INTO decision_audit_history (verdict, because, considered) VALUES ('blocked', 'x', 10)`).run()
  const v = inspectorView(db)
  assert.equal(v.findings.length, 1)
  assert.ok(v.findings[0].falsifier.prediction)
  assert.equal(v.auditHistory.length, 1)
  assert.ok(v.lastRun)
})

test('wiring pins: fast-monitor band, CONTROLLERS entry, loop history insert, route', () => {
  const fast = readFileSync(new URL('./fast-monitor.js', import.meta.url), 'utf8')
  assert.ok(fast.includes("due('log_inspector', 300"), 'inspector not on the fast-monitor band')
  const hb = readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8')
  assert.ok(hb.includes('log_inspector:'), 'log_inspector missing from CONTROLLERS')
  const loop = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.ok(loop.includes('INSERT INTO decision_audit_history'), 'verdict history insert missing from loop.js')
  const state = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8')
  assert.ok(state.includes("'/inspector'"), '/state/inspector route missing')
})

test('evalFalsifierMetric: state_advanced falsifies the stuck reading when the record moves', () => {
  const db = initDB(':memory:')
  setState(db, 'protection_audit_last_json', JSON.stringify({ at: new Date(NOW + 60_000).toISOString() }))
  // Record advanced past sinceMs → prediction ("advances without code change")
  // held → the STUCK interpretation is falsified → metric returns false.
  assert.equal(evalFalsifierMetric(db, { kind: 'state_advanced', key: 'protection_audit_last_json', sinceMs: NOW }), false)
  setState(db, 'protection_audit_last_json', JSON.stringify({ at: new Date(NOW - 60_000).toISOString() }))
  assert.equal(evalFalsifierMetric(db, { kind: 'state_advanced', key: 'protection_audit_last_json', sinceMs: NOW }), true)
  assert.equal(evalFalsifierMetric(db, { kind: 'state_advanced', key: 'missing_key', sinceMs: NOW }), null)
})
