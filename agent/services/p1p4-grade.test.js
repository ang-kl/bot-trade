// node --test agent/services/p1p4-grade.test.js
//
// V3 M3 (P1/P4-3): the acceptance grader and the read-only harness. What
// these tests hold the code to (V3-SEQUENCE §1 item 17):
//   · a restart is detected by uptime reset, commit change or boot-record change;
//   · the first 300 s are judged on raw timestamps, never on heartbeat verdicts
//     (heartbeat.js suppresses those during the boot grace);
//   · absent or stale data is Not Verifiable — absence never passes;
//   · values on each side of every boundary;
//   · a Failed observation stays Failed after later passing samples;
//   · a window with no visible tab is Not Verifiable (Failed stays Failed);
//   · platform gateway errors are classified apart from the app's own 5xx;
//   · recovery = the pre-release snapshot plus changes the evidence explains;
//   · the harness only ever sends GET, and never writes or logs the token.

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { tempDir } from '../test-support/temp-dir.js'
import {
  PASSED, FAILED, NOT_VERIFIABLE, P1P4_PROPOSED_LIMITS, p1p4LimitsFromTargets, p1p4TargetDefaults,
  compactHealth, compactHeartbeats, classifyResponse, routeClass, splitBoots, gradeStartup, gradeRecovery, gradeSteady,
  gradeRun, formatGrade, combineVerdicts, toMs, compactEntryEngines, endedBefore, p99Below,
} from './p1p4-grade.js'
import { runHarness, makeReader, collectEvidence, readSamples, scrub, CADENCE, DEFAULT_MAX_JOURNALS } from '../../scripts/v3-p1p4-acceptance.mjs'

