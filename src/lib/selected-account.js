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
  // The VIEWED account, not the traded one: when an override is set the pages
  // must follow the override. With no override this is the traded account, so
  // the behaviour is unchanged.
  const id = viewedAccountId()
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

// ---------------------------------------------------------------------------
// THE VIEWED ACCOUNT — S3, owner-approved 2026-08-03 ("view-only").
//
// Owner: "I find it difficult to switch account to check."
//
// The only switch that existed until now is POST /actions/ctrader-select-account,
// and it rewrites the SERVER's trading account: ctrader_account_id,
// symbol_id_map, account_balance_usd, account_leverage, roles_json. It moves
// what the BOT TRADES. Wiring that to a dropdown in the page chrome would make
// a stray click able to re-point live trading — including at the LIVE account.
//
// S1 changed what is possible. Every account-meaningful /state route now takes
// `?account=`, so "look at another account" no longer requires moving the bot.
// That is the whole idea here: VIEWING IS NOT ARMING, and the two must not
// share a control.
//
// This lives in selected-account.js rather than a new module ON PURPOSE. A
// parallel "viewed account" file is exactly the second-source-of-truth defect
// this workstream exists to remove — the server already has an unused
// services/viewed-account.js, and adding a client twin would make three.
//
// DEFAULT IS NULL = no override = today's behaviour, byte for byte. Nothing
// changes until the operator picks an account to view.
// ---------------------------------------------------------------------------

const VIEW_KEY = 'viewed_account_id'

/**
 * The account being LOOKED AT: the override if one is set, otherwise whatever
 * the server is trading. Never null unless nothing is selected at all.
 */
export function viewedAccountId() {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw === 'all') return 'all'
    if (raw) return Number(raw)
  } catch { /* private mode — fall through to the traded account */ }
  return selectedAccountId()
}

/** True when the operator is looking at something other than what is traded. */
export function isViewingOther() {
  const v = viewedAccountId()
  const s = selectedAccountId()
  return v != null && s != null && String(v) !== String(s)
}

/**
 * Set (or clear, with null) the viewed account. Clearing returns the app to
 * following the traded account, which is the resting state.
 *
 * Fans out through the SAME onAccountSwitch subscribers the traded-account
 * switch uses, so every page's existing useAccountSwitch(load) reloads
 * immediately. No page needs to know this feature exists — which is what
 * "iron-clad wired to every page" has to mean if it is to survive the next
 * feature.
 */
export function setViewedAccount(accountId) {
  const before = viewedAccountId()
  try {
    if (accountId == null) localStorage.removeItem(VIEW_KEY)
    else localStorage.setItem(VIEW_KEY, String(accountId))
  } catch { /* private mode — the picker will look unresponsive, not lie */ }
  const after = viewedAccountId()
  if (String(before) === String(after)) return
  for (const cb of subscribers) {
    try { cb({ from: before, to: after, label: accountLabel(after), viewOnly: true }) } catch { /* keep going */ }
  }
}
