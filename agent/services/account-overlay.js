// account-overlay — the one way a per-account setting is stored in this repo.
//
// Owner, 04-08-2026: "i try to change the setup for different account but it
// didn't work." Most protection settings had no per-account dimension at all:
// one global JSON key, written by a page sitting under an account selector.
//
// risk-config already had the right pattern and the stage matrix now uses it
// too. Rather than write it a fourth, fifth and sixth time for the loss cap,
// the profit ratchet and the Loss Guardian, it lives here:
//
//     global key          <base>                 e.g. loss_cap_json
//     per-account key     acct:<id>:<base>       e.g. acct:5203012:loss_cap_json
//
// THE OVERLAY IS PARTIAL, and that is the whole point. Only the fields an
// account actually saved are in it; everything else keeps following the global
// value, so changing a shared default still reaches every account that never
// diverged. An account with no overlay is byte-identical to the behaviour
// before overlays existed.
//
// A corrupt overlay is IGNORED, not treated as empty config: falling back to
// the global settings is the conservative answer, and "the JSON broke so this
// account now has no loss cap" is the answer that loses money.
import { getState } from '../db.js'

export const acctStateKey = (accountId, baseKey) => `acct:${accountId}:${baseKey}`

function parse(db, key) {
  try {
    const v = JSON.parse(getState(db, key) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

/**
 * defaults ← global ← this account's overlay.
 *
 * @param {object} defaults   shipped defaults, always the floor
 * @param {string} baseKey    the global state key, e.g. 'loss_cap_json'
 * @param {string|number|null} accountId  null = the global config itself
 */
export function loadWithOverlay(db, defaults, baseKey, accountId = null) {
  const global = parse(db, baseKey) || {}
  const merged = { ...defaults, ...global }
  if (accountId == null) return merged
  const overlay = parse(db, acctStateKey(accountId, baseKey))
  return overlay ? { ...merged, ...overlay } : merged
}

/**
 * Merge a patch into the right store and return what that scope now reads.
 * With an accountId ONLY the account's overlay moves — the global config and
 * every other account are untouched, which is the property the owner was
 * missing.
 *
 * @returns {{next: object, key: string, overlayKeys: string[]}}
 */
export function saveWithOverlay(db, setState, { defaults, baseKey, accountId = null, patch }) {
  const key = accountId == null ? baseKey : acctStateKey(accountId, baseKey)
  const cur = parse(db, key) || {}
  const stored = { ...cur, ...(patch || {}) }
  setState(db, key, JSON.stringify(stored))
  return {
    next: loadWithOverlay(db, defaults, baseKey, accountId),
    key,
    overlayKeys: accountId == null ? [] : Object.keys(stored),
  }
}

/** Which fields this account has pinned — so the UI can never hide an override. */
export function overlayKeys(db, baseKey, accountId) {
  if (accountId == null) return []
  return Object.keys(parse(db, acctStateKey(accountId, baseKey)) || {})
}

/** Drop an account's overlay entirely: back to following the global config. */
export function clearOverlay(db, setState, baseKey, accountId) {
  if (accountId == null) return false
  setState(db, acctStateKey(accountId, baseKey), null)
  return true
}