const L = { ...P1P4_PROPOSED_LIMITS }
const BOOT = Date.parse('2026-09-28T13:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000

// --- raw bodies, in the shapes production serves (V3 M1 /health, /state/heartbeats) ---

function rawHealth(t, o = {}) {
  const bootAt = o.bootAt ?? BOOT
  return {
    status: 'ok', commit: o.commit ?? 'aaaaaaa', authenticated: true,
    uptime: o.uptime ?? (t - bootAt) / 1000,
    loopCount: o.loopCount ?? 10, lastLoopMs: o.lastLoopMs ?? 40_000, loopPhase: 'idle',
    fastMonitor: o.fm === null ? null : { everyMs: 3000, lastMs: 40, max10mMs: o.tickMax ?? 1_000, skipShare10m: o.skip ?? 0, busyShare10m: 0.1, at: iso(o.fmAt ?? t - 2_000) },
    bootRecord: o.noRecord ? undefined : {
      current: {
        bootId: o.bootId ?? 'boot-1', bootAt: iso(bootAt), commit: o.commit ?? 'aaaaaaa', startupWindowMs: 900_000,
        listening: { at: iso(bootAt + (o.listeningMs ?? 7_500)), sinceBootMs: o.listeningMs ?? 7_500 },
        db: { openedSinceBootMs: 3_000 },
        startupLag: o.startupLag === null ? null : { ms: o.startupLag ?? 800, at: iso(bootAt + 60_000), loopPhase: 'scan' },
        startupHttp: { complete: o.complete ?? (t - bootAt > 900_000), total: {}, first5xx: null, routes: o.routes ?? [] },
        first: o.first ?? {
          loop: { sinceBootMs: 70_000, ms: 62_000, ok: true },
          band: { sinceBootMs: 20_000, ms: 3_000, overran: false, ok: true },
          protectionAudit: { sinceBootMs: 30_000, ok: true, accounts: 7, errors: 0 },
          cleanProtectionAudit: { sinceBootMs: 30_000, accounts: 7, unauditable: 0 },
          slowMonitor: { sinceBootMs: 71_000, positions: 5 },
          equityStop: { sinceBootMs: 72_000, ok: true },
          adaptiveBreaker: { sinceBootMs: 72_000, ok: true },
          performanceBreaker: { sinceBootMs: 72_000, ok: true },
        },
      },
      previous: null,
    },
    latencyWindows: o.noRecord ? undefined : {
      mainLoop: { n: 20, p50: 40_000, p95: 50_000, p99: 55_000, max: 60_000 },
      eventLoopLag: {
        last10m: { n: 6_000, maxMs: o.lagMax ?? 300, p95LeMs: 100, p99LeMs: o.lagP99 ?? 250, coveredFrom: iso(t - 600_000), worst: { ms: o.lagMax ?? 300, at: iso(t - 1_000), loopPhase: 'idle' } },
        sinceStart: { n: 9_000, maxMs: o.lagMax ?? 300, p95LeMs: 100, p99LeMs: o.startP99 ?? 250, coveredFrom: iso(bootAt) },
      },
      budgetOverruns: { total10m: o.overruns ?? 0, byName10m: {} },
    },
    clients: { openTabs: o.visible ?? 1, visibleTabs: o.visible ?? 1, tabs: (o.visible ?? 1) ? [{ id: 'tab-secret-id', sid: 'sess_abcdef0123456789', ip: '203.0.113.9', tz: 'Asia/Singapore', page: '/desk', status: 'active' }] : [] },
  }
}
const health = (t, o) => ({ t, kind: 'health', route: '/health', status: 200, cls: 'ok', ms: 3, data: compactHealth(rawHealth(t, o)) })

function rawHeartbeats(t, o = {}) {
  const accounts = o.accounts ?? [{ id: '46130058' }]
  return {
    // What the boot grace makes these read in the first 300 s: 'ok'. The grader never looks.
    controllers: [{ name: 'protection_audit', verdict: 'ok' }, { name: 'fast_monitor', verdict: 'ok' }],
    runtime: {
      at: iso(t),
      accounts: accounts.map(a => ({
        accountId: a.id, environment: 'demo', enabled: a.enabled ?? true, entryMode: 'TIME_BASED',
        entryCounts: a.counts ?? { unsent: 0, inFlight: 0, resting: 1, unknown: 0 },
        protection: { at: a.auditAt === null ? null : iso(a.auditAt ?? t - 30_000), checked: 3, ok: true, stale: false },
        independentProtection: a.indAt === null ? { ok: false, error: 'No independent broker reading' } : {
          accountId: a.id, checkedAtMs: a.indAt ?? t - 40_000, openCount: (a.pos ?? [['240505699', 476.6, 518]]).length, missingSl: 0, missingTp: 0, ok: true, stale: false,
          positions: (a.pos ?? [['240505699', 476.6, 518]]).map(([positionId, stopLoss, takeProfit]) => ({ positionId, stopLoss, takeProfit, symbolId: '10097' })),
        },
      })),
      watchdog: { status: { incidents: { a: 'x'.repeat(20_000) } } },
      monitor: { band: { everyMs: 60_000, lastMs: 3_000, max10mMs: o.bandMax ?? 3_000, overran: o.overran ?? false, skippedBands: o.skippedBands ?? 0 } },
      managementWork: { at: o.workAt === null ? undefined : iso(o.workAt ?? t), positions: o.work ?? [] },
    },
  }
}
const hb = (t, o) => ({ t, kind: 'heartbeats', route: '/state/heartbeats', status: 200, cls: 'ok', ms: 30, data: compactHeartbeats(rawHeartbeats(t, o)) })
const ee = (t, accounts) => ({ t, kind: 'entryEngines', route: '/state/entry-engines', status: 200, cls: 'ok', ms: 5, data: { at: iso(t), accounts } })
const eeAcct = (o = {}) => ({ id: '46130058', mode: 'TIME_BASED', req: 'TIME_BASED', rev: 2, epoch: o.epoch ?? 0, policy: 'manual', transition: 'STABLE', counts: { unsent: 0, inFlight: 0, unknown: 0 } })

const byId = (criteria) => Object.fromEntries(criteria.map(c => [c.id, c]))
const bootOf = (samples) => splitBoots(samples)[splitBoots(samples).length - 1]

// ---------------------------------------------------------------------------

test('restart detection: uptime reset, commit change and boot-record change each start a new boot; a steady run is one boot', () => {
  const steady = [health(BOOT + 20 * MIN), health(BOOT + 21 * MIN), health(BOOT + 22 * MIN)]
  assert.equal(splitBoots(steady).length, 1)
  assert.equal(splitBoots(steady)[0].restartObserved, false, 'the harness started mid-boot: no restart observed')

  const B2 = BOOT + 60 * MIN
  const uptimeReset = [...steady, health(B2 + 40_000, { bootAt: B2, noRecord: true })]
  const u = splitBoots(uptimeReset)
  assert.equal(u.length, 2)
  assert.deepEqual(u[1].reasons, ['uptime reset'])
  assert.equal(u[1].restartObserved, true)

  const commit = [...steady, health(BOOT + 23 * MIN, { commit: 'bbbbbbb' })]
  assert.deepEqual(splitBoots(commit)[1].reasons, ['commit changed'])

  const record = [...steady, health(BOOT + 23 * MIN, { bootId: 'boot-2' })]
  assert.deepEqual(splitBoots(record)[1].reasons, ['boot record changed'])
})

// A startup window is graded from the boot record read after it closed, and is
// representative only with a sample inside it that saw a visible tab.
const startupOf = (o) => [health(BOOT + 10 * MIN, o), health(BOOT + 16 * MIN, o)]

test('startup: graded from the boot record; boundaries on both sides of every limit', () => {
  const at = (o) => byId(gradeStartup(bootOf(startupOf(o)), L).criteria)
  assert.equal(at({ listeningMs: 15_000 })['startup.listening'].verdict, PASSED)
  assert.equal(at({ listeningMs: 15_001 })['startup.listening'].verdict, FAILED)
  assert.equal(at({ startupLag: 4_999 })['startup.lag_max'].verdict, PASSED)
  assert.equal(at({ startupLag: 5_000 })['startup.lag_max'].verdict, FAILED, 'max must be UNDER 5,000 ms')
  assert.equal(at({ routes: [] })['startup.critical_5xx'].verdict, PASSED)
  assert.equal(at({ routes: [{ route: '/state/heartbeats', '4xx': 0, '5xx': 1, aborted: 0 }] })['startup.critical_5xx'].verdict, FAILED)
  const rep = at({ routes: [{ route: '/state/decisions-daily', '4xx': 0, '5xx': 2, aborted: 0 }] })
  assert.equal(rep['startup.critical_5xx'].verdict, PASSED, 'a report route is not a critical one')
  assert.equal(rep['startup.report_5xx'].verdict, NOT_VERIFIABLE, 'report 5xx tolerance is the owner\'s decision')
  assert.equal(rep['startup.report_5xx'].value, 2, 'counted and listed')
  assert.equal(at({ first: { band: { sinceBootMs: 20_000, ms: 61_000, overran: true, ok: false } } })['startup.first_band'].verdict, FAILED)
  const c = at({})
  assert.equal(c['startup.first_band'].verdict, PASSED)
  assert.equal(c['startup.first_clean_audit'].verdict, PASSED)
  assert.equal(at({ first: { cleanProtectionAudit: { sinceBootMs: 300_001 } } })['startup.first_clean_audit'].verdict, FAILED)
  assert.equal(c['startup.first_loop'].verdict, NOT_VERIFIABLE, 'no first-loop bar until the owner sets one')
  assert.equal(c['startup.first_loop'].value, 62_000)
  assert.equal(at({ first: { equityStop: { sinceBootMs: 80_000, ok: false } } })['startup.first_protection'].verdict, FAILED, 'a failed first evaluation fails whatever X is')
  // p99 from the since-start histogram of the last in-window sample covering the window.
  const p99 = (v) => byId(gradeStartup(bootOf([health(BOOT + 14 * MIN + 30_000, { startP99: v }), health(BOOT + 16 * MIN)]), L).criteria)['startup.lag_p99']
  // The proposal is p99 < 1,000 ms (H-P1-1); the value is a histogram bound.
  assert.equal(p99(500).verdict, PASSED)
  assert.equal(p99(999).verdict, PASSED, 'a bound capped at the max under the limit shows p99 < limit')
  const edge = p99(1_000)
  assert.equal(edge.verdict, NOT_VERIFIABLE, 'the 500–1,000 bucket cannot show p99 < 1,000 (RED under <=)')
  assert.match(edge.reason, /cannot show p99 < 1000 ms/)
  assert.equal(p99(2_000).verdict, FAILED, 'the 1,000–2,000 bucket shows p99 > 1,000')
  // The first band's cause is on the printed line, not only in detail (169d337: "pnl_watch exceeded its 5s budget").
  const band = at({ first: { band: { sinceBootMs: 20_000, ms: 14_790, overran: false, ok: false, error: 'pnl_watch exceeded its 5s budget' } } })['startup.first_band']
  assert.equal(band.verdict, FAILED)
  assert.equal(band.reason, 'pnl_watch exceeded its 5s budget')
  assert.equal(at({ first: { band: { sinceBootMs: 20_000, ms: 61_000, overran: true, ok: false } } })['startup.first_band'].reason, 'the first band overran')
  assert.equal(c['startup.first_band'].reason, null, 'a passing band carries no reason')
})

test('p99Below: a histogram upper bound against the strict limit — pass, fail, or cannot say', () => {
  assert.equal(p99Below(250, 1_000), 'pass')
  assert.equal(p99Below(700, 1_000), 'pass', 'a bound capped at the observed max, inside the 500–1,000 bucket')
  assert.equal(p99Below(1_000, 1_000), 'unknown', 'p99 lies in (500, 1,000]: it may or may not be under 1,000')
  assert.equal(p99Below(1_500, 1_000), 'fail', 'capped at 1,500 in (1,000, 2,000]: p99 > 1,000')
  assert.equal(p99Below(2_000, 1_000), 'fail')
  assert.equal(p99Below(40_000, 1_000), 'fail', 'above the last edge')
  assert.equal(p99Below(1_000, 800), 'unknown', 'a limit inside the bucket cannot be decided by it')
  assert.equal(p99Below(2_000, 800), 'fail', 'the bucket above 1,000 is wholly over 800')
  assert.equal(p99Below(null, 1_000), null)
  assert.equal(p99Below(500, null), null)
})

test('startup: absent data is Not Verifiable, never Passed; a failure already seen does not wait for the window to close', () => {
  const none = gradeStartup(bootOf([health(BOOT + 16 * MIN, { noRecord: true })]), L)
  assert.ok(none.criteria.every(c => c.verdict === NOT_VERIFIABLE), 'no boot record: nothing passes')
  // Window still open (5 min in): a clean partial reading is not a pass...
  const open = byId(gradeStartup(bootOf([health(BOOT + 5 * MIN)]), L).criteria)
  assert.equal(open['startup.lag_max'].verdict, NOT_VERIFIABLE)
  assert.equal(open['startup.critical_5xx'].verdict, NOT_VERIFIABLE)
  // ...but a stall already over the limit is Failed at once.
  const bad = byId(gradeStartup(bootOf([health(BOOT + 5 * MIN, { startupLag: 9_000 })]), L).criteria)
  assert.equal(bad['startup.lag_max'].verdict, FAILED)
  // After the recovery deadline, no band and no clean audit are failures, not unknowns.
  const late = byId(gradeStartup(bootOf([health(BOOT + 6 * MIN, { first: {} })]), L).criteria)
  assert.equal(late['startup.first_band'].verdict, FAILED)
  assert.equal(late['startup.first_clean_audit'].verdict, FAILED)
})

// 25-09 22:08–22:10Z: three Node boots in 14 minutes (ec4bc3c, 74bb211,
// 169d337) — the first cut at +757 s, the second at +86 s. A boot the next
// merge replaced never finishes its window; "still open" would be false.
test('a boot the next restart replaced is a partial reading for good: named as ended, never "still open", never a pass', () => {
  const B2 = BOOT + 757_000
  const cut = [health(BOOT + 5 * MIN), health(BOOT + 12 * MIN), health(B2 + 20_000, { bootAt: B2, bootId: 'boot-2', commit: 'bbbbbbb' })]
  const boots = splitBoots(cut)
  assert.equal(boots.length, 2)
  assert.equal(boots[0].toMs, B2, 'the first boot ends where the next begins')
  const c = byId(gradeStartup(boots[0], L).criteria)
  for (const id of ['startup.lag_max', 'startup.critical_5xx']) {
    assert.equal(c[id].verdict, NOT_VERIFIABLE, `${id}: a partial window never passes`)
    assert.match(c[id].reason, /^the boot ended at \+757 s \(the next restart\), before BOOT \+ 900 s/, id)
    assert.doesNotMatch(c[id].reason, /still open/, id)
  }
  // Control: the same partial reading on a boot that is still running says so.
  const live = byId(gradeStartup(bootOf([health(BOOT + 5 * MIN)]), L).criteria)
  assert.match(live['startup.lag_max'].reason, /still open/)
  assert.match(live['startup.critical_5xx'].reason, /still open/)

  // Replaced before the 300 s recovery deadline: no band yet is neither
  // Failed nor "not yet", and recovery names the restart that ended it.
  const B3 = BOOT + 86_000
  const short = [health(BOOT - 60_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }), hb(BOOT - 50_000), health(BOOT + 30_000, { first: {} }), health(B3 + 20_000, { bootAt: B3, bootId: 'boot-3' })]
  const s = splitBoots(short)
  const first = s.find(b => b.bootAtMs === BOOT)
  assert.equal(first.toMs, B3)
  const st = byId(gradeStartup(first, L).criteria)
  assert.equal(st['startup.first_band'].verdict, NOT_VERIFIABLE)
  assert.match(st['startup.first_band'].reason, /^the boot ended at \+86 s \(the next restart\), before BOOT \+ 300 s/)
  const rc = byId(gradeRecovery(first, L, { samples: short }).criteria)
  assert.equal(rc['recovery.independent_retained'].verdict, NOT_VERIFIABLE)
  assert.match(rc['recovery.independent_retained'].reason, /^the boot ended at \+86 s/)

  // The boundary: a boot that lasted exactly the window is not "ended before" it.
  assert.equal(endedBefore({ bootAtMs: BOOT, toMs: BOOT + 900_000 }, 900_000), null)
  assert.match(endedBefore({ bootAtMs: BOOT, toMs: BOOT + 899_999 }, 900_000), /ended at \+900 s/)
  assert.equal(endedBefore({ bootAtMs: BOOT, toMs: Infinity }, 900_000), null, 'a live boot has not ended')
})

