// agent/services/tick-replay-parity.test.js — PR-Q1 (V3 P6/P7, 25-09-2026):
// does the replay reproduce the shadow? ok when the sidecar's own signals and
// shadow trades match the replay's; mismatch naming what is missing; and
// not_comparable — never a mismatch — where the sidecar's record is lossy (a
// boot change, a ring seq gap, a lost_restart), where the windows do not
// overlap, where the replay never settled, or where the fill rules differ.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync as makeTempDir, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

import { initDB } from '../db.js'
import { profileHash, normalizeParams } from '../lib/tick-strategy.js'
import { fixtureSegment } from './tick-research-run.test.js'
import { tickResearchAction } from './tick-research-run.js'
import { importTickTrial } from './tick-research.js'
import { compareParity, parityWindow, sidecarLossy, simComparison, replayParityView, trialParity, sidecarRecord, BOOTS_SQL, SIGNALS_SQL, SHADOW_TRADES_SQL, PROFILE_TRIALS_MAX, RING_SLACK_MS } from './tick-replay-parity.js'
import stateRouter from '../routes/state.js'

const temporaryDirectories = new Set()
after(() => { for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true }) })

// ---- the comparator, pure ----------------------------------------------------
const REPLAY = () => ({
  fromMs: 1_000, toMs: 100_000, settledFromMs: 2_000, latencyMs: 250, truncated: false,
  signals: [{ seq: 10, recvMs: 5_000, side: 'BUY' }, { seq: 20, recvMs: 9_000, side: 'SELL' }],
  trades: [{ side: 'BUY', entryMs: 5_300, exitMs: 6_000, reason: 'target' }, { side: 'SELL', entryMs: 9_300, exitMs: 9_800, reason: 'stop' }],
  gaps: [],
})
const HEALTHY = { boots: [{ bootId: 'b1', lo: 1, hi: 50, n: 50 }], lostRestart: 0 }
const SIDECAR = (over = {}) => ({
  signals: [{ seq: 10, recvMs: 5_000, side: 'BUY' }, { seq: 20, recvMs: 9_000, side: 'SELL' }],
  trades: [{ side: 'BUY', entryMs: 5_300, exitMs: 6_000, reason: 'target' }, { side: 'SELL', entryMs: 9_300, exitMs: 9_800, reason: 'stop' }],
  health: HEALTHY, ...over,
})

test('planted cpp_decisions signals and tick_shadow_trades that match the replay read parity ok', () => {
  const r = compareParity(REPLAY(), SIDECAR())
  assert.equal(r.parity, 'ok', JSON.stringify(r))
  assert.equal(r.signals.matched, 2); assert.equal(r.trades.matched, 2); assert.deepEqual(r.reasons, [])
  // entry within the latency still matches (the tolerance is the sim's own latency)
  const late = SIDECAR({ trades: [{ side: 'BUY', entryMs: 5_500, exitMs: 6_000, reason: 'target' }, { side: 'SELL', entryMs: 9_300, exitMs: 9_800, reason: 'stop' }] })
  assert.equal(compareParity(REPLAY(), late).parity, 'ok')
  const tooLate = SIDECAR({ trades: [{ side: 'BUY', entryMs: 5_600, exitMs: 6_000, reason: 'target' }, { side: 'SELL', entryMs: 9_300, exitMs: 9_800, reason: 'stop' }] })
  assert.equal(compareParity(REPLAY(), tooLate).parity, 'mismatch', '300 ms off at a 250 ms latency is not the same trade')
})

