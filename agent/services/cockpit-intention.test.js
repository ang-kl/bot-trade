// PHASE 5 GATE (cockpit live-wiring prompt): "seeded position produces a
// reproducible supported explanation." Reproducible = same inputs, identical
// output. Supported = every sentence carries evidence IDs and every cited ID
// resolves in the returned evidence bundle. Plus the state distinctions the
// phase demands: holding/managing/exiting/paused/blocked/unknown, honest
// unknowns without a live price, and account-scoped blocking state.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { buildIntention } from './cockpit-intention.js'
import { cockpitSnapshot } from './cockpit-snapshot.js'

const NOW = Date.parse('2026-07-31T05:00:00Z')

// The exact JOIN the snapshot runs — the tests must see the same row shape.
function fetchRow(db, id) {
  return db.prepare(
    `SELECT mp.*, t.volume AS volume, t.opened_at AS opened_at,
            t.ctrader_position_id AS ctrader_position_id,
            t.strategy AS trade_strategy, t.conviction AS conviction,
            t.analysis_id AS analysis_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.id = ?`).get(id)
}

function freshDb() {
  const db = initDB(':memory:')
  const t = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, opened_at, ctrader_position_id, status, strategy, conviction)
    VALUES (?, ?, ?, ?, datetime('now'), ?, 'open', ?, ?)`)
  const mp = db.prepare(`INSERT INTO monitored_positions
    (symbol, trade_id, side, entry_price, current_sl, current_tp, initial_risk, account_id, status,
     thesis, invalidation_trigger, time_cap_at, strategy, source,
     last_check_action, last_check_reasoning, last_check_at, thesis_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // Seed: EURUSD long, entry 100, SL 98 (initial risk 2), TP 106, reviewed HOLD.
  const ta = t.run('EURUSD', 'long', 100, 0.5, '900001', 'ema_pullback', 0.8).lastInsertRowid
  const idA = mp.run('EURUSD', ta, 'long', 100, 98, 106, 2, 'ACC_A',
    'Uptrend pullback to the 20 EMA held', 'price<99', '2026-07-31T08:00:00Z', 'ema_pullback', 'autopilot',
    'HOLD', 'hold (R=0.20, mfe=0.30, mae=-0.10)', '2026-07-31T04:55:00Z', 'intact').lastInsertRowid
  return { db, idA }
}

let ctx
beforeEach(() => { ctx = freshDb() })

const LIVE = { price: 101 }
const LIVE_AT = '2026-07-31T04:59:30Z'

test('GATE: the seeded position produces a reproducible, supported explanation', () => {
  const row = fetchRow(ctx.db, ctx.idA)
  const a = buildIntention(ctx.db, row, LIVE, LIVE_AT, 'rev1', NOW)
  const b = buildIntention(ctx.db, row, LIVE, LIVE_AT, 'rev1', NOW)
  // Reproducible: byte-identical on identical inputs.
  assert.deepEqual(a, b)
  assert.equal(a.status, 'derived')
  assert.equal(a.explanation.mode, 'deterministic')
  assert.equal(a.explanation.model, null)
  assert.equal(a.explanation.evidenceRevision, 'rev1')
  // Supported: every sentence ends with [evidence, ids]; every cited id
  // resolves in the bundle.
  const sentences = a.explanation.text.split(/(?<=\])\s+/).filter(Boolean)
  assert.ok(sentences.length >= 2, 'explanation must be more than one sentence')
  for (const s of sentences) {
    const m = s.match(/\[([^\]]+)\]\.?$/)
    assert.ok(m, `sentence must carry evidence IDs: "${s}"`)
    for (const id of m[1].split(',').map(x => x.trim())) {
      assert.ok(a.evidenceIndex[id], `evidence id "${id}" must resolve in evidenceIndex`)
    }
  }
})

