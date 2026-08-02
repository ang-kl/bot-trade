// A6 — one setting, two levels: the account's own, or the shared default.
//
// docs/per-account-control-plan.md §5.1:
//
//   "Do NOT fork every setting per account — seven accounts × ~40 settings is
//    a configuration surface nobody can keep coherent. Instead a two-level
//    resolver:
//
//      settingFor(accountId, key) → acct:<id>:<key>  if present
//                                 → <key>            otherwise
//
//    So an account inherits your house rules until you deliberately override
//    one, and the UI can show 'inherited' vs 'overridden for this account'
//    with a one-tap revert. That is the difference between per-account
//    settings that stay maintainable and seven drifting copies."
//
// The `acct:<id>:<key>` convention already exists (account-registry.acctKey)
// and exactly two keys used it — account_balance_usd and account_leverage.
// This generalises it WITHOUT generalising the mess.
//
// ===========================================================================
// AN ALLOWLIST, NOT A FREE-FOR-ALL
// ===========================================================================
// The plan leaves "which settings should be overridable" open and answers it
// partially: risk sizing and the protection layers clearly yes, the symbol
// universe probably, LLM/provider settings almost certainly not. That is
// implemented as an ALLOWLIST rather than a denylist, and the direction
// matters: a new setting added next month is NOT silently overridable, so the
// per-account surface can only grow by someone deciding it should. A denylist
// would grow it by default and nobody would notice.
//
// Two categories are deliberately excluded and the reason is not taste:
//
//   process-level      LLM provider/model, poll cadences, token budgets. These
//                      belong to the PROCESS, not an account. Forking them per
//                      account would create settings that cannot take effect —
//                      there is one loop and one LLM client.
//   safety-invariant   the global guards. 5A exists precisely so a portfolio
//                      limit cannot be evaded per account; making it
//                      overridable would hand back what that layer took.
//
// ===========================================================================
// WHAT "INHERITED" MEANS, EXACTLY
// ===========================================================================
// Inherited means THE SHARED VALUE APPLIES AND WILL KEEP APPLYING — including
// when you later change the shared one. That is the property that makes this
// maintainable and it is also the property that surprises people, so the view
// says `inherited` explicitly rather than just showing the value. An account
// showing 1.5% because it inherited it and an account showing 1.5% because
// someone pinned it there are different states, and only one of them follows
// you when you change your mind.
import { getState, setState } from '../db.js'
import { acctKey } from './account-registry.js'

/**
 * Overridable settings, grouped as the plan groups them. Each entry names the
 * agent_state key and what it is, so the UI needs no parallel label table.
 */
export const OVERRIDABLE = {
  risk: {
    label: 'Risk sizing',
    keys: {
      risk_config_json: 'Per-trade risk, caps, sizing rules',
    },
  },
  protection: {
    label: 'Position protection',
    keys: {
      profit_keeper_json: 'Profit keeper — trail and bank rules',
      loss_guard_json: 'Loss guardian — protective stop and time cap',
      loss_cap_json: 'Absolute dollar loss cap per position',
      ratchet_json: 'Profit ratchet staircase',
    },
  },
  universe: {
    label: 'Symbol universe',
    keys: {
      autopilot_symbols_json: 'The watchlist this account trades',
    },
  },
}

/** Flat key → { category, label } for lookups. */
export const OVERRIDABLE_KEYS = Object.entries(OVERRIDABLE).reduce((acc, [cat, group]) => {
  for (const [key, label] of Object.entries(group.keys)) acc[key] = { category: cat, label }
  return acc
}, {})

/**
 * Explicitly NOT overridable, with the reason. Returned by the API so a
 * refusal explains itself rather than looking like an omission.
 */
export const NOT_OVERRIDABLE = {
  global_guards_json: 'a portfolio-level safety limit — 5A exists so it cannot be evaded per account',
  llm_provider: 'a process-level setting: there is one LLM client, not one per account',
  loop_interval_min: 'a process-level setting: there is one loop, not one per account',
  daily_token_budget: 'a process cost, shared by every account',
}

export function isOverridable(key) {
  return Object.prototype.hasOwnProperty.call(OVERRIDABLE_KEYS, String(key))
}

