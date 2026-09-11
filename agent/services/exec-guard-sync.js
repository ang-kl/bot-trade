// ---------------------------------------------------------------------------
// agent/services/exec-guard-sync.js — declarative convergence of the C++
// order guard (2026-08-31 supervision plan).
//
// THE GAP THIS CLOSES, measured: the sidecar's OrderGuard — the last line of
// defence before an order leaves the process — was pushed by exactly ONE
// caller, the manual POST /actions/exec-guard UI action. No breaker, equity
// stop or portfolio halt ever reached it, so an automated halt in Node bound
// only on the JS risk path; and a sidecar restart reset the guard to compiled
// defaults, silently discarding a stored halt until someone clicked the
// button again.
//
// DECLARATIVE, NOT IMPERATIVE. desiredGuardFor() derives the whole guard from
// durable state on every call; the probe pushes it whenever it differs from
// what the sidecar reports. There is no un-halt event to remember: when the
// FX day rolls over, an equity-stop trip ages out of alreadyTrippedToday, the
// derived haltAccounts set empties, and the next probe converges. The same
// convergence is what restores a stored guard after a sidecar restart.
//
// SCOPES, deliberately (both are settled owner decisions):
// - equity-stop trips are PER-ACCOUNT (owner 30-07: a global disarm for one
//   account's trip is the defect that module removed) → they land in
//   haltAccounts, never in the process-wide halt.
// - the performance breaker is ALERT-ONLY unless the owner arms autoDisarm
//   (owner 30-07, twice-confirmed) → its halt mirror binds only when
//   autoDisarm is armed AND the master autotrade flag is off, i.e. only when
//   the machine was already authorized to stop trading.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { engineStatusFor } from './entry-mode.js'
import { alreadyTrippedToday } from './equity-stop.js'
import { loadGlobalGuards } from './global-guards.js'
import { loadPerformanceBreakerConfig } from './performance-breaker.js'
import { fxDayOpenMs } from '../lib/volume-structure.js'

/**
 * The guard the sidecar SHOULD be running, derived from durable state only.
 * Pure read — no pushes, no writes — so the derivation is testable as a
 * truth table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{isLive: boolean|null}} side  which sidecar (null = single/unsplit)
 * @param {number} [nowMs]
 * @returns {{halt:boolean, requireBracket?:boolean, requireTarget?:boolean,
 *            maxOrderVolume?:number, haltAccounts:number[]}}
 */