test('one missing shadow trade is a mismatch that NAMES it; a missing sidecar signal likewise; a replay trade open at the data end is not required to match', () => {
  const r = compareParity(REPLAY(), SIDECAR({ trades: [{ side: 'BUY', entryMs: 5_300, exitMs: 6_000, reason: 'target' }] }))
  assert.equal(r.parity, 'mismatch')
  assert.equal(r.trades.missingInShadow, 1); assert.deepEqual(r.trades.unmatched.missingInShadow.map(t => [t.side, t.entryMs]), [['SELL', 9_300]])
  assert.equal(r.signals.verdict, 'ok')
  const s = compareParity(REPLAY(), SIDECAR({ signals: [{ seq: 10, recvMs: 5_000, side: 'BUY' }] }))
  assert.equal(s.parity, 'mismatch'); assert.deepEqual(s.signals.unmatched.missingInShadow.map(x => x.seq), [20])
  const extra = compareParity(REPLAY(), SIDECAR({ signals: [...SIDECAR().signals, { seq: 30, recvMs: 20_000, side: 'BUY' }] }))
  assert.equal(extra.parity, 'mismatch'); assert.deepEqual(extra.signals.unmatched.missingInReplay.map(x => x.seq), [30])
  const open = REPLAY(); open.trades[1].reason = 'data_end'
  const o = compareParity(open, SIDECAR({ trades: [SIDECAR().trades[0]] }))
  assert.equal(o.parity, 'ok'); assert.equal(o.trades.openAtReplayEnd, 1)
  // a withheld record's trade still open at the test block: its entry only, matched when the shadow has it
  const sealed = REPLAY(); Object.assign(sealed.trades[1], { reason: 'open_at_scope_end', exitMs: null })
  assert.equal(compareParity(sealed, SIDECAR()).trades.matched, 2)
  assert.equal(compareParity(sealed, SIDECAR({ trades: [SIDECAR().trades[0]] })).parity, 'ok')
})

test('not_comparable, never mismatch: non-overlapping windows, a replay that never settled, a boot change, a ring seq gap, a lost_restart row', () => {
  const noOverlap = parityWindow(REPLAY(), [], { fromMs: 200_000, toMs: 300_000 })
  assert.equal(noOverlap.ok, false); assert.equal(noOverlap.reason, 'no_overlap')
  assert.equal(compareParity(REPLAY(), SIDECAR(), { window: noOverlap }).parity, 'not_comparable')
  const cold = { ...REPLAY(), settledFromMs: null }
  assert.deepEqual(compareParity(cold, SIDECAR()).reasons, ['replay_never_settled'])
  // the sidecar lost records: mismatching data inside is NOT scored against the replayer
  const lossy = (health) => compareParity(REPLAY(), SIDECAR({ trades: [], health }))
  const boot = lossy({ boots: [{ bootId: 'b1', lo: 1, hi: 10, n: 10 }, { bootId: 'b2', lo: 1, hi: 5, n: 5 }], lostRestart: 0 })
  assert.equal(boot.parity, 'not_comparable'); assert.ok(boot.reasons.includes('boot_change'), 'RED if a boot change is scored as a mismatch')
  const gap = lossy({ boots: [{ bootId: 'b1', lo: 1, hi: 60, n: 50 }], lostRestart: 0 })
  assert.equal(gap.parity, 'not_comparable'); assert.ok(gap.reasons.includes('decision_seq_gap')); assert.equal(gap.seqGaps[0].missing, 10)
  const lost = lossy({ ...HEALTHY, lostRestart: 1 })
  assert.equal(lost.parity, 'not_comparable'); assert.ok(lost.reasons.includes('shadow_lost_restart'))
  const nothing = lossy({ boots: [], lostRestart: 0 })
  assert.ok(nothing.reasons.includes('no_sidecar_record'))
  assert.deepEqual(sidecarLossy(HEALTHY).reasons, [])
})

