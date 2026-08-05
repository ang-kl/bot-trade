// account-roster — ONE /state/accounts fetch per page load, shared by every
// component that needs to turn an account id into a name.
//
// Extracted from ScopeChip (05-08-2026) when the account FAB became the second
// consumer. Two module-local promises would have meant two fetches, and worse,
// two caches that can disagree: the chip on a card saying "Demo · 7353" while
// the FAB that SET that scope still shows the previous roster is precisely the
// class of contradiction this workstream exists to remove.
//
// A FAILED fetch is deliberately not cached. Caching a rejection would leave
// every chip on the page rendering a raw account id forever, with no retry
// short of a reload.
import { agentGet } from './agent-api.js'

let rosterPromise = null

/** @returns {Promise<Array>} registry rows, or [] when the agent is unreachable. */
export function accountRoster() {
  if (!rosterPromise) {
    rosterPromise = agentGet('/state/accounts')
      .then(r => r?.accounts || [])
      .catch(() => { rosterPromise = null; return [] })
  }
  return rosterPromise
}

/** Drop the cache — used by tests and after an account is added or removed. */
export function resetAccountRoster() {
  rosterPromise = null
}