export function desiredGuardFor(db, side = { isLive: null }, nowMs = Date.now()) {
  let stored = {}
  try { stored = JSON.parse(getState(db, 'exec_guard_json') || '{}') } catch { stored = {} }

  let halt = stored.halt === true

  // 5A portfolio halt: today it gates only the JS risk path — mirroring it
  // into the cpp guard is what makes it bind on anything that bypasses the
  // JS gates (the VPO tier, a hand-rolled curl).
  try {
    if (loadGlobalGuards(db)?.halt === true) halt = true
  } catch { /* guards unreadable — stored value stands */ }

  // Performance breaker, ONLY when the owner armed autoDisarm: the breaker's
  // authority is the master autotrade flag, so mirror exactly that — armed
  // breaker + master off = the machine stopped trading, and the cpp guard
  // should agree. autoDisarm off (the default, owner order) changes nothing.
  try {
    const pb = loadPerformanceBreakerConfig(db)
    if (pb?.autoDisarm === true && getState(db, 'autotrade_enabled') !== 'true') halt = true
  } catch { /* breaker unreadable — no halt from it */ }

  // Equity-stop trips, per account, self-clearing at the FX-day rollover.
  const haltAccounts = []
  try {
    const dayOpen = fxDayOpenMs(nowMs)
    const rows = db.prepare(
      'SELECT account_id FROM accounts WHERE enabled = 1' +
      (side?.isLive == null ? '' : ' AND is_live = ?')
    ).all(...(side?.isLive == null ? [] : [side.isLive ? 1 : 0]))
    for (const r of rows) {
      if (alreadyTrippedToday(db, String(r.account_id), dayOpen)) {
        haltAccounts.push(Number(r.account_id))
      }
    }
  } catch { /* no accounts table — empty set */ }
  haltAccounts.sort((a, b) => a - b)

  const out = { halt, haltAccounts }
  for (const k of ['requireBracket', 'requireTarget']) {
    if (typeof stored[k] === 'boolean') out[k] = stored[k]
  }
  if (Number.isFinite(Number(stored.maxOrderVolume))) out.maxOrderVolume = Number(stored.maxOrderVolume)
  // P2a (docs/tick-momentum/plan.md §3 step 1, §13): every registry account's
  // current entry epoch, so the sidecar can refuse a permit from an earlier
  // one at ITS send boundary. Full replace, like haltAccounts. An account
  // listed here has its permits REQUIRED by the sidecar — which is why every
  // Node entry path carries one (ctrader-creds.js attachEntryFence).
  try {
    const epochs = {}
    const rows = db.prepare('SELECT account_id FROM accounts' + (side?.isLive == null ? '' : ' WHERE is_live = ?'))
      .all(...(side?.isLive == null ? [] : [side.isLive ? 1 : 0]))
    for (const r of rows) epochs[String(r.account_id)] = engineStatusFor(db, r.account_id).modeEpoch
    out.entryEpochs = epochs
  } catch { /* no accounts table — no epochs pushed, no permits required */ }
  // P3a: the recorder's switch. Recording is ON for a side when any account
  // on it has tick observation RECORD (or SHADOW, once P4 exists) — an
  // operator's declaration per account (POST /actions/tick-observation),
  // never a side effect of deploying the recorder. The symbol NAMES the
  // owner wants carried live on tick_symbols_json; syncExecGuard resolves
  // them to this side's ids (the resolution needs the broker's symbol map,
  // so it is not in this pure derivation).
  out.tickRecord = false
  try {
    const rows = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1' + (side?.isLive == null ? '' : ' AND is_live = ?'))
      .all(...(side?.isLive == null ? [] : [side.isLive ? 1 : 0]))
    for (const r of rows) if (engineStatusFor(db, r.account_id).tickObservation !== 'OFF') { out.tickRecord = true; break }
  } catch { /* no accounts table — recording stays off */ }
  return out
}

/** The owner's tick symbol names (tick_symbols_json), validated. */
export function tickSymbolNames(db) {
  try {
    const arr = JSON.parse(getState(db, 'tick_symbols_json') || '[]')
    return Array.isArray(arr) ? [...new Set(arr.map(s => String(s).trim().toUpperCase()).filter(Boolean))] : []
  } catch { return [] }
}

// Unresolvable names are logged once per (side, name), not per probe.
const unresolvedLogged = new Set()
/** Resolve the tick symbol names to this side's ids (unknown names skipped). */
export async function resolveTickSymbolIds(db, creds, side, { resolveSymbolId = null } = {}) {
  const names = tickSymbolNames(db)
  if (!names.length || !creds?.ready) return []
  const resolve = resolveSymbolId || (await import('../lib/ctrader-creds.js')).resolveSymbolId
  const ids = []
  for (const name of names) {
    try {
      const r = await resolve(db, creds, name)
      const id = Number(r?.id ?? r?.symbolId ?? r) // resolveSymbolId → { id, source }
      if (Number.isFinite(id) && id > 0) ids.push(id)
      else throw new Error('no id')
    } catch (err) {
      const key = `${side?.name || 'exec'}:${name}`
      if (!unresolvedLogged.has(key)) {
        unresolvedLogged.add(key)
        console.warn(`[tick] ${side?.name || 'exec'}: symbol ${name} not resolvable on this side (${err?.message || err}) — not carried`)
      }
    }
  }
  return [...new Set(ids)].sort((a, b) => a - b)
}
export function _resetTickResolveLogForTests() { unresolvedLogged.clear() }

/**
 * Does the sidecar's reported guard snapshot (from GET /health `guard`)
 * differ from the desired one? Only fields the desired guard SETS are
 * compared — an absent stored knob keeps the sidecar's default.
 */