test('currentDecision restates the recorded review verbatim, with state=holding', () => {
  const row = fetchRow(ctx.db, ctx.idA)
  const out = buildIntention(ctx.db, row, LIVE, LIVE_AT, 'rev1', NOW)
  assert.equal(out.currentDecision.state, 'holding')
  assert.equal(out.currentDecision.action, 'HOLD')
  assert.equal(out.currentDecision.asOf, '2026-07-31T04:55:00Z')
  assert.equal(out.currentDecision.source, 'monitor')
  assert.match(out.currentDecision.reason, /hold \(R=0\.20/)
  // Stored plan facts ride along untouched.
  assert.equal(out.thesis, 'Uptrend pullback to the 20 EMA held')
  assert.equal(out.timeCapAt, '2026-07-31T08:00:00Z')
  assert.equal(out.strategy, 'ema_pullback')
  assert.equal(out.conviction, 0.8)
  assert.equal(out.initialRisk, 2)
})

test('review-writer prefixes map to their sources and to managing/exiting states', () => {
  const cases = [
    ['FAST:TIGHTEN_SL', 'fast_monitor', 'managing'],
    ['SCALE_OUT', 'monitor', 'managing'],
    ['EXIT', 'monitor', 'exiting'],
    ['EQUITY_STOP', 'equity_stop', 'exiting'],
    ['GUARD:BE', 'session_open_guard', 'managing'],
  ]
  for (const [action, source, state] of cases) {
    ctx.db.prepare('UPDATE monitored_positions SET last_check_action = ? WHERE id = ?').run(action, ctx.idA)
    const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
    assert.equal(out.currentDecision.source, source, action)
    assert.equal(out.currentDecision.state, state, action)
  }
})

test('nextAction is the NEAREST measurable trigger — hand arithmetic', () => {
  // Long from 100, risk 2, price 101. FX rules: BE at +0.7R → 101.4 (0.4 away),
  // partial at +1.0R → 102 (1 away; re-based from 1.5R by owner order
  // 2026-08-22, audit item 4), bank at +4R → 108 (7), broker TP 106 (5),
  // time cap has no distance. Nearest = break-even at 101.4.
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.manager, 'position_manager')
  assert.equal(out.nextAction.kind, 'break_even')
  assert.ok(Math.abs(out.nextAction.triggerPrice - 101.4) < 1e-9)
  assert.ok(Math.abs(out.nextAction.distance - 0.4) < 1e-9)
  assert.equal(out.nextAction.ruleSource, 'position_manager')
  // The full armed list carries the others, each with real trigger prices.
  const kinds = out.armedActions.map(a => a.kind)
  for (const k of ['time_cap_exit', 'scale_out', 'bank_exit', 'tp_exit']) assert.ok(kinds.includes(k), k)
  const partial = out.armedActions.find(a => a.kind === 'scale_out')
  assert.ok(Math.abs(partial.triggerPrice - 102) < 1e-9)
})

test('no live price: distances/ETA/R are null and the explanation says so', () => {
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), null, null, 'r', NOW)
  assert.equal(out.currentR, null)
  assert.equal(out.verdictNow, null)
  for (const a of out.armedActions) assert.equal(a.distance, null, a.kind)
  // With nothing measurable the time cap (a real ETA) becomes the next action.
  assert.equal(out.nextAction.kind, 'time_cap_exit')
  assert.equal(out.nextAction.eta, '2026-07-31T08:00:00Z')
  assert.match(out.explanation.text, /unknown rather than estimated/)
  // The stored price trigger cannot be evaluated without a price — unknown.
  const stored = out.invalidation.find(i => i.kind === 'stored_trigger')
  assert.equal(stored.state, 'unknown')
})

test('invalidation watch: stored trigger, thesis, time cap and SL — states move with facts', () => {
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  const byKind = Object.fromEntries(out.invalidation.map(i => [i.kind, i]))
  assert.equal(byKind.stored_trigger.condition, 'price<99')
  assert.equal(byKind.stored_trigger.state, 'watching')   // price 101, trigger <99
  assert.equal(byKind.stored_trigger.machineEvaluable, true)
  assert.equal(byKind.thesis.state, 'watching')            // intact
  assert.equal(byKind.time_cap.state, 'watching')          // NOW is before 08:00Z
  assert.equal(byKind.stop_loss.state, 'armed')
  assert.ok(Math.abs(byKind.stop_loss.distance - 3) < 1e-9) // 101 − 98
  // Trigger fires when price crosses it.
  const fired = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), { price: 98.5 }, LIVE_AT, 'r', NOW)
  assert.equal(fired.invalidation.find(i => i.kind === 'stored_trigger').state, 'met')
  // Time cap flips to met once now passes it.
  const late = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', Date.parse('2026-07-31T09:00:00Z'))
  assert.equal(late.invalidation.find(i => i.kind === 'time_cap').state, 'met')
  // Broken thesis reads as met + an exiting decision state.
  ctx.db.prepare("UPDATE monitored_positions SET thesis_status = 'broken' WHERE id = ?").run(ctx.idA)
  const broken = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(broken.invalidation.find(i => i.kind === 'thesis').state, 'met')
  assert.equal(broken.currentDecision.state, 'exiting')
})