test('a window with no visible tab cannot pass; its failures still stand', () => {
  const g = gradeStartup(bootOf(startupOf({ visible: 0, listeningMs: 20_000 })), L)
  const c = byId(g.criteria)
  assert.equal(g.representative.representative, false)
  assert.equal(c['startup.listening'].verdict, FAILED, 'a failure under light load is still a failure')
  assert.equal(c['startup.lag_max'].verdict, NOT_VERIFIABLE, 'a pass under no browser load is not representative')
  assert.equal(c['startup.first_band'].verdict, NOT_VERIFIABLE)
  // The same readings with a visible tab in the window pass: the tab is what changed.
  assert.equal(byId(gradeStartup(bootOf(startupOf({ visible: 1 })), L).criteria)['startup.lag_max'].verdict, PASSED)
})

test('platform gateway errors are classified apart from the application\'s own 5xx', () => {
  assert.equal(classifyResponse({ status: 502, bodyText: '{"status":"error","code":502,"message":"Application failed to respond"}' }), 'platform')
  assert.equal(classifyResponse({ status: 503, bodyText: '<html>upstream</html>' }), 'platform')
  assert.equal(classifyResponse({ error: 'ECONNRESET' }), 'platform')
  assert.equal(classifyResponse({ status: 503, bodyText: '{"error":"performance_report_worker_capacity"}' }), 'app_5xx')
  assert.equal(classifyResponse({ status: 200, bodyText: '{}' }), 'ok')
  assert.equal(routeClass('/health'), 'critical')
  assert.equal(routeClass('/state/position/:id/cockpit'), 'critical')
  assert.equal(routeClass('/state/decisions-daily'), 'report')
  // In a run: a platform 502 on /health during the swap is listed, and is not an app 5xx.
  const samples = [
    health(BOOT - 5 * MIN, { bootAt: BOOT - 120 * MIN, bootId: 'boot-0' }),
    { t: BOOT + 3_000, kind: 'health', route: '/health', status: 502, cls: 'platform', ms: 15_000, data: null, bodyText: 'Application failed to respond' },
    health(BOOT + 10 * MIN, { bootId: 'boot-1' }),
    health(BOOT + 16 * MIN, { bootId: 'boot-1' }),
  ]
  const g = gradeRun(samples)
  assert.equal(g.platform.count, 1)
  assert.equal(byId(g.boots[1].startup.criteria)['startup.critical_5xx'].verdict, PASSED)
  // An app 5xx seen by the harness itself on a critical route inside the window is counted.
  samples.push({ t: BOOT + 4 * MIN, kind: 'heartbeats', route: '/state/heartbeats', status: 500, cls: 'app_5xx', ms: 9, data: null })
  assert.equal(byId(gradeRun(samples).boots[1].startup.criteria)['startup.critical_5xx'].verdict, FAILED)
})

test('steady state: boundaries, and a Failed observation stays Failed after later passing samples', () => {
  const run = (o, { hours = 2.5, first = {} } = {}) => {
    const s = []
    const end = BOOT + 15 * MIN + hours * 3_600_000
    let n = 10
    for (let t = BOOT + 15 * MIN; t <= end; t += 30_000) {
      s.push(health(t, { ...o(t), loopCount: n, lastLoopMs: 40_000 }))
      n += 1
      if ((t - BOOT) % MIN === 0) s.push(hb(t, first))
    }
    return byId(gradeSteady(splitBoots(s)[0], L, { samples: s }).criteria)
  }
  assert.equal(run(() => ({ skip: 0.10 }))['steady.fast_monitor_skip'].verdict, PASSED)
  assert.equal(run(() => ({ skip: 0.101 }))['steady.fast_monitor_skip'].verdict, FAILED)
  assert.equal(run(() => ({ tickMax: 6_000 }))['steady.tick_max'].verdict, PASSED)
  assert.equal(run(() => ({ tickMax: 6_001 }))['steady.tick_max'].verdict, FAILED)
  // One bad sample at the start, then two hours of good ones: still Failed.
  const once = run(t => ({ skip: t === BOOT + 15 * MIN ? 0.45 : 0 }))['steady.fast_monitor_skip']
  assert.equal(once.verdict, FAILED)
  assert.match(once.reason, /^1 of \d+ sample/)
  assert.equal(run(() => ({ lagMax: 4_999, lagP99: 500 }))['steady.lag'].verdict, PASSED)
  const edgeLag = run(() => ({ lagMax: 4_999, lagP99: 1_000 }))['steady.lag']
  assert.equal(edgeLag.verdict, NOT_VERIFIABLE, 'a p99 bound of 1,000 cannot show p99 < 1,000 (RED under <=)')
  assert.match(edgeLag.reason, /p99 bound reaches 1000 ms/)
  assert.equal(run(t => ({ lagMax: 4_999, lagP99: t === BOOT + 15 * MIN ? 2_000 : 1_000 }))['steady.lag'].verdict, FAILED, 'one sample over the limit still fails the window')
  assert.equal(run(() => ({ lagMax: 5_000 }))['steady.lag'].verdict, FAILED)
  assert.equal(run(() => ({ lagP99: 2_000 }))['steady.lag'].verdict, FAILED)
  assert.equal(run(() => ({ overruns: 1 }))['steady.budget_overruns'].verdict, FAILED)
  assert.equal(run(() => ({}), { first: { bandMax: 60_001 } })['steady.band'].verdict, FAILED)
  const ok = run(() => ({}))
  assert.equal(ok['steady.main_loop_p95'].verdict, PASSED)
  assert.equal(run(() => ({}), { first: { accounts: [{ id: '1', auditAt: undefined }] } })['steady.audit_age'].verdict, PASSED)
  // A stale fast-monitor record (older than 5 min at the sample) is not data.
  assert.equal(run(t => ({ fmAt: t - 6 * MIN, skip: 0 }))['steady.fast_monitor_skip'].verdict, NOT_VERIFIABLE)
  // A short window cannot pass...
  const short = run(() => ({}), { hours: 1 })
  assert.equal(short['steady.fast_monitor_skip'].verdict, NOT_VERIFIABLE)
  // ...but its failures stand.
  assert.equal(run(() => ({ skip: 0.5 }), { hours: 1 })['steady.fast_monitor_skip'].verdict, FAILED)
})

test('steady state: protection ages are computed from raw timestamps at the sample, with the limit on both sides', () => {
  const t = BOOT + 20 * MIN
  const s = (o) => [health(t), hb(t, { accounts: [{ id: '1', ...o }] })]
  const grade = (o) => byId(gradeSteady(splitBoots(s(o))[0], L, { samples: s(o) }).criteria)
  // Run at 2.5 h is not needed to see the per-sample verdict; the short window
  // turns Passed into Not Verifiable, so read the underlying failure only.
  assert.equal(grade({ indAt: t - 121_000 })['steady.independent_age'].verdict, FAILED)
  assert.notEqual(grade({ indAt: t - 120_000 })['steady.independent_age'].verdict, FAILED)
  assert.equal(grade({ auditAt: t - 121_000 })['steady.audit_age'].verdict, FAILED)
  assert.notEqual(grade({ auditAt: t - 120_000 })['steady.audit_age'].verdict, FAILED)
  const absent = grade({ indAt: null })['steady.independent_age']
  assert.equal(absent.verdict, FAILED, 'an account with no reading is not fresh')
  assert.equal(absent.value, 'absent')
})

