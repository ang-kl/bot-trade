// scope-label — ONE way to name the account a card is showing.
//
// Owner, 05-08-2026, on four screenshots of one page: "Doesn't show the user
// which account it is looking at or looking at the summary. We keep having the
// problem of understanding the page: whether we are looking at a specific
// account or the summary."
//
// The four cards in those screenshots answered it four different ways — one
// with its own pill row on Demo 8549, one resolving its own account to Demo
// 7353, one with a second pill row on 7353, and one saying nothing at all. The
// silent one is genuinely global, but silence is indistinguishable from
// "forgot to say", so the reader has to know the codebase to read the page.
//
// THREE STATES, AND THE THIRD IS THE POINT:
//
//   account  this card shows ONE account          "Demo · 7353"
//   all      this card aggregates the book        "All accounts"
//   global   this setting is not per-account      "Global"
//
// `global` is what makes the other two trustworthy. Without it, a card with no
// chip could mean either "applies everywhere" or "nobody labelled this", and a
// reader who cannot tell those apart cannot trust the labels that ARE there.
//
// WHY A SHARED FORMATTER. Six call sites were building this string, in five
// different formats — `Live · 7353`, `Live 5067353`, `Live ·353`,
// `Live · 5067353 · OFF`. On one page that reads as different KINDS of thing
// rather than the same thing said differently, which is part of what made the
// page hard to read in the first place.

/** Last-N digits of the broker login — the part the owner recognises. */
export const LABEL_DIGITS = 4

/**
 * "Live · 1247" / "Demo · 7353". Falls back to the internal account id only
 * when there is no broker login, and says so by keeping the full value rather
 * than trimming it to a lookalike 4-digit tail.
 */
export function accountLabel(account, { digits = LABEL_DIGITS } = {}) {
  if (!account) return null
  const login = account.trader_login ?? account.traderLogin ?? null
  const side = (account.is_live ?? account.isLive) ? 'Live' : 'Demo'
  if (login == null || login === '') {
    const id = account.account_id ?? account.accountId
    return id == null || id === '' ? null : `${side} · ${String(id)}`
  }
  const s = String(login)
  return `${side} · ${s.length > digits ? s.slice(-digits) : s}`
}

/** Find a registry row by either id shape, without coercing null to 0. */
export function findAccount(accounts, accountId) {
  if (accountId == null || accountId === '') return null
  const want = String(accountId)
  return (Array.isArray(accounts) ? accounts : [])
    .find(a => String(a?.account_id ?? a?.accountId ?? '') === want) || null
}

/**
 * What a card's chip should say.
 *
 * @param {'all'|'global'|string|null} scope  'all', 'global', or an account id
 * @param {Array} accounts                    registry rows from /state/accounts
 * @returns {{kind:'all'|'global'|'account'|'unknown', text:string, title:string}}
 */
export function scopeLabel(scope, accounts = []) {
  if (scope === 'global') {
    return {
      kind: 'global',
      text: 'Global',
      title: 'This setting is not per-account — it applies to every account.',
    }
  }
  if (scope == null || scope === '' || scope === 'all') {
    return {
      kind: 'all',
      text: 'All accounts',
      title: 'Aggregated across every account, not one account\'s figures.',
    }
  }
  const acct = findAccount(accounts, scope)
  const label = accountLabel(acct)
  if (!label) {
    // The roster has not loaded, or this id is not in it. Say the id rather
    // than inventing a friendly name for an account we cannot identify —
    // a wrong name here is worse than a raw number.
    return {
      kind: 'unknown',
      text: `Account ${String(scope)}`,
      title: `Scoped to account ${String(scope)} — not found in the account registry.`,
    }
  }
  return {
    kind: 'account',
    text: label,
    title: `Everything in this card is scoped to ${label} (account ${String(scope)}).`,
  }
}

/**
 * Do two scopes disagree in a way worth pointing at? Used to decide whether a
 * card is PINNED away from the page scope — which is legitimate, and must be
 * visible rather than silent.
 */
export function scopeDiffers(cardScope, pageScope) {
  // A global card never differs: it is not on the same axis as the page scope.
  if (cardScope === 'global') return false
  const norm = (v) => (v == null || v === '' ? 'all' : String(v))
  return norm(cardScope) !== norm(pageScope)
}
