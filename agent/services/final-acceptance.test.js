// agent/services/final-acceptance.test.js — V3 R2 (P8d, corrected): the P8
// final-acceptance evaluators, graded on saved-body fixtures shaped like the
// real routes (tick-segments with the R1 manifest, tick-recorder, the
// runtime manifest, protection-audit, entry-intents, decisions,
// momentum-targets, position-history, broker-deals, scanner-mirrors), plus the
// command line that reads them from files.
//
// Every PASS fixture below is paired with the one change that must turn it
// FAIL or NOT_VERIFIABLE, so no green here can be a green that cannot go red.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { tempDir } from '../test-support/temp-dir.js'
import { initDB } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { reserveEntry, redeemPermit, resolveIntent, ledgerView, STANDING_PRODUCERS } from './entry-ledger.js'
import { _resetRefusalDedupe } from './entry-mode.js'
import {
  VERDICT, fold, check, freezeManifest, freezeFieldsFromBodies, recorderDrill, retentionCheck, capacityStage,
  e2eTrace, soakVerdict, finalReport, isStorageBody, assertNotStorage, StorageBodyRefused, wilson, toMs, E2E_SOURCES,
  STANDING_SIGNAL_PRODUCERS,
} from './final-acceptance.js'
import { defaultFaultPlan, sourceHashes, SOAK_SOURCES, soakArgs } from '../../scripts/tick-recorder-soak.mjs'
import { runStep } from '../../scripts/v3-final-acceptance.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const { PASS, FAIL, NOT_VERIFIABLE: NV } = VERDICT
const iso = (ms) => new Date(ms).toISOString()
const sqlite = (ms) => iso(ms).replace('T', ' ').slice(0, 19)
const T = Date.parse('2026-10-01T10:00:00Z')
const H = 3_600_000

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

test('the fold: nothing evaluated is NOT_VERIFIABLE, never PASS; one FAIL fails; an unknown verdict is not a pass', () => {
  assert.equal(fold('x', []).verdict, NV)
  assert.equal(fold('x', [null, undefined]).verdict, NV)
  assert.equal(fold('x', [check('a', PASS, 'ok')]).verdict, PASS)
  const f = fold('x', [check('a', PASS, 'ok'), check('b', NV, 'unseen'), check('c', FAIL, 'broken'), check('d', FAIL, 'later')])
  assert.equal(f.verdict, FAIL); assert.equal(f.reason, 'c: broken', 'the FIRST failing check names the fold')
  assert.equal(fold('x', [check('a', PASS, 'ok'), check('b', NV, 'unseen')]).reason, 'b: unseen')
  assert.equal(check('a', 'GREEN', 'typo').verdict, NV, 'a verdict string that is not one of the three is not a pass')
})

test('times: ISO, SQLite UTC and epoch ms read the same instant', () => {
  assert.equal(toMs('2026-10-01T10:00:00Z'), T)
  assert.equal(toMs('2026-10-01 10:00:00'), T, "SQLite datetime('now') is UTC with no zone")
  assert.equal(toMs(T), T); assert.equal(toMs(String(T)), T); assert.equal(toMs('garbage'), null); assert.equal(toMs(null), null)
})

// ---------------------------------------------------------------------------
// /state/storage is refused
// ---------------------------------------------------------------------------

test('a /state/storage body is refused by route and by shape', () => {
  const storage = { at: iso(T), files: { db: { path: '/data/agent.db', bytes: 1 }, wal: { path: 'x', bytes: 0 }, shm: {} }, volume: {}, tables: [] }
  assert.equal(isStorageBody(storage), true)
  assert.equal(isStorageBody({ at: iso(T), sides: [] }), false)
  assert.throws(() => assertNotStorage('/state/tick-segments', storage), StorageBodyRefused)
  assert.throws(() => assertNotStorage('/state/storage', {}), StorageBodyRefused)
  assert.doesNotThrow(() => assertNotStorage('/state/tick-segments', { sides: [] }))
})

// ---------------------------------------------------------------------------
// T0 — freeze
// ---------------------------------------------------------------------------

const FROZEN = {
  originMainSha: 'a'.repeat(40), nodeCommit: 'b'.repeat(40),
  railwayDeployments: { 'cpp-exec': 'd1', 'cpp-acct': 'd2', 'cpp-verify': 'd3', 'cpp-scan-tick': 'd4', 'cpp-scan-timeframe': 'd5' },
  accounts: [{ accountId: '…0058', environment: 'demo', effectiveEntryMode: 'TIME_BASED', bases: ['bar'] }],
  tickProfileHash: '967c1defd6e78d09', tickValidationSha256: 'c'.repeat(64), caps: { maxOpenPositions: 5, bookMax: 8 },
  partialTpPolicyVersion: 'ptp-1',
}

