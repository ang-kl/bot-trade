// node --test agent/services/tick-segment-manifest.test.js — V3 R1 (P8b): the
// tick segment manifest. Behaviour, not source: listings are fed through the
// same reconcile the heartbeat runs, with the recorder's /tick-status counters
// and cap, and what each vanished segment is classed as — and the verdicts
// that follow — are read back from the database.
//
// The shapes are production's (GET /state/tick-recorder and /tick-segments,
// 25-09-2026 16:49 UTC): 64 MiB segments sealed at 67,108,872 B, a 2 GiB cap,
// so a full spool holds 31 sealed segments.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, getState } from '../db.js'
import { probeOneSidecar } from './heartbeat.js'
import {
  classifyVanished, reconcileSegmentManifest, persistenceVerdict, retentionVerdict, segmentManifestView,
  loadDurabilityPolicy, policyAt, segmentStartMs, GONE, DURABILITY, VERDICT, MANIFEST_STATE_KEY,
} from './tick-segment-manifest.js'

const SEG = 67_108_872           // one sealed 64 MiB segment as production lists it
const CAP = 2 * 1024 ** 3         // spoolCapBytes
const T0 = Date.parse('2026-09-26T00:00:00Z')
const MIN = 60_000
const name = (i) => `seg-${String(1_790_000_000_000 + i * 3_600_000)}-${String(i).padStart(6, '0')}.tks`
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k)
const status = ({ retired = 0, sealed = 0, cap = CAP } = {}) => ({
  enabled: true, recording: true, state: 'RECORDING',
  segments: { retired, sealed, spoolCapBytes: cap, segmentBytes: 64 * 1024 * 1024, sealedBytes: 0, openBytes: 0 },
})
const lister = (ids, { truncated = false, bytes = () => SEG } = {}) => {
  const fn = async () => { fn.calls++; return { ok: true, enabled: true, spool: '/data/tick', segments: ids.map(i => ({ name: name(i), bytes: bytes(i), sealedAtMs: 1_790_000_000_000 + i * 3_600_000 + 3_000_000, index: i })), openBytes: 0, truncated } }
  fn.calls = 0
  return fn
}
const SIDE = { name: 'cpp_exec_demo', base: 'http://demo.invalid' }
const reconcile = (db, ids, { boot = 'boot-a', retired = 0, sealed = 0, at = T0, side = SIDE, truncated = false, bytes } = {}) =>
  reconcileSegmentManifest(db, side, { status: status({ retired, sealed }), bootId: boot, nowMs: at, list: lister(ids, { truncated, bytes }) })
const rows = (db, side = SIDE.name) => db.prepare('SELECT name, bytes, first_bytes, gone_reason, gone_at_ms FROM tick_segment_manifest WHERE side = ? ORDER BY name').all(side)
const reasons = (db, side = SIDE.name) => Object.fromEntries(rows(db, side).filter(r => r.gone_reason).map(r => [r.name, r.gone_reason]))
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn() } finally { console.log = l; console.warn = w } }
const declared = (policy, from = '2026-09-25T00:00:00Z') => [{ policy, from, fromMs: Date.parse(from), basis: 'test' }]

test('(1) a restart that takes two sealed segments the cap cannot explain: lost_restart = 2, persistence FAILED under DURABLE', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 5), { boot: 'boot-a', sealed: 5 })
    // New boot: the oldest two are gone, the counter (per boot) says 0 retired.
    const r = await reconcile(db, range(3, 5), { boot: 'boot-b', retired: 0, sealed: 0, at: T0 + 2 * MIN })
    assert.equal(r.boot, 'changed')
  })
  assert.deepEqual(reasons(db), { [name(1)]: GONE.LOST_RESTART, [name(2)]: GONE.LOST_RESTART }, 'RED if a retire is claimed for segments 5 × 64 MiB could never push past a 2 GiB cap')
  const boot = db.prepare('SELECT * FROM tick_segment_boots').get()
  assert.deepEqual([boot.prev_boot_id, boot.boot_id, boot.listed_before, boot.survived, boot.retired, boot.lost, boot.lost_bytes], ['boot-a', 'boot-b', 5, 3, 0, 2, 2 * SEG])
  const v = persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 3 * MIN })
  assert.equal(v.verdict, VERDICT.FAILED)
  assert.equal(v.lostRestart, 2); assert.equal(v.lostBytes, 2 * SEG)
  assert.match(v.reason, /gone at a gateway restart under the DURABLE policy/)
})