/**
 * Resolve one setting for one account.
 *
 * @returns {{key, accountId, value: string|null, source: 'account'|'shared'|'unset',
 *            sharedValue: string|null, overridable: boolean}}
 *   `value` is the raw agent_state string — callers parse it exactly as they
 *   do today, so adopting the resolver changes no parsing.
 */
export function settingFor(db, accountId, key) {
  const k = String(key)
  const shared = safeGet(db, k)
  const id = accountId == null || accountId === '' || accountId === 'all' ? null : String(accountId)
  if (id) {
    const own = safeGet(db, acctKey(id, k))
    // An override that exists but is an empty string is still an override —
    // "this account deliberately has nothing here" is a real state, and
    // treating it as absent would silently re-inherit the shared value.
    if (own != null) {
      return { key: k, accountId: id, value: own, source: 'account', sharedValue: shared, overridable: isOverridable(k) }
    }
  }
  return {
    key: k,
    accountId: id,
    value: shared,
    source: shared == null ? 'unset' : 'shared',
    sharedValue: shared,
    overridable: isOverridable(k),
  }
}

/**
 * Pin a setting to this account. Refuses keys outside the allowlist, with the
 * stated reason when there is one — a bare "no" on a setting the operator can
 * see in the UI is the kind of refusal that gets worked around.
 */
export function setOverride(db, accountId, key, value) {
  const k = String(key)
  const id = accountId == null ? '' : String(accountId)
  if (!id) return { ok: false, error: 'setOverride needs an accountId' }
  if (!isOverridable(k)) {
    const why = NOT_OVERRIDABLE[k]
    return {
      ok: false,
      error: why
        ? `${k} is not overridable per account: ${why}`
        : `${k} is not in the per-account allowlist — settings become overridable by decision, not by default`,
    }
  }
  setState(db, acctKey(id, k), value == null ? '' : String(value))
  return { ok: true, accountId: id, key: k, source: 'account' }
}

/**
 * Revert to inheritance — the one-tap the plan asks for.
 *
 * Deletes the account row rather than copying the shared value into it. The
 * difference is the whole point: a copy would freeze today's shared value and
 * stop following later changes, which is the drift this design exists to
 * avoid. Reverting means "follow the house rule again", not "match it once".
 */
export function clearOverride(db, accountId, key) {
  const k = String(key)
  const id = String(accountId)
  try {
    db.prepare('DELETE FROM agent_state WHERE key = ?').run(acctKey(id, k))
  } catch {
    // Older stores without a delete path: write empty and report honestly
    // that inheritance could not be restored, rather than claiming it was.
    return { ok: false, error: 'could not delete the override row' }
  }
  return { ok: true, accountId: id, key: k, source: 'shared' }
}

/**
 * Every overridable setting for one account: what applies, where it came
 * from, and what the shared value is.
 *
 * `differs` is computed rather than assumed: an override whose value happens
 * to equal the shared one is still an OVERRIDE (it will not follow a later
 * change), and the UI needs to say so instead of rendering it as inherited.
 */
export function overrideView(db, accountId) {
  const id = accountId == null ? null : String(accountId)
  const groups = Object.entries(OVERRIDABLE).map(([category, group]) => ({
    category,
    label: group.label,
    settings: Object.entries(group.keys).map(([key, label]) => {
      const r = settingFor(db, id, key)
      return {
        key,
        label,
        source: r.source,
        overridden: r.source === 'account',
        // Present/absent rather than the values themselves: these are whole
        // JSON configs, and dumping them into a list view would bury the one
        // fact the view is for.
        hasValue: r.value != null && r.value !== '',
        hasShared: r.sharedValue != null && r.sharedValue !== '',
        differs: r.source === 'account' && r.value !== r.sharedValue,
      }
    }),
  }))
  return {
    accountId: id,
    groups,
    overriddenCount: groups.reduce((n, g) => n + g.settings.filter(s => s.overridden).length, 0),
    notOverridable: Object.entries(NOT_OVERRIDABLE).map(([key, why]) => ({ key, why })),
  }
}

function safeGet(db, key) {
  try {
    const v = getState(db, key)
    return v == null ? null : v
  } catch { return null }
}
