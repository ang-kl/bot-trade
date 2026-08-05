// scope-fab — what the account FAB puts on its own face, and what it offers
// when you tap it.
//
// Owner, 05-08-2026, on four screenshots of one page: "Doesn't show the user
// which account it is looking at or looking at the summary … do you think an
// Account switcher FAB/Account Total FAB add to the navigation FAB be better."
//
// The point of putting the account on a FAB rather than in a menu is that the
// ANSWER IS ON SCREEN WITHOUT OPENING ANYTHING. That only works if the face
// can be read at a glance on a 4.7" phone, which rules out an 8-digit internal
// id and rules out colour as the live/demo signal — the owner reads red and
// green as one thing. So the face is two short words stacked:
//
//     DEMO          ALL          ACCT
//     7353         ACCTS           ?
//
// …the third being the state that makes the other two trustworthy. A roster
// that has not loaded, or an id that is not in the registry, must NOT fall
// back to the ALL face: "I am looking at every account" and "I do not know
// which account this is" are different facts, and conflating them is the exact
// confusion the chip work was undone by.
//
// Pure functions, no React and no fetch, so the face can be tested without a
// DOM — the failure being guarded against is a face that renders a plausible
// wrong account, which a render test would not notice.
import { scopeLabel, findAccount, accountLabel } from './scope-label.js'

/** The aggregate scope, spelled the same way `useLensAccount` spells it. */
export const FAB_ALL = 'all'

/** Digits the 56px FACE can hold. The face is a glance, not a listing — the
 *  sheet behind it carries the full login and the full account id, which is
 *  where "all accounts listed must include the ID" is satisfied. */
const FACE_DIGITS = 4
function tail(login) {
  const s = String(login ?? '')
  return s.length > FACE_DIGITS ? s.slice(-FACE_DIGITS) : s
}

/**
 * What the FAB shows without being opened.
 *
 * @param {'all'|'global'|string|null} scope  the PAGE scope
 * @param {Array} accounts                    rows from /state/accounts
 * @returns {{kind:string, top:string, bottom:string, title:string}}
 */
export function fabFace(scope, accounts = []) {
  const s = scopeLabel(scope, accounts)
  if (s.kind === 'account') {
    const acct = findAccount(accounts, scope)
    const login = acct?.trader_login ?? acct?.traderLogin
    return {
      kind: 'account',
      // The word, not a colour — LIVE has to survive a red/green reader.
      top: (acct?.is_live ?? acct?.isLive) ? 'LIVE' : 'DEMO',
      bottom: tail(login ?? scope),
      title: s.title,
    }
  }
  if (s.kind === 'unknown') {
    // Honest blank. The full id is in the tooltip; what must NOT happen is
    // this reading as "All accounts" while the roster is still in flight.
    return { kind: 'unknown', top: 'ACCT', bottom: '?', title: s.title }
  }
  // 'all' and 'global' agree on the only thing the face has room to say:
  // you are not looking at one account. The title keeps them apart.
  return { kind: s.kind, top: 'ALL', bottom: 'ACCTS', title: s.title }
}

/**
 * The rows the FAB's sheet offers. `All accounts` first — it is the safe,
 * aggregate choice — then demo accounts, then LIVE last.
 *
 * Live sorts last on purpose. Choosing it here is VIEW-only and moves nothing
 * at the broker, but it is still the row where a mis-tap costs the most
 * confusion, so it does not sit in the middle of the demo accounts.
 *
 * @param {Array} accounts   rows from /state/accounts
 * @param {{tradedId?: string|number|null}} opts
 * @returns {Array<{value:string, label:string, live:boolean, traded:boolean}>}
 */
export function fabOptions(accounts = [], { tradedId = null } = {}) {
  const rows = (Array.isArray(accounts) ? accounts : [])
    .map(a => {
      const id = String(a?.account_id ?? a?.accountId ?? '')
      return {
        value: id,
        label: accountLabel(a) || `Account ${id}`,
        live: Boolean(a?.is_live ?? a?.isLive),
        traded: tradedId != null && String(tradedId) === id,
      }
    })
    .filter(r => r.value !== '')
  // Stable within each group: registry order is the operator's own order.
  const demo = rows.filter(r => !r.live)
  const live = rows.filter(r => r.live)
  return [
    { value: FAB_ALL, label: 'All accounts', live: false, traded: false },
    ...demo, ...live,
  ]
}