test('(2) within one boot, the recorder retires two at the cap and counts them: retired = 2, retention VERIFIED', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 31), { retired: 4, sealed: 31 })            // a full spool: 31 × 67,108,872 B ≤ 2 GiB
    await reconcile(db, range(3, 33), { retired: 6, sealed: 33, at: T0 + 2 * MIN }) // two sealed, the oldest two retired
  })
  assert.deepEqual(reasons(db), { [name(1)]: GONE.RETIRED, [name(2)]: GONE.RETIRED })
  const state = JSON.parse(getState(db, MANIFEST_STATE_KEY))[SIDE.name]
  assert.equal(state.retiredAccounted, 6, 'both retires matched, none left over to explain a later loss')
  const v = retentionVerdict(db, SIDE.name, { state })
  assert.equal(v.verdict, VERDICT.VERIFIED); assert.equal(v.retired, 2)
})

test('(3) within one boot, a segment gone with no retire counted is held one probe, then unexplained; retention FAILED', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 31), { retired: 0, sealed: 31 })
    // The cap allows retiring #1 (#32 was sealed) but the counter says 0: held
    // pending — /tick-status is read BEFORE the listing, so a retire between
    // the two reads only shows in the next status.
    const a = await reconcile(db, range(2, 32), { retired: 0, sealed: 32, at: T0 + 2 * MIN })
    assert.deepEqual(a.pending, [name(1)])
  })
  assert.deepEqual(reasons(db), {}, 'nothing classed on the first sight')
  assert.equal(retentionVerdict(db, SIDE.name).verdict, VERDICT.NOT_VERIFIABLE)
  await quiet(() => reconcile(db, range(2, 32), { retired: 0, sealed: 32, at: T0 + 4 * MIN }))
  assert.deepEqual(reasons(db), { [name(1)]: GONE.UNEXPLAINED })
  const v = retentionVerdict(db, SIDE.name)
  assert.equal(v.verdict, VERDICT.FAILED); assert.equal(v.unexplained, 1)
})

test('(3b) the held segment is RETIRED when the next status counts the retire — the read-order race does not become a false loss', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 31), { retired: 0, sealed: 31 })
    await reconcile(db, range(2, 32), { retired: 0, sealed: 32, at: T0 + 2 * MIN })
    await reconcile(db, range(2, 32), { retired: 1, sealed: 32, at: T0 + 4 * MIN })
  })
  assert.deepEqual(reasons(db), { [name(1)]: GONE.RETIRED })
})

test('(3c) within one boot, a segment gone that the cap cannot explain is unexplained at once, even with a retire counted', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 5), { retired: 0, sealed: 5 })
    await reconcile(db, range(2, 5), { retired: 1, sealed: 5, at: T0 + 2 * MIN })
  })
  assert.deepEqual(reasons(db), { [name(1)]: GONE.UNEXPLAINED }, 'five 64 MiB segments are under the 2 GiB cap: no retire could have taken #1')
})

test('(4) no restart observed: persistence NOT_VERIFIABLE under DURABLE, and nothing is gone', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 5), { sealed: 5 })
    await reconcile(db, range(1, 6), { sealed: 6, at: T0 + 2 * MIN })
  })
  const v = persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 3 * MIN })
  assert.equal(v.verdict, VERDICT.NOT_VERIFIABLE)
  assert.match(v.reason, /no gateway restart with sealed segments/)
  assert.equal(rows(db).length, 6)
})

test('review blocker 4(2): a retire the OLD boot made after its last sample is classed retired, not lost_restart — persistence VERIFIED', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 31), { boot: 'boot-a', retired: 3, sealed: 31 })
    // boot-a sealed #32 and retired #1 after that listing, then died; boot-b's
    // counters start at 0, so the old boot's retire is on no counter anywhere.
    await reconcile(db, range(2, 32), { boot: 'boot-b', retired: 0, sealed: 0, at: T0 + 2 * MIN })
  })
  assert.deepEqual(reasons(db), { [name(1)]: GONE.RETIRED })
  const v = persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 3 * MIN })
  assert.equal(v.verdict, VERDICT.VERIFIED)
  assert.equal(v.restartsWithSegments, 1); assert.equal(v.lostRestart, 0)
})

