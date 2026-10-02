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
  // A policyOnly amend carries no stop of its own (the sidecar reads the
  // broker's); the caller names the broker's stop in stopContext.stop so the
  // lock rule can still be decided.
  const stopForRule = Number(out.stopLoss) > 0 ? out.stopLoss : ctx?.stop
  const fields = policyFields({ policy, side: ctx?.side, entry: ctx?.entry, stop: stopForRule, book: ctx?.book === true })
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
    const trailingRequested = args?.trailingStopLoss === true
    const trailing = trailingRequested
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
    // The bot's evidence that this position's stop is now trailed by the broker:
    // the flag went out, and the sidecar neither refused it, stripped it, nor read
    // back that the broker is NOT trailing (a mismatch is not evidence of a trail).
    if (trailingRequested && !error && !policy?.refused && policy?.skipped !== 'cooldown' && policy?.readback !== 'mismatch') markTrailing(args?.ctidTraderAccountId, args?.positionId)
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

// ---------------------------------------------------------------------------
// Positions the bot has asked the broker to TRAIL (02-10-2026). A broker-trailed
// stop moves between the bot's reads; the reconciler would otherwise call every
// such move a "manual change" (a TAMPER row, a Telegram alert, a re-strategize).
// The registry is the bot's own evidence that a stop move may be the trail: it
// is only ever the TIGHTENING direction that is adopted quietly, and a position
// not in the registry keeps the old rules. Persisted (agent_state) because a
// restart must not turn every trailing stop back into "tampering".
// ---------------------------------------------------------------------------
export const TRAILING_KEY = 'stop_policy_trailing_json'
const TRAILING_MAX = 500
let trailedPositions = new Map() // `${account}:${positionId}` -> ISO time first requested
let trailingDirty = false

const trailKey = (accountId, positionId) => `${String(accountId)}:${String(positionId)}`

export function markTrailing(accountId, positionId, at = new Date().toISOString()) {
  if (accountId == null || positionId == null) return
  const k = trailKey(accountId, positionId)
  if (trailedPositions.has(k)) return
  trailedPositions.set(k, at)
  if (trailedPositions.size > TRAILING_MAX) trailedPositions = new Map([...trailedPositions].slice(-TRAILING_MAX))
  trailingDirty = true
}

export function isTrailing(accountId, positionId) {
  return accountId != null && positionId != null && trailedPositions.has(trailKey(accountId, positionId))
}

export function loadTrailingRegistry(db, read) {
  let stored = null
  try { stored = JSON.parse(read(db, TRAILING_KEY) || 'null') } catch { stored = null }
  trailedPositions = new Map(Object.entries(stored && typeof stored === 'object' ? stored : {}))
  trailingDirty = false
  return trailedPositions.size
}

/** Persist when something changed. `write` is db.js's setState. Never throws. */
export function saveTrailingRegistry(db, write) {
  if (!trailingDirty) return false
  try { write(db, TRAILING_KEY, JSON.stringify(Object.fromEntries(trailedPositions))); trailingDirty = false; return true } catch { return false }
}

export function resetTrailingRegistry() { trailedPositions = new Map(); trailingDirty = false }

/** The trigger method a verifier's position row reports (number), or null when the broker does not report one. */
export function brokerTrigger(position) {
  const v = position?.stopLossTriggerMethod
  return v == null ? null : Number(v)
}

/** The trailing flag a verifier's position row reports: true, false, or null when not reported. */
export function brokerTrailing(position) {
  return typeof position?.trailingStopLoss === 'boolean' ? position.trailingStopLoss : null
}

/** Did the stop move to the SAFER side (up for a long, down for a short)? False on unknown input. */
export function stopTightened(side, from, to) {
  const dir = sideDirection(side)
  const a = Number(from)
  const b = Number(to)
  if (!dir || !(a > 0) || !(b > 0)) return false
  return dir === 1 ? b > a : b < a
}

export function stopPolicyStats() {
  return { counts: { ...counts, readback: { ...counts.readback } }, recent: [...ring].reverse() }
}

export function resetStopPolicyStats() {
  ring = []
  counts = freshCounts()
}

