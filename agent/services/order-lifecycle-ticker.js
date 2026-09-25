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
// ---------------------------------------------------------------------------

import { setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { readOrderLifecycle } from './performance-populations.js'
import { compactSnapshot, SNAPSHOT_KEY, SNAPSHOT_OPTIONS, TICK_MS } from './order-lifecycle.js'

/** One pass. Never throws: the result carries ok / error, and the heartbeat records it. */
export async function runOrderLifecyclePass(db, { read = readOrderLifecycle, heartbeat = null } = {}) {
  const hb = heartbeat ?? await import('./heartbeat.js')
  try {
    const report = await read(db, SNAPSHOT_OPTIONS)
    const snap = compactSnapshot(report)
    const json = JSON.stringify(snap)
    setState(db, SNAPSHOT_KEY, json)
    // The snapshot is written out-of-band from any route; the /state cache
    // only clears on a write it saw (daily-report.js does the same).
    invalidateStateCache()
    const counts = Object.fromEntries(Object.entries(snap.summary).map(([k, v]) => [k, { new: v.new, legacy: v.legacy }]))
    hb.beat(db, 'order_lifecycle', { ok: true, detail: { at: snap.at, bytes: json.length, samplesPerRule: snap.samplesPerRule, summary: counts } })
    return { ok: true, at: snap.at, bytes: json.length }
  } catch (err) {
    const error = err?.reason && err.reason !== err.message ? `${err.reason}: ${err.message}` : String(err?.message || err)
    try { hb.beat(db, 'order_lifecycle', { ok: false, error }) } catch { /* the result still carries the error */ }
    return { ok: false, error }
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
