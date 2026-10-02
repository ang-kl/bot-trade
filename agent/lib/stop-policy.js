// ---------------------------------------------------------------------------
// agent/lib/stop-policy.js — what stop-loss protection the bot asks the broker
// for (owner, 02-10-2026: "Opposite for stop-loss and broker-side trailing";
// decision: trailing turns on once the stop locks profit).
//
// Two cTrader fields ride on the amend that sets a position's stop:
//   · stopLossTriggerMethod — OPPOSITE (2): a long's stop fires on the ask, so
//     a spread blowout or a single wick on the bid side does not sweep it
//     (the spike concern the owner raised on 24-07-2026; order-protection.js
//     has the enum and carried it on new orders until the key was retired).
//   · trailingStopLoss — the broker trails the stop server-side, so it keeps
//     trailing through a bot or sidecar outage.
//
// WHY THIS IS A MODULE AND NOT A CONSTANT IN EACH CALLER. cTrader's amend
// REPLACES a position's protection; every one of the dozen amend sites that
// sends stopLoss and takeProfit would, if it ignored these fields, risk
// resetting them (whether an omitted flag is preserved or reset is NOT
// documented — only guaranteedStopLoss says it is preserved). So the policy is
// stamped at the one chokepoint every amend passes (exec-engine.amendPosition),
// from one place, and callers only say what the stop MEANS (side, entry, book).
//
// The new-order stopTriggerMethod is for pending STOP orders only: a position's
// stop-loss trigger can only be set by an amend after the position exists, so
// a desired-state controller stamps new positions (PR-2); this module is the
// shared vocabulary for both.
//
// Pure: no db import. The persisted copy lives at agent_state.stop_policy_json
// and is loaded once at boot and on every config change (setStopPolicy).
// ---------------------------------------------------------------------------
import { STOP_TRIGGER_METHODS } from './order-protection.js'

export const POLICY_KEY = 'stop_policy_json'
export const TRAILING_MODES = Object.freeze(['on_lock', 'off'])
export const TRIGGER_ENCODINGS = Object.freeze(['number', 'name'])

export const DEFAULT_STOP_POLICY = Object.freeze({
  enabled: true,
  triggerMethod: 'OPPOSITE',
  trailing: 'on_lock',
  // The JSON wire accepts enum numbers and names; the broker's own replies
  // emit numbers. Neither form of THIS field has production history, so the
  // choice is a config value, not a code edit, if the broker disagrees.
  encoding: 'number',
})

const TRIGGER_NAMES = Object.keys(STOP_TRIGGER_METHODS)

function triggerName(v) {
  if (typeof v === 'number') return TRIGGER_NAMES.find(n => STOP_TRIGGER_METHODS[n] === v) ?? null
  const up = String(v ?? '').trim().toUpperCase()
  return TRIGGER_NAMES.includes(up) ? up : null
}

/** A trigger method as the NAME, or null when it is not one (the strict form routes use: no silent fallback). */
export function parseTriggerMethod(v) { return triggerName(v) }

/** Any stored/posted shape → a complete, valid policy. Unknown keys dropped; invalid values fall back to the default. */
export function normaliseStopPolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return Object.freeze({
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_STOP_POLICY.enabled,
    triggerMethod: triggerName(r.triggerMethod) ?? DEFAULT_STOP_POLICY.triggerMethod,
    trailing: TRAILING_MODES.includes(r.trailing) ? r.trailing : DEFAULT_STOP_POLICY.trailing,
    encoding: TRIGGER_ENCODINGS.includes(r.encoding) ? r.encoding : DEFAULT_STOP_POLICY.encoding,
  })
}

let current = normaliseStopPolicy(null)

export function getStopPolicy() { return current }

export function setStopPolicy(raw) {
  current = normaliseStopPolicy(raw)
  return current
}

/** Read the stored policy with db.js's getState and make it the live one. Unreadable → defaults (policy ON, as ordered). */
export function loadStopPolicy(db, read) {
  let stored = null
  try { stored = JSON.parse(read(db, POLICY_KEY) || 'null') } catch { stored = null }
  return setStopPolicy(stored)
}

/** The enum as the number 1..4. */
export function triggerValue(policy = current) {
  return STOP_TRIGGER_METHODS[policy.triggerMethod] ?? STOP_TRIGGER_METHODS.OPPOSITE
}

/** The enum as it goes on the wire: the number, or the name when the policy says so. */
export function triggerWire(policy = current) {
  return policy.encoding === 'name' ? policy.triggerMethod : triggerValue(policy)
}

/** BUY/LONG/1 → 1, SELL/SHORT/-1 → -1, anything else → 0. */
export function sideDirection(side) {
  if (side === 1 || side === -1) return side
  const s = String(side ?? '').trim().toUpperCase()
  if (s === 'BUY' || s === 'LONG') return 1
  if (s === 'SELL' || s === 'SHORT') return -1
  return 0
}

/**
 * Does this stop lock profit — sit at or past the entry on the profit side?
 * (Owner decision 02-10-2026: broker trailing starts once the stop does.)
 * False on any missing or non-positive input: unknown is not "locked".
 */
