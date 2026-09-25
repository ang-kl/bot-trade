// ---------------------------------------------------------------------------
// agent/services/order-lifecycle-ticker.js — the order_lifecycle controller
// (V3 L1). Every 10 minutes it builds the lifecycle report on the read-only
// worker (performance-populations kind 'order-lifecycle'), writes the compact
// snapshot (≤ 64 KB) to agent_state `order_lifecycle_last_json` with ONE
// setState, and beats `order_lifecycle`. The goal rows, the inspector and the
// daily report read that one row; none of them runs a rule.
//
// Its own unref'd timer with a re-entrancy guard, like startMinuteReview
// (minute-review.js), so a stalled main loop does not silence it. The beat is
// about the BUILD: ok when a snapshot was written, ok: false with the error
// when it was not. Violations are not failures of this controller — they
// belong to the goal rows. A failed pass keeps the previous snapshot, whose
// own `at` then ages past the heartbeat's effect limit (never re-stamped).
//
// V3 I3: THE PASS ALSO RESOLVES. Before the snapshot is built, the stuck
// resolver (stuck-resolver.js) settles stuck records from broker evidence or
// writes them off under the owner's rule — on this timer, off the trading
// loop, bounded per pass. It writes on this (management) connection; the
// snapshot that follows reads the result on the worker. A resolver pass that
// fails does NOT withhold the snapshot, but it fails the beat (ok: false,
// "stuck resolver: …"), so a resolver that stopped working is a failing
// controller on /state/heartbeats and in STK-11, never a silent one. Its last
// result is kept at agent_state `stuck_resolver_last_json`; agent_state
// `stuck_resolver_enabled` = 'false' switches it off (said in the beat).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { readOrderLifecycle } from './performance-populations.js'
import { compactSnapshot, SNAPSHOT_KEY, SNAPSHOT_OPTIONS, TICK_MS } from './order-lifecycle.js'
import { runStuckResolver, ENABLED_KEY as RESOLVER_ENABLED_KEY, LAST_KEY as RESOLVER_LAST_KEY } from './stuck-resolver.js'

/** The resolver half of the pass. Never throws: its failure is its result. */
export function runResolverStep(db, resolve = runStuckResolver, nowMs = Date.now()) {
  let result
  try {
    result = getState(db, RESOLVER_ENABLED_KEY) === 'false'
      ? { at: new Date(nowMs).toISOString(), ok: true, skipped: `switched off (agent_state ${RESOLVER_ENABLED_KEY} = 'false')` }
      : resolve(db, { nowMs })
  } catch (err) {
    result = { at: new Date(nowMs).toISOString(), ok: false, error: String(err?.message || err).slice(0, 200) }
  }
  try { setState(db, RESOLVER_LAST_KEY, JSON.stringify(result)) } catch { /* the beat still carries it */ }
  return result
}

/** The resolver's counts and its first error, small enough for the beat. */
function resolverBrief(r) {
  if (!r) return null
  const kinds = ['trades', 'resting', 'captures', 'targetless']
  const counts = Object.fromEntries(kinds.filter(k => r[k] && typeof r[k] === 'object').map(k => [k, Object.fromEntries(Object.entries(r[k]).filter(([, v]) => typeof v === 'number'))]))
  const errors = [r.error, ...kinds.flatMap(k => [r[k]?.error, ...(r[k]?.errors || [])])].filter(Boolean)
  return { ok: r.ok !== false && errors.length === 0, ...(r.skipped ? { skipped: r.skipped } : {}), counts, errors: errors.slice(0, 3) }
}

/** One pass. Never throws: the result carries ok / error, and the heartbeat records it. */
export async function runOrderLifecyclePass(db, { read = readOrderLifecycle, heartbeat = null, resolve = runStuckResolver } = {}) {
  const hb = heartbeat ?? await import('./heartbeat.js')
  const resolver = resolverBrief(runResolverStep(db, resolve))
  try {
    const report = await read(db, SNAPSHOT_OPTIONS)
    const snap = compactSnapshot(report)
    const json = JSON.stringify(snap)
    setState(db, SNAPSHOT_KEY, json)
    // The snapshot is written out-of-band from any route; the /state cache
    // only clears on a write it saw (daily-report.js does the same).
    invalidateStateCache()
    const counts = Object.fromEntries(Object.entries(snap.summary).map(([k, v]) => [k, { new: v.new, legacy: v.legacy }]))
    const detail = { at: snap.at, bytes: json.length, samplesPerRule: snap.samplesPerRule, summary: counts, resolver }
    if (!resolver.ok) {
      const error = `stuck resolver: ${resolver.errors[0] ?? 'failed'}`
      hb.beat(db, 'order_lifecycle', { ok: false, error, detail })
      return { ok: false, error, at: snap.at, bytes: json.length, resolver }
    }
    hb.beat(db, 'order_lifecycle', { ok: true, detail })
    return { ok: true, at: snap.at, bytes: json.length, resolver }
  } catch (err) {
    const error = err?.reason && err.reason !== err.message ? `${err.reason}: ${err.message}` : String(err?.message || err)
    try { hb.beat(db, 'order_lifecycle', { ok: false, error, detail: { resolver } }) } catch { /* the result still carries the error */ }
    return { ok: false, error, resolver }
  }
}

/** Start the ticker: a first pass after `firstMs`, then every `tickMs`. Returns a stop function. */
export function startOrderLifecycle(db, deps = {}) {
  const tickMs = deps.tickMs ?? Math.max(60_000, Number(process.env.ORDER_LIFECYCLE_MS) || TICK_MS)
  const firstMs = deps.firstMs ?? 60_000
  let running = false
  let skipped = 0
  const tick = async () => {
    if (running) {
      skipped++
      if (skipped === 1 || skipped % 20 === 0) console.log(`[order-lifecycle] previous pass still running — skipped ${skipped} tick(s)`)
      return
    }
    running = true
    try {
      const r = await runOrderLifecyclePass(db, deps)
      if (!r.ok) console.error('[order-lifecycle] pass failed:', r.error)
      skipped = 0
    } finally {
      running = false
    }
  }
  const first = setTimeout(tick, firstMs)
  first.unref?.()
  const t = setInterval(tick, tickMs)
  t.unref?.()
  return () => { clearTimeout(first); clearInterval(t) }
}