test('T0: a complete freeze identical at the end passes; unrecorded drift fails; a recorded change passes; a missing field is not verifiable; caps other than 5/8 fail', () => {
  assert.equal(freezeManifest(FROZEN, { end: structuredClone(FROZEN) }).verdict, PASS)
  const drift = freezeManifest(FROZEN, { end: { ...FROZEN, nodeCommit: 'e'.repeat(40) } })
  assert.equal(drift.verdict, FAIL); assert.match(drift.reason, /drift\.nodeCommit: changed during the trial and not recorded/)
  assert.equal(freezeManifest(FROZEN, { end: { ...FROZEN, nodeCommit: 'e'.repeat(40) }, changes: [{ field: 'nodeCommit', reason: 'the X1 merge, owner-approved' }] }).verdict, PASS)
  assert.equal(freezeManifest(FROZEN, { end: { ...FROZEN, nodeCommit: 'e'.repeat(40) }, changes: [{ field: 'nodeCommit' }] }).verdict, FAIL, 'a change with no reason is not a recorded change')
  const noEnd = freezeManifest(FROZEN)
  assert.equal(noEnd.verdict, NV); assert.match(noEnd.reason, /no end-of-trial manifest/)
  const { railwayDeployments, ...partial } = FROZEN
  assert.ok(railwayDeployments)
  const missing = freezeManifest(partial, { end: partial })
  assert.equal(missing.verdict, NV); assert.match(missing.reason, /start\.railwayDeployments: not captured/)
  const caps = freezeManifest({ ...FROZEN, caps: { maxOpenPositions: 16, bookMax: 8 } }, { end: { ...FROZEN, caps: { maxOpenPositions: 16, bookMax: 8 } } })
  assert.equal(caps.verdict, FAIL); assert.match(caps.reason, /not the owner's 5\/8/)
})

test('T0: the fields a saved runtime manifest, entry-engines and tick-recorder body carry', () => {
  const f = freezeFieldsFromBodies({
    runtimeManifest: { items: [{ key: 'node.commit', value: 'b'.repeat(40) }] },
    entryEngines: { accounts: [{ accountId: '…0058', environment: 'demo', effectiveEntryMode: 'TIME_BASED', admittedBases: ['bar'], bases: ['bar'], registry: { enabled: true } }] },
    tickRecorder: { sides: [{ side: 'cpp_exec', status: { strategy: { profileHash: '967c1defd6e78d09' } } }, { side: 'cpp_exec_demo', status: { strategy: { profileHash: '967c1defd6e78d09' } } }] },
  })
  assert.equal(f.nodeCommit, 'b'.repeat(40)); assert.equal(f.tickProfileHash, '967c1defd6e78d09'); assert.equal(f.accounts.length, 1)
  const conflict = freezeFieldsFromBodies({ tickRecorder: { sides: [{ side: 'cpp_exec', status: { strategy: { profileHash: 'aaaaaaaa' } } }, { side: 'cpp_exec_demo', status: { strategy: { profileHash: 'bbbbbbbb' } } }] } })
  assert.equal(conflict.tickProfileHash, undefined, 'two sides disagreeing is not one frozen hash')
  assert.deepEqual(conflict.tickProfileHashConflict, ['aaaaaaaa', 'bbbbbbbb'])
})

// ---------------------------------------------------------------------------
// T1 — the recovery drill
// ---------------------------------------------------------------------------

const SEGS = [
  { name: 'seg-1790000000000-000001.tks', bytes: 67108904, sealedAtMs: T - 5 * H },
  { name: 'seg-1790000100000-000002.tks', bytes: 67108904, sealedAtMs: T - 4 * H },
  { name: 'seg-1790000200000-000003.tks', bytes: 67108904, sealedAtMs: T - 3 * H },
]
const perSymbol = (n) => Array.from({ length: n }, (_, i) => ({ symbolId: i + 1, events: 10 }))
function recStatus({ state = 'RECORDING', recording = true, dropped = 0, gaps = 1, pausedDrops = 0, tornAtStart = 0, writeErrors = 0, symbols = 53, bootId = 'boot-b', sealedBytes = 201326712, openBytes = 1000, cap = 2147483648, retired = 0, generation = 1, extra = {} } = {}) {
  return {
    enabled: true, recording, state, generation,
    events: { total: 1000, dropped, gaps, pausedDrops },
    segments: { tornAtStart, writeErrors, sealedBytes, openBytes, spoolCapBytes: cap, segmentBytes: 67108864, retired, ...extra },
    perSymbol: perSymbol(symbols), shadowPortfolio: { bootId }, strategy: { profileHash: '967c1defd6e78d09' },
  }
}
const recBody = (at, side, status, rate24h = null) => ({ at: iso(at), sides: [{ side, at: iso(at), status, rate24h }] })
const segBody = (at, side, list, manifest) => ({ at: iso(at), sides: [{ side, reachable: true, enabled: true, segments: list.length, truncated: false, list, ...(manifest ? { manifest } : {}) }] })
const rm = (bootId, startedAtMs) => ({ at: iso(startedAtMs), items: [{ key: 'node.commit', value: 'b'.repeat(40) }, { key: 'sidecar.demo.bootId', value: bootId }, { key: 'sidecar.demo.startedAtMs', value: startedAtMs }] })
const audit = (at, o = {}) => ({ hasRun: true, stale: false, at: iso(at), ageSec: 5, checked: 32, naked: 0, targetless: 0, unmatched: 0, ...o })
const engines = () => ({ at: iso(T), accounts: [{ accountId: '…0058', environment: 'demo', effectiveEntryMode: 'TIME_BASED', bases: ['bar'], registry: { enabled: true } }] })
const intentsBody = (at, recent = [], counts = { '…0058': { FILLED: 3 } }) => ({ at: iso(at), countsByAccount: counts, open: [], recent })

function drillPair({ policy = 'DURABLE', afterList = SEGS, gone = [], tornAtStart = 0, gaps = 1 } = {}) {
  const side = 'cpp_exec_demo'
  const restartAt = T
  const before = {
    '/state/tick-segments': segBody(T - 10 * 60_000, side, SEGS, { persistence: { policy }, gone: [] }),
    '/state/tick-recorder': [recBody(T - 10 * 60_000, side, recStatus({ bootId: 'boot-a' }))],
    '/state/runtime-manifest': rm('boot-a', T - 50 * H),
    '/state/protection-audit': audit(T - 5 * 60_000),
    '/state/entry-intents': intentsBody(T - 5 * 60_000),
    '/state/entry-engines': engines(),
  }
  const after = {
    '/state/tick-segments': segBody(T + 4 * 60_000, side, afterList, { persistence: { policy }, gone }),
    '/state/tick-recorder': [recBody(T + 60_000, side, recStatus({ state: 'OFF', recording: false, gaps: 0, tornAtStart })), recBody(T + 2.5 * 60_000, side, recStatus({ tornAtStart, gaps }))],
    '/state/runtime-manifest': rm('boot-b', restartAt),
    '/state/protection-audit': audit(T + 3 * 60_000),
    '/state/entry-intents': intentsBody(T + 3 * 60_000),
    '/state/entry-engines': engines(),
    gatewayHealth: { [side]: { connected: true, lastReconcileAt: T + 90_000, trail: { tracked: 4 } } },
  }
  return { before, after, opts: { sides: [side] } }
}

test('T1 drill PASS: a DURABLE demo spool lists every sealed segment again with the same bytes, records within 5 min, marks the restart, keeps protection', () => {
  const { before, after, opts } = drillPair()
  const r = recorderDrill(before, after, opts)
  assert.equal(r.verdict, PASS, r.reason)
  const seg = r.checks.find(c => c.name === 'cpp_exec_demo.segments')
  assert.equal(seg.evidence.listedAgain, 3)
  assert.match(r.checks.find(c => c.name === 'cpp_exec_demo.recordingResumed').reason, /150 s after the sidecar started/)
})

test('T1 drill FAIL when one sealed segment from before is missing after the restart (DURABLE)', () => {
  const { before, after, opts } = drillPair({ afterList: SEGS.slice(1) })
  const r = recorderDrill(before, after, opts)
  assert.equal(r.verdict, FAIL)
  assert.match(r.reason, /cpp_exec_demo\.segments: DURABLE spool: 1 sealed segment\(s\) from before are gone \(seg-1790000000000-000001\.tks\)/)
})

test('T1 drill: a retire recorded by the manifest is not a loss; a resized segment fails', () => {
  const retired = drillPair({ afterList: SEGS.slice(1), gone: [{ name: SEGS[0].name, reason: 'retired' }] })
  assert.equal(recorderDrill(retired.before, retired.after, retired.opts).verdict, PASS)
  const resized = drillPair({ afterList: [SEGS[0], SEGS[1], { ...SEGS[2], bytes: 12 }] })
  const r = recorderDrill(resized.before, resized.after, resized.opts)
  assert.equal(r.verdict, FAIL); assert.match(r.reason, /listed again with different bytes/)
})

test('T1 drill on an EPHEMERAL_LOSS_RECORDED spool: losses recorded by name pass; a loss the manifest did not record fails', () => {
  const recorded = drillPair({ policy: 'EPHEMERAL_LOSS_RECORDED', afterList: [], gone: SEGS.map(s => ({ name: s.name, reason: 'lost_restart' })) })
  const ok = recorderDrill(recorded.before, recorded.after, recorded.opts)
  assert.equal(ok.verdict, PASS, ok.reason)
  assert.match(ok.checks.find(c => c.name === 'cpp_exec_demo.segments').reason, /3 recorded lost_restart by name/)
  const silent = drillPair({ policy: 'EPHEMERAL_LOSS_RECORDED', afterList: [], gone: SEGS.slice(1).map(s => ({ name: s.name, reason: 'lost_restart' })) })
  const bad = recorderDrill(silent.before, silent.after, silent.opts)
  assert.equal(bad.verdict, FAIL); assert.match(bad.reason, /the manifest does not record them as lost or retired/)
})

test('T1 drill: no restart, no per-segment list, no policy, an unmarked restart gap and a torn tail with no torn bytes are each named', () => {
  const same = drillPair()
  same.after['/state/runtime-manifest'] = rm('boot-a', T - 50 * H)
  assert.match(recorderDrill(same.before, same.after, same.opts).reason, /no restart happened between the two reads/)
  const noList = drillPair()
  delete noList.before['/state/tick-segments'].sides[0].list
  assert.match(recorderDrill(noList.before, noList.after, noList.opts).reason, /no per-segment list .*R1/)
  const noPolicy = drillPair({ policy: null })
  assert.match(recorderDrill(noPolicy.before, noPolicy.after, noPolicy.opts).reason, /no durability policy is in force/)
  const unmarked = drillPair({ gaps: 0 })
  const u = recorderDrill(unmarked.before, unmarked.after, unmarked.opts)
  assert.equal(u.verdict, FAIL); assert.match(u.reason, /restartGap: recording with no gap record this boot/)
  const torn = drillPair({ tornAtStart: 1 })
  const t = recorderDrill(torn.before, torn.after, torn.opts)
  assert.equal(t.verdict, NV); assert.match(t.reason, /tornTail: 1 torn tail\(s\) at start and the recorder reports neither salvage nor torn bytes/)
  const counted = drillPair({ tornAtStart: 1 })
  counted.after['/state/tick-recorder'][1].sides[0].status.segments.tornBytes = 3000
  assert.equal(recorderDrill(counted.before, counted.after, counted.opts).verdict, PASS)
})

test('T1 drill: naked positions after the restart, an UNKNOWN intent or a changed roster fail; an audit older than the restart is not verifiable', () => {
  const naked = drillPair()
  naked.after['/state/protection-audit'] = audit(T + 3 * 60_000, { naked: 1 })
  assert.match(recorderDrill(naked.before, naked.after, naked.opts).reason, /^protection: after the restart: 1 naked/)
  const unknown = drillPair()
  unknown.after['/state/entry-intents'] = intentsBody(T + 3 * 60_000, [], { '…0058': { FILLED: 3, UNKNOWN: 1 } })
  assert.match(recorderDrill(unknown.before, unknown.after, unknown.opts).reason, /^intents: UNKNOWN intents after the restart on …0058/)
  const roster = drillPair()
  roster.after['/state/entry-engines'] = { accounts: [{ ...engines().accounts[0], effectiveEntryMode: 'STOPPED' }] }
  assert.match(recorderDrill(roster.before, roster.after, roster.opts).reason, /^roster: the account roster changed/)
  const old = drillPair()
  old.after['/state/protection-audit'] = audit(T - 60_000)
  assert.match(recorderDrill(old.before, old.after, old.opts).reason, /^protection: the audit .* predates the restart/)
})

// ---------------------------------------------------------------------------
// T2 — retention
// ---------------------------------------------------------------------------

function retentionSamples({ unexplained = 0, retired = 2, verdict = 'VERIFIED', tornBytes = 0, sealedBytes = 2080374784, openBytes = 60000000 } = {}) {
  const side = 'cpp_exec_demo'
  const firstRetire = T
  const gone = [
    ...Array.from({ length: retired }, (_, i) => ({ name: `seg-17900000${i}0000-00000${i}.tks`, reason: 'retired', goneAtMs: firstRetire + i * H })),
    ...Array.from({ length: unexplained }, (_, i) => ({ name: `seg-17901000${i}0000-00010${i}.tks`, reason: 'unexplained', goneAtMs: firstRetire + H })),
  ]
  const manifest = { retired, unexplained, lostRestart: 0, listedBytes: sealedBytes, gone, retention: { verdict, reason: 'r1' } }
  return {
    segments: [segBody(T + 2 * H, side, [], manifest)],
    recorder: [T - H, T + H].map(at => recBody(at, side, recStatus({ sealedBytes, openBytes, retired, extra: { tornBytes } }))),
  }
}

test('T2 retention PASS: a retire bracketed by samples, nothing unexplained, sealed + open + torn under the cap', () => {
  const r = retentionCheck(retentionSamples(), { sides: ['cpp_exec_demo'] })
  assert.equal(r.verdict, PASS, r.reason)
})

test('T2 retention FAIL when a segment vanished with no retire to explain it (unexplained > 0)', () => {
  const r = retentionCheck(retentionSamples({ unexplained: 1, verdict: 'FAILED' }), { sides: ['cpp_exec_demo'] })
  assert.equal(r.verdict, FAIL)
  assert.match(r.reason, /cpp_exec_demo\.unexplained: 1 sealed segment\(s\) vanished within one boot/)
})

test('T2 retention: no retire yet is not verifiable; torn bytes unreported is not verifiable; the open segment past the cap fails unless the owner allows it', () => {
  assert.match(retentionCheck(retentionSamples({ retired: 0, verdict: 'NOT_VERIFIABLE' }), { sides: ['cpp_exec_demo'] }).reason, /retireObserved: no segment has been retired yet/)
  const noTorn = retentionSamples()
  for (const b of noTorn.recorder) delete b.sides[0].status.segments.tornBytes
  const nt = retentionCheck(noTorn, { sides: ['cpp_exec_demo'] })
  assert.equal(nt.verdict, NV); assert.match(nt.reason, /underCap: .*torn files are outside the count until P8c/)
  const over = retentionSamples({ sealedBytes: 2147483648, openBytes: 60000000 })
  assert.match(retentionCheck(over, { sides: ['cpp_exec_demo'] }).reason, /underCap: 2 sample\(s\) over the 2147483648 B cap by up to 60000000 B/)
  assert.equal(retentionCheck(over, { sides: ['cpp_exec_demo'], allowOpenSegmentOverCap: true }).verdict, PASS)
})

// ---------------------------------------------------------------------------
// T3 — a capacity stage
// ---------------------------------------------------------------------------

test('T3: a clean 24 h stage still reads NOT_VERIFIABLE without the owner\'s limits; a dropped event fails it', () => {
  const side = 'cpp_exec_demo'
  const samples = [0, 12, 24.5].map(h => recBody(T + h * H, side, recStatus({ symbols: 106 }), { bytesPerDay: 350_000_000 }))
  const stage = { side, symbols: 106, requiredRetentionDays: 5, afterQualification: true, rssMiB: 90, rssBoundMiB: 128, protectionLatency: { p95Ms: 800, p99Ms: 1500, limitP95Ms: 1000, limitP99Ms: 2000 } }
  assert.equal(capacityStage(samples, stage).verdict, PASS)
  const noLimits = capacityStage(samples, { side, symbols: 106 })
  assert.equal(noLimits.verdict, NV)
  assert.ok(noLimits.checks.some(c => c.name === 'protectionLatency' && /no owner latency limits/.test(c.reason)))
  const dropped = samples.map((b, i) => recBody(T + [0, 12, 24.5][i] * H, side, recStatus({ symbols: 106, dropped: i === 2 ? 5 : 0 }), { bytesPerDay: 350_000_000 }))
  const d = capacityStage(dropped, stage)
  assert.equal(d.verdict, FAIL); assert.match(d.reason, /^dropped: 5 event\(s\) dropped/)
  assert.equal(capacityStage(samples.slice(0, 1), stage).verdict, NV)
})

// ---------------------------------------------------------------------------
// T4 — the natural end-to-end trace
// ---------------------------------------------------------------------------

const ACCT = '46130058'
const WINDOW = { from: iso(T), to: iso(T + 6 * H) }
function intent(o = {}) {
  return {
    id: 'i1', account_id: '…0058', symbol: 'AAPL.US', symbol_id: 10095, side: 'BUY', producer_id: 'cross_sectional_book', basis: 'bar',
    state: 'FILLED', resolution_source: 'response', error_code: null, created_at: iso(T + H), resolved_at: iso(T + H + 2000),
    broker_order_id: 'o1', broker_position_id: 'p1', signal_ref: null, ...o,
  }
}
// The oldest row of each saved newest-first list, BEFORE the window start: a
// production ledger and decision log reach back past any trial window, and
// only a list that does is read as complete (a smaller ?limit cuts it).
const OLDER_INTENT = intent({ id: 'i0', symbol: 'MSFT.US', symbol_id: 10096, state: 'REJECTED', error_code: 'max_positions', resolution_source: 'admission', created_at: iso(T - 2 * H), resolved_at: iso(T - 2 * H + 1000), broker_order_id: null, broker_position_id: null })
const OLDER_DECISION = { id: 9, account_id: ACCT, symbol: 'MSFT.US', stage: 'risk_gate', decision: 'veto', reason: 'max_positions: 5/5 open', created_at: sqlite(T - 2 * H) }
function e2eBodies({ intents = [intent()], dealsNet = [8, 4.5], phNet = 12.5, decisions = null } = {}) {
  const deals = dealsNet.map((n, i) => ({ deal_id: `d${i + 1}`, position_id: 'p1', account_id: ACCT, net_pnl: n, closed_at: sqlite(T + (3 + i) * H) }))
  return {
    '/state/entry-intents': intentsBody(T + 6 * H, [...intents, OLDER_INTENT], { '…0058': { FILLED: 1 } }),
    '/state/decisions': decisions ?? { decisions: [{ id: 11, account_id: ACCT, symbol: 'AAPL.US', stage: 'dispatch', decision: 'proceed', reason: 'order dispatched: BUY 1 lots (risk event 5)', created_at: sqlite(T + H - 3000) }, OLDER_DECISION] },
    '/state/scanner-mirrors': { observedAtMs: T + 6 * H, status: 'unavailable', reason: 'no_scanner_observation' },
    '/state/momentum-targets': { accountId: 'all', rows: [{ accountId: ACCT, tradeId: 7, positionId: 'p1', evidenceValid: true, evidenceId: 'ev1', partialState: 'CONFIRMED' }], truncated: false },
    '/state/protection-audit': [audit(T + H + 40_000, { checked: 5 }), audit(T + 6 * H, { checked: 4 })],
    '/state/position-history': { recent: [{ account_id: ACCT, ctrader_position_id: 'p1', net_pnl: phNet, realised_r: 1.2, close_reason: 'momentum_book: TP1 partial then 3×ATR trail', closed_at_ms: T + 4 * H, verification_state: 'verified' }] },
    '/state/broker-deals': { rows: deals, total: deals.length },
    '/state/tick-segments': { at: iso(T + 6 * H), sides: ['cpp_exec', 'cpp_exec_demo'].map(side => ({ side, manifest: { unexplained: 0 } })) },
    '/state/tick-recorder': { at: iso(T + 6 * H), sides: ['cpp_exec', 'cpp_exec_demo'].map(side => ({ side, at: iso(T + 6 * H), status: recStatus({ bootId: `b-${side}` }) })) },
  }
}
function gateBodies() {
  return {
    '/state/protection-audit': audit(T - 30_000),
    '/state/entry-intents': intentsBody(T),
    '/state/watchdog': { observedAtMs: T, calendarsComplete: true, workComplete: true },
    '/state/heartbeats': { runtime: { at: iso(T) }, controllers: [{ name: 'pnl_reconcile', status: 'ok' }] },
    '/state/scanner-mirrors': { observedAtMs: T, mode: 'mirror', sources: [{ source: 'cpp-scan-tick' }] },
    '/state/tick-recorder': { at: iso(T), sides: ['cpp_exec', 'cpp_exec_demo'].map(side => ({ side, at: iso(T), status: recStatus({ bootId: `b-${side}` }) })) },
  }
}
const OPTS = { window: WINDOW, gate: gateBodies(), deadlineMs: 60_000 }

test('T4 PASS: one natural momentum entry linked candidate → admission → intent → fill → protection → TP1 and runner → P&L matched to the broker', () => {
  const r = e2eTrace(e2eBodies(), OPTS)
  assert.equal(r.verdict, PASS, r.reason)
  assert.equal(r.entries.length, 1); assert.equal(r.entries[0].verdict, PASS, r.entries[0].reason)
  assert.deepEqual(r.entries[0].checks.map(c => c.name), ['candidate', 'admission', 'intent', 'fill', 'protection', 'exits', 'pnl'])
  assert.equal(r.report.graded, false, 'PF in R and the win rate are reported, not graded')
  assert.equal(r.report.closed, 1); assert.equal(r.report.wins, 1); assert.deepEqual(r.report.wilson95, wilson(1, 1))
  assert.deepEqual(Object.keys(E2E_SOURCES).sort(), ['/state/broker-deals', '/state/decisions', '/state/entry-intents', '/state/momentum-targets', '/state/position-history', '/state/protection-audit', '/state/scanner-mirrors'])
})

test('T4 NOT_VERIFIABLE with zero natural events: a window with nothing in it is never a pass', () => {
  const empty = e2eTrace(e2eBodies({ intents: [] }), OPTS)
  assert.equal(empty.verdict, NV)
  assert.match(empty.reason, /^entries: no natural entry reached the broker between 2026-10-01T10:00:00\.000Z and 2026-10-01T16:00:00\.000Z; no forced trade stands in for one/)
  // Every other check in that result passed: only the missing event keeps it from PASS.
  assert.deepEqual(empty.checks.filter(c => c.verdict !== PASS).map(c => c.name), ['entries'])
  const outside = e2eTrace(e2eBodies({ intents: [intent({ created_at: iso(T - H), resolved_at: iso(T - H) })] }), OPTS)
  assert.equal(outside.verdict, NV, 'an entry before the window is not in it')
  const manual = e2eTrace(e2eBodies({ intents: [intent({ producer_id: 'route_manual_order' })] }), OPTS)
  assert.equal(manual.verdict, NV, 'a manual order is not a natural event')
  assert.equal(manual.excluded.length, 1)
})

test('T4 FAIL names the FIRST broken link in chain order (admission before P&L)', () => {
  const r = e2eTrace(e2eBodies({ decisions: { decisions: [] }, phNet: 99 }), OPTS)
  assert.equal(r.verdict, FAIL)
  assert.match(r.reason, /^entries: entry i1 — admission: no stage 'dispatch' decision 'proceed' on …0058 within 5 min before the intent/)
  const pnl = e2eTrace(e2eBodies({ phNet: 99 }), OPTS)
  assert.match(pnl.reason, /^entries: entry i1 — pnl: position-history net_pnl 99 disagrees with the sum of the broker deals' net_pnl 12\.5 \(field net_pnl, 2 deal\(s\)\)/)
  const fill = e2eTrace(e2eBodies({ intents: [intent({ broker_position_id: null })] }), OPTS)
  assert.match(fill.reason, /^entries: entry i1 — fill: FILLED with no broker position id/)
  const oldBuild = intent(); delete oldBuild.broker_position_id
  const nv = e2eTrace(e2eBodies({ intents: [oldBuild] }), OPTS)
  assert.equal(nv.verdict, NV, 'a route build that does not carry the key is not a broken link')
})

test('T4: a position still open at the end leaves its exits NOT_VERIFIABLE, not FAIL; an AMBIGUOUS partial fails', () => {
  const b = e2eBodies({ dealsNet: [] })
  b['/state/position-history'] = { recent: [] }
  b['/state/momentum-targets'].rows[0].partialState = 'ARMED'
  const open = e2eTrace(b, OPTS)
  assert.equal(open.verdict, NV)
  const exits = open.entries[0].checks.find(c => c.name === 'exits')
  assert.equal(exits.verdict, NV); assert.match(exits.reason, /still open at the end of the window; its exits are observed when the broker closes it naturally/)
  const amb = e2eBodies(); amb['/state/momentum-targets'].rows[0].partialState = 'AMBIGUOUS'
  assert.match(e2eTrace(amb, OPTS).reason, /exits: the partial TP1 on position p1 is AMBIGUOUS/)
  const oneDeal = e2eBodies({ dealsNet: [12.5] })
  assert.match(e2eTrace(oneDeal, OPTS).reason, /exits: the partial TP1 is CONFIRMED but the broker shows 1 closing deal/)
})

test('T4: naked or targetless positions, duplicate intents, a refusal with no reason, an unknown close reason and an unexplained segment loss each fail; gaps over reconnects are not verifiable', () => {
  const naked = e2eBodies(); naked['/state/protection-audit'][1] = audit(T + 5 * H, { targetless: 2 })
  assert.match(e2eTrace(naked, OPTS).reason, /^nakedOrTargetless: audit .* 0 naked, 2 targetless/)
  const dup = e2eBodies({ intents: [intent(), intent({ id: 'i2', created_at: iso(T + 2 * H), resolved_at: iso(T + 2 * H) })] })
  assert.match(e2eTrace(dup, OPTS).reason, /^duplicateIntents: position p1 on …0058/)
  const refusal = e2eBodies()
  refusal['/state/decisions'].decisions.push({ id: 12, account_id: ACCT, symbol: 'MSFT.US', stage: 'risk_gate', decision: 'veto', reason: '', created_at: sqlite(T + 2 * H) })
  assert.match(e2eTrace(refusal, OPTS).reason, /^refusalReasons: decision 12 \(risk_gate\) veto with no reason/)
  const unknown = e2eBodies(); unknown['/state/position-history'].recent[0].close_reason = 'unknown'
  assert.match(e2eTrace(unknown, OPTS).reason, /pnl: unknown close reason/)
  // A keeper switch-off writes GAP_SWITCHED_OFF with no reconnect, and the GET
  // body counts gaps without reasons: more gaps than reconnects is not proof of
  // loss (drops and reserve refusals fail on their own counters). T3 agrees.
  const gaps = e2eBodies(); gaps['/state/tick-recorder'].sides[1].status.events.gaps = 4
  const g = e2eTrace(gaps, OPTS)
  assert.equal(g.verdict, NV, g.reason)
  assert.match(g.reason, /^recorderGaps: recorder\.cpp_exec_demo\.counters: 3 gap\(s\) inside the window against 0 reconnect\(s\): the rest are not explained by these counters \(a keeper switch-off writes a gap with no reconnect/)
  const refused = e2eBodies(); refused['/state/tick-recorder'].sides[1].status.events.gaps = 4; refused['/state/tick-recorder'].sides[1].status.events.pausedDrops = 7
  assert.match(e2eTrace(refused, OPTS).reason, /^recorderGaps: recorder\.cpp_exec_demo\.counters: 7 event\(s\) dropped or refused by the reserve inside the window/, 'a gap with refused events still fails')
  const lost = e2eBodies(); lost['/state/tick-segments'].sides[0].manifest.unexplained = 1
  assert.match(e2eTrace(lost, OPTS).reason, /^recorderGaps: recorder\.cpp_exec\.manifest: 1 unexplained/)
})

test('T4 and T1: two sequential tick fills sharing one standing permit key are two entries, not a duplicate; two in flight at once are', () => {
  // tick-permits.js keys every permit for a symbol `tick:<symbolId>` and the
  // ledger stores that key as signal_ref, so it recurs on every fill.
  const tick = (o) => intent({ producer_id: 'tick_momentum', basis: 'tick', symbol: 'EURUSD', symbol_id: 5, signal_ref: 'tick:5', ...o })
  const seq = [
    tick({ id: 't1', broker_position_id: '111', created_at: iso(T + H), resolved_at: iso(T + H + 2000) }),
    tick({ id: 't2', broker_position_id: '222', created_at: iso(T + 4 * H), resolved_at: iso(T + 4 * H + 2000) }),
  ]
  const r = e2eTrace(e2eBodies({ intents: seq }), OPTS)
  const dup = r.checks.find(c => c.name === 'duplicateIntents')
  assert.equal(dup.verdict, PASS, dup.reason)
  const overlap = [
    tick({ id: 't1', broker_position_id: '111', created_at: iso(T + H), resolved_at: iso(T + 2 * H) }),
    tick({ id: 't2', broker_position_id: '222', created_at: iso(T + 1.5 * H), resolved_at: iso(T + 1.5 * H + 2000) }),
  ]
  const o = e2eTrace(e2eBodies({ intents: overlap }), OPTS)
  assert.equal(o.verdict, FAIL); assert.match(o.reason, /^duplicateIntents: permit key tick:5 on …0058: t1 and t2 in flight at once/)
  const undated = [tick({ id: 't1', broker_position_id: '111', created_at: null }), tick({ id: 't2', broker_position_id: '222', created_at: null, resolved_at: iso(T + 4 * H) })]
  const u = e2eTrace(e2eBodies({ intents: undated }), OPTS).checks.find(c => c.name === 'duplicateIntents')
  assert.equal(u.verdict, NV, 'a standing pair with no created time cannot be judged either way'); assert.match(u.reason, /carry no created time, so overlap cannot be judged: permit key tick:5 on …0058/)
  // A bar producer's signal is one signal: two reached intents on it stay a duplicate however far apart.
  const bar = [intent({ id: 'b1', signal_ref: 'sig-9', broker_position_id: '111' }), intent({ id: 'b2', signal_ref: 'sig-9', broker_position_id: '222', created_at: iso(T + 4 * H), resolved_at: iso(T + 4 * H) })]
  assert.match(e2eTrace(e2eBodies({ intents: bar }), OPTS).reason, /^duplicateIntents: signal sig-9 on …0058/)
  // T1 reads every recent[] row, not only a window: the same sequential pair passes there, the overlap fails.
  const drill = drillPair()
  drill.after['/state/entry-intents'] = intentsBody(T + 3 * 60_000, seq)
  assert.equal(recorderDrill(drill.before, drill.after, drill.opts).checks.find(c => c.name === 'intents').verdict, PASS)
  drill.after['/state/entry-intents'] = intentsBody(T + 3 * 60_000, overlap)
  assert.match(recorderDrill(drill.before, drill.after, drill.opts).reason, /^intents: duplicate intents: permit key tick:5 on …0058: t1 and t2 in flight at once/)
  assert.deepEqual([...STANDING_SIGNAL_PRODUCERS].sort(), [...STANDING_PRODUCERS].sort(), 'pinned to the ledger\'s own standing producers')
})

test('T4: a list saved with a small ?limit is not read as complete — only one reaching back past the window start is', () => {
  // Ten rows, all inside the window, fewer than the default page of 50: the old
  // rule read that as complete. The body does not state its ?limit.
  const tenIn = Array.from({ length: 10 }, (_, i) => intent({ id: `r${i}`, state: 'REJECTED', error_code: 'max_positions', broker_order_id: null, broker_position_id: null, created_at: iso(T + (i + 1) * 60_000), resolved_at: iso(T + (i + 1) * 60_000 + 500) }))
  const cut = e2eBodies({ intents: tenIn })
  cut['/state/entry-intents'].recent = cut['/state/entry-intents'].recent.filter(x => x.id !== OLDER_INTENT.id)
  const c = e2eTrace(cut, OPTS).checks.find(x => x.name === 'coverage.intents')
  assert.equal(c.verdict, NV); assert.match(c.reason, /does not reach back to the window start/)
  assert.equal(e2eTrace(e2eBodies({ intents: tenIn }), OPTS).checks.find(x => x.name === 'coverage.intents').verdict, PASS, 'the same rows with one older than the window start: complete')
  // Five decisions, none a dispatch for i1 and none before the window: not proof there was no admission.
  const five = { decisions: Array.from({ length: 5 }, (_, i) => ({ id: 20 + i, account_id: ACCT, symbol: 'MSFT.US', stage: 'risk_gate', decision: 'skip', reason: 'spread', created_at: sqlite(T + 2 * H + i * 1000) })) }
  const a = e2eTrace(e2eBodies({ decisions: five }), OPTS)
  const adm = a.entries[0].checks.find(x => x.name === 'admission')
  assert.equal(adm.verdict, NV, adm.reason); assert.match(adm.reason, /does not reach back to this intent/)
  assert.equal(a.checks.find(x => x.name === 'refusalReasons').verdict, NV)
  const none = e2eBodies({ intents: [] }); none['/state/entry-intents'].recent = []
  assert.equal(e2eTrace(none, OPTS).checks.find(x => x.name === 'coverage.intents').verdict, PASS, 'an empty page is the whole table (?limit is at least 1)')
})

test('T4: the entry gate is read at the start — missing, late or failing gate bodies are named', () => {
  assert.match(e2eTrace(e2eBodies(), { ...OPTS, gate: null }).reason, /^gate: gate: the entry gate bodies were not saved/)
  const late = gateBodies(); late['/state/watchdog'].observedAtMs = T - 20 * 60_000
  assert.match(e2eTrace(e2eBodies(), { ...OPTS, gate: late }).reason, /^gate: gate\/state\/watchdog\.readAt: read 20 min from the start/)
  const cal = gateBodies(); cal['/state/watchdog'].calendarsComplete = false
  assert.equal(e2eTrace(e2eBodies(), { ...OPTS, gate: cal }).verdict, NV)
  assert.equal(e2eTrace(e2eBodies(), { ...OPTS, gate: cal, waive: ['calendars'] }).verdict, PASS, 'the owner may waive complete calendars')
  const pnl = gateBodies(); pnl['/state/heartbeats'].controllers[0] = { name: 'pnl_reconcile', status: 'error', error_is_current: true, last_error: '2 closed trade(s) with no realised P&L' }
  assert.match(e2eTrace(e2eBodies(), { ...OPTS, gate: pnl }).reason, /^gate: gate\.pnlReconcile: pnl_reconcile error/)
  assert.equal(e2eTrace(e2eBodies(), { ...OPTS, deadlineMs: null }).verdict, NV, 'no owner protection deadline: the protection link cannot pass')
})

test('T4 over the REAL GET /state/entry-intents body: recent[] carries the broker position id and created time the fill and admission links join on', () => {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: ACCT, isLive: false })
  _resetRefusalDedupe()
  const now = Date.now()
  const r = reserveEntry(db, { accountId: ACCT, producerId: 'daily_momentum_account', symbol: 'AAPL.US', symbolId: 10095, side: 'BUY', volume: 1, sl: 1, tp: 2, now })
  assert.equal(r.ok, true, r.reason)
  assert.equal(redeemPermit(db, r.permit.id, { now }).ok, true)
  assert.equal(resolveIntent(db, r.intentId, { state: 'FILLED', positionId: 'p1', source: 'response', now: now + 1000 }).ok, true)
  const body = ledgerView(db)
  const row = body.recent.find(x => x.id === r.intentId)
  assert.equal(row.broker_position_id, 'p1'); assert.equal(row.basis, 'bar'); assert.equal(row.symbol_id, 10095)
  assert.equal(toMs(row.created_at), now)
  assert.ok(!JSON.stringify(body).includes(ACCT), 'account ids stay redacted')
  const bodies = e2eBodies()
  bodies['/state/entry-intents'] = body
  bodies['/state/decisions'].decisions[0].created_at = sqlite(now - 2000)
  const t = e2eTrace(bodies, { window: { from: iso(now - H), to: iso(now + H) }, deadlineMs: 60_000 })
  const entry = t.entries.find(e => e.id === r.intentId)
  assert.ok(entry, 'the real body produces an entry')
  assert.equal(entry.checks.find(c => c.name === 'fill').verdict, PASS)
  assert.equal(entry.checks.find(c => c.name === 'admission').verdict, PASS)
})

// ---------------------------------------------------------------------------
// P8d — the soak verdict
// ---------------------------------------------------------------------------

function soakReport({ elapsedS = 86400, offered = 1000, quotes = 990, dropped = 0, pausedDrops = 10, recordsWritten = 991, gaps = 1, writeErrors = 0, truncated = 0, faults = null } = {}) {
  return {
    config: { symbols: 20, ratePerSymbol: 100, burstFactor: 10, spoolCapBytes: 2147483648, segmentBytes: 67108864 },
    faults: faults ?? [{ atS: 10, kind: 'probe_low', applied: true, note: 'x', moved: { pausedDrops: 10, writeErrors: 0 } }, { atS: 20, kind: 'probe_ok', applied: true, moved: {} }],
    final: {
      elapsedS, offeredWhileOn: offered, offeredPerSecBase: 1990, offeredPerSecBurst: 19800, peakRssKiB: 20000, peakSpoolBytes: 2000000000,
      stats: { recordsWritten, gaps, dropped, pausedDrops, writeErrors },
      disk: { segmentsRead: 3, unreadSegments: 0, quoteRecords: quotes, truncatedSegments: truncated, gapBids: { reservePause: pausedDrops, queueOverflow: dropped } },
      unaccountedLoss: Math.max(0, offered - quotes - dropped - pausedDrops),
    },
  }
}

test('soak: a clean 24 h report passes every counter and disk check; a smoke run is not the soak', () => {
  const r = soakVerdict(soakReport(), { rssBoundMiB: 128 })
  assert.equal(r.verdict, PASS, r.reason)
  const smoke = soakVerdict(soakReport({ elapsedS: 60 }), { rssBoundMiB: 128 })
  assert.equal(smoke.verdict, NV); assert.match(smoke.reason, /^duration: 60 s run; the soak is 86400 s \(this is a smoke run, not the soak\)/)
  assert.equal(soakVerdict(null).verdict, NV)
})

test('soak: records counted as written but unreadable on disk fail; a fault that moved no counter fails; a fault not applied is not verifiable', () => {
  const lost = soakVerdict(soakReport({ quotes: 900, writeErrors: 3, truncated: 1 }), { rssBoundMiB: 128 })
  assert.equal(lost.verdict, FAIL)
  assert.match(lost.reason, /^disk: 90 record\(s\) the recorder counted as written are not readable on disk; 1 segment\(s\) stop at a bad checksum — 3 write error\(s\) were counted, but no counter says how many records they lost/)
  const rename = soakVerdict(soakReport({ faults: [{ atS: 5, kind: 'rename_fail', applied: true, hits: 3, moved: { writeErrors: 0, pausedDrops: 0 } }] }), { rssBoundMiB: 128 })
  assert.equal(rename.verdict, FAIL); assert.match(rename.reason, /fault\.rename_fail@5s: the fault was applied and failed 3 call\(s\), and writeErrors did not move: the recorder did not count it/)
  const unmet = soakVerdict(soakReport({ faults: [{ atS: 5, kind: 'probe_low', applied: true, hits: 0, moved: { pausedDrops: 0 } }] }), { rssBoundMiB: 128 })
  assert.equal(unmet.verdict, NV, 'a fault that met no call cannot accuse the recorder')
  assert.match(unmet.reason, /fault\.probe_low@5s: applied, but no call the fault breaks happened inside its window/)
  const root = soakVerdict(soakReport({ faults: [{ atS: 5, kind: 'chmod_ro', applied: false, note: 'running as root' }] }), { rssBoundMiB: 128 })
  assert.equal(root.verdict, NV); assert.match(root.reason, /fault\.chmod_ro@5s: not applied: running as root/)
  // An unwritable spool that ends the fault PAUSED_RESERVE is a write failure
  // reported as a full disk (the 60 s smoke run: writeErrors +8,260 and
  // pausedDrops +8,260). A full disk read as a reserve pause is right.
  const misread = soakVerdict(soakReport({ faults: [{ atS: 23, kind: 'unwritable', applied: true, hits: 8260, moved: { writeErrors: 8260, pausedDrops: 8260 }, stateAtEnd: 'PAUSED_RESERVE' }] }), { rssBoundMiB: 128 })
  assert.equal(misread.verdict, FAIL)
  assert.match(misread.reason, /^fault\.unwritable@23s: writeErrors \+8260, but the recorder ended the fault PAUSED_RESERVE: the unwritable fault is reported as a free-space pause and 8260 event\(s\) were counted as reserve refusals/)
  const counted = soakVerdict(soakReport({ faults: [{ atS: 23, kind: 'unwritable', applied: true, hits: 50, moved: { writeErrors: 50, pausedDrops: 0 }, stateAtEnd: 'RECORDING' }] }), { rssBoundMiB: 128 })
  assert.equal(counted.checks.find(x => x.name === 'fault.unwritable@23s').verdict, PASS)
  const full = soakVerdict(soakReport({ faults: [{ atS: 23, kind: 'enospc_write', applied: true, hits: 50, moved: { writeErrors: 50, pausedDrops: 9 }, stateAtEnd: 'PAUSED_RESERVE' }] }), { rssBoundMiB: 128 })
  assert.equal(full.checks.find(x => x.name === 'fault.enospc_write@23s').verdict, PASS, 'ENOSPC is a full disk: a reserve pause is the right reading')
  const cumul = soakReport({ pausedDrops: 10 }); cumul.final.disk.gapBids.reservePause = 16
  assert.match(soakVerdict(cumul, { rssBoundMiB: 128 }).reason, /^gaps\.reserve: GAP_RESERVE_PAUSE records on disk count 16 refused event\(s\); the counter says 10/)
})

test('soak runner: the default fault plan places every fault inside the run and holds seal-dependent faults across a segment', () => {
  const plan = defaultFaultPlan({ duration: 60, segmentBytes: 262144, symbols: 20, rate: 100 })
  const entries = plan.split(',').map(e => { const [at, kind] = e.split(':'); return { at: Number(at), kind } })
  assert.ok(entries.every(e => e.at >= 0 && e.at < 60), plan)
  for (const k of ['probe_low', 'eio_write', 'short_write', 'rename_fail', 'unwritable', 'slow', 'eio_fsync', 'reconnect', 'chmod_ro']) assert.ok(entries.some(e => e.kind === k), k)
  const held = (kind) => { const i = entries.findIndex(e => e.kind === kind); return entries[i + 1].at - entries[i].at }
  assert.ok(held('rename_fail') >= 1.5 * (262144 / (20 * 100 * 40)), 'rename_fail is held across at least 1.5 segments')
  assert.ok(held('probe_low') >= 2.5 * 2, 'a free-space fault outlasts 2.5 of the recorder\'s 2 s probe intervals')
  assert.ok(held('eio_fsync') >= 1.5 * 5, 'a failed fsync is held across 1.5 of the recorder\'s 5 s fsync intervals')
  assert.equal(entries.filter(e => e.kind === 'probe_low').length, 2, 'two reserve pauses: the cumulative gap count is exercised')
  for (const d of [60, 3600, 86400]) {
    const e = defaultFaultPlan({ duration: d, segmentBytes: 67108864, symbols: 20, rate: 100 }).split(',').map(x => { const [t, kind] = x.split(':'); return { t: Number(t), kind } })
    const restore = new Set(['none', 'probe_ok', 'restore', 'free_inodes'])
    let open = null
    for (const x of e) {
      if (restore.has(x.kind)) { assert.ok(open, `${d}s: a restore with no open fault at ${x.t}`); open = null; continue }
      assert.equal(open, null, `${d}s: ${x.kind} at ${x.t} starts inside ${open?.kind}'s window`)
      if (x.kind !== 'reconnect') open = x
    }
    assert.ok(e.every((x, i) => i === 0 || x.t >= e[i - 1].t), 'the plan is in time order')
  }
  const h = sourceHashes(ROOT)
  assert.match(h.sourceSha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(h.files.map(f => f.file), [...SOAK_SOURCES])
  // --keep without --dir would keep nothing (the temp dir is removed at exit): refused, not ignored.
  assert.throws(() => soakArgs(['--keep']), /--keep needs --dir DIR/)
  assert.equal(soakArgs(['--keep', '--dir', '/x']).keep, true)
  assert.equal(soakArgs([]).keep, false)
})

// ---------------------------------------------------------------------------
// T5 — the report
// ---------------------------------------------------------------------------

test('T5: rollback deployment ids alone are not a rollback PASS; cost over the ceiling fails; a missing step is not run', () => {
  const steps = Object.fromEntries(['T0', 'T1', 'T1b', 'T2', 'T3', 'T4', 'soak'].map(s => [s, { verdict: PASS, reason: 'ok' }]))
  const rehearsed = finalReport({ steps, rollback: { rehearsed: true, evidence: 'redeployed d1 at 03:10Z, read back', deployments: { 'cpp-exec': 'd1' } }, cost: { monthlyUsd: 80, ceilingUsd: 100, readBy: 'owner' } })
  assert.equal(rehearsed.verdict, PASS, rehearsed.reason)
  const idsOnly = finalReport({ steps, rollback: { deployments: { 'cpp-exec': 'd1' } }, cost: { monthlyUsd: 80, ceilingUsd: 100 } })
  assert.equal(idsOnly.verdict, NV); assert.match(idsOnly.reason, /^rollback: 1 deployment id\(s\) recorded, not rehearsed: a list of ids is not a rollback/)
  assert.match(finalReport({ steps, rollback: { rehearsed: true, evidence: 'x' }, cost: { monthlyUsd: 120, ceilingUsd: 100 } }).reason, /^cost: 120 USD a month against a 100 USD ceiling/)
  const { T3, ...noT3 } = steps
  assert.ok(T3)
  assert.match(finalReport({ steps: noT3, rollback: { rehearsed: true, evidence: 'x' }, cost: { monthlyUsd: 1, ceilingUsd: 2 } }).reason, /^T3: not run/)
})

// ---------------------------------------------------------------------------
// The command line: reads saved files, never a service; refuses /state/storage
// ---------------------------------------------------------------------------

function writeDir(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body))
}
const cli = (...argv) => spawnSync(process.execPath, ['scripts/v3-final-acceptance.mjs', ...argv], { cwd: ROOT, encoding: 'utf8' })

