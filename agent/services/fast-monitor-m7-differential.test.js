// node --test agent/services/fast-monitor-m7-differential.test.js
//
// M7 round 4 (26-09-2026): the DIFFERENTIAL harness. Every scenario runs
// through origin/main's runFastMonitor (the frozen pre-M7 baseline,
// ../test-support/m7-baseline/, blob-pinned below) and through this tree's,
// on the same virtual clock, prices and broker behaviour
// (../test-support/fast-monitor-sim.js), and holds this tree to main:
//
//   · EXIT: no position is handed to the broker for a FULL_EXIT more than
//     ONE tick (3 s) later than main hands it, however slow other positions'
//     work is (X1), inside a spike window (X2), after probe failures (X3);
//   · LATENESS: no due → evaluated sample is kept that main excludes (X4) —
//     a first sighting is `first_seen`, the evaluation after a closure is
//     `after_no_quote`, exactly as main files them;
//   · GRADE: the P1/P4 recovery criterion R3 is never Passed on this tree's
//     receipts at a moment main's receipts grade Failed (X5), with the same
//     one-tick tolerance the exits get.
//
// The X1–X5 labels are the round-3 adversarial findings they reproduce
// (head 8db7f5a); each scenario was run there and failed — see the PR.
// Scenarios run twice on this tree: with what the ticker gives a pass of a
// 3 s tick (a 2 s end-of-pass probe wait) and with no wait at all
// (probeWaitMs 0, pure next-pass consumption), so neither the wait nor its
// absence is what carries an invariant.

import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, BASELINE, readBaseline, gitBlobId } from '../test-support/fast-monitor-sim.js'
import { compactHealth, compactHeartbeats, splitBoots, gradeRecovery, P1P4_PROPOSED_LIMITS, PASSED, FAILED } from './p1p4-grade.js'

const TICK = 3_000
const T0 = Date.parse('2026-09-28T13:00:00Z')
const SYM = { EURUSD: 1, GBPUSD: 2, USDJPY: 3, AUDUSD: 4, NZDUSD: 5, USDCAD: 6, EURGBP: 7, EURJPY: 8, GBPJPY: 9, AUDJPY: 10, CHFJPY: 11, CADJPY: 12, NZDJPY: 13 }
const quote = (mid, spread = 0.0002) => ({ bid: mid - spread / 2, ask: mid + spread / 2 })
const iso = (ms) => new Date(ms).toISOString()
// null: the wait the ticker gives a 3 s tick (2 s); 0: none at all.
const WAITS = [null, 0]
const waitLabel = (w) => (w == null ? 'ticker wait' : `wait ${w} ms`)

async function both(sc, probeWaitMs) {
  const main = await runScenario('main', sc)
  const branch = await runScenario('branch', sc, { probeWaitMs })
  return { main, branch }
}

function exitNotLater(t, name, { main, branch }, id, ticks = 1) {
  const m = main.exitAt(id)
  const b = branch.exitAt(id)
  t.diagnostic(`${name}: main exits at +${m == null ? '—' : (m - T0) / 1000} s, branch at +${b == null ? 'never' : (b - T0) / 1000} s`)
  assert.ok(m != null, `${name}: harness sanity — main must exit in this scenario`)
  assert.ok(b != null, `${name}: the branch never handed the FULL_EXIT to the broker; main did at +${(m - T0) / 1000} s`)
  assert.ok(b <= m + ticks * TICK, `${name}: the branch exited at +${(b - T0) / 1000} s, more than ${ticks} tick(s) after main's +${(m - T0) / 1000} s`)
}

test('the baseline is origin/main 580308e\'s fast-monitor.js, byte for byte', () => {
  assert.equal(gitBlobId(readBaseline()), BASELINE.blob, 'the frozen baseline drifted — restore it from `git show 580308e:agent/services/fast-monitor.js`')
})