test('split by gap reason: a mismatch where the RECORDER dropped quotes is not_comparable (recorder_dropped_quotes); a reconnect in the window is listed but does not excuse a mismatch', () => {
  const dropped = { ...REPLAY(), gaps: [{ reason: 'queue_overflow', recvMs: 7_000 }, { reason: 'reserve_pause', recvMs: 8_000 }] }
  const mis = compareParity(dropped, SIDECAR({ trades: [SIDECAR().trades[0]] }))
  assert.equal(mis.parity, 'not_comparable'); assert.ok(mis.reasons.includes('recorder_dropped_quotes'))
  assert.deepEqual(mis.gapsByReason, { queue_overflow: 1, reserve_pause: 1 }); assert.equal(mis.trades.verdict, 'mismatch', 'the mismatch itself is still shown')
  assert.equal(compareParity(dropped, SIDECAR()).parity, 'ok', 'a drop that changed nothing still reads ok')
  const reconnect = { ...REPLAY(), gaps: [{ reason: 'reconnect', recvMs: 7_000 }] }
  assert.equal(compareParity(reconnect, SIDECAR({ trades: [SIDECAR().trades[0]] })).parity, 'mismatch')
})

test('a replay that starts cold compares only once both books are flat: a live trade open at the settle point pushes the window past its exit', () => {
  const w = parityWindow(REPLAY(), [{ side: 'BUY', entryMs: 1_500, exitMs: 4_000 }])
  assert.equal(w.ok, true); assert.equal(w.fromMs, 4_001)
  const r = compareParity(REPLAY(), SIDECAR({ trades: [{ side: 'BUY', entryMs: 1_500, exitMs: 4_000, reason: 'stop' }, ...SIDECAR().trades] }))
  assert.equal(r.parity, 'ok'); assert.equal(r.window.fromMs, 4_001)
})

test('different fill rules are a different population: trades are not_comparable (sim_differs) while signals — which no sim touches — are still judged', () => {
  const differs = { ok: false, diffs: [{ field: 'latencyMs', replay: 60, shadow: 250 }] }
  const r = compareParity(REPLAY(), SIDECAR(), { sim: differs })
  assert.equal(r.parity, 'not_comparable'); assert.ok(r.reasons.includes('sim_differs')); assert.equal(r.trades.verdict, 'not_comparable')
  const sigMis = compareParity(REPLAY(), SIDECAR({ signals: [] }), { sim: differs })
  assert.equal(sigMis.parity, 'mismatch', 'a signal mismatch is a mismatch whatever the sim')
  // the comparison itself: maxHoldEvents 0 (the shadow file) and null (the replay default) are the same 4N
  const shadow = { latencyMs: 250, targetR: 3, minTargetToCost: 3, maxHoldEvents: 0, maxHoldMs: 21_600_000 }
  const same = simComparison({ latencyMs: 250, targetR: 3, minTargetToCost: 3, maxHoldEvents: null, maxHoldMs: 21_600_000 }, { rangeEvents: 256 }, shadow, [{ cost_class: null }])
  assert.equal(same.ok, true, JSON.stringify(same.diffs))
  const hold = simComparison({ latencyMs: 250, targetR: 3, minTargetToCost: 3, maxHoldEvents: 40, maxHoldMs: 21_600_000 }, { rangeEvents: 256 }, shadow, [{ cost_class: null }])
  assert.deepEqual(hold.diffs.map(d => d.field), ['maxHoldEvents'])
  const cost = simComparison({ ...shadow, maxHoldEvents: null, commissionBpsPerSide: 0.35 }, { rangeEvents: 256 }, shadow, [{ cost_class: 'fx', commission_bps: 0.5 }])
  assert.deepEqual(cost.diffs.map(d => d.field), ['costTerms'])
})

// ---- the database path -------------------------------------------------------
const PARAMS = { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }
// The shadow's non-cost fill rules (tick-shadow-sim.json): a trial replayed at
// them is comparable on trades; symbol 7 is in no cost map, so it is charged
// nothing, like the planted shadow rows below.
const SHADOW_SIM = JSON.parse(readFileSync(new URL('../config/tick-shadow-sim.json', import.meta.url), 'utf8'))
const SIM = { latencyMs: SHADOW_SIM.latencyMs, targetR: SHADOW_SIM.targetR, minTargetToCost: SHADOW_SIM.minTargetToCost, maxHoldMs: SHADOW_SIM.maxHoldMs, maxHoldEvents: SHADOW_SIM.maxHoldEvents }

