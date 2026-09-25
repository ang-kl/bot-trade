// ---------------------------------------------------------------------------
// agent/services/tick-entry-work.js — V3 C4 (SEQUENCE PR-4, WP-B B2 + WP-C
// PR-C1): the tick permit feeder's work receipt.
//
// The bar scan publishes `legacy_scanner_work_json` (scanner-work.js
// recordScannerWork) and the watchdog judges no_orders from it. The tick side
// had nothing: an account that admits only tick, or whose bar scan is off or
// stale, got no entry_activity item and so no no_orders incident, and a
// sidecar `no_permit` refusal had no recorded reason on the Node side.
//
// ONE receipt per side, written by the pass that did the work
// (heartbeat.js feedTickPermits after runTickPermitFeeder), not by a Node
// timer — a timer is not evidence that the feeder ran. It carries FULL
// account ids (the feeder's own result masks them to …1234 for logs), the
// symbols the pass carried, and each account's outcome: permits pushed,
// the pause reason, the first refusal and a bounded refusal list.
//
// Readers (all read-only, all through tickEntryReceipts):
//   - scanner-work.js scannerWork: tick entry_activity items;
//   - watchdog-calendar-refresh.js watchdogCalendarDemand: each tick
//     account's own (account, symbolId) calendars;
//   - blocker-report.js tickEntryEvaluation: "evaluated" only when a fresh
//     pushed receipt lists the account.
//
// The feeder itself runs on the fast monitor's cpp_probe (every 120 s), not on
// the bar scan. Two parts of the tick path still ride the LOOP timer and are
// named here, not changed: the entry drain (loop.js drainEntryOrdersPass)
// settles QUIESCING → RECONCILING → STABLE, and tickEntryAccountsFor requires
// STABLE, so a stalled loop leaves a tick switch unsettled; and
// expireStale / reconcileIntents settle tick intents in the loop's
// reconcile branch, and the no_orders evidence counts intent states.
//
// A receipt older than TICK_RECEIPT_MAX_AGE_MS is not evidence. The feeder's
// memory of its last push is in-process (heartbeat.js lastTickEntryPush), so
// after a restart with no tick account nothing would ever overwrite an old
// receipt — the age rule retires it, and feedTickPermits deletes the side's
// receipt as soon as no account on the side admits tick.
// ---------------------------------------------------------------------------
import { getState, setState } from '../db.js'

export const TICK_ENTRY_WORK_KEY = 'tick_entry_work_json'
// The cpp_probe cadence (fast-monitor.js due('cpp_probe', 120)).
export const TICK_FEED_CADENCE_MS = 120_000
// The same freshness rule the calendar demand applies to the bar receipt
// (watchdog-calendar-refresh.js: now - completedAt < 360 s).
export const TICK_RECEIPT_MAX_AGE_MS = 360_000
export const MAX_RECEIPT_ACCOUNTS = 64
export const MAX_RECEIPT_SYMBOLS = 512
const MAX_REFUSALS_PER_ACCOUNT = 16

function readAll(db) {
  try {
    const v = JSON.parse(getState(db, TICK_ENTRY_WORK_KEY) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

const clip = (value, n = 200) => value == null ? null : String(value).slice(0, n)

/**
 * Write the side's receipt from one feeder pass. `accounts` are the FULL ids
 * the pass was asked to serve (tickEntryAccountsFor); `result` is what
 * runTickPermitFeeder returned. Other sides' receipts are kept.
 */
export function recordTickEntryWork(db, { side, creds, accounts, result, completedAt, cadenceMs = TICK_FEED_CADENCE_MS }) {
  const name = String(side?.name || 'exec')
  const ids = (Array.isArray(accounts) ? accounts : []).map(String)
  const byId = new Map((Array.isArray(result?.work) ? result.work : []).map(w => [String(w.accountId), w]))
  const symbols = (Array.isArray(result?.carried) ? result.carried : []).map(String)
  const error = result?.error ? clip(result.error) : null
  const receipt = {
    side: name, completedAt, nextDue: completedAt + cadenceMs,
    // A pass that pushed nothing, failed, carried no symbol or was truncated
    // is not a completed pass: its accounts read activityComplete false and
    // ordersSinceOpen null, never an observed zero.
    complete: creds?.ready === true && result?.pushed === true && !error
      && symbols.length > 0 && symbols.length <= MAX_RECEIPT_SYMBOLS && ids.length <= MAX_RECEIPT_ACCOUNTS,
    pushed: result?.pushed === true,
    error,
    reason: result?.reason ? clip(result.reason) : symbols.length ? null : 'no_symbol_carried',
    symbols: symbols.slice(0, MAX_RECEIPT_SYMBOLS),
    accounts: ids.slice(0, MAX_RECEIPT_ACCOUNTS).map(accountId => {
      const w = byId.get(accountId)
      const refused = Array.isArray(w?.refused) ? w.refused : []
      return {
        accountId,
        // false: the pass returned before reaching the account (no_creds).
        reached: !!w,
        permits: Number.isSafeInteger(w?.permits) ? w.permits : 0,
        paused: w?.paused ? clip(w.paused) : null,
        firstRefusal: w?.firstRefusal ? clip(w.firstRefusal) : null,
        refused: refused.slice(0, MAX_REFUSALS_PER_ACCOUNT).map(x => ({ symbol: clip(x?.symbol, 32), side: x?.side ? clip(x.side, 4) : null, reason: clip(x?.reason) })),
        refusedCount: refused.length,
        budget: w?.budget && typeof w.budget === 'object' ? w.budget : null,
      }
    }),
  }
  const all = readAll(db)
  all[name] = receipt
  setState(db, TICK_ENTRY_WORK_KEY, JSON.stringify(all))
  return receipt
}

/** Delete the side's receipt (no account on the side admits tick). Writes only when one exists. */
export function clearTickEntryWork(db, sideName) {
  const all = readAll(db)
  if (!Object.prototype.hasOwnProperty.call(all, sideName)) return false
  delete all[sideName]
  setState(db, TICK_ENTRY_WORK_KEY, JSON.stringify(all))
  return true
}

/**
 * The valid, fresh side receipts, newest first. Read-only. Valid: safe-integer
 * times, completedAt ≤ now and younger than TICK_RECEIPT_MAX_AGE_MS, bounded
 * arrays. Anything else is not tick work evidence.
 */
export function tickEntryReceipts(db, now, { maxAgeMs = TICK_RECEIPT_MAX_AGE_MS } = {}) {
  const out = []
  for (const [side, r] of Object.entries(readAll(db))) {
    if (!r || typeof r !== 'object') continue
    if (!Number.isSafeInteger(r.completedAt) || !Number.isSafeInteger(r.nextDue) || r.completedAt > now || now - r.completedAt >= maxAgeMs) continue
    if (!Array.isArray(r.symbols) || r.symbols.length > MAX_RECEIPT_SYMBOLS || !Array.isArray(r.accounts) || r.accounts.length > MAX_RECEIPT_ACCOUNTS) continue
    out.push({ ...r, side: String(r.side || side) })
  }
  return out.sort((a, b) => b.completedAt - a.completedAt)
}