test('recovery: raw timestamps decide, not the heartbeat verdicts the boot grace suppresses', () => {
  const pre = BOOT - 60_000
  const post = BOOT + 5 * MIN + 10_000
  const base = [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 20_000 }] }),
    ee(pre, [eeAcct()]),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
  ]
  // The verifier's reading is cleared after boot (controllers still read 'ok').
  const cleared = [...base, hb(BOOT + 60_000, { accounts: [{ id: '1', indAt: null }] }), hb(post, { accounts: [{ id: '1', indAt: post - 10_000 }] }), ee(post, [eeAcct()])]
  const c1 = byId(gradeRecovery(bootOf(cleared), L, { samples: cleared }).criteria)
  assert.equal(c1['recovery.independent_retained'].verdict, FAILED)
  assert.match(c1['recovery.independent_retained'].reason, /cleared/)
  // A Node audit that predates this boot is not a recovered audit, however fresh.
  const oldAudit = [...base, hb(post, { accounts: [{ id: '1', indAt: post - 10_000, auditAt: BOOT - 5_000 }] }), ee(post, [eeAcct()])]
  assert.equal(byId(gradeRecovery(bootOf(oldAudit), L, { samples: oldAudit }).criteria)['recovery.node_audit_fresh'].verdict, FAILED)
  // Everything retained, advanced and fresh: Passed.
  const good = [...base, hb(post, { accounts: [{ id: '1', indAt: post - 10_000 }] }), ee(post, [eeAcct()])]
  const c3 = byId(gradeRecovery(bootOf(good), L, { samples: good, evidence: { actionLog: { ok: true, rows: [] }, journals: {} } }).criteria)
  assert.equal(c3['recovery.independent_retained'].verdict, PASSED)
  assert.equal(c3['recovery.node_audit_fresh'].verdict, PASSED)
  assert.equal(c3['recovery.config_and_protection_unchanged'].verdict, PASSED)
  assert.equal(c3['recovery.intents_settled'].verdict, PASSED)
  assert.equal(c3['recovery.native_deployments'].verdict, NOT_VERIFIABLE, 'three of five native deployments need a Railway read')
  // Unsettled intents fail.
  const open = [...base, hb(post, { accounts: [{ id: '1', indAt: post - 10_000, counts: { unsent: 0, inFlight: 1, unknown: 0 } }] })]
  assert.equal(byId(gradeRecovery(bootOf(open), L, { samples: open }).criteria)['recovery.intents_settled'].verdict, FAILED)
})

test('recovery: absent pre-release or post-deadline samples are Not Verifiable', () => {
  // The harness started after BOOT: there is no pre-release snapshot.
  const late = [health(BOOT + 20_000), hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', indAt: BOOT + 5 * MIN }] })]
  const c = byId(gradeRecovery(bootOf(late), L, { samples: late }).criteria)
  assert.equal(c['recovery.config_and_protection_unchanged'].verdict, NOT_VERIFIABLE)
  assert.match(c['recovery.config_and_protection_unchanged'].reason, /did not observe this restart/)
  assert.equal(c['recovery.independent_retained'].verdict, NOT_VERIFIABLE)
  // No heartbeats sample within 3 min after the deadline: nothing is graded as passing.
  const none = [health(BOOT - 60_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }), health(BOOT + 20_000, { bootId: 'b1' }), hb(BOOT + 9 * MIN)]
  const n = gradeRecovery(bootOf(none), L, { samples: none })
  assert.ok(n.criteria.filter(x => x.id !== 'recovery.native_deployments').every(x => x.verdict === NOT_VERIFIABLE))
})

test('recovery: an SL/TP or entry-config change is allowed only when the evidence explains it', () => {
  const pre = BOOT - 60_000
  const post = BOOT + 5 * MIN + 10_000
  const samples = (postPos, postEpoch = 0, postRev = 2) => [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 20_000, pos: [['111', 1.10, 1.20]] }] }),
    ee(pre, [{ ...eeAcct(), id: '1' }]),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
    hb(post, { accounts: [{ id: '1', indAt: post - 10_000, pos: postPos }] }),
    ee(post, [{ ...eeAcct({ epoch: postEpoch }), id: '1', rev: postRev }]),
  ]
  const grade = (s, evidence) => byId(gradeRecovery(bootOf(s), L, { samples: s, evidence }).criteria)['recovery.config_and_protection_unchanged']
  const moved = samples([['111', 1.15, 1.20]])
  const journalAt = new Date(BOOT + 60_000).toISOString().replace('T', ' ').slice(0, 19) // SQLite datetime('now') form
  assert.equal(grade(moved, { actionLog: { ok: true, rows: [] }, journals: { '1:111': [{ at: journalAt, kind: 'sl_moved', source: 'cpp_trail_engine' }] } }).verdict, PASSED, 'the trail engine\'s journalled amend explains it')
  const unexplained = grade(moved, { actionLog: { ok: true, rows: [] }, journals: { '1:111': [] } })
  assert.equal(unexplained.verdict, FAILED, 'journal read, no event: unexplained')
  assert.match(unexplained.reason, /unexplained: 1:111 SL 1.1→1.15/)
  assert.equal(grade(moved, { actionLog: { ok: true, rows: [] }, journals: {} }).verdict, NOT_VERIFIABLE, 'journal not read: cannot say')
  assert.equal(grade(samples([]), { actionLog: { ok: true, rows: [] }, journals: {} }).verdict, NOT_VERIFIABLE, 'a closure with no evidence read is not a failure')
  // Entry epoch bumped: explained by an entry-mode action_log row, unexplained without one.
  const bumped = samples([['111', 1.10, 1.20]], 1)
  assert.equal(grade(bumped, { actionLog: { ok: true, rows: [{ at: journalAt, method: 'POST', path: '/actions/entry-mode', account_id: '1', body: '{}' }] }, journals: {} }).verdict, PASSED)
  assert.equal(grade(bumped, { actionLog: { ok: true, rows: [] }, journals: {} }).verdict, FAILED)
  assert.equal(grade(bumped, null).verdict, NOT_VERIFIABLE, 'no action_log read: cannot say')
  // Checker 25-09: a revision bump with no entry-mode path. The boot seed
  // seedTickObservationFromConfig raises configRevision (requestTickObservation,
  // /actions/tick-observation) whenever config/tick-observation.json changes —
  // at the very restart being graded — and importTickValidation raises it too
  // (/actions/tick-validation). The explaining row was read, so it is explained.
  const revved = samples([['111', 1.10, 1.20]], 0, 3)
  const row = (path, account = '1') => ({ actionLog: { ok: true, rows: [{ at: journalAt, method: 'POST', path, account_id: account, body: '{}' }] }, journals: {} })
  const obs = grade(revved, row('/actions/tick-observation'))
  assert.equal(obs.verdict, PASSED, `a tick-observation row explains rev 2→3 (RED when only /entry-mode/ paths explain): ${obs.reason}`)
  assert.equal(obs.value.attributed, 1)
  assert.equal(grade(revved, row('/actions/tick-validation')).verdict, PASSED, 'a tick-validation stage row explains rev 2→3')
  assert.equal(grade(revved, row('/actions/entry-mode-policy')).verdict, PASSED, 'a policy row (the policy seed) explains it')
  const other = grade(revved, row('/actions/tick-observation', '2'))
  assert.equal(other.verdict, FAILED, 'another account\'s tick-observation row explains nothing here')
  assert.match(other.reason, /unexplained: 1 rev 2→3/)
  assert.equal(grade(revved, row('/actions/profit-keeper')).verdict, FAILED, 'a row that does not write the entry configuration explains nothing')
  assert.equal(grade(revved, { actionLog: { ok: true, rows: [] }, journals: {} }).verdict, FAILED, 'no row at all: unexplained')
  assert.equal(toMs('2026-09-28 13:01:00'), Date.parse('2026-09-28T13:01:00Z'), 'SQLite timestamps are UTC')
})