function replayedTrial() {
  const db = initDB(':memory:')
  const dir = makeTempDir(join(tmpdir(), 'tick-parity-'))
  temporaryDirectories.add(dir)
  writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment())
  const hash = profileHash(normalizeParams(PARAMS))
  const r = tickResearchAction(db, { includeTest: true, params: PARAMS, sim: SIM, profileHash: hash }, { segmentsDir: dir })
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  const row = db.prepare('SELECT * FROM tick_trials WHERE trial_id = ?').get(r.body.trialIds[0])
  return { db, row, hash, rec: JSON.parse(row.parity_json) }
}
/** Plant the sidecar's own record of what the replay did, on the demo side, one boot, a contiguous ring. */
function plantSidecar(db, rec, hash, { dropSignalSeq = null } = {}) {
  const side = 'cpp_exec_demo'
  const ring = db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, symbol_id, code, detail) VALUES (?, 'boot-1', ?, ?, ?, ?, 7, ?, ?)`)
  // The ring numbers every record it logs, in time order, across components:
  // background traffic over the whole window plus the tick signals.
  const entries = []
  for (let ms = rec.fromMs; ms <= rec.toMs; ms += 500) entries.push({ ms, component: 'engine', kind: 'heartbeat', code: '', detail: '' })
  for (const s of rec.signals) entries.push({ ms: s.recvMs, component: 'tick', kind: 'signal', code: s.side, detail: `shadow dir=x seq=${s.seq} recvMs=${s.recvMs} bid=1 ask=2 profile=${hash}`, signalSeq: s.seq })
  entries.sort((a, b) => a.ms - b.ms)
  let seq = 0
  for (const e of entries) {
    seq++
    // A record the ring LOST (overflow between pulls) leaves its seq unused.
    if (e.signalSeq != null && e.signalSeq === dropSignalSeq) continue
    ring.run(side, seq, e.ms, e.component, e.kind, e.code, e.detail)
  }
  const tr = db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry_ms, exit_ms, reason, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps) VALUES (?, 'boot-1', ?, 7, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0)`)
  rec.trades.forEach((t, i) => tr.run(side, i + 1, hash, t.side, t.entryMs, t.exitMs, t.reason === 'data_end' ? 'hold_events' : t.reason))
  return { side, lastSeq: seq }
}

test('a stored trial against the sidecar\'s own rows: ok when they match; the manifest\'s environment picks the side; one dropped sidecar signal is a named mismatch', () => {
  const { db, row, hash, rec } = replayedTrial()
  assert.ok(rec.signals.length >= 1 && rec.trades.length >= 1, 'the parity record carries signals and trades')
  assert.ok(rec.settledFromMs != null, 'the fixture warms and settles')
  plantSidecar(db, rec, hash)
  const ok = trialParity(db, row)
  assert.equal(ok.side, 'cpp_exec_demo', 'demo segments are the demo sidecar\'s')
  assert.equal(ok.parity, 'ok', JSON.stringify(ok).slice(0, 600))
  assert.ok(ok.signals.matched >= 1)
  // the same trial, one sidecar signal missing: mismatch naming its seq
  const { db: db2, row: row2, hash: hash2, rec: rec2 } = replayedTrial()
  const compared = rec2.signals.filter(s => s.recvMs >= ok.window.fromMs && s.recvMs <= ok.window.toMs)
  assert.ok(compared.length >= 1, 'at least one signal falls inside the comparable window')
  plantSidecar(db2, rec2, hash2, { dropSignalSeq: compared[0].seq })
  const mis = trialParity(db2, row2)
  assert.equal(mis.parity, 'not_comparable', 'the dropped signal left a ring seq gap — the ring cannot tell a lost record from a missing signal')
  assert.ok(mis.reasons.includes('decision_seq_gap'))
})

