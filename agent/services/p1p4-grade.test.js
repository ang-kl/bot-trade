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
import { readFileSync } from 'node:fs'
import { tempDir } from '../test-support/temp-dir.js'
import {
  PASSED, FAILED, NOT_VERIFIABLE, P1P4_PROPOSED_LIMITS, p1p4LimitsFromTargets, p1p4TargetDefaults,
  compactHealth, compactHeartbeats, classifyResponse, routeClass, splitBoots, gradeStartup, gradeRecovery, gradeSteady,
  gradeRun, formatGrade, combineVerdicts, toMs,
} from './p1p4-grade.js'
import { runHarness, makeReader, collectEvidence, readSamples, scrub, CADENCE } from '../../scripts/v3-p1p4-acceptance.mjs'

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
      managementWork: { at: iso(t), positions: o.work ?? [] },
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
  assert.equal(p99(1_000).verdict, PASSED)
  assert.equal(p99(2_000).verdict, FAILED)
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
  assert.equal(run(() => ({ lagMax: 4_999, lagP99: 1_000 }))['steady.lag'].verdict, PASSED)
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
  const samples = (postPos, postEpoch = 0) => [
    health(BOOT - 90_000, { bootAt: BOOT - 3 * 3_600_000, bootId: 'boot-0' }),
    hb(pre, { accounts: [{ id: '1', indAt: pre - 20_000, pos: [['111', 1.10, 1.20]] }] }),
    ee(pre, [{ ...eeAcct(), id: '1' }]),
    health(BOOT + 20_000, { bootId: 'boot-1' }),
    hb(post, { accounts: [{ id: '1', indAt: post - 10_000, pos: postPos }] }),
    ee(post, [{ ...eeAcct({ epoch: postEpoch }), id: '1' }]),
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
  assert.equal(toMs('2026-09-28 13:01:00'), Date.parse('2026-09-28T13:01:00Z'), 'SQLite timestamps are UTC')
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

test('harness: a restart makes heartbeats dense, and the evidence is read once, GET-only, after the deadline', async () => {
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
  })
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