test('recovery: the tick-observation boot seed\'s revision bump is explained by the row it writes (real writer → /state/entry-engines view → grader)', async () => {
  // End to end on the production code path, not a hand-written row: the
  // seed a merge of config/tick-observation.json triggers at boot, the
  // compacted /state/entry-engines view before and after it, and the
  // action_log row it wrote. Goes RED if the grader stops accepting the
  // path the writer actually logs, or if the writer's path or account id
  // changes under the grader.
  const { initDB } = await import('../db.js')
  const { upsertAccount } = await import('./account-registry.js')
  const { seedTickObservationFromConfig, entryEnginesView } = await import('./entry-mode.js')
  const ID = '46130058'
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: ID, isLive: false })
  const dir = tempDir('p1p4-seed-')
  const file = join(dir, 'tick-observation.json')
  writeFileSync(file, JSON.stringify({ accounts: { [ID]: 'SHADOW' } }))
  const view = () => compactEntryEngines(entryEnginesView(db, { includeRoutingIdentity: true }))
  const before = view()
  const logged = db.prepare('SELECT COUNT(*) AS n FROM action_log').get().n
  const seeded = seedTickObservationFromConfig(db, { file })
  assert.deepEqual(seeded.applied, [`…${ID.slice(-4)}:SHADOW`], `the seed applied: ${JSON.stringify(seeded)}`)
  const after = view()
  const b = before.accounts.find(a => a.id === ID)
  const a = after.accounts.find(x => x.id === ID)
  assert.ok(b && a, 'the view names the account by its routing id')
  assert.equal(a.rev, b.rev + 1, 'premise: the seed raises configRevision')
  const written = db.prepare('SELECT method, path, body, account_id FROM action_log ORDER BY id').all().slice(logged)
  assert.ok(written.length >= 1, 'premise: the seed wrote an action_log row')
  const pre = BOOT - 60_000
  const post = BOOT + 5 * MIN + 10_000
  const at = new Date(BOOT + 30_000).toISOString().replace('T', ' ').slice(0, 19)
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: ID, indAt: pre - 20_000, pos: [['111', 1.10, 1.20]] }] }),
    ee(pre, before.accounts),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
    hb(post, { accounts: [{ id: ID, indAt: post - 10_000, pos: [['111', 1.10, 1.20]] }] }),
    ee(post, after.accounts),
  ]
  // The harness maps each /state/action-log row to exactly these fields (collectEvidence).
  const rows = written.map(r => ({ at, method: r.method, path: r.path, account_id: r.account_id == null ? null : String(r.account_id), body: String(r.body ?? '').slice(0, 300) }))
  const grade = (actionRows) => byId(gradeRecovery(bootOf(s), L, { samples: s, evidence: { actionLog: { ok: true, rows: actionRows }, journals: {} } }).criteria)['recovery.config_and_protection_unchanged']
  const explained = grade(rows)
  assert.equal(explained.verdict, PASSED, `the seed's own row explains the bump: ${explained.reason}`)
  assert.equal(explained.value.attributed, 1)
  const bare = grade([])
  assert.equal(bare.verdict, FAILED, 'the bump is visible to the grader: with the action_log read and empty it is unexplained')
  assert.match(bare.reason, new RegExp(`unexplained: ${ID} rev ${b.rev}→${a.rev}`))
})

test('recovery: a fast-monitor position first evaluated too late is Failed from the sample bounds', () => {
  const pre = BOOT - 60_000
  const w = (done) => [{ accountId: '1', positionId: 7, owner: 'node_fast_monitor', lastCompletedAt: iso(done), nextDueAt: iso(done + 60_000), state: 'not_due', cadenceMs: 60_000 }]
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 1_000 }], work: w(pre - 5_000) }),
    health(BOOT + 20_000, { bootId: 'b1' }),
    // At +200 s the receipt still predates BOOT: no evaluation had happened, and 200 s > 60 + 60.
    hb(BOOT + 200_000, { accounts: [{ id: '1', indAt: BOOT + 190_000 }], work: w(pre - 5_000) }),
    hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', indAt: BOOT + 300_000 }], work: w(BOOT + 290_000) }),
  ]
  const c = byId(gradeRecovery(bootOf(s), L, { samples: s }).criteria)['recovery.fast_monitor_resumed']
  assert.equal(c.verdict, FAILED)
  assert.match(c.reason, /first evaluated after 200 s/)
  // Evaluated 90 s after boot (within 60 + 60): Passed.
  const s2 = [...s.slice(0, 3), hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', indAt: BOOT + 300_000 }], work: w(BOOT + 90_000) })]
  assert.equal(byId(gradeRecovery(bootOf(s2), L, { samples: s2 }).criteria)['recovery.fast_monitor_resumed'].verdict, PASSED)
})

// Checker 25-09, blocker 1: receipts written at BOOT − 30 min, both positions
// exempt, the same file in the BOOT + 310 s sample → Passed "2/2". The
// exemption must come from a pass this boot wrote.
test('recovery: a receipt file written before BOOT exempts nothing — no fast-monitor pass since the restart is Failed', () => {
  const pre = BOOT - 60_000
  const staleAt = BOOT - 30 * MIN
  const w = (done, state) => ({ accountId: '1', positionId: state === 'observe_only' ? 8 : 7, owner: 'node_fast_monitor', lastCompletedAt: iso(done), nextDueAt: iso(done + 60_000), state, cadenceMs: 60_000 })
  const exempt = [w(staleAt - 5_000, 'quote_unavailable'), w(staleAt - 5_000, 'observe_only')]
  const s = (postWorkAt) => [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 1_000 }], work: exempt, workAt: staleAt }),
    health(BOOT + 20_000, { bootId: 'b1' }),
    hb(BOOT + 310_000, { accounts: [{ id: '1', indAt: BOOT + 300_000 }], work: exempt, workAt: postWorkAt }),
  ]
  const grade = (x) => byId(gradeRecovery(bootOf(x), L, { samples: x }).criteria)['recovery.fast_monitor_resumed']
  const stale = grade(s(staleAt))
  assert.equal(stale.verdict, FAILED, `the file predates BOOT: the fast monitor never resumed (RED when the states exempt it): ${stale.reason}`)
  assert.match(stale.reason, /^no fast-monitor pass written since BOOT — receipts at 2026-09-28T12:30:00\.000Z, 1800 s before BOOT, read at \+310 s$/)
  assert.equal(stale.value, '0/2')
  // The same states in a file this boot wrote are exempt: explicit states, not missing work.
  assert.equal(grade(s(BOOT + 305_000)).verdict, PASSED)
  // An empty receipt file still proves a pass; one dated before BOOT does not.
  const empty = (at) => [...s(at).slice(0, 3), hb(BOOT + 310_000, { accounts: [{ id: '1', indAt: BOOT + 300_000 }], work: [], workAt: at })]
  assert.equal(grade(empty(BOOT - 60_000)).verdict, FAILED, 'no position, and still no pass since BOOT')
  assert.equal(grade(empty(BOOT + 305_000)).verdict, NOT_VERIFIABLE, 'a post-boot pass with nothing to evaluate')
  // An undated file cannot show its states are this boot's: Not Verifiable, not exempt.
  const undated = grade(s(null))
  assert.equal(undated.verdict, NOT_VERIFIABLE)
  assert.match(undated.reason, /quote_unavailable in an undated receipt file/)
})

// Checker 25-09, blocker 2: one independent reading at BOOT − 20 s carried into
// the BOOT + 310 s sample → Passed {1, 1, unexplained 0} while R1 said Failed.
test('recovery: SL/TP tuples are compared only on an independent reading taken after BOOT', () => {
  const pre = BOOT - 10_000
  const post = BOOT + 310_000
  const s = (postInd, postPos = [['111', 1.10, 1.20]], extra = []) => [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: '1', indAt: BOOT - 20_000, pos: [['111', 1.10, 1.20]] }, ...extra.map(e => e.pre)] }),
    ee(pre, [{ ...eeAcct(), id: '1' }]),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
    hb(post, { accounts: [{ id: '1', indAt: postInd, pos: postPos }, ...extra.map(e => e.post)] }),
    ee(post, [{ ...eeAcct(), id: '1' }]),
  ]
  // Journals read and empty for both positions: a compared change is unexplained, not unverifiable.
  const ev = { actionLog: { ok: true, rows: [] }, journals: { '1:111': [], '2:222': [] } }
  const grade = (x) => byId(gradeRecovery(bootOf(x), L, { samples: x, evidence: ev }).criteria)
  // A reading that advanced past the pre-release one but still predates BOOT is not this boot's either.
  const advanced = s(BOOT - 20_000).map(x => (x.kind === 'heartbeats' && x.t === pre ? hb(pre, { accounts: [{ id: '1', indAt: BOOT - 80_000, pos: [['111', 1.10, 1.20]] }] }) : x))
  const adv = grade(advanced)['recovery.config_and_protection_unchanged']
  assert.equal(adv.verdict, NOT_VERIFIABLE, `advanced but pre-boot (RED without the BOOT bound): ${adv.reason}`)
  assert.match(adv.reason, /no post-boot independent reading/)
  const carried = grade(s(BOOT - 20_000))
  const c = carried['recovery.config_and_protection_unchanged']
  assert.equal(c.verdict, NOT_VERIFIABLE, `a pre-boot reading cannot show the tuples unchanged (RED when it is compared): ${JSON.stringify(c.value)}`)
  assert.match(c.reason, /^1: 1 position\(s\) not compared — no post-boot independent reading \(reading at 2026-09-28T12:59:40\.000Z, BOOT 2026-09-28T13:00:00\.000Z\)$/)
  assert.equal(c.value.accountsNotCompared, 1)
  assert.equal(carried['recovery.independent_retained'].verdict, FAILED, 'premise: R1 beside it fails the same reading')
  // A post-boot reading is compared as before: unchanged passes...
  assert.equal(grade(s(BOOT + 300_000))['recovery.config_and_protection_unchanged'].verdict, PASSED)
  // ...and a pre-boot one hides no failure elsewhere: a fresh account's unexplained move still fails.
  const two = s(BOOT - 20_000, [['111', 1.10, 1.20]], [{
    pre: { id: '2', indAt: BOOT - 30_000, pos: [['222', 2.0, 2.4]] },
    post: { id: '2', indAt: BOOT + 290_000, pos: [['222', 2.1, 2.4]] },
  }])
  const both = grade(two)['recovery.config_and_protection_unchanged']
  assert.equal(both.verdict, FAILED)
  assert.match(both.reason, /unexplained: 2:222 SL 2→2\.1/)
  assert.match(both.reason, /1: 1 position\(s\) not compared/)
  // No reading at all in the post sample: not compared either.
  assert.match(grade(s(null, []))['recovery.config_and_protection_unchanged'].reason, /1: 1 position\(s\) not compared — no independent reading in the post sample/)
})

