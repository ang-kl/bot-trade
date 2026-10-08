// ---------------------------------------------------------------------------
// agent/services/broker-roster-refresh.js — keep the broker roster fresh from
// the loop, not only from a page.
//
// Claude · № 12,280 08-Oct (ordered "all three" after № 12,279; claude-builder).
//
// broker-roster.js records what GET_ACCOUNTS_BY_TOKEN last said, and every
// "is this account still at the broker" light gates on that record being
// under 24 h old. The ONLY writer was POST /actions/ctrader-accounts — the
// Connect and Accounts pages. Measured 08-10-2026: every one of the seven
// accounts' link lights read "unknown — the recorded broker roster is stale",
// while every balance was fresh. The roster was stale because nobody had
// opened the page, not because the broker had gone quiet.
//
// This refresher runs on the loop: when the record is older than
// ROSTER_REFRESH_AFTER_MS (or absent) it lists the accounts by the stored
// token and records them through recordBrokerRoster — the same writer the
// page uses, with the same honesty rule (an empty list is never recorded).
// A failed listing is paced by ROSTER_RETRY_AFTER_MS so a broker outage does
// not become a per-cycle retry storm. Nothing here changes `enabled`, closes
// a position or stops a dispatch; it only refreshes a record.
//
// Routing only reads the environment (host, client, token); no account's
// is_live is read here — the roster is a list of ids.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { loadBrokerRoster, recordBrokerRoster } from './broker-roster.js'

export const ROSTER_REFRESH_AFTER_MS = 6 * 3_600_000
export const ROSTER_RETRY_AFTER_MS = 30 * 60_000
export const ROSTER_ATTEMPT_KEY = 'broker_roster_refresh_attempt_ms'
export const ROSTER_LIST_HOST = 'demo.ctraderapi.com' // GET_ACCOUNTS_BY_TOKEN answers on either host

/**
 * @returns {Promise<{state:'fresh'|'paced'|'no_credentials'|'no_transport'|'refreshed'|'empty'|'failed', count?:number, ageMs?:number, error?:string}>}
 */
export async function refreshBrokerRosterIfStale(db, {
  now = Date.now(), listAccounts, accessToken, clientId, clientSecret, host = ROSTER_LIST_HOST,
  maxAgeMs = ROSTER_REFRESH_AFTER_MS, retryAfterMs = ROSTER_RETRY_AFTER_MS, timeoutMs = 20_000,
} = {}) {
  const rec = loadBrokerRoster(db)
  const at = rec ? Date.parse(rec.at || '') : NaN
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : Infinity
  if (rec && ageMs <= maxAgeMs) return { state: 'fresh', count: rec.ids.length, ageMs }
  const lastAttempt = Number(getState(db, ROSTER_ATTEMPT_KEY) || 0)
  if (Number.isFinite(lastAttempt) && lastAttempt > 0 && now - lastAttempt < retryAfterMs) {
    return { state: 'paced', count: rec ? rec.ids.length : 0, ageMs }
  }
  if (!accessToken || !clientId || !clientSecret) return { state: 'no_credentials', ageMs }
  if (typeof listAccounts !== 'function') return { state: 'no_transport', ageMs }
  setState(db, ROSTER_ATTEMPT_KEY, String(now))
  try {
    const data = await listAccounts(host, clientId, clientSecret, accessToken, timeoutMs)
    const accounts = (Array.isArray(data?.ctidTraderAccount) ? data.ctidTraderAccount : [])
      .map(a => ({ accountId: a?.ctidTraderAccountId }))
    const written = recordBrokerRoster(db, accounts, now)
    if (!written) return { state: 'empty', count: 0, ageMs }
    return { state: 'refreshed', count: written.ids.length, ageMs: 0 }
  } catch (e) {
    return { state: 'failed', count: rec ? rec.ids.length : 0, ageMs, error: String(e?.message || e).slice(0, 200) }
  }
}