// ---------------------------------------------------------------------------
// X1 — starvation. Q (EURUSD, sidecar-priced) is in its spike window and
// every pass spends 11 s in an erroring broker action, AHEAD of P (GBPUSD,
// broker-priced, trigger price<1.2650). Round 3 aged P's probe result past
// 10 s at P's own turn every pass and relaunched it forever.
// ---------------------------------------------------------------------------
function x1({ pAhead = false } = {}) {
  const q = { id: pAhead ? 102 : 101, symbol: 'EURUSD', entry: 1.1000, sl: 1.0950, risk: 0.005, trigger: 'price<1.0950' }
  const p = { id: pAhead ? 101 : 102, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }
  return {
    startMs: T0, durationMs: 150_000, symbolMap: SYM, overrides: { EURUSD: 0.25, GBPUSD: 0.25 },
    positions: pAhead ? [p, q] : [q, p],
    // Q crosses its own trigger at +15 s — a 0.9 % move in 15 s is a spike, so Q is due every pass from then on.
    sidecar: (t) => ({ [SYM.EURUSD]: quote(t < T0 + 15_000 ? 1.1000 : 1.0900) }),
    broker: (id, t) => ({ kind: 'quote', latencyMs: 400, ...quote(t < T0 + 40_000 ? 1.2700 : 1.2621) }),
    action: (pos) => (pos.symbol === 'EURUSD' ? { durationMs: 11_000, outcome: { error: 'TRADING_BAD_VOLUME' } } : null),
    pId: p.id,
  }
}

// X1 on its FIRST pass — the checker's own shape: P through its trigger from
// the start, and Q's 11 s erroring action in the same pass. Behind Q, main
// exits P right after Q's action; AHEAD of Q, main exits P before Q's action
// starts — so must this tree (the barrier before a later position's action).
function x1First({ pAhead }) {
  const q = { id: pAhead ? 1202 : 1201, symbol: 'EURUSD', entry: 1.1000, sl: 1.0950, risk: 0.005, trigger: 'price<1.0950' }
  const p = { id: pAhead ? 1201 : 1202, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }
  return {
    startMs: T0, durationMs: 60_000, symbolMap: SYM, overrides: { EURUSD: 0.25, GBPUSD: 0.25 },
    positions: pAhead ? [p, q] : [q, p],
    sidecar: () => ({ [SYM.EURUSD]: quote(1.0900) }),
    broker: () => ({ kind: 'quote', latencyMs: 400, ...quote(1.2621) }),
    action: (pos) => (pos.symbol === 'EURUSD' ? { durationMs: 11_000, outcome: { error: 'TRADING_BAD_VOLUME' } } : null),
    pId: p.id,
  }
}

for (const w of WAITS) {
  test(`X1 first pass (${waitLabel(w)}): behind Q's 11 s action, P exits within one tick of main's pass-1 exit`, async (t) => {
    const sc = x1First({ pAhead: false })
    exitNotLater(t, 'X1 first pass', await both(sc, w), sc.pId)
  })
  test(`X1 first pass, P ahead (${waitLabel(w)}): P exits before Q's 11 s action starts, as on main`, async (t) => {
    const sc = x1First({ pAhead: true })
    const r = await both(sc, w)
    exitNotLater(t, 'X1 first pass, P ahead', r, sc.pId)
    const qAction = (run) => run.obs.actions.find(a => a.symbol === 'EURUSD')?.at
    assert.ok(r.branch.exitAt(sc.pId) <= qAction(r.branch), 'P\'s exit went to the broker before Q\'s action started')
  })
  test(`X1 (${waitLabel(w)}): a broker-priced position BEHIND an 11 s action every pass exits within one tick of main`, async (t) => {
    const sc = x1()
    const r = await both(sc, w)
    exitNotLater(t, 'X1', r, sc.pId)
    // The waits behind Q's actions are real lateness: kept as main keeps
    // them, never larger than main's by more than the tick.
    latenessMatches(t, 'X1 lateness', r)
    assert.ok(Math.max(...r.main.lat.lateness.map(x => x[1])) >= 10_000, 'harness sanity: main records the 11 s waits as lateness here')
  })
  test(`X1 mirror (${waitLabel(w)}): a broker-priced position AHEAD of the 11 s action exits within one tick of main`, async (t) => {
    const sc = x1({ pAhead: true })
    exitNotLater(t, 'X1 mirror', await both(sc, w), sc.pId)
  })
}