test('steady: a window with no /health sample says so, not "V3 M1 not deployed" or "0 loops ran"', () => {
  // Health only inside the startup window; heartbeats past it.
  const s = [health(BOOT + 10 * MIN), health(BOOT + 14 * MIN), hb(BOOT + 20 * MIN), hb(BOOT + 25 * MIN)]
  const c = byId(gradeSteady(splitBoots(s)[0], L, { samples: s }).criteria)
  for (const id of ['steady.main_loop_p95', 'steady.budget_overruns', 'steady.lag', 'steady.fast_monitor_skip', 'steady.tick_max']) {
    assert.equal(c[id].verdict, NOT_VERIFIABLE, id)
    assert.equal(c[id].reason, 'no /health sample in the steady window', `${id}: ${c[id].reason}`)
  }
  // With samples that lack the field, the deployment is named.
  const old = [health(BOOT + 20 * MIN, { noRecord: true }), health(BOOT + 21 * MIN, { noRecord: true })]
  const o = byId(gradeSteady(splitBoots(old)[0], L, { samples: old }).criteria)
  assert.match(o['steady.budget_overruns'].reason, /V3 M1 not deployed/)
  assert.match(o['steady.lag'].reason, /V3 M1 not deployed/)
})

// Checker 25-09, nit 6: route-timings is read every 5 min, so the first
// in-window sample can come up to 5 min after BOOT + 15 min; a 5xx in that
// gap was counted by neither window.
test('steady: the 5xx delta starts from the last route-timings sample before the steady start, so a 5xx in the gap is counted', () => {
  const rt = (t, n) => ({ t, kind: 'routeTimings', route: '/state/route-timings', status: 200, cls: 'ok', ms: 20, data: { statusTotals: null, overflowRequests: 0, routes: n ? [{ route: '/health', n: 50, '5xx': n, aborted: 0, last5xx: null }] : [] } })
  const base = [health(BOOT + 10 * MIN), health(BOOT + 16 * MIN), health(BOOT + 24 * MIN)]
  const s = [...base, rt(BOOT + 13 * MIN, 0), rt(BOOT + 18 * MIN, 1), rt(BOOT + 23 * MIN, 1)]
  const c = byId(gradeSteady(splitBoots(s)[0], L, { samples: s }).criteria)['steady.critical_5xx']
  assert.equal(c.verdict, FAILED, `the /health 5xx between BOOT + 15 min and the first in-window sample (RED without the baseline): ${c.reason}`)
  assert.equal(c.value, 1)
  assert.match(c.reason, /counted from the route-timings sample at BOOT \+ 780 s/)
  // Another boot's counters are never a baseline (they restart at zero).
  const other = [health(BOOT - 30 * MIN, { bootAt: BOOT - 3_600_000, bootId: 'b0' }), rt(BOOT - 20 * MIN, 5), ...base.map(h => health(h.t, { bootId: 'b1' })), rt(BOOT + 18 * MIN, 1), rt(BOOT + 23 * MIN, 1)]
  const b1 = splitBoots(other)[1]
  const o = byId(gradeSteady(b1, L, { samples: other }).criteria)['steady.critical_5xx']
  assert.equal(o.value, 0, 'the previous boot\'s sample is not this boot\'s baseline')
})

// Checker 25-09, nit 5: the evidence reads (4.4–4.7 s action-log reads) land
// inside the startup window; a stall they overlap is annotated like any other
// harness read.
test('a startup stall that overlaps the harness\'s own evidence read is annotated, and still Failed', () => {
  const stallAt = BOOT + 60_000 // the fixture's startupLag.at
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    health(BOOT + 10 * MIN, { bootId: 'b1', startupLag: 7_000 }),
    health(BOOT + 16 * MIN, { bootId: 'b1', startupLag: 7_000 }),
    { t: BOOT + 6 * MIN, kind: 'evidence', route: null, status: null, cls: 'ok', ms: null, data: { bootAtMs: BOOT, actionLog: { ok: true, rows: [] }, journals: {}, reads: [{ t: stallAt - 2_000, route: '/state/action-log', status: 200, cls: 'ok', ms: 4_600 }] } },
  ]
  const lag = byId(gradeRun(s).boots[1].startup.criteria)['startup.lag_max']
  assert.equal(lag.verdict, FAILED)
  assert.deepEqual(lag.detail.harnessOverlap, [{ stallAt: iso(stallAt), harnessRoute: '/state/action-log', harnessMs: 4_600 }], 'RED when the evidence reads are left out of the harness\'s own requests')
})

test('limits: proposed until the owner stamps a date; a stored null or boolean never becomes a number', () => {
  const d = p1p4TargetDefaults()
  assert.equal(d.p1p4LimitsConfirmedAt, '')
  assert.equal(d.p1p4Report5xxMax, null)
  assert.equal(d.fastMonitorSkipMaxPct, undefined, 'the existing goal-table key is reused, not duplicated')
  const none = p1p4LimitsFromTargets({})
  assert.equal(none.confirmed, false)
  assert.equal(none.limits.report5xxMax, null)
  const stored = p1p4LimitsFromTargets({ ...d, p1p4Report5xxMax: null, p1p4ListeningMaxSec: true, p1p4LagMaxMs: 4000, fastMonitorSkipMaxPct: 15 })
  assert.equal(stored.limits.report5xxMax, null, 'null stays unset (Number(null) would be 0)')
  assert.equal(stored.limits.listeningMaxSec, 15, 'true is not 1')
  assert.equal(stored.limits.lagMaxMs, 4000)
  assert.equal(stored.limits.fastMonitorSkipMaxPct, 15)
  const ok = p1p4LimitsFromTargets({ p1p4LimitsConfirmedAt: '2026-09-28T12:00:00Z' })
  assert.equal(ok.confirmed, true)
  // The run says which: proposed is never acceptance.
  const g = gradeRun([health(BOOT + 16 * MIN)])
  assert.equal(g.limits.source, 'proposed')
  assert.match(g.acceptance, /NOT acceptance/)
  const gc = gradeRun([health(BOOT + 16 * MIN), { t: BOOT + 16 * MIN, kind: 'goalTable', route: '/state/goal-table', status: 200, cls: 'ok', data: { targets: { p1p4LimitsConfirmedAt: '2026-09-28T12:00:00Z', p1p4ListeningMaxSec: 5 } } }])
  assert.equal(gc.limits.source, 'confirmed')
  assert.equal(byId(gc.boots[0].startup.criteria)['startup.listening'].verdict, FAILED, 'the owner\'s limit (5 s) is what grades')
  assert.match(formatGrade(gc), /limits confirmed/)
  assert.equal(combineVerdicts([]), NOT_VERIFIABLE)
})

test('compaction keeps what the criteria read and drops tab identities and the watchdog map', () => {
  const h = compactHealth(rawHealth(BOOT + 16 * MIN))
  const text = JSON.stringify(h)
  assert.doesNotMatch(text, /203\.0\.113\.9|tab-secret-id|sess_|Asia\/Singapore/)
  assert.deepEqual(h.tabs, { open: 1, visible: 1, pages: ['/desk'] })
  assert.equal(h.boot.listeningMs, 7_500)
  const b = compactHeartbeats(rawHeartbeats(BOOT))
  assert.ok(JSON.stringify(b).length < 1_000, 'the ~300 KB body compacts to under 1 KB per account')
  assert.deepEqual(b.accounts[0].pos, [['240505699', 476.6, 518]])
})

// ---------------------------------------------------------------------------
// The harness: GET only; the token never leaves the Authorization header.
// ---------------------------------------------------------------------------

const TOKEN = 'read-token-DO-NOT-LEAK-0123456789abcdef'

