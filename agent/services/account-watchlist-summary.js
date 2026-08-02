// Per-account watchlist facts — the answer to the owner's question of
// 02-08-2026: "I am confuse whether the ACCOUNT has how many symbols in
// watchlist, how many backtested?"
//
// Three facts per account, each of which the UI was previously unable to state:
//
//   1. HOW MANY SYMBOLS this account actually trades. Not "the watchlist" —
//      an account either has its own list or inherits the shared one, and the
//      count differs. `inherited` says which, because "42 symbols" means two
//      different things depending on the answer: a list that is this account's
//      alone, or a view of a list that changes under it whenever the shared
//      one is edited.
//
//   2. HOW MANY ARE ENABLED. A disabled entry stays on the list and is not
//      traded, so a raw length overstates the universe.
//
//   3. HOW MANY HAVE BEEN BACKTESTED, and how long ago. Backtests are stored
//      per SYMBOL, not per account (backtest_runs has no account_id — it is a
//      property of the market, not of who is trading it), so this is an
//      intersection: of the symbols on THIS account's list, how many have a
//      usable run on record. Rows carrying an `error` are excluded — a run
//      that failed to fetch data is not evidence about the symbol, and
//      counting it would make coverage look better than it is.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not compute a "coverage score",
// grade an account, or hide the untested symbols behind a percentage. The
// untested ones are returned by name (capped, with the true total alongside)
// because the useful action is "backtest these", and a percentage cannot be
// acted on.
import { readWatchlist, hasOwnWatchlist } from './watchlists.js'
import { listAccounts } from './account-registry.js'

/** How many untested symbols to name before falling back to the count alone. */
export const UNTESTED_SAMPLE = 12

/**
 * @param {*} db
 * @param {{accountIds?: (string|number)[]|null}} opts
 *   accountIds: the ids to report on. Defaults to the registry. Ids NOT in the
 *   registry are still valid — readWatchlist falls back to the shared list for
 *   them, which is exactly what such an account would trade if it were
 *   enabled, so the Connect page can ask about broker accounts the registry
 *   has never seen.
 * @returns {{global: object, accounts: object[]}}
 */
export function accountWatchlistSummary(db, { accountIds = null } = {}) {
  // One pass over backtest_runs for the whole call. Per-account queries would
  // re-scan the table once per account for no new information — the runs are
  // account-independent.
  const tested = new Map() // SYMBOL -> newest ran_at of a non-error run
  for (const r of db.prepare(
    `SELECT symbol, MAX(ran_at) AS last_at
       FROM backtest_runs
      WHERE error IS NULL AND symbol IS NOT NULL
      GROUP BY symbol`
  ).all()) {
    tested.set(String(r.symbol).toUpperCase(), r.last_at || null)
  }

  const registry = new Map(listAccounts(db).map(a => [String(a.account_id), a]))
  const ids = Array.isArray(accountIds) && accountIds.length
    ? accountIds.map(String)
    : [...registry.keys()]

  const rowFor = (id) => {
    const reg = id == null ? null : registry.get(String(id)) || null
    const items = readWatchlist(db, id)
    const own = id == null ? true : hasOwnWatchlist(db, id)
    return {
      accountId: id == null ? null : String(id),
      label: reg?.broker_label || null,
      isLive: reg ? reg.is_live === 1 : null,
      enabledAccount: reg ? reg.enabled === 1 : null,
      // null id = the shared list itself, which inherits from nothing.
      inherited: id == null ? false : !own,
      inRegistry: id == null ? null : registry.has(String(id)),
      ...countsFor(items, tested),
    }
  }

  return {
    global: rowFor(null),
    accounts: ids.map(rowFor),
  }
}

function countsFor(items, tested) {
  const enabled = items.filter(i => i.enabled !== false)
  let backtested = 0
  let newest = null
  const untested = []
  for (const i of items) {
    const at = tested.get(i.symbol)
    if (at) {
      backtested += 1
      if (newest == null || String(at) > String(newest)) newest = at
    } else {
      untested.push(i.symbol)
    }
  }
  return {
    symbols: items.length,
    enabled: enabled.length,
    disabled: items.length - enabled.length,
    backtested,
    // Named, not scored — the useful next action is to test these.
    untested: untested.length,
    untestedSample: untested.slice(0, UNTESTED_SAMPLE),
    untestedTruncated: untested.length > UNTESTED_SAMPLE,
    lastBacktestAt: newest,
  }
}