test('a stored trial whose sidecar record lacks a signal WITHOUT a ring gap is a mismatch naming it; a trial written before PR-Q1 has no record to compare', () => {
  const { db, row, hash, rec } = replayedTrial()
  const { side } = plantSidecar(db, rec, hash)
  const w = trialParity(db, row).window
  const target = rec.signals.find(s => s.recvMs >= w.fromMs && s.recvMs <= w.toMs)
  // the signal row exists in the ring (seq contiguous) but says another profile rang it
  db.prepare(`UPDATE cpp_decisions SET detail = replace(detail, ?, 'profile=ffffffffffffffff') WHERE side = ? AND kind = 'signal' AND detail LIKE ?`).run(`profile=${hash}`, side, `%seq=${target.seq} %`)
  const mis = trialParity(db, row)
  assert.equal(mis.parity, 'mismatch', JSON.stringify(mis).slice(0, 600))
  assert.deepEqual(mis.signals.unmatched.missingInShadow.map(s => s.seq), [target.seq])
  // legacy row: no parity_json
  importTickTrial(db, { trialId: 'legacy-1', strategyId: 'tick_momentum_breakout', strategyVersion: 'v1', profileHash: hash, params: normalizeParams(PARAMS), sim: { latencyMs: 250 }, manifest: { files: ['x'] }, summary: { trades: 1 }, blocks: [] })
  const legacy = replayParityView(db, { trialId: 'legacy-1' })
  assert.equal(legacy.status, 200); assert.equal(legacy.body.parity, 'not_comparable'); assert.deepEqual(legacy.body.results[0].reasons, ['no_replay_record'])
  assert.match(legacy.body.note, /NOT YET COMPARED/)
  // by profile: every trial with a record, and the count of those without one
  const byProfile = replayParityView(db, { profile: hash, side: 'cpp_exec_demo' })
  assert.equal(byProfile.status, 200); assert.equal(byProfile.body.trialsCompared, 1); assert.equal(byProfile.body.trialsWithoutRecord, 1); assert.equal(byProfile.body.parity, 'mismatch')
  assert.equal(replayParityView(db, { profile: 'zz' }).status, 400)
  assert.equal(replayParityView(db, { profile: hash, side: 'nope' }).status, 400)
  assert.equal(replayParityView(db, { trialId: 'nope' }).status, 404)
  assert.equal(replayParityView(db, { profile: hash, from: 'not a time' }).status, 400)
})

test('GET /state/tick-replay-parity answers over a real router (report only), and GET /state/tick-research takes ?profile= and ?limit=all', async () => {
  const { db, row, hash } = replayedTrial()
  const app = express(); app.use(express.json()); app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  const url = (p) => `http://127.0.0.1:${s.address().port}${p}`
  try {
    const r = await fetch(url(`/state/tick-replay-parity?trialId=${row.trial_id}`))
    assert.equal(r.status, 200)
    const b = await r.json()
    assert.equal(b.results[0].trialId, row.trial_id); assert.equal(b.parity, 'not_comparable', 'no sidecar record planted'); assert.match(b.gates, /report only/)
    assert.equal((await fetch(url('/state/tick-replay-parity'))).status, 400)
    const all = await (await fetch(url(`/state/tick-research?profile=${hash}&limit=all`))).json()
    assert.equal(all.limit, 'all'); assert.equal(all.trials.length, 1); assert.equal(all.trials[0].profileHash, hash)
    assert.equal((await fetch(url('/state/tick-research?profile=xyz'))).status, 400)
  } finally { s.close() }
})