export function locksProfit(side, entry, stop) {
  const dir = sideDirection(side)
  const e = Number(entry)
  const s = Number(stop)
  if (!dir || !(e > 0) || !(s > 0)) return false
  return dir === 1 ? s >= e : s <= e
}

/**
 * The policy fields for one stop: always the trigger method; the trailing flag
 * only when trailing is on_lock, the row is not a momentum-book row (its own
 * daily 3×ATR trail is its only stop authority — one-horizon rule) and the
 * stop locks profit. The bot never sends trailingStopLoss:false: it never turns
 * a trailing stop OFF (a hand-set trailing flag is not ours to clear).
 */
export function policyFields({ policy = current, side, entry, stop, book = false } = {}) {
  if (!policy.enabled) return {}
  const out = { stopLossTriggerMethod: triggerWire(policy) }
  if (policy.trailing === 'on_lock' && !book && locksProfit(side, entry, stop)) out.trailingStopLoss = true
  return out
}

/**
 * The amend chokepoint's use of the policy. `args` is an amend argument object;
 * `stopContext` ({side, entry, book}) and `noStopPolicy` are instructions to
 * THIS function and never reach the wire. Explicit fields already on the args
 * win (the controller's own stamp passes its own). An amend that sends no stop
 * (target-only) gets nothing: the trigger method is a property of the stop.
 */
export function applyStopPolicyToAmend(args, policy = current) {
  const out = { ...(args && typeof args === 'object' ? args : {}) }
  const ctx = out.stopContext
  const skip = out.noStopPolicy === true
  delete out.stopContext
  delete out.noStopPolicy
  if (skip || !policy.enabled) return out
  if (!(Number(out.stopLoss) > 0) && out.policyOnly !== true) return out
  const fields = policyFields({ policy, side: ctx?.side, entry: ctx?.entry, stop: out.stopLoss, book: ctx?.book === true })
  for (const [k, v] of Object.entries(fields)) if (out[k] === undefined) out[k] = v
  return out
}

/**
 * The /trail-config fragment: the sidecar's TrailEngine stamps it on every
 * amend it sends and computes the lock rule itself from each spec's entryPrice.
 * Absent when the policy is off — /trail-config is full-replace, so an absent
 * block clears it.
 */
export function trailConfigPolicy(policy = current) {
  if (!policy.enabled) return null
  return { stopLossTriggerMethod: triggerWire(policy), trailing: policy.trailing }
}

// ---------------------------------------------------------------------------
// What the policy has done since boot — the first live evidence. In memory and
// bounded: it answers "did the flags go out, did the broker accept them, did
// the sidecar read them back" the minute after a deploy, before any controller
// or database record exists. Counts since `since`; the ring keeps the last 50.
// ---------------------------------------------------------------------------
const RING_MAX = 50
let ring = []
let counts = freshCounts()

function freshCounts() {
  return {
    since: new Date().toISOString(),
    amends: 0, withTrigger: 0, withTrailing: 0, ratchet: 0, unchanged: 0, errors: 0,
    applied: 0, refused: 0, cooldown: 0,
    readback: { confirmed: 0, mismatch: 0, unreadable: 0, unverified: 0, none: 0 },
  }
}

/** Record one amend's policy outcome. `args` is what went to the transport (after stamping); never throws. */
export function noteAmendOutcome({ args, result, error, now = Date.now() } = {}) {
  try {
    counts.amends += 1
    const trigger = args?.stopLossTriggerMethod
    const trailing = args?.trailingStopLoss === true
    if (trigger != null) counts.withTrigger += 1
    if (trailing) counts.withTrailing += 1
    if (args?.ratchetOnly === true) counts.ratchet += 1
    if (error) counts.errors += 1
    if (!error && result?.unchanged === true) counts.unchanged += 1
    const policy = result?.policy && typeof result.policy === 'object' ? result.policy : null
    if (policy) {
      if (policy.applied === true) counts.applied += 1
      if (policy.refused) counts.refused += 1
      if (policy.skipped === 'cooldown') counts.cooldown += 1
      const rb = typeof policy.readback === 'string' && policy.readback in counts.readback ? policy.readback : null
      if (rb) counts.readback[rb] += 1
    }
    if (trigger == null && !trailing && !policy) return
    ring.push({
      at: new Date(now).toISOString(),
      accountId: args?.ctidTraderAccountId != null ? `…${String(args.ctidTraderAccountId).slice(-4)}` : null,
      positionId: args?.positionId ?? null,
      requested: { stopLossTriggerMethod: trigger ?? null, trailingStopLoss: trailing ? true : null },
      ratchet: args?.ratchetOnly === true,
      unchanged: result?.unchanged === true,
      policy: policy ? { applied: policy.applied === true, readback: policy.readback ?? null, refused: !!policy.refused, skipped: policy.skipped ?? null } : null,
      error: error ? String(error?.message || error).slice(0, 200) : null,
    })
    if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX)
  } catch { /* evidence only — never blocks an amend */ }
}

export function stopPolicyStats() {
  return { counts: { ...counts, readback: { ...counts.readback } }, recent: [...ring].reverse() }
}

export function resetStopPolicyStats() {
  ring = []
  counts = freshCounts()
}