function fakeProduction({ throwWithToken = false } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization })
    if (throwWithToken && url.endsWith('/state/goal-table')) throw new Error(`socket hang up (Bearer ${TOKEN})`)
    const path = new URL(url).pathname
    const body = path === '/health' ? rawHealth(BOOT + 16 * MIN)
      : path === '/state/heartbeats' ? rawHeartbeats(BOOT + 16 * MIN)
        : path === '/state/entry-engines' ? { at: iso(BOOT), accounts: [{ routingAccountId: '1', effectiveEntryMode: 'TIME_BASED', configRevision: 2, modeEpoch: 0 }] }
          : path === '/state/goal-table' ? { at: iso(BOOT), targets: {}, goals: [], summary: {} }
            : path === '/actions/goal-table' ? { ok: true, targets: { p1p4ListeningMaxSec: 15 } }
              : path === '/state/route-timings' ? { routes: [], statusTotals: {} }
                : { items: [] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetchImpl }
}

test('harness: every request is a GET with the read token in the header only; nothing written or logged carries it', async () => {
  const dir = tempDir('p1p4-harness-')
  const out = join(dir, 'samples.jsonl')
  const { calls, fetchImpl } = fakeProduction({ throwWithToken: true })
  const logs = []
  // The full table is OFF by default (a measured 12.4 s main-thread block):
  // a default round never asks for it.
  const byDefault = fakeProduction()
  await runHarness({ token: TOKEN, out: join(dir, 'default.jsonl'), fetchImpl: byDefault.fetchImpl, rounds: 1, now: () => BOOT + 16 * MIN, log: () => {}, sleep: async () => {} })
  assert.equal(byDefault.calls.length, 6, 'health, heartbeats, entry-engines, goal-table targets, route-timings, manifest')
  assert.ok(!byDefault.calls.some(c => c.url.endsWith('/state/goal-table')), 'the full table is not read unless opted in')
  // Opted in (--goal-table-every-min): the seventh read.
  const samples = await runHarness({ token: TOKEN, out, fetchImpl, rounds: 1, now: () => BOOT + 16 * MIN, log: (l) => logs.push(l), sleep: async () => {}, cadence: { ...CADENCE, goalTable: 60 * MIN } })
  assert.equal(calls.length, 7, 'health, heartbeats, entry-engines, goal-table targets, route-timings, manifest, goal table')
  assert.ok(calls.some(c => c.url.endsWith('/actions/goal-table')), 'the limits come from the targets-only read')
  assert.ok(calls.every(c => c.method === 'GET'))
  assert.ok(calls.every(c => c.auth === `Bearer ${TOKEN}`))
  assert.ok(calls.every(c => !c.url.includes(TOKEN)))
  const written = readFileSync(out, 'utf8')
  assert.equal(written.trim().split('\n').length, samples.length)
  assert.ok(!written.includes(TOKEN), 'the file never holds the token')
  assert.ok(!logs.join('\n').includes(TOKEN), 'no log line holds the token')
  const failed = samples.find(s => s.route === '/state/goal-table')
  assert.equal(failed.cls, 'platform')
  assert.match(failed.error, /\[redacted\]/, 'an error echoing the token is scrubbed')
  assert.equal(readSamples(out).samples.length, samples.length)
  await assert.rejects(runHarness({ token: '', out, fetchImpl, rounds: 1 }), /AGENT_SECRET_READ/)
  assert.equal(scrub(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a [redacted] b [redacted]')
})

async function simulatedRestart(extra = {}) {
  let clock = BOOT - 2 * MIN
  let booted = false
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method })
    const u = new URL(url)
    const bootAt = booted ? BOOT : BOOT - 3 * 3_600_000
    const id = booted ? 'boot-1' : 'boot-0'
    const pos = booted && clock >= BOOT + 5 * MIN ? [['111', 1.15, 1.2]] : [['111', 1.1, 1.2]]
    const body = u.pathname === '/health' ? rawHealth(clock, { bootAt, bootId: id })
      : u.pathname === '/state/heartbeats' ? rawHeartbeats(clock, { accounts: [{ id: '1', indAt: clock - 5_000, pos }] })
        : u.pathname === '/state/entry-engines' ? { at: iso(clock), accounts: [{ routingAccountId: '1', effectiveEntryMode: 'TIME_BASED', configRevision: 2, modeEpoch: 0, entryModePolicy: 'manual' }] }
          : u.pathname === '/state/action-log' ? { rows: [{ at: iso(BOOT + 30_000), method: 'POST', path: '/actions/x', account_id: '1', body: '{}' }] }
            : u.pathname === '/state/positions' ? { positions: [{ id: 42, account_id: '1', ctrader_position_id: '111' }] }
              : u.pathname === '/state/position/42/cockpit' ? { journal: [{ at: iso(BOOT + 90_000), kind: 'sl_moved', from: 1.1, to: 1.15, source: 'cpp_trail_engine' }] }
                : u.pathname === '/state/goal-table' ? { targets: {}, goals: [] }
                  : u.pathname === '/state/route-timings' ? { routes: [] } : { items: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  const writes = []
  const samples = await runHarness({
    token: TOKEN, fetchImpl, write: (l) => writes.push(l), log: () => {}, rounds: 60,
    now: () => clock,
    sleep: async (ms) => { clock += ms; if (!booted && clock >= BOOT + 20_000) booted = true },
    ...extra,
  })
  return { samples, calls, writes }
}

test('harness: a restart makes heartbeats dense, and the evidence is read once, GET-only, after the deadline', async () => {
  const { samples, calls, writes } = await simulatedRestart()
  assert.ok(calls.every(c => c.method === 'GET'))
  const hbAfter = samples.filter(s => s.kind === 'heartbeats' && s.t >= BOOT && s.t <= BOOT + 6 * MIN).map(s => s.t)
  const gaps = hbAfter.slice(1).map((t, i) => t - hbAfter[i])
  assert.ok(gaps.length >= 8 && gaps.every(g => g <= 31_000), `heartbeats every 30 s during recovery (gaps ${gaps.join(',')})`)
  const ev = samples.filter(s => s.kind === 'evidence')
  assert.equal(ev.length, 1, 'evidence read once for the one restart')
  assert.deepEqual(ev[0].data.journals['1:111'].map(e => e.kind), ['sl_moved'])
  assert.ok(ev[0].t >= BOOT + 5 * MIN, 'after the recovery deadline')
  const g = gradeRun(samples)
  const r = byId(g.boots[1].recovery.criteria)['recovery.config_and_protection_unchanged']
  assert.equal(r.verdict, PASSED, 'the journalled trail amend explains the SL move')
  assert.equal(writes.length, samples.length)
})

test('harness: --max-journals reaches the evidence read — 0 makes no cockpit read (no broker bar fetch), and the SL move is Not Verifiable, not unexplained', async () => {
  // Checker 25-09: each cockpit read draws a broker bar inside the startup
  // window being graded. The cap is the operator's lever; pin its wiring.
  const { samples, calls } = await simulatedRestart({ maxJournals: 0 })
  assert.equal(calls.filter(c => /\/cockpit\b/.test(c.url)).length, 0, 'no cockpit read at maxJournals 0 (RED when runHarness drops the option)')
  const ev = samples.filter(s => s.kind === 'evidence')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].data.journalsOk, false)
  const r = byId(gradeRun(samples).boots[1].recovery.criteria)['recovery.config_and_protection_unchanged']
  assert.equal(r.verdict, NOT_VERIFIABLE, r.reason)
  const dflt = await simulatedRestart()
  assert.equal(dflt.calls.filter(c => /\/cockpit\b/.test(c.url)).length, 1, 'by default the one changed position\'s journal is read')
})

test('evidence: cockpit journal reads stop at DEFAULT_MAX_JOURNALS; over the cap the changes are Not Verifiable, never Failed', async () => {
  const ids = Array.from({ length: DEFAULT_MAX_JOURNALS + 2 }, (_, i) => String(1000 + i))
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    hb(BOOT - 60_000, { accounts: [{ id: '1', pos: ids.map(id => [id, 1.1, 1.2]) }] }),
    health(BOOT + 20_000, { bootId: 'b1' }),
    hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', pos: ids.map(id => [id, 1.15, 1.2]) }] }),
  ]
  const cockpits = []
  const get = makeReader({ token: TOKEN, fetchImpl: async (url) => {
    const u = new URL(url)
    if (u.pathname === '/state/positions') return new Response(JSON.stringify({ positions: ids.map((id, i) => ({ id: i + 1, account_id: '1', ctrader_position_id: id })) }), { status: 200 })
    if (u.pathname.endsWith('/cockpit')) { cockpits.push(u.pathname); return new Response(JSON.stringify({ journal: [] }), { status: 200 }) }
    return new Response(JSON.stringify({ rows: [] }), { status: 200 })
  } })
  const ev = await collectEvidence(get, bootOf(s), s, L)
  assert.equal(cockpits.length, DEFAULT_MAX_JOURNALS, 'no more cockpit reads (broker bar fetches) than the cap')
  assert.equal(ev.journalsOk, false, 'over the cap the journals count as not read')
  const r = byId(gradeRecovery(bootOf(s), L, { samples: s, evidence: ev }).criteria)['recovery.config_and_protection_unchanged']
  assert.equal(r.verdict, NOT_VERIFIABLE, `empty journals over the cap are not "unexplained": ${r.reason}`)
  cockpits.length = 0
  const two = await collectEvidence(get, bootOf(s), s, L, { maxJournals: 2 })
  assert.equal(cockpits.length, 2)
  assert.equal(Object.keys(two.journals).length, 2)
})