// ---- Q1 follow-up: the checker's B1 and N7 ------------------------------------
test('Q1 follow-up (checker B1): the ring reads are INDEXED — SQLite plans them on (side, ts_ms) and (side, component, kind, symbol_id, ts_ms), not the UNIQUE autoindex on side alone', () => {
  const db = initDB(':memory:')
  const plan = (sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(' | ')
  const boots = plan(BOOTS_SQL, ['cpp_exec_demo', 0, 1])
  assert.match(boots, /idx_cpp_decisions_side_ts/, `RED without the (side, ts_ms) index — the per-boot health scanned every row the side kept: ${boots}`)
  const signals = plan(SIGNALS_SQL, ['cpp_exec_demo', 7, 0, 1])
  assert.match(signals, /idx_cpp_decisions_tick_signal/, `RED without the signal index: ${signals}`)
  const trades = plan(SHADOW_TRADES_SQL, ['cpp_exec_demo', 7, 'x', 1, 0, 0])
  assert.match(trades, /idx_tick_shadow_side_profile/, `the shadow read stays on its own index: ${trades}`)
})

test('Q1 follow-up (checker B1): the profile form compares at most PROFILE_TRIALS_MAX trials per request, newest first, and says how many trials with a record it did NOT compare', () => {
  const { db, row, hash } = replayedTrial()
  const rec = JSON.parse(row.parity_json)
  const base = { strategyId: row.strategy_id, strategyVersion: row.version, profileHash: hash, params: JSON.parse(row.params_json), sim: JSON.parse(row.sim_json), manifest: JSON.parse(row.manifest_json), summary: JSON.parse(row.summary_json), blocks: JSON.parse(row.blocks_json), parity: rec }
  const extra = PROFILE_TRIALS_MAX + 4
  for (let i = 0; i < extra; i++) assert.equal(importTickTrial(db, { ...base, trialId: `copy-${String(i).padStart(3, '0')}` }).ok, true)
  const r = replayParityView(db, { profile: hash, side: 'cpp_exec_demo', limit: 200 })
  assert.equal(r.status, 200)
  assert.equal(PROFILE_TRIALS_MAX, 20)
  assert.equal(r.body.trialsCompared, PROFILE_TRIALS_MAX, 'RED if a request can still ask for 200 trials on the event loop')
  assert.equal(r.body.limit, PROFILE_TRIALS_MAX)
  assert.equal(r.body.trialsNotCompared, extra + 1 - PROFILE_TRIALS_MAX, 'the reply says how many it left out')
  assert.match(r.body.notComparedNote, /trialId=/)
  assert.equal(r.body.results[0].trialId, `copy-${String(extra - 1).padStart(3, '0')}`, 'newest first')
  const fewer = replayParityView(db, { profile: hash, side: 'cpp_exec_demo', limit: 3 })
  assert.equal(fewer.body.trialsCompared, 3); assert.equal(fewer.body.trialsNotCompared, extra + 1 - 3)
  assert.match(r.body.unobservedLosses, /worker-queue drops/, 'N6: the report names the loss it cannot see')
})

test('Q1 follow-up (checker N7): a shadow trade open ACROSS the whole window is read — the busy check pushes the window past it (not_comparable), where it used to be missed and the replay\'s trades scored a false mismatch', () => {
  const { db, row, hash, rec } = replayedTrial()
  assert.ok(rec.trades.length >= 1)
  // the sidecar rang the same signals but its book was busy the whole time
  const { side } = plantSidecar(db, { ...rec, trades: [] }, hash)
  const entry = rec.fromMs - 2 * RING_SLACK_MS, exit = rec.toMs + 2 * RING_SLACK_MS
  db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry_ms, exit_ms, reason, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps) VALUES (?, 'boot-1', 999, 7, ?, 'BUY', ?, ?, 'hold_clock', NULL, 0, 0, 0, 0)`).run(side, hash, entry, exit)
  const read = sidecarRecord(db, { side, profile: hash, symbolId: 7, fromMs: rec.fromMs, toMs: rec.toMs })
  assert.deepEqual(read.trades.map(t => [t.entryMs, t.exitMs]), [[entry, exit]], 'RED if the read keeps only trades that entered or exited inside the window')
  const r = trialParity(db, row)
  assert.notEqual(r.parity, 'mismatch', JSON.stringify(r).slice(0, 400))
  assert.equal(r.parity, 'not_comparable'); assert.deepEqual(r.reasons, ['no_overlap'])
})
