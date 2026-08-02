// ---------------------------------------------------------------------------
// agent/services/broker-roster.js — what the BROKER last said this token can
// see, so a registry row that has vanished from it can be told apart from one
// nobody has checked.
//
// THE INCIDENT (owner 02-08-2026): "I select only two account from the CTrader,
// but still shows 5 in the Tune > Pipeline. I am confuse."
//
// There are two account lists in this system and they never reconcile:
//
//   · the BROKER list — whatever GET_ACCOUNTS_BY_TOKEN returns right now.
//     Connect's picker and Accounts > Trading switches render this, so
//     unticking an account in the cTrader app makes its row disappear there.
//   · the REGISTRY (`accounts` table) — insert-or-enrich only. upsertAccount
//     never deletes and never flips `enabled` on an existing row, there is no
//     `DELETE FROM accounts` anywhere in agent/, and nothing re-fetches the
//     broker list on a schedule (only the Accounts and Connect pages do, while
//     open). Tune > Pipeline, Desk's engineering panel, every scope pill and
//     the watchlist compare all read THIS.
//
// So a deselected account vanishes from half the UI and persists in the other
// half — and if it was `enabled = 1`, the loop and the C++ sidecar keep
// targeting it. Worse, the one button that could disable it ("Disconnect")
// lives on a broker-fed surface, so by the time you want it, the row you would
// click is already gone.
//
// The owner's call was explicit: FLAG IT LOUDLY, DO NOT TOUCH IT. Nothing here
// changes `enabled`, closes a position or stops a dispatch. It records what the
// broker said and when, so the UI can say "this account is no longer at the
// broker" and offer a Disable that works from a registry-fed surface.
//
// THE HONESTY RULE, which is the whole reason this file exists rather than a
// one-line comparison at the call site: "absent from the roster" is only
// meaningful when there IS a roster, and only while it is fresh. A missing or
// stale roster yields `null` — UNKNOWN — never `false`. Reporting "gone from
// the broker" off a roster nobody has refreshed since Tuesday would push an
// operator to disable a perfectly live account.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const ROSTER_KEY = 'broker_account_roster_json'

// How long a recorded roster stays trustworthy. The roster only refreshes
// while the Accounts or Connect page is open, so this is generous on purpose:
// past it we say "unknown", which is the truthful answer, not "missing".
export const ROSTER_MAX_AGE_MS = 24 * 3_600_000

/**
 * Record the account ids the broker just reported. Called from the one place
 * that talks to GET_ACCOUNTS_BY_TOKEN.
 *
 * An EMPTY list is not recorded. A token that legitimately sees no accounts is
 * indistinguishable here from a call that half-failed, and the cost of being
 * wrong is flagging every account in the registry as gone at once.
 */
export function recordBrokerRoster(db, accounts, nowMs = Date.now()) {
  const ids = (Array.isArray(accounts) ? accounts : [])
    .map(a => (a?.accountId == null ? null : String(a.accountId)))
    .filter(Boolean)
  if (!ids.length) return null
  const rec = { ids: [...new Set(ids)].sort(), at: new Date(nowMs).toISOString() }
  try { setState(db, ROSTER_KEY, JSON.stringify(rec)) } catch { return null }
  return rec
}

/** The last recorded roster, or null when there is none or it is unreadable. */
export function loadBrokerRoster(db) {
  try {
    const raw = getState(db, ROSTER_KEY)
    if (!raw) return null
    const rec = JSON.parse(raw)
    if (!rec || !Array.isArray(rec.ids) || !rec.ids.length) return null
    return { ids: rec.ids.map(String), at: rec.at || null }
  } catch { return null }
}

/**
 * Roster status for the UI: is it usable, how old, and how many ids.
 * `fresh` is what every "is this account missing" question must gate on.
 */
export function brokerRosterStatus(db, nowMs = Date.now()) {
  const rec = loadBrokerRoster(db)
  if (!rec) return { known: false, fresh: false, at: null, ageMin: null, count: 0 }
  const t = Date.parse(rec.at || '')
  const ageMs = Number.isFinite(t) ? Math.max(0, nowMs - t) : Infinity
  return {
    known: true,
    fresh: ageMs <= ROSTER_MAX_AGE_MS,
    at: rec.at,
    ageMin: Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null,
    count: rec.ids.length,
  }
}

/**
 * Is this account still listed by the broker?
 *
 * @returns {true|false|null} true = present, false = the broker listed
 *   accounts and this was NOT among them, null = unknown (no roster, or one
 *   too old to trust). Callers must render null as "unknown", never as gone.
 */
export function accountAtBroker(db, accountId, nowMs = Date.now()) {
  if (accountId == null || accountId === '') return null
  const st = brokerRosterStatus(db, nowMs)
  if (!st.known || !st.fresh) return null
  const rec = loadBrokerRoster(db)
  return rec.ids.includes(String(accountId))
}

/**
 * Registry rows the broker no longer lists, worst first.
 *
 * `enabled` is carried through untouched — it is the whole point of the
 * warning. An account that is gone from the broker AND still enabled is the
 * dangerous one: the loop dispatches to it and the sidecar holds
 * authorisation for it. A gone-but-disabled row is only clutter.
 *
 * @param {Array<{account_id, enabled, ...}>} registryRows from listAccounts()
 */
export function staleRegistryAccounts(db, registryRows, nowMs = Date.now()) {
  const st = brokerRosterStatus(db, nowMs)
  if (!st.known || !st.fresh) return { rosterStatus: st, stale: [] }
  const rec = loadBrokerRoster(db)
  const have = new Set(rec.ids)
  const stale = (Array.isArray(registryRows) ? registryRows : [])
    .filter(r => r?.account_id != null && !have.has(String(r.account_id)))
    .map(r => ({
      accountId: String(r.account_id),
      traderLogin: r.trader_login ?? null,
      isLive: r.is_live === 1,
      enabled: r.enabled === 1,
      mode: r.mode ?? null,
    }))
    // Enabled first: those are the ones still being traded.
    .sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0))
  return { rosterStatus: st, stale }
}