test('the policy decides what a loss means: EPHEMERAL_LOSS_RECORDED reads the recorded loss as VERIFIED, DURABLE as FAILED, none in force as NOT_VERIFIABLE', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 4), { boot: 'boot-a', sealed: 4 })
    await reconcile(db, [], { boot: 'boot-b', at: T0 + 2 * MIN })        // an ephemeral spool: everything gone
  })
  assert.equal(Object.values(reasons(db)).filter(r => r === GONE.LOST_RESTART).length, 4)
  const eph = persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.EPHEMERAL_LOSS_RECORDED), nowMs: T0 + 3 * MIN })
  assert.equal(eph.verdict, VERDICT.VERIFIED); assert.match(eph.reason, /ephemeral by declaration: 1 gateway restart\(s\) observed, 4 sealed segment\(s\) \(268435488 B\) lost/)
  assert.equal(persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 3 * MIN }).verdict, VERDICT.FAILED)
  const none = persistenceVerdict(db, SIDE.name, { entries: [{ policy: DURABILITY.DURABLE, from: null, fromMs: null, pending: 'volume not attached' }], nowMs: T0 + 3 * MIN })
  assert.equal(none.verdict, VERDICT.NOT_VERIFIABLE); assert.equal(none.policy, null)
  assert.deepEqual(none.declaredNotInForce, [{ policy: DURABILITY.DURABLE, pending: 'volume not attached' }])
  // A loss BEFORE the DURABLE declaration took effect is not judged against it.
  const later = [...declared(DURABILITY.EPHEMERAL_LOSS_RECORDED), ...declared(DURABILITY.DURABLE, new Date(T0 + 10 * MIN).toISOString())]
  const v = persistenceVerdict(db, SIDE.name, { entries: later, nowMs: T0 + 11 * MIN })
  assert.equal(v.policy, DURABILITY.DURABLE); assert.equal(v.verdict, VERDICT.NOT_VERIFIABLE); assert.equal(v.lostRestart, 0)
})

test('a truncated listing keeps its oldest entries: a known name past its last entry is not classed gone', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 6), { sealed: 6 })
    await reconcile(db, range(1, 4), { sealed: 6, truncated: true, at: T0 + 2 * MIN })
  })
  assert.deepEqual(reasons(db), {})
  assert.equal(rows(db).filter(r => r.gone_at_ms == null).length, 6)
})

test('a segment listed again after it was classed gone is restored and recorded, and no longer counts as lost', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 3), { boot: 'boot-a', sealed: 3 })
    await reconcile(db, [], { boot: 'boot-b', at: T0 + 2 * MIN })          // the spool not yet mounted
    const r = await reconcile(db, range(1, 3), { boot: 'boot-b', at: T0 + 4 * MIN })
    assert.deepEqual(r.reappeared, [name(1), name(2), name(3)])
  })
  assert.deepEqual(reasons(db), {})
  const row = db.prepare('SELECT reappeared_at_ms, reappeared_from FROM tick_segment_manifest WHERE name = ?').get(name(1))
  assert.equal(row.reappeared_at_ms, T0 + 4 * MIN); assert.match(row.reappeared_from, /^lost_restart at 2026-09-26T00:02:00/)
  assert.equal(persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 5 * MIN }).verdict, VERDICT.VERIFIED)
})

test('a sealed segment listed again with different bytes is recorded and fails persistence under DURABLE', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 3), { boot: 'boot-a', sealed: 3 })
    await reconcile(db, range(1, 3), { boot: 'boot-b', at: T0 + 2 * MIN, bytes: (i) => (i === 2 ? SEG - 40 : SEG) })
  })
  const r = rows(db).find(x => x.name === name(2))
  assert.deepEqual([r.first_bytes, r.bytes], [SEG, SEG - 40])
  const v = persistenceVerdict(db, SIDE.name, { entries: declared(DURABILITY.DURABLE), nowMs: T0 + 3 * MIN })
  assert.equal(v.verdict, VERDICT.FAILED); assert.match(v.reason, /different bytes/)
})

test('classifyVanished (pure): a name newer than a survivor is never a retire, whatever the cap', () => {
  const b = (i) => ({ name: name(i), bytes: SEG })
  const c = classifyVanished({ before: range(1, 40).map(b), after: [...range(1, 20), ...range(22, 40)].map(b), boot: 'changed', capBytes: { prev: 1, cur: 1 } })
  assert.deepEqual(c.gone.map(g => [g.name, g.reason]), [[name(21), GONE.LOST_RESTART]])
  assert.match(c.gone[0].detail, /not oldest-first/)
})

test('the listing is read on EVERY probe and an unreachable sidecar is recorded, not thrown', async () => {
  const db = initDB(':memory:')
  const fn = lister(range(1, 2))
  await quiet(async () => {
    for (let k = 0; k < 3; k++) await reconcileSegmentManifest(db, SIDE, { status: status(), bootId: 'b', nowMs: T0 + k * 2 * MIN, list: fn })
    const r = await reconcileSegmentManifest(db, SIDE, { status: status(), bootId: 'b', nowMs: T0 + 8 * MIN, list: async () => ({ ok: false, error: 'sidecar 502 on /tick-segments' }) })
    assert.deepEqual(r, { ok: false, error: 'sidecar 502 on /tick-segments' })
  })
  assert.equal(fn.calls, 3)
  assert.equal(rows(db).filter(r => r.gone_at_ms == null).length, 2, 'a failed listing classes nothing')
  assert.equal(JSON.parse(getState(db, MANIFEST_STATE_KEY))[SIDE.name].lastError, 'sidecar 502 on /tick-segments')
})

