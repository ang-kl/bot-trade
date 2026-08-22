// ---------------------------------------------------------------------------
// agent/lib/token-coverage.js — does this token reach the accounts we run?
//
// WHY (2026-08-22, from the deploy log). The owner linked cTrader twice inside
// a minute. The log records both:
//
//   09:23:55  [actions] ctrader token stored — 7 account(s) available
//   09:24:40  [actions] ctrader token stored — 2 account(s) available
//
// The second overwrote the first. From 09:25 onward every call against
// 43097342, 46979908, 42993489, 43002148 and 43069009 returned
// CH_ACCESS_TOKEN_INVALID, and `cpp roster drift corrected` re-ran every two
// minutes without ever sticking — the sidecar kept being told to authorise
// accounts the stored token has no grant for.
//
// NOTHING OBJECTED. The route printed a count and returned ok, and a count is
// exactly the wrong shape of answer: 2 is only alarming if you happen to
// remember the previous line said 7. The registry already knows which accounts
// are supposed to be tradable, so the honest reading is not "how many did this
// token bring" but "which of the ones we run does it NOT cover".
//
// This is a REPORT, not a gate. A token is still stored even when it covers
// nothing — refusing it would strand an owner who is deliberately narrowing
// the set, and a stored-but-narrow token is recoverable by linking again while
// a refused one leaves the old broken token in place.
// ---------------------------------------------------------------------------

const id = (v) => (v == null ? null : String(v).trim())

/**
 * Which enabled accounts does this token fail to cover?
 *
 * Pure. `tokenAccounts` is whatever listCtraderAccounts returned (objects with
 * some flavour of account id, or bare ids); `enabledRows` is the registry's
 * enabled accounts.
 *
 * @returns {{covered:string[], missing:string[], extra:string[], ok:boolean}}
 */
export function tokenCoverage(tokenAccounts = [], enabledRows = []) {
  const tokenIds = new Set(
    (tokenAccounts || [])
      .map(a => id(a?.ctidTraderAccountId ?? a?.accountId ?? a?.account_id ?? a))
      .filter(Boolean),
  )
  const wanted = (enabledRows || []).map(r => id(r?.account_id ?? r)).filter(Boolean)
  const covered = wanted.filter(a => tokenIds.has(a))
  const missing = wanted.filter(a => !tokenIds.has(a))
  const extra = [...tokenIds].filter(a => !wanted.includes(a))
  return { covered, missing, extra, ok: missing.length === 0 }
}

/**
 * One line for the log and the UI. Null when there is nothing to warn about —
 * a caller that prints this unconditionally would be adding noise on the happy
 * path, which is how warnings stop being read.
 */
export function describeCoverage(cov) {
  if (!cov || cov.ok) return null
  return `this token does NOT cover ${cov.missing.length} enabled account(s): `
    + `${cov.missing.join(', ')} — they will fail with CH_ACCESS_TOKEN_INVALID until you link again `
    + 'and authorise every account at the cTrader consent screen'
}