test('guard_json rows belong to trade-guard: legs are armed verbatim, done legs excluded', () => {
  ctx.db.prepare('UPDATE monitored_positions SET guard_json = ? WHERE id = ?').run(
    JSON.stringify({ breakEven: { on: true, triggerPips: 15, offsetPips: 2 }, trailing: { on: true, distancePips: 20 }, takeProfits: [{ price: 102, lots: 0.2, done: false }, { price: 104, lots: 0.3, done: true }] }),
    ctx.idA)
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.manager, 'trade_guard')
  const legs = out.armedActions.filter(a => a.kind === 'scale_out' && a.ruleSource === 'trade_guard')
  assert.equal(legs.length, 1)                      // the done leg must not re-arm
  assert.equal(legs[0].triggerPrice, 102)
  assert.ok(Math.abs(legs[0].distance - 1) < 1e-9)
  // Pip-denominated rules state their trigger in their own units — the read
  // path holds no pip size, so no price is invented for them.
  const be = out.armedActions.find(a => a.kind === 'break_even')
  assert.equal(be.triggerPrice, null)
  assert.match(be.trigger, /15 pips/)
  // Position-manager R-rules must NOT arm alongside the guard (the loop's
  // precedence: guard rows are skipped by keeper and R-manager alike).
  assert.ok(!out.armedActions.some(a => a.ruleSource === 'position_manager' && a.kind !== 'time_cap_exit'))
})

test('external rows without a guard belong to the profit keeper', () => {
  ctx.db.prepare("UPDATE monitored_positions SET source = 'external' WHERE id = ?").run(ctx.idA)
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.manager, 'profit_keeper')
  const arm = out.armedActions.find(a => a.kind === 'trail_arm')
  assert.equal(arm.ruleSource, 'profit_keeper')
  assert.match(arm.trigger, /Chandelier/)           // default config is adaptive
  // Opting out hands the row back to the R-manager.
  ctx.db.prepare('UPDATE monitored_positions SET keeper_opt_out = 1 WHERE id = ?').run(ctx.idA)
  assert.equal(buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW).manager, 'position_manager')
})

test('paused and halted states are stated, account-scoped, and never fabricated for others', () => {
  // Paused row.
  ctx.db.prepare('UPDATE monitored_positions SET paused = 1 WHERE id = ?').run(ctx.idA)
  let out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.currentDecision.state, 'paused')
  ctx.db.prepare('UPDATE monitored_positions SET paused = 0 WHERE id = ?').run(ctx.idA)
  // Exec kill switch blocks management.
  setState(ctx.db, 'exec_guard_json', JSON.stringify({ halt: true }))
  out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.currentDecision.state, 'blocked')
  assert.ok(out.currentDecision.evidence.includes('state:exec_guard_json'))
  setState(ctx.db, 'exec_guard_json', JSON.stringify({ halt: false }))
  // Equity stop tripped on ANOTHER account must not block this one.
  setState(ctx.db, 'acct:ACC_B:equity_stop_tripped_at', '2026-07-31T04:00:00Z')
  out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.notEqual(out.currentDecision.state, 'blocked')
  assert.ok(!out.invalidation.some(i => i.kind === 'equity_stop'))
  // On THIS account it blocks and shows as a met invalidation.
  setState(ctx.db, 'acct:ACC_A:equity_stop_tripped_at', '2026-07-31T04:30:00Z')
  out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.currentDecision.state, 'blocked')
  assert.equal(out.invalidation.find(i => i.kind === 'equity_stop').state, 'met')
})

test('a never-reviewed position is unknown, not assumed', () => {
  ctx.db.prepare('UPDATE monitored_positions SET last_check_action = NULL, last_check_reasoning = NULL, last_check_at = NULL, thesis_status = NULL WHERE id = ?').run(ctx.idA)
  const out = buildIntention(ctx.db, fetchRow(ctx.db, ctx.idA), LIVE, LIVE_AT, 'r', NOW)
  assert.equal(out.currentDecision.state, 'unknown')
  assert.equal(out.currentDecision.action, null)
  assert.match(out.explanation.text, /unknown, not assumed/)
})

test('snapshot integration: intention rides the endpoint and the revision moves with reviews', () => {
  const scope = { accountId: 'ACC_A', all: false, explicit: true }
  const out = cockpitSnapshot(ctx.db, ctx.idA, scope, NOW)
  assert.equal(out.status, 200)
  assert.equal(out.body.intention.status, 'derived')
  assert.equal(out.body.intention.explanation.evidenceRevision, out.body.meta.revision)
  assert.ok(String(out.body.meta.revision).includes('2026-07-31T04:55:00Z'))
  // A new review must invalidate cached explanations: revision changes.
  ctx.db.prepare("UPDATE monitored_positions SET last_check_at = '2026-07-31T05:05:00Z' WHERE id = ?").run(ctx.idA)
  const out2 = cockpitSnapshot(ctx.db, ctx.idA, scope, NOW)
  assert.notEqual(out2.body.meta.revision, out.body.meta.revision)
})
