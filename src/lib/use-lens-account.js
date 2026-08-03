// useLensAccount — make the sidebar lens the DEFAULT scope of a page that
// keeps its own account selector.
//
// Owner, 03-08-2026: "If I change the viewing lens in the side bar, what can
// it do? it isn't wire to the rest of the page to the account … there must be
// an alternative for me to quickly change account and then pages like Risk,
// Trade, Performance will prioritise to this new change as default."
//
// He is right, and here is exactly how far the lens got:
//
//   · agent-api.js appends ?account=<viewed> to every /state read that does
//     NOT already carry one. Pages with no account selector of their own —
//     Desk, Trade — follow the lens today.
//   · An EXPLICIT ?account= always wins, deliberately: the Accounts page
//     compares accounts side by side and must not have its own query
//     rewritten under it.
//   · But Risk, Performance and Tune each hold their own selector and put an
//     explicit ?account= on every read. So they were never following the
//     lens. Worse, their defaults disagreed with each other: Risk started at
//     'all' (the global config), Performance started at the TRADED account.
//     Changing the lens moved neither.
//
// So the fix is not to make the lens louder — it is to let these pages take
// their INITIAL scope from it, and follow it when it moves. The per-page
// dropdown still overrides for the next comparison; the lens just decides
// where the page starts and where it lands when you switch.
//
// It does not touch which account the bot TRADES. That is still
// POST /actions/ctrader-select-account, on Accounts and Connect, behind its
// own confirmations.
import { useState, useEffect, useCallback } from 'react'
import { viewedAccountId, onAccountSwitch } from './selected-account.js'

/**
 * @param {'all'|null} fallback what to use when no account is viewable yet.
 * @returns {[string, (v: string) => void]} the page's account scope + setter.
 */
export function useLensAccount(fallback = 'all') {
  const [acct, setAcct] = useState(() => {
    try {
      const v = viewedAccountId()
      return v == null ? fallback : String(v)
    } catch { return fallback }
  })

  useEffect(() => {
    // A switch — from the sidebar lens OR from the traded-account switcher —
    // moves the page's scope with it. Without this the page keeps showing the
    // previous account's rows under the new account's heading, which is the
    // failure this whole workstream started from.
    const off = onAccountSwitch((ev) => {
      if (ev?.to != null) setAcct(String(ev.to))
    })
    return off
  }, [])

  // Stable identity so callers can put it in a dependency array.
  const set = useCallback((v) => setAcct(v), [])
  return [acct, set]
}