// ---------------------------------------------------------------------------
// X2 — inside a spike window every tick re-prices. P's own move at ~+18 s
// arms the window; the price crosses the trigger at +30.5 s, just after the
// probe of the +30 s pass landed. Round 3 re-used that cached result for
// 10 s and exited four passes late.
// ---------------------------------------------------------------------------
function x2() {
  return {
    startMs: T0, durationMs: 90_000, symbolMap: SYM, overrides: { GBPUSD: 0.25 },
    positions: [{ id: 201, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }],
    sidecar: () => ({ [SYM.EURUSD]: quote(1.1000) }),
    broker: (id, t) => ({ kind: 'quote', latencyMs: 400, ...quote(t < T0 + 15_000 ? 1.2700 : t < T0 + 30_500 ? 1.2660 : 1.2640) }),
  }
}
for (const w of WAITS) {
  test(`X2 (${waitLabel(w)}): inside a spike window the crossing is acted on within one tick of main`, async (t) => {
    const r = await both(x2(), w)
    exitNotLater(t, 'X2', r, 201)
    // Every tick of the window re-priced from the broker: no pass reused an
    // earlier probe instead of asking again.
    const inWindow = (run) => run.probesOf(SYM.GBPUSD).filter(p => p.at >= T0 + 21_000 && p.at < T0 + 30_000).length
    assert.ok(inWindow(r.branch) >= inWindow(r.main) - 1, `spike window re-probes: branch ${inWindow(r.branch)}, main ${inWindow(r.main)}`)
  })
}

// ---------------------------------------------------------------------------
// X3 — a probe FAILURE is not a quiet symbol. The broker fails (a timeout
// before subscribing, an auth error, a closed socket) until +18 s, then
// answers a crossed price. The side is fresh (EURUSD streams), so a clean
// empty answer could back off — a failure must not. Round 3 read every
// failure as "clean, no quote" and backed off to +63 s.
// ---------------------------------------------------------------------------
function x3(reason, { spike = false } = {}) {
  const latencyMs = { timeout: 6_000, auth: 200, close: 1_000 }[reason]
  const failFrom = spike ? T0 + 30_000 : T0
  const failTo = spike ? T0 + 36_000 : T0 + 18_000
  return {
    startMs: T0, durationMs: 120_000, symbolMap: SYM, overrides: { GBPUSD: 0.25 },
    positions: [{ id: 301, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }],
    sidecar: () => ({ [SYM.EURUSD]: quote(1.1000) }),
    broker: (id, t) => {
      if (t >= failFrom && t < failTo) return { kind: 'failed', reason, latencyMs }
      if (spike) return { kind: 'quote', latencyMs: 400, ...quote(t < T0 + 15_000 ? 1.2700 : t < failTo ? 1.2660 : 1.2640) }
      return { kind: 'quote', latencyMs: 400, ...quote(1.2621) }
    },
  }
}
for (const w of WAITS) {
  for (const reason of ['timeout', 'auth', 'close']) {
    test(`X3 (${reason}, ${waitLabel(w)}): a failing broker is retried on main's schedule, never backed off`, async (t) => {
      exitNotLater(t, `X3 ${reason}`, await both(x3(reason), w), 301)
    })
    test(`X3 spike (${reason}, ${waitLabel(w)}): a failure inside a spike window is retried on the next tick`, async (t) => {
      exitNotLater(t, `X3 spike ${reason}`, await both(x3(reason, { spike: true }), w), 301)
    })
  }
}