test('(5) wiring: the heartbeat probe lists the sealed segments and writes the manifest; a restart between probes is recorded', async () => {
  const db = initDB(':memory:')
  const probe = (bootId, ids, at, { tickEnabled = true } = {}) => {
    const list = lister(ids)
    return quiet(async () => {
      await probeOneSidecar(db, {
        pingSidecar: async () => ({ ok: true, mode: 'cpp', connected: true, hasCredentials: true, lastReconcileAt: at - 10_000, accounts: null, bootId, tick: { enabled: true, recording: true, state: 'RECORDING' } }),
        sidecarTickStatus: async () => (tickEnabled ? status({ sealed: ids.length }) : { enabled: false, reason: 'TICK_SPOOL_PATH not set' }),
      }, { name: 'cpp_exec_demo', base: 'http://demo.invalid', isLive: false }, { now: new Date(at), listTickSegments: list })
      return list
    })
  }
  const first = await probe('boot-a', range(1, 3), T0)
  assert.equal(first.calls, 1)
  assert.deepEqual(rows(db, 'cpp_exec_demo').map(r => r.name), [name(1), name(2), name(3)], 'RED if the probe stops calling the manifest reconcile (failure mode #4)')
  await probe('boot-b', range(3, 3), T0 + 2 * MIN)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_segment_boots').get().n, 1)
  assert.deepEqual(reasons(db, 'cpp_exec_demo'), { [name(1)]: GONE.LOST_RESTART, [name(2)]: GONE.LOST_RESTART })
  // A sidecar that says it has no recorder is not listed at all.
  const off = await probe('boot-b', range(1, 3), T0 + 4 * MIN, { tickEnabled: false })
  assert.equal(off.calls, 0)
})

test('the view: every segment by name and bytes, the gone ones with their class, horizon, and both verdicts per side', async () => {
  const db = initDB(':memory:')
  await quiet(async () => {
    await reconcile(db, range(1, 31), { retired: 0, sealed: 31 })
    await reconcile(db, range(2, 32), { retired: 1, sealed: 32, at: T0 + 2 * MIN })
  })
  const policy = { sides: { cpp_exec_demo: declared(DURABILITY.DURABLE) }, errors: [] }
  const v = segmentManifestView(db, { nowMs: T0 + 3 * MIN, policy })
  const d = v.sides.cpp_exec_demo
  assert.equal(d.listed, 31); assert.equal(d.listedBytes, 31 * SEG)
  assert.equal(d.segments[0].name, name(2)); assert.equal(d.segments[0].bytes, SEG); assert.equal(d.segments[0].startMs, segmentStartMs(name(2)))
  assert.deepEqual(d.gone.map(g => [g.name, g.bytes, g.reason]), [[name(1), SEG, GONE.RETIRED]])
  assert.deepEqual([d.retired, d.lostRestart, d.unexplained, d.goneTotal], [1, 0, 0, 1])
  assert.equal(d.oldestStartMs, segmentStartMs(name(2)))
  assert.equal(d.horizonHours, +((T0 + 3 * MIN - segmentStartMs(name(2))) / 3_600_000).toFixed(2))
  assert.equal(d.retention.verdict, VERDICT.VERIFIED)
  assert.equal(d.persistence.verdict, VERDICT.NOT_VERIFIABLE)
  assert.equal(d.lastListing.capBytes, CAP)
  // the live side has no declaration in this policy and nothing recorded
  assert.equal(v.sides.cpp_exec.persistence.verdict, VERDICT.NOT_VERIFIABLE)
  assert.equal(v.sides.cpp_exec.listed, 0)
})

test('the checked-in durability policy loads clean: demo DURABLE in force, live EPHEMERAL in force with its DURABLE entry pending the volume', () => {
  const p = loadDurabilityPolicy()
  assert.deepEqual(p.errors, [])
  const now = Date.parse('2026-09-26T00:00:00Z')
  assert.equal(policyAt(p.sides.cpp_exec_demo, now)?.policy, DURABILITY.DURABLE)
  assert.equal(policyAt(p.sides.cpp_exec, now)?.policy, DURABILITY.EPHEMERAL_LOSS_RECORDED)
  const pending = p.sides.cpp_exec.filter(e => e.fromMs == null)
  assert.deepEqual(pending.map(e => e.policy), [DURABILITY.DURABLE], 'the owner-approved live volume is declared, not yet in force')
})