test('CLI: the drill step grades saved bodies from two directories (PASS exit 0, a missing segment exit 1), and a /state/storage body is refused (exit 2)', () => {
  const tmp = tempDir('final-acceptance-cli-')
  const write = (dirName, pair) => {
    const files = {}
    for (const [route, body] of Object.entries(pair)) {
      if (route === 'gatewayHealth') { for (const [side, h] of Object.entries(body)) files[`gateway-health.${side}.json`] = h; continue }
      const name = route.replace('/state/', '')
      if (Array.isArray(body)) body.forEach((b, i) => { files[`${name}.${i}.json`] = b })
      else files[`${name}.json`] = body
    }
    writeDir(join(tmp, dirName), files)
    return join(tmp, dirName)
  }
  const good = drillPair()
  const ok = cli('drill', '--before', write('b1', good.before), '--after', write('a1', good.after), '--side', 'cpp_exec_demo')
  assert.equal(ok.status, 0, ok.stderr + ok.stdout.slice(0, 2000))
  const out = JSON.parse(ok.stdout)
  assert.equal(out.step, 'T1'); assert.equal(out.verdict, PASS); assert.match(out.evaluatorVersion, /^v3-r2-/)
  const bad = drillPair({ afterList: SEGS.slice(1) })
  const fail = cli('drill', '--before', write('b2', bad.before), '--after', write('a2', bad.after), '--side', 'cpp_exec_demo')
  assert.equal(fail.status, 1); assert.equal(JSON.parse(fail.stdout).verdict, FAIL)
  writeDir(join(tmp, 'a3'), { 'storage.json': { files: { db: {}, wal: {} }, tables: [] } })
  const refused = cli('drill', '--before', join(tmp, 'b1'), '--after', join(tmp, 'a3'))
  assert.equal(refused.status, 2); assert.match(refused.stderr, /GET \/state\/storage body is refused/)
  writeDir(join(tmp, 'a4'), { 'tick-segments.json': { files: { db: {}, wal: {} }, tables: [] } })
  assert.equal(cli('drill', '--before', join(tmp, 'b1'), '--after', join(tmp, 'a4')).status, 2, 'refused by shape under another name')
  const e2e = cli('e2e', '--dir', join(tmp, 'b1'), '--from', WINDOW.from, '--to', WINDOW.to)
  assert.equal(e2e.status, 3, 'no natural entry in these bodies: NOT_VERIFIABLE, exit 3')
  assert.equal(cli('nonsense').status, 2)
})