// ---------------------------------------------------------------------------
// X4 — lateness keeps exactly what main keeps. (a) a broker-priced first
// sighting is `first_seen`, not a counted one-tick sample; (b) the
// evaluation after a 2-hour closure is `after_no_quote`, not a 7,221,000 ms
// sample. The side is EMPTY here so no backoff can apply: the evaluations
// line up tick for tick and the samples can be compared one to one.
// ---------------------------------------------------------------------------
function x4({ closureMs = 0 } = {}) {
  const closeAt = T0 + 60_000
  return {
    startMs: T0, durationMs: closureMs ? closureMs + 150_000 : 90_000, symbolMap: SYM, overrides: { GBPUSD: 0.25 },
    positions: [{ id: 401, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }],
    sidecar: () => ({}),
    broker: (id, t) => (closureMs && t >= closeAt && t < closeAt + closureMs
      ? { kind: 'empty', latencyMs: 6_000 }
      : { kind: 'quote', latencyMs: 400, ...quote(1.2702) }),
  }
}
// Samples are paired by the DUE TIME they answer (evaluatedAt − lateness):
// the branch may evaluate up to a tick after main, so its due times may run
// up to a tick apart, and its last evaluation may fall past the simulated
// window. Held: the exclusions are main's (they happen mid-window); every
// sample the branch keeps is one main keeps, no more than a tick later; and
// the only samples of main's the branch lacks are in the window's last two
// ticks.
function latenessMatches(t, name, { main, branch }) {
  const m = main.lat, b = branch.lat
  const end = main.sc.startMs + main.sc.durationMs
  t.diagnostic(`${name}: main kept ${m.lateness.length} (max ${Math.max(0, ...m.lateness.map(x => x[1]))} ms), excluded ${JSON.stringify(m.excluded)}; branch kept ${b.lateness.length} (max ${Math.max(0, ...b.lateness.map(x => x[1]))} ms), excluded ${JSON.stringify(b.excluded)}`)
  assert.deepEqual(b.excluded, m.excluded, `${name}: the branch must exclude exactly what main excludes`)
  const unpaired = m.lateness.map(([at, ms]) => ({ at, ms, due: at - ms }))
  for (const [at, ms] of b.lateness) {
    const i = unpaired.findIndex(x => Math.abs(x.due - (at - ms)) <= TICK)
    assert.ok(i >= 0, `${name}: the branch kept a ${ms} ms sample (due +${(at - ms - main.sc.startMs) / 1000} s) main has no counterpart for`)
    assert.ok(ms <= unpaired[i].ms + TICK, `${name}: branch ${ms} ms against main's ${unpaired[i].ms} ms for the same due time`)
    unpaired.splice(i, 1)
  }
  for (const x of unpaired) assert.ok(x.at > end - 2 * TICK, `${name}: main kept a ${x.ms} ms sample at +${(x.at - main.sc.startMs) / 1000} s the branch never took`)
}
for (const w of WAITS) {
  test(`X4a (${waitLabel(w)}): a broker-priced first sighting is first_seen, as on main`, async (t) => {
    latenessMatches(t, 'X4a', await both(x4(), w))
  })
  test(`X4b (${waitLabel(w)}): the evaluation after a 2-hour closure is after_no_quote, as on main`, async (t) => {
    latenessMatches(t, 'X4b', await both(x4({ closureMs: 2 * 3_600_000 }), w))
  })
}

