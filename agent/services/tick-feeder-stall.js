// ---------------------------------------------------------------------------
// agent/services/tick-feeder-stall.js — V3 F4: an alarm when the tick permit
// feeder stalls (#1099 fix-round nit 2).
//
// THE GAP. The feeder (heartbeat.js feedTickPermits) runs on the fast
// monitor's cpp_probe, and only when the side's /health carries a tick block.
// When it stops — the probe fails, the sidecar stops reporting its tick
// recorder, the pass throws — it simply goes quiet: its receipt
// (tick_entry_work_json) ages past six minutes and stops being evidence, the
// tick entry_activity items leave the watchdog inventory, and cpp-verify
// retires any open no_orders incident on them. An account that admits tick
// then places nothing and nothing says so (failure mode #3).
//
// THE CHECK. Every cpp_probe, AFTER the sides were probed (so a pass that ran
// this probe is already on record), each side's tick-admitting accounts are
// set beside that side's latest receipt:
//   idle        no account on the side admits tick — nothing to feed
//   ok          a complete pass within STALL_AFTER_MS
//   incomplete  the latest pass pushed nothing, failed, or carried no symbol
//   stalled     no pass on record, or none within STALL_AFTER_MS, while an
//               account admits tick
// The verdict is the `tick_feeder` heartbeat (ok only when no side is
// stalled or incomplete; the reason in last_error, the per-side table in
// the beat's detail) and a finding in the log inspector. No Telegram: the
// registry marks `tick_feeder` quiet, so the watchdog records its stall and
// failure events in action_log without sending them (delivery is OD-10's).
//
// Observation only: nothing here pushes, pauses or changes a permit.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'
import { TICK_ENTRY_WORK_KEY, TICK_FEED_CADENCE_MS } from './tick-entry-work.js'

// Two missed cadences: the check runs right after the feeder in the same
// probe, so a working feeder reads ~0 s; one late probe is not a stall. The
// comparison is `>=`: with probes exactly one cadence apart the second missed
// pass reads exactly 240 s, and that is the stall (a `>` put the first
// `stalled` on the third missed probe, ~360 s — W1.7 checker nit).
export const STALL_AFTER_MS = 2 * TICK_FEED_CADENCE_MS
export const TICK_FEEDER_CHECK_KEY = 'tick_feeder_check_json'

/** Every side's receipt as stored, fresh or not (the stall IS an old one). */
export function tickEntryReceiptsRaw(db) {
  try {
    const v = JSON.parse(getState(db, TICK_ENTRY_WORK_KEY) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

/**
 * Pure. `sides`: [{ name, accounts }] with the side's tick-admitting account
 * ids; `receipts`: side name → receipt. Returns the verdict the heartbeat and
 * the inspector read.
 */
export function judgeTickFeed({ sides, receipts, nowMs }) {
  const out = []
  for (const s of Array.isArray(sides) ? sides : []) {
    const name = String(s?.name || 'exec')
    const accounts = (Array.isArray(s?.accounts) ? s.accounts : []).map(String)
    const r = receipts?.[name]
    const completedAt = Number.isSafeInteger(r?.completedAt) ? r.completedAt : null
    const ageMs = completedAt == null ? null : nowMs - completedAt
    const row = { side: name, accounts: accounts.length, accountIds: accounts.slice(0, 16), lastPassAt: completedAt == null ? null : new Date(completedAt).toISOString(), ageSec: ageMs == null ? null : Math.round(ageMs / 1000) }
    if (!accounts.length) out.push({ ...row, state: 'idle', reason: 'no account on this side admits tick' })
    else if (completedAt == null) out.push({ ...row, state: 'stalled', reason: `no feeder pass on record while ${accounts.length} account(s) admit tick` })
    else if (ageMs >= STALL_AFTER_MS) out.push({ ...row, state: 'stalled', reason: `last feeder pass ${Math.round(ageMs / 1000)} s ago (one every ${TICK_FEED_CADENCE_MS / 1000} s expected) while ${accounts.length} account(s) admit tick` })
    else if (r.complete !== true) out.push({ ...row, state: 'incomplete', reason: `latest feeder pass incomplete: ${r.error || r.reason || (r.pushed ? 'not complete' : 'nothing pushed')}` })
    else out.push({ ...row, state: 'ok', reason: null })
  }
  const bad = out.filter(x => x.state === 'stalled' || x.state === 'incomplete')
  const state = out.some(x => x.state === 'stalled') ? 'stalled'
    : bad.length ? 'incomplete'
      : out.some(x => x.state === 'ok') ? 'ok' : 'idle'
  return {
    at: new Date(nowMs).toISOString(), state, ok: bad.length === 0,
    error: bad.length ? bad.map(x => `${x.side}: ${x.reason}`).join(' · ') : null,
    stallAfterSec: STALL_AFTER_MS / 1000, sides: out,
  }
}

/** The last verdict recordTickFeederCheck stored, or null. */
export function readTickFeederCheck(db) {
  try {
    const v = JSON.parse(getState(db, TICK_FEEDER_CHECK_KEY) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

export function recordTickFeederCheck(db, verdict) {
  try { setState(db, TICK_FEEDER_CHECK_KEY, JSON.stringify(verdict)) } catch { /* observation only */ }
}

/**
 * The heartbeat registry's `dormantWhen`: dormant only while the last check
 * — no older than the stall window plus one cadence — found no side with an
 * account that admits tick. A stale or unreadable check is not dormancy.
 */
export function tickFeederDormantReason(db, { nowMs = Date.now() } = {}) {
  try {
    const v = JSON.parse(getState(db, TICK_FEEDER_CHECK_KEY) || 'null')
    const at = Date.parse(v?.at || '')
    if (v?.state !== 'idle' || !Number.isFinite(at) || nowMs - at > STALL_AFTER_MS + TICK_FEED_CADENCE_MS) return null
    return 'no enabled account admits tick (every account is bar-only or stopped) — the tick permit feeder has nothing to push'
  } catch { return null }
}