test('CLI freeze: the tick-validation sha is never computed from the checkout for the START of a start-and-end freeze, so a change during the trial cannot be hidden', () => {
  const tmp = tempDir('final-acceptance-freeze-')
  const bodies = {
    'runtime-manifest.json': { at: iso(T), items: [{ key: 'node.commit', value: 'b'.repeat(40) }] },
    'entry-engines.json': engines(),
    'tick-recorder.json': { at: iso(T), sides: ['cpp_exec', 'cpp_exec_demo'].map(side => ({ side, at: iso(T), status: recStatus() })) },
  }
  writeDir(join(tmp, 'start'), bodies); writeDir(join(tmp, 'end'), bodies)
  const { tickValidationSha256, nodeCommit, accounts, tickProfileHash, ...operator } = FROZEN
  assert.ok(tickValidationSha256 && nodeCommit && accounts && tickProfileHash, 'the operator file carries only what no GET body does')
  writeDir(tmp, { 'fields.json': operator })
  const checkout = createHash('sha256').update(readFileSync(join(ROOT, 'agent/config/tick-validation.json'))).digest('hex')
  const at = '2026-10-02T09:00:00.000Z'
  const drift = (r) => r.checks.find(c => c.name === 'drift.tickValidationSha256')
  // Start only: the capture IS the evaluation, so the sha is computed — and labelled as such.
  const s0 = runStep({ step: 'freeze', start: join(tmp, 'start'), fields: join(tmp, 'fields.json') }, { evaluatedAt: at })
  assert.equal(s0.manifest.start.fields.tickValidationSha256, checkout)
  assert.equal(s0.manifest.start.sources.tickValidationSha256, `computed at evaluation ${at} from this checkout's agent/config/tick-validation.json`)
  // Start and end, no sha in the start fields file: not captured, so its drift is NOT_VERIFIABLE — never "identical".
  const both = runStep({ step: 'freeze', start: join(tmp, 'start'), fields: join(tmp, 'fields.json'), end: join(tmp, 'end'), endFields: join(tmp, 'fields.json') }, { evaluatedAt: at })
  assert.equal(both.manifest.start.fields.tickValidationSha256, undefined)
  assert.match(both.manifest.start.sources.tickValidationSha256, /^not captured: the start fields file carries no tickValidationSha256/)
  assert.equal(both.manifest.end.fields.tickValidationSha256, checkout)
  assert.match(both.manifest.end.sources.tickValidationSha256, /^computed at evaluation 2026-10-02T09:00:00\.000Z/)
  assert.equal(drift(both).verdict, NV); assert.match(drift(both).reason, /start value not captured/)
  assert.equal(both.checks.find(c => c.name === 'start.tickValidationSha256').verdict, NV)
  // The sha recorded at the start differs from the file now: the change is seen.
  writeDir(tmp, { 'fields-start.json': { ...operator, tickValidationSha256: '0'.repeat(64) } })
  const changed = runStep({ step: 'freeze', start: join(tmp, 'start'), fields: join(tmp, 'fields-start.json'), end: join(tmp, 'end'), endFields: join(tmp, 'fields.json') }, { evaluatedAt: at })
  assert.equal(changed.verdict, FAIL); assert.equal(drift(changed).verdict, FAIL); assert.match(drift(changed).reason, /changed during the trial and not recorded/)
  writeDir(tmp, { 'fields-same.json': { ...operator, tickValidationSha256: checkout } })
  const same = runStep({ step: 'freeze', start: join(tmp, 'start'), fields: join(tmp, 'fields-same.json'), end: join(tmp, 'end'), endFields: join(tmp, 'fields.json') }, { evaluatedAt: at })
  assert.equal(drift(same).verdict, PASS)
})