test('evidence: a journal that could not be read is left unread, so the change is Not Verifiable rather than unexplained', async () => {
  const get = makeReader({ token: TOKEN, fetchImpl: async (url) => new URL(url).pathname === '/state/positions' ? new Response('{"status":"error","code":502,"message":"Application failed to respond"}', { status: 502 }) : new Response(JSON.stringify({ rows: [] }), { status: 200 }) })
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    hb(BOOT - 60_000, { accounts: [{ id: '1', pos: [['111', 1.1, 1.2]] }] }),
    health(BOOT + 20_000, { bootId: 'b1' }),
    hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', pos: [['111', 1.15, 1.2]] }] }),
  ]
  const ev = await collectEvidence(get, bootOf(s), s, L)
  assert.equal(ev.actionLog.ok, true)
  assert.equal(ev.journals['1:111'], undefined)
  assert.equal(ev.journalsOk, false)
  assert.equal(ev.reads.find(r => r.route === '/state/positions').cls, 'platform')
})

test('a stall that overlaps the harness\'s own slow read is annotated, and still Failed', () => {
  const s = []
  for (let t = BOOT + 16 * MIN; t <= BOOT + 16 * MIN + 2.2 * 3_600_000; t += 30_000) s.push(health(t))
  // One 10-min window whose worst stall (13.3 s) sits inside the harness's own /state/goal-table read.
  const at = BOOT + 60 * MIN
  s.push({ t: at - 5_000, kind: 'goalTable', route: '/state/goal-table', status: 200, cls: 'ok', ms: 13_271, data: null })
  const bad = health(at + 30_000, { lagMax: 13_300 })
  bad.data.lat.lag10m.worst.at = iso(at + 2_000)
  s.push(bad)
  const lag = byId(gradeRun(s).boots[0].steady.criteria)['steady.lag']
  assert.equal(lag.verdict, FAILED, 'a stall the harness caused is still a stall: any Desk reader of that route causes it')
  assert.equal(lag.detail.harnessOverlap[0].harnessRoute, '/state/goal-table')
  assert.match(lag.reason, /overlapped the harness's own slow request/)
  // A stall with no harness read in flight carries no annotation.
  const alone = s.filter(x => x.kind !== 'goalTable')
  assert.equal(byId(gradeRun(alone).boots[0].steady.criteria)['steady.lag'].detail.harnessOverlap, undefined)
})

// ---------------------------------------------------------------------------
// Maker's corrections on top of the first draft (25-09 evening).
// ---------------------------------------------------------------------------

test('the harness\'s own deadline is a timeout, not a platform error — a blocked main thread looks exactly like it', async () => {
  assert.equal(classifyResponse({ error: new Error('x'), timedOut: true }), 'timeout')
  assert.equal(classifyResponse({ error: new Error('ECONNRESET') }), 'platform')
  const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const get = makeReader({ token: TOKEN, fetchImpl: async () => { throw timeoutErr } })
  const r = await get('/health')
  assert.equal(r.cls, 'timeout')
  const resetGet = makeReader({ token: TOKEN, fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.equal((await resetGet('/health')).cls, 'platform')
  // In a run it is listed apart from the gateway errors and printed.
  const g = gradeRun([health(BOOT + 16 * MIN), { t: BOOT + 17 * MIN, kind: 'health', route: '/health', status: null, cls: 'timeout', ms: 20_000, data: null }])
  assert.equal(g.timeouts.count, 1)
  assert.equal(g.platform.count, 0)
  assert.match(formatGrade(g), /harness timeouts 1/)
})

test('evidence: action_log is read for EVERY account, and a read that does not reach back to the window is not treated as complete', async () => {
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3_600_000, bootId: 'b0' }),
    hb(BOOT - 60_000, { accounts: [{ id: '1', pos: [['111', 1.1, 1.2]] }] }),
    health(BOOT + 20_000, { bootId: 'b1' }),
    hb(BOOT + 5 * MIN + 10_000, { accounts: [{ id: '1', pos: [['111', 1.1, 1.2]] }] }),
  ]
  const urls = []
  // The fake answers like account-scope.js requestedAccount: without an
  // explicit account=all it scopes to the SELECTED account ('1') and NULL rows.
  const reader = (rows) => makeReader({ token: TOKEN, fetchImpl: async (url) => {
    urls.push(url)
    const all = new URL(url).searchParams.get('account') === 'all'
    const scoped = all ? rows : rows.filter(r => r.account_id == null || String(r.account_id) === '1')
    return new Response(JSON.stringify({ rows: scoped }), { status: 200 })
  } })
  const few = await collectEvidence(reader([{ at: iso(BOOT + 30_000), method: 'POST', path: '/actions/entry-mode', account_id: '2', body: '{}' }]), bootOf(s), s, L)
  assert.equal(few.actionLog.ok, true)
  assert.equal(few.actionLog.rows.length, 1, 'another account\'s entry-mode row is in the evidence (RED when the read is scoped to the selected account)')
  assert.ok(urls.some(u => /\/state\/action-log\?account=all&limit=1000$/.test(u)), `the scope is explicit: ${urls.join(' ')}`)
  // 1,000 rows, all newer than the window start: the window is not covered.
  const recent = Array.from({ length: 1000 }, (_, i) => ({ at: iso(BOOT + 6 * MIN + i), method: 'GET', path: '/x', account_id: null, body: '' }))
  const trunc = await collectEvidence(reader(recent), bootOf(s), s, L)
  assert.equal(trunc.actionLog.ok, false)
  assert.match(trunc.actionLog.reason, /do not reach back/)
})

test('evidence: a native trail amend journalled after the post sample (first keeper pass after boot) still explains the change', () => {
  const pre = BOOT - 60_000
  const post = BOOT + 5 * MIN + 10_000
  const s = [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 20_000, pos: [['111', 1.10, 1.20]] }] }),
    ee(pre, [{ ...eeAcct(), id: '1' }]),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
    hb(post, { accounts: [{ id: '1', indAt: post - 10_000, pos: [['111', 1.15, 1.20]] }] }),
    ee(post, [{ ...eeAcct(), id: '1' }]),
  ]
  const late = iso(post + 3 * MIN) // journalled after post + 60 s, before the evidence read
  const grade = (window) => byId(gradeRecovery(bootOf(s), L, { samples: s, evidence: { window, actionLog: { ok: true, rows: [] }, journals: { '1:111': [{ at: late, kind: 'trail_tightened', source: 'cpp_trail_engine' }] } } }).criteria)['recovery.config_and_protection_unchanged']
  assert.equal(grade({ journalsToMs: post + 4 * MIN }).verdict, PASSED, 'read up to the evidence read')
  assert.equal(grade({}).verdict, FAILED, 'without the read horizon the same event is outside the window')
})

test('only enabled accounts are graded; disabled ones are named apart, not failed for having no audit', () => {
  const t = BOOT + 20 * MIN
  const c = compactHeartbeats(rawHeartbeats(t, { accounts: [{ id: '1' }, { id: '2', enabled: false, auditAt: null, indAt: null }] }))
  assert.deepEqual(c.accounts.map(a => a.id), ['1'])
  assert.deepEqual(c.disabled, ['2'])
  const s = [health(t), { t, kind: 'heartbeats', route: '/state/heartbeats', status: 200, cls: 'ok', ms: 30, data: c }]
  const g = byId(gradeSteady(splitBoots(s)[0], L, { samples: s }).criteria)
  assert.notEqual(g['steady.audit_age'].verdict, FAILED)
  assert.notEqual(g['steady.independent_age'].verdict, FAILED)
})

test('the grade names which pages were visible, so a window without the Desk or Performance is visible as such', () => {
  const g = gradeStartup(bootOf(startupOf({ visible: 1 })), L)
  assert.equal(g.representative.deskVisible, true)
  assert.equal(g.representative.performanceVisible, false)
  const text = formatGrade(gradeRun(startupOf({ visible: 1 })))
  assert.match(text, /visible tabs: \/desk; Performance never visible/)
  assert.equal(routeClass('/state/watchdog'), 'report', 'a worker report route is report class')
  assert.equal(routeClass('/state/account-money'), 'critical')
})
