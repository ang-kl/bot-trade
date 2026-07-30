// selected-account.js — one place that knows WHICH account the app is showing,
// and tells every page the moment it changes.
//
// Owner (2026-07-30): "when I switch the account the pages doesn't change in
// real time."
//
// They were right, and the reason was latency, not a broken read. Switching
// accounts rewrites the SERVER's selected account, so every page's NEXT poll
// returns the new account's data — but nothing told the pages the switch had
// happened, so they each waited out their own clock:
//
//   Performance    60s        Desk           20s
//   AccountsAudit  60s        Trade          30s
//   Accounts       30s        Tune           on demand
//
// ...plus up to 10s of the server's own /state/* response cache. Performance
// could therefore show the PREVIOUS account's numbers, unlabelled, for over a
// minute after the switch. Showing one account's figures under another
// account's name is a correctness problem, not a slow refresh.
//
// This module is deliberately tiny and has no React dependency of its own:
// AccountSwitcher already writes the roster to sessionStorage, so that key is
// the single source of truth. One shared interval watches it and fans the
// change out to subscribers; pages reload immediately instead of on their next
// tick, and can show WHOSE data is on its way.
//
// Why poll a storage key rather than emit an event on switch: a switch can also
// happen in another tab, or via Telegram, or from the Connect page — all of
// which change the server without going through this tab's switcher. Watching
// the state catches every one of those; an event only catches the button.

const CACHE = 'accounts_cache_v1'
const WATCH_MS = 1_000

let current = null           // last seen selectedAccountId
let started = false
const subscribers = new Set()

function readCache() {
  try { return JSON.parse(sessionStorage.getItem(CACHE)) } catch { return null }
}

/** The selected account id right now, or null before the switcher has loaded. */
export function selectedAccountId() {
  return readCache()?.selectedAccountId ?? null
}

/** The roster entry for the selected account, or null. */
export function selectedAccount() {
  const c = readCache()
  if (!c?.accounts) return null
  return c.accounts.find(a => a.accountId === c.selectedAccountId) ?? null
}

/** A human label for an account id — the broker LOGIN, which is what the
 *  owner reads, not the ctidTraderAccountId. */
export function accountLabel(id) {
  const c = readCache()
  const a = c?.accounts?.find(x => x.accountId === id)
  if (!a) return id == null ? 'another account' : String(id)
  return `${a.isLive ? 'LIVE' : 'DEMO'} ${a.traderLogin ?? a.accountId}`
}

/**
 * Record a switch made by ANY code path — Connect, the switcher, or a poll
 * that noticed the server's selection moved.
 *
 * Owner (2026-07-30, screenshot): "I selected a different account in connect,
 * your header doesn't reflect." The header module's own comment claimed
 * watching sessionStorage catches switches made from the Connect page. That
 * was false: watching the cache only catches switches that WRITE the cache,
 * and Connect never did — only AccountSwitcher's load() wrote it. This is the
 * single write point both paths now share, so "the cache is the signal" is
 * finally a true statement instead of a hopeful comment.
 */
export function writeSelection(accountId) {
  const id = accountId == null ? null : Number(accountId)
  if (id == null || Number.isNaN(id)) return
  try {
    const c = readCache() || { accounts: [], selectedAccountId: null }
    if (Number(c.selectedAccountId) === id) return
    c.selectedAccountId = id
    sessionStorage.setItem(CACHE, JSON.stringify(c))
  } catch { /* private mode — the server poll still corrects the header */ }
  // The 1s watcher would catch this anyway; ticking now makes the switch
  // visible immediately instead of up to a second later.
  tick()
}

function tick() {
  const id = readCache()?.selectedAccountId ?? null
  if (id == null) return
  // First observation establishes the baseline; it is not a switch.
  if (current == null) { current = id; return }
  if (id === current) return
  const from = current
  current = id
  for (const cb of subscribers) {
    // One subscriber throwing must not stop the others from being told —
    // a page that fails to reload is a stale page, and stale is the exact
    // failure this module exists to prevent.
    try { cb({ from, to: id, label: accountLabel(id) }) } catch { /* keep going */ }
  }
}

/**
 * Call `cb({ from, to, label })` whenever the selected account changes.
 * Returns an unsubscribe function.
 */
export function onAccountSwitch(cb) {
  subscribers.add(cb)
  if (!started) {
    started = true
    current = readCache()?.selectedAccountId ?? null
    setInterval(tick, WATCH_MS)
  }
  return () => subscribers.delete(cb)
}
