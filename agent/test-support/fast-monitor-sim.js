// ---------------------------------------------------------------------------
// agent/test-support/fast-monitor-sim.js — test-only DIFFERENTIAL simulator for
// the fast monitor's exit path (M7 round 4, 26-09-2026).
//
// WHY THIS EXISTS. Three M7 rounds were each refuted by a reproduction that
// ran the same scenario through origin/main and through the branch and
// found the branch exiting later (a starved position, a spike window that
// stopped re-pricing, a failure read as a quiet symbol) or reporting a
// lateness or grade main would not. Every one of those was reachable only
// through runFastMonitor's public entry point, with injected time, prices
// and broker actions — which is exactly what this module drives:
//
//   · runFastMonitor(db, creds, deps) of TWO implementations: the pre-M7
//     baseline — agent/services/fast-monitor.js at origin/main 580308e,
//     frozen byte-for-byte in m7-baseline/ and pinned by its git blob id —
//     and the tree under test. Nothing M7-internal is imported: the two are
//     told apart only by which file is loaded, and every API difference
//     (main asks `ws.wsGetSpotOnce`, which answers a quote or null; this PR
//     asks `ws.wsProbeSpot`, which says WHY there is no quote) is adapted
//     HERE, from one broker model, never in a test's assertion;
//   · a virtual clock (`deps.now`, `deps.monoNow`, `deps.sleep`, and every
//     mock's latency), advanced event by event, so a 2-hour closure runs in
//     milliseconds and two runs of one scenario are identical;
//   · a ticker with startFastMonitor's own semantics: a pass starts on each
//     tick unless the previous pass is still running, in which case the tick
//     is skipped (fast-monitor.js startFastMonitor, `tickRunning`).
//
// THE BASELINE IS LOADED FROM A MIRROR. The frozen file's relative imports
// (`../db.js`, `./protection-latency.js`, …) must resolve to the real
// modules, so it is copied into a temporary agent/services/ whose every other
// entry is a symlink back into this tree (Node resolves a symlinked module to
// its real path, so the shared modules are the same instances the branch
// uses). Each run imports a FRESH instance of its implementation (a query
// string on the URL), so the monitor's module-level state — cadence stamps,
// spike windows, decision transitions, probes — never leaks between runs.
// protection-latency.js is shared by both implementations and reset before
// each run; runs are sequential, never interleaved.
// ---------------------------------------------------------------------------

import { readdirSync, symlinkSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtempSync } from './temp-dir.js'
import { initDB, setState, getState } from '../db.js'

const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url))

/** origin/main's fast-monitor.js, frozen: which commit, which blob, where. */
export const BASELINE = Object.freeze({
  commit: '580308e',
  blob: '0b15e092bcac1fd5af42de1409c1fb3e7558697a',
  path: join(AGENT_DIR, 'test-support', 'm7-baseline', 'fast-monitor.main-580308e.js'),
})

export const WORK_KEY = 'fast_monitor_position_work_json'

/** git's blob id of a buffer (sha1 of "blob <len>\0<bytes>"). */
export function gitBlobId(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

let mirror = null
function baselineUrl() {
  if (!mirror) {
    const root = mkdtempSync(join(tmpdir(), 'm7-baseline-'))
    const agent = join(root, 'agent')
    mkdirSync(agent)
    for (const e of readdirSync(AGENT_DIR)) if (e !== 'services') symlinkSync(join(AGENT_DIR, e), join(agent, e))
    const services = join(agent, 'services')
    mkdirSync(services)
    for (const e of readdirSync(join(AGENT_DIR, 'services'))) if (e !== 'fast-monitor.js') symlinkSync(join(AGENT_DIR, 'services', e), join(services, e))
    copyFileSync(BASELINE.path, join(services, 'fast-monitor.js'))
    mirror = pathToFileURL(join(services, 'fast-monitor.js')).href
  }
  return mirror
}

let instance = 0
/** A FRESH module instance of 'main' (the frozen baseline) or 'branch' (the tree under test). */
export async function loadImplementation(which) {
  const url = which === 'main' ? baselineUrl() : new URL('../services/fast-monitor.js', import.meta.url).href
  instance++
  return import(`${url}?sim=${instance}`)
}

// ---------------------------------------------------------------------------
// Virtual time. `sleep` parks a promise until the clock reaches it; the
// driver moves the clock to the next due timer, resolves it and lets every
// continuation it unblocks run before looking again.
// ---------------------------------------------------------------------------
export function makeVirtualTime(startMs) {
  let now = startMs
  let seq = 0
  const timers = []
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)) }
  return {
    now: () => now,
    sleep: (ms) => new Promise(resolve => { timers.push({ at: now + Math.max(0, Number(ms) || 0), seq: seq++, resolve }) }),
    flush,
    nextAt: () => (timers.length ? Math.min(...timers.map(t => t.at)) : null),
    async advanceTo(target) {
      await flush()
      for (;;) {
        let i = -1
        for (let k = 0; k < timers.length; k++) {
          if (timers[k].at <= target && (i < 0 || timers[k].at < timers[i].at || (timers[k].at === timers[i].at && timers[k].seq < timers[i].seq))) i = k
        }
        if (i < 0) break
        const [t] = timers.splice(i, 1)
        now = Math.max(now, t.at)
        t.resolve()
        await flush()
      }
      now = Math.max(now, target)
      await flush()
    },
  }
}