// ---------------------------------------------------------------------------
// X5 — R3 ("every fast-monitor position evaluated since boot") is never
// Passed on this tree's receipts while main's grade Failed. Two broker-priced
// positions last evaluated before BOOT; the broker refuses every probe; the
// side is fresh (EURUSD streams with no position on it). Main records
// quote_unavailable on each due attempt and not_due between, so R3 fails
// "not evaluated since boot"; round 3 sat in probe_backoff/probe_deferred,
// which its grader exempted: Passed.
// ---------------------------------------------------------------------------
function x5() {
  const w = (id) => ({ accountId: '111', positionId: id, owner: 'node_fast_monitor', lastCompletedAt: iso(T0 - 600_000), nextDueAt: iso(T0 - 585_000), state: 'not_due', lastOutcome: 'evaluated', cadenceMs: 15_000 })
  return {
    startMs: T0, durationMs: 500_000, symbolMap: SYM, overrides: { GBPUSD: 0.25, USDJPY: 0.25 },
    positions: [
      { id: 501, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' },
      { id: 502, symbol: 'USDJPY', entry: 150.00, sl: 149.50, risk: 0.5, trigger: 'price<149.50' },
    ],
    sidecar: () => ({ [SYM.EURUSD]: quote(1.1000) }),
    broker: () => ({ kind: 'failed', reason: 'auth', latencyMs: 200 }),
    priorWork: { version: 1, at: iso(T0 - 5_000), positions: [w(501), w(502)], total: 2, complete: true },
  }
}
function r3At(run, at) {
  const BOOT = run.sc.startMs
  const health = { t: BOOT + 20_000, kind: 'health', route: '/health', status: 200, cls: 'ok', ms: 3,
    data: compactHealth({ status: 'ok', commit: 'sim', authenticated: true, uptime: 20, bootRecord: { current: { bootId: 'sim', bootAt: iso(BOOT) } } }) }
  const hb = (x) => ({ t: x, kind: 'heartbeats', route: '/state/heartbeats', status: 200, cls: 'ok', ms: 30,
    data: compactHeartbeats({ runtime: { at: iso(x), accounts: [], managementWork: run.workAt(x) } }) })
  const samples = [health]
  for (let x = BOOT + 30_000; x < BOOT + 300_000; x += 30_000) samples.push(hb(x))
  samples.push(hb(at))
  const boot = splitBoots(samples).at(-1)
  return gradeRecovery(boot, { ...P1P4_PROPOSED_LIMITS }, { samples }).criteria.find(c => c.id === 'recovery.fast_monitor_resumed')
}
for (const w of WAITS) {
  test(`X5 (${waitLabel(w)}): R3 is never Passed on the branch's receipts while main's grade Failed`, async (t) => {
    const { main, branch } = await both(x5(), w)
    let mainFailed = 0
    const lenient = []
    for (let at = T0 + 303_000; at < T0 + 480_000; at += TICK) {
      const m = r3At(main, at).verdict
      const mPrev = r3At(main, at - TICK).verdict
      if (m !== FAILED || mPrev !== FAILED) continue
      mainFailed++
      const b = r3At(branch, at)
      if (b.verdict === PASSED) lenient.push(`+${(at - T0) / 1000} s`)
    }
    t.diagnostic(`X5: main Failed at ${mainFailed} post-sample instants; branch Passed at ${lenient.length} of them`)
    assert.ok(mainFailed > 10, 'harness sanity: main must fail R3 across the post window here')
    assert.deepEqual(lenient, [], 'the branch graded Passed where main graded Failed (a starved or failing position hidden)')
  })
}

// ---------------------------------------------------------------------------
// Shapes the round-4 design must also hold under (not round-3 findings).
// Under the ticker's wait every one is within one tick of main. The no-wait
// variant is a stress case the ticker never produces (a 3 s tick always gets
// a 2 s wait; a 1 s tick gets none, but then its tick is 1 s): every answer
// there is served a pass after it lands, and in these compound shapes a
// queue of actions ahead adds its own time — they are held to two ticks.
// ---------------------------------------------------------------------------
const compoundTicks = (w) => (w == null ? 1 : 2)

// R/S ordering: R's crossed quote must not wait on S's slower probe.
function ordering() {
  return {
    startMs: T0, durationMs: 60_000, symbolMap: SYM, overrides: { GBPUSD: 0.25, USDJPY: 0.25 },
    positions: [
      { id: 601, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' },
      { id: 602, symbol: 'USDJPY', entry: 150.00, sl: 149.50, risk: 0.5, trigger: 'price<149.50' },
    ],
    sidecar: () => ({}),
    broker: (id, t) => (id === SYM.GBPUSD
      ? { kind: 'quote', latencyMs: 300, ...quote(t < T0 + 20_000 ? 1.2700 : 1.2621) }
      : { kind: 'failed', reason: 'timeout', latencyMs: 6_000 }),
  }
}
// Cap overflow: twelve broker-priced symbols cross together.
function capOverflow() {
  const names = ['GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CHFJPY', 'CADJPY', 'NZDJPY']
  return {
    startMs: T0, durationMs: 90_000, symbolMap: SYM, overrides: Object.fromEntries(names.map(n => [n, 0.25])),
    positions: names.map((n, i) => ({ id: 700 + i, symbol: n, entry: 100, sl: 99, risk: 1, trigger: 'price<99' })),
    sidecar: () => ({}),
    broker: (id, t) => ({ kind: 'quote', latencyMs: 1_500, ...quote(t < T0 + 30_000 ? 100 : 98.5, 0.02) }),
  }
}
// Two positions on one symbol share one probe; both exit.
function sharedSymbol() {
  return {
    startMs: T0, durationMs: 60_000, symbolMap: SYM, overrides: { GBPUSD: 0.25 },
    positions: [
      { id: 801, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' },
      { id: 802, symbol: 'GBPUSD', entry: 1.2690, sl: 1.2640, risk: 0.005, trigger: 'price<1.2640' },
    ],
    sidecar: () => ({}),
    broker: (id, t) => ({ kind: 'quote', latencyMs: 400, ...quote(t < T0 + 20_000 ? 1.2700 : 1.2600) }),
  }
}
// No override: the relVol read is awaited work between probes.
function relVolReads() {
  return {
    startMs: T0, durationMs: 400_000, symbolMap: SYM, volFetchMs: 900,
    positions: [
      { id: 901, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' },
      { id: 902, symbol: 'USDJPY', entry: 150.00, sl: 149.50, risk: 0.5, trigger: 'price<149.50' },
      { id: 903, symbol: 'AUDUSD', entry: 0.6600, sl: 0.6550, risk: 0.005, trigger: 'price<0.6550' },
    ],
    sidecar: () => ({}),
    broker: (id, t) => {
      const late = t >= T0 + 200_000
      if (id === SYM.GBPUSD) return { kind: 'quote', latencyMs: 700, ...quote(late ? 1.2621 : 1.2700) }
      if (id === SYM.USDJPY) return { kind: 'quote', latencyMs: 700, ...quote(late ? 149.10 : 150.00, 0.02) }
      return { kind: 'quote', latencyMs: 700, ...quote(late ? 0.6521 : 0.6600) }
    },
  }
}
for (const w of WAITS) {
  test(`ordering (${waitLabel(w)}): a crossed quote is acted on without waiting for a later position's slow probe`, async (t) => {
    exitNotLater(t, 'ordering', await both(ordering(), w), 601, compoundTicks(w))
  })
  test(`cap overflow (${waitLabel(w)}): twelve symbols under a cap of eight all exit within ${compoundTicks(w)} tick(s) of main`, async (t) => {
    const sc = capOverflow()
    const r = await both(sc, w)
    for (const p of sc.positions) exitNotLater(t, `cap ${p.symbol}`, r, p.id, compoundTicks(w))
  })
  test(`shared symbol (${waitLabel(w)}): two positions on one symbol both exit within ${compoundTicks(w)} tick(s) of main`, async (t) => {
    const r = await both(sharedSymbol(), w)
    exitNotLater(t, 'shared 801', r, 801, compoundTicks(w))
    exitNotLater(t, 'shared 802', r, 802, compoundTicks(w))
  })
  test(`relVol reads (${waitLabel(w)}): probes overlapping awaited trendbar reads still exit within ${compoundTicks(w)} tick(s) of main`, async (t) => {
    const sc = relVolReads()
    const r = await both(sc, w)
    for (const p of sc.positions) exitNotLater(t, `relVol ${p.symbol}`, r, p.id, compoundTicks(w))
  })
}

// A slow probe AHEAD of a crossed one: waiters are served in main's order, so
// R waits for S — never longer than main's serial loop makes it wait.
function slowHead() {
  const sc = ordering()
  sc.positions = [sc.positions[1], sc.positions[0]] // USDJPY (6 s failures) first, GBPUSD behind it
  sc.positions[0] = { ...sc.positions[0], id: 1001 }
  sc.positions[1] = { ...sc.positions[1], id: 1002 }
  return sc
}
// OD-22's backoff — the ONE deliberate departure from main's timing: a clean
// empty answer while the side streams defers the next probe up to backoffMs
// (60 s default) after the empty one was sent; a spike window never does.
function quietThenOpen() {
  return {
    startMs: T0, durationMs: 150_000, symbolMap: SYM, overrides: { GBPUSD: 0.25 },
    positions: [{ id: 1101, symbol: 'GBPUSD', entry: 1.2700, sl: 1.2650, risk: 0.005, trigger: 'price<1.2650' }],
    sidecar: () => ({ [SYM.EURUSD]: quote(1.1000) }),
    broker: (id, t) => (t < T0 + 20_000 ? { kind: 'empty', latencyMs: 6_000 } : { kind: 'quote', latencyMs: 400, ...quote(1.2621) }),
  }
}
for (const w of WAITS) {
  test(`slow head (${waitLabel(w)}): a crossed quote queued behind a 6 s probe exits within ${compoundTicks(w)} tick(s) of main`, async (t) => {
    exitNotLater(t, 'slow head', await both(slowHead(), w), 1002, compoundTicks(w))
  })
  test(`OD-22 backoff (${waitLabel(w)}): a quiet symbol in a streaming side may be re-asked late — by at most the 60 s backoff`, async (t) => {
    const r = await both(quietThenOpen(), w)
    const m = r.main.exitAt(1101)
    const b = r.branch.exitAt(1101)
    t.diagnostic(`OD-22: main exits at +${(m - T0) / 1000} s, branch at +${(b - T0) / 1000} s`)
    assert.ok(m != null && b != null)
    assert.ok(b <= m + 60_000 + TICK, 'bounded by the owner\'s backoff, never more')
    assert.ok(r.branch.probesOf(SYM.GBPUSD).length < r.main.probesOf(SYM.GBPUSD).length, 'and it does ask the broker less often — the point of the backoff')
  })
}