export function guardDiffers(desired, reported) {
  if (!reported || typeof reported !== 'object') return true // unknown → push
  if ((reported.halt === true) !== (desired.halt === true)) return true
  const reportedCount = Number(reported.haltAccountCount)
  if (Number.isFinite(reportedCount) && reportedCount !== desired.haltAccounts.length) return true
  for (const k of ['requireBracket', 'requireTarget']) {
    if (typeof desired[k] === 'boolean' && reported[k] !== desired[k]) return true
  }
  if (desired.maxOrderVolume != null && Number(reported.maxOrderVolume) !== desired.maxOrderVolume) return true
  // P2a: an epoch the sidecar does not hold, or holds at another value, is a
  // difference; an older sidecar that reports none is pushed every time,
  // which is harmless (the push is idempotent).
  if (desired.entryEpochs) {
    const rep = reported.entryEpochs && typeof reported.entryEpochs === 'object' ? reported.entryEpochs : {}
    for (const [id, epoch] of Object.entries(desired.entryEpochs)) if (Number(rep[id]) !== Number(epoch)) return true
    if (Object.keys(rep).length !== Object.keys(desired.entryEpochs).length) return true
  }
  // P3a: compared only against a sidecar that reports a recorder at all — a
  // sidecar without TICK_SPOOL_PATH reports tick:null and is never pushed
  // for it (the push would be a no-op there anyway).
  const tick = reported.tick && typeof reported.tick === 'object' ? reported.tick : null
  if (tick && typeof desired.tickRecord === 'boolean' && typeof tick.recording === 'boolean' && tick.recording !== desired.tickRecord) return true
  if (tick && Array.isArray(desired.tickSymbolIds) && desired.tickSymbolIds.length && Array.isArray(tick.subscribed)) {
    const have = new Set(tick.subscribed.map(Number))
    for (const id of desired.tickSymbolIds) if (!have.has(Number(id))) return true
  }
  return false
}

/**
 * One sync pass for one sidecar: derive, compare, push on diff, audit the
 * push. Called from the heartbeat probe's connected branch — every ~2 min,
 * so convergence (including after a sidecar restart) is bounded by the probe
 * cadence. Never throws.
 *
 * Never throws — but a push that FAILED (the sidecar threw, or answered
 * ok:false) is reported as `error`, because `pushed:false` alone is also the
 * healthy "nothing differed" answer and the two must not read the same.
 *
 * @returns {{pushed: boolean, desired: object, error?: string}}
 */
export async function syncExecGuard(db, exec, side, { reportedGuard = null, creds = null, now = null, reportedTick = null, resolveSymbolId = null } = {}) {
  const desired = desiredGuardFor(db, side, now ?? Date.now())
  try {
    // P3a: the tick symbols ride on the same push, resolved to this side's
    // ids; only asked for when recording is wanted (nothing to carry otherwise).
    if (desired.tickRecord && creds) {
      try { desired.tickSymbolIds = await resolveTickSymbolIds(db, creds, side, { resolveSymbolId }) } catch { desired.tickSymbolIds = [] }
    }
    if (reportedTick && reportedGuard && typeof reportedGuard === 'object' && !('tick' in reportedGuard)) reportedGuard = { ...reportedGuard, tick: reportedTick }
    if (!guardDiffers(desired, reportedGuard)) return { pushed: false, desired }
    if (!exec?.setExecGuard || !creds) return { pushed: false, desired }
    const r = await exec.setExecGuard(creds, desired)
    const pushed = r?.ok !== false
    if (pushed) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('GUARD_SYNC', `/exec-guard/${side?.name || 'exec'}`, JSON.stringify(desired).slice(0, 2000))
      } catch { /* audit best-effort */ }
      return { pushed, desired }
    }
    return { pushed, desired, error: String(r?.error || 'sidecar refused the guard push') }
  } catch (err) {
    return { pushed: false, desired, error: err?.message || String(err) }
  }
}