const iso = (ms) => new Date(ms).toISOString()

/**
 * A scenario:
 *   startMs, durationMs, tickMs (3,000)
 *   accountId ('111'), symbolMap {SYMBOL: id}, overrides {SYMBOL: minutes}
 *   positions [{ id, symbol, side, entry, sl, tp, risk, trigger }]  — rowid order is loop order
 *   sidecar(t)          → Map/obj symbolId → {bid, ask}: the sidecar's FRESH table at t
 *   broker(symbolId, t) → what a probe STARTING at t gets (the kind and
 *                         the latency; a quote's PRICE is read again at the
 *                         probe's completion — the first tick is what it
 *                         reports, as a real subscription does):
 *                         { kind: 'quote', bid, ask, latencyMs }
 *                         { kind: 'empty', latencyMs }            subscribed, the symbol printed nothing
 *                         { kind: 'failed', reason, latencyMs }   timeout before subscribing, auth/cTrader error, socket closed
 *   action(pos, eval_, t) → { durationMs, outcome }  (default 250 ms, { summary: 'ok' })
 *   volFetchMs, bars(symbolId) for the relVol fetch (unused when an override pins the cadence)
 *   priorWork: a receipt file to seed (a previous process's), or null
 * `probeWaitMs` (null = what the ticker would give a pass of this tick).
 */
export async function runScenario(which, sc, { probeWaitMs = null } = {}) {
  const impl = await loadImplementation(which)
  const latency = await import('../services/protection-latency.js')
  latency._resetAmendLatencyForTests()
  const tickMs = sc.tickMs ?? 3_000
  const vt = makeVirtualTime(sc.startMs)
  const accountId = sc.accountId ?? '111'
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(accountId)
  setState(db, 'ctrader_account_id', accountId)
  setState(db, 'symbol_id_map', JSON.stringify(sc.symbolMap))
  if (sc.overrides) setState(db, 'monitor_overrides_json', JSON.stringify(sc.overrides))
  const ins = db.prepare(`
    INSERT INTO monitored_positions
      (id, symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, account_id, invalidation_trigger, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'autopilot', 'fib_618_fade', ?, ?, datetime('now'))`)
  for (const p of sc.positions) ins.run(p.id, p.symbol, p.side ?? 'BUY', p.entry, p.sl, p.tp ?? null, p.risk, accountId, p.trigger ?? null)
  if (sc.priorWork) setState(db, WORK_KEY, JSON.stringify(sc.priorWork))

  const obs = { actions: [], probes: [], evaluations: [], checks: [], receipts: [], passes: [], skipped: 0 }
  const creds = { ready: true, host: 'demo.ctraderapi.com', clientId: 'cid', clientSecret: 'cs', accessToken: 'tok', accountId, isLive: false }

  // One broker model, two contracts.
  const priceAt = (symbolId, started) => {
    const o = sc.broker(symbolId, vt.now())
    return o.kind === 'quote' ? o : started // the market at the first tick; the start's price if it went quiet since
  }
  const probe = (api, symbolId) => {
    const at = vt.now()
    const o = sc.broker(Number(symbolId), at)
    obs.probes.push({ at, symbolId: Number(symbolId), api, kind: o.kind })
    return { o, at }
  }
  const ws = {
    // main's contract: a quote, or null for every other outcome.
    wsGetSpotOnce: async (_h, _c, _s, _t, _a, symbolId) => {
      const { o } = probe('wsGetSpotOnce', symbolId)
      await vt.sleep(o.latencyMs)
      if (o.kind !== 'quote') return null
      const p = priceAt(Number(symbolId), o)
      return { bid: p.bid, ask: p.ask }
    },
    // this PR's contract: a quote, or why there is none.
    wsProbeSpot: async (_h, _c, _s, _t, _a, symbolId) => {
      const { o } = probe('wsProbeSpot', symbolId)
      await vt.sleep(o.latencyMs)
      if (o.kind === 'quote') { const p = priceAt(Number(symbolId), o); return { kind: 'quote', bid: p.bid, ask: p.ask } }
      if (o.kind === 'empty') return { kind: 'empty', reason: 'subscribed; no two-sided price before the deadline' }
      return { kind: 'failed', reason: o.reason ?? 'failed' }
    },
    wsGetTrendbarsBatch: async (_h, _c, _s, _t, _a, symbolId) => {
      await vt.sleep(sc.volFetchMs ?? 150)
      return { '1m': sc.bars ? sc.bars(Number(symbolId)) : [] }
    },
  }
  const exec = {
    sidecarQuotes: async () => {
      await vt.sleep(20)
      const t = vt.now()
      const table = sc.sidecar ? sc.sidecar(t) : {}
      const quotes = Object.entries(table).map(([id, q]) => ({ symbolId: Number(id), bid: q.bid, ask: q.ask, tsMs: t - 300, recvMs: t - 300 }))
      return { feed: 'up', generation: 1, accountId, nowMs: t, count: quotes.length, quotes }
    },
  }
  const stmtsFor = new WeakMap()
  const loop = {
    prepareStatements: (d) => {
      if (stmtsFor.has(d)) return stmtsFor.get(d)
      const metrics = d.prepare('UPDATE monitored_positions SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ? WHERE id = ?')
      const check = d.prepare('UPDATE monitored_positions SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ? WHERE id = ?')
      const marks = d.prepare('UPDATE monitored_positions SET time_cap_trail_at = COALESCE(time_cap_trail_at, ?), bank_partial_at = COALESCE(bank_partial_at, ?) WHERE id = ?')
      const s = {
        // Every evaluation writes its metrics first: that write is the observable "evaluated at".
        updatePositionMetrics: { run: (...a) => { obs.evaluations.push({ at: vt.now(), id: Number(a[4]) }); return metrics.run(...a) } },
        updatePositionCheck: { run: (...a) => { obs.checks.push({ at: vt.now(), id: Number(a[4]), action: a[0] }); return check.run(...a) } },
        stampPositionExitMarks: marks,
      }
      stmtsFor.set(d, s)
      return s
    },
    executeBrokerAction: async (d, _s, pos, eval_, source, timing) => {
      const at = vt.now()
      const plan = sc.action ? sc.action(pos, eval_, at) : null
      obs.actions.push({ at, id: pos.id, symbol: pos.symbol, action: eval_.action, reason: eval_.reason, source, timing })
      await vt.sleep(plan?.durationMs ?? 250)
      const outcome = plan?.outcome ?? { summary: 'ok' }
      if (!outcome.error && !outcome.skipped && eval_.action === 'FULL_EXIT') d.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE id = ?`).run(pos.id)
      return outcome
    },
    stampExitMarks: () => false,
  }
  // What startFastMonitor hands a pass: its tick (the branch derives its probe
  // wait and quote age from it; main ignores it). `probeWaitMs` overrides the
  // wait only for the no-wait variant.
  const deps = { now: vt.now, monoNow: vt.now, sleep: vt.sleep, tickMs, quoteMaxAgeMs: 10_000, ws, exec, loop, ...(probeWaitMs == null ? {} : { probeWaitMs }) }

  const prevFrozen = process.env.FROZEN_QUOTE_MIN
  process.env.FROZEN_QUOTE_MIN = '0' // the frozen-quote alert imports telegram-control; out of scope here
  const log = console.log
  console.log = () => {} // the monitors' per-action lines; warnings and errors still print
  const end = sc.startMs + sc.durationMs
  let running = null
  try {
    for (let at = sc.startMs; at <= end; at += tickMs) {
      await vt.advanceTo(at)
      obs.receipts.push({ at: vt.now(), file: readWork(db) })
      if (running) { obs.skipped++; continue }
      const rec = { startedAt: vt.now(), endedAt: null, result: null, error: null }
      obs.passes.push(rec)
      running = Promise.resolve()
        .then(() => impl.runFastMonitor(db, creds, deps))
        .then(r => { rec.result = r }, e => { rec.error = e })
        .finally(() => { rec.endedAt = vt.now(); running = null })
      await vt.flush()
    }
    for (let guard = 0; running && guard < 10_000; guard++) {
      const n = vt.nextAt()
      if (n == null) break
      await vt.advanceTo(n)
    }
  } finally {
    console.log = log
    if (prevFrozen === undefined) delete process.env.FROZEN_QUOTE_MIN
    else process.env.FROZEN_QUOTE_MIN = prevFrozen
  }
  const lat = latency._amendLatencyStateForTests()
  const decisions = db.prepare(`SELECT symbol, decision, reason, detail_json FROM decision_log WHERE stage = 'fast_monitor' ORDER BY id`).all()
  return {
    which, sc, db, obs, lat, decisions, tickMs,
    /** Virtual time of the first FULL_EXIT decision handed to the broker for `id` (null = never). */
    exitAt: (id) => obs.actions.find(a => a.id === id && a.action === 'FULL_EXIT')?.at ?? null,
    evaluationsOf: (id) => obs.evaluations.filter(e => e.id === id).map(e => e.at),
    probesOf: (symbolId) => obs.probes.filter(p => p.symbolId === symbolId),
    /** The receipt file as it stood at virtual time t (the last one written at or before t). */
    workAt: (t) => [...obs.receipts].reverse().find(r => r.at <= t)?.file ?? null,
    iso,
  }
}

function readWork(db) {
  try { return JSON.parse(getState(db, WORK_KEY) || 'null') } catch { return null }
}

/** Read the frozen baseline back — for the pin test. */
export function readBaseline() { return readFileSync(BASELINE.path) }
