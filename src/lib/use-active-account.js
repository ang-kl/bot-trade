// use-active-account — WHICH account is selected, its balance, its currency,
// and whether each pipeline phase is running.
//
// Extracted from ActiveAccountHeader.jsx so the sidebar block, the phone chip
// and the per-page account line all read the same thing from one poll instead
// of three components each fetching /state/health on their own clock and
// disagreeing for a few seconds.
//
// Lives in lib/ because a component module may only export components
// (react-refresh/only-export-components).
import { useSyncExternalStore } from 'react'
import { agentGet, agentConfigured } from './agent-api.js'
import { writeSelection } from './selected-account.js'

// The same sessionStorage key AccountSwitcher fills — reading it costs nothing
// and avoids a second /actions/ctrader-accounts round-trip per mount.
const CACHE = 'accounts_cache_v1'
const POLL_MS = 30_000

// ONE shared poll for the whole app, not one per mounting component. Three
// consumers on 30s timers each would triple the request rate and let the
// sidebar and the page line show different numbers between ticks.
let shared = { acct: null, phasesView: null, phasesSig: '', ccy: null }
let started = false
const listeners = new Set()

function emit() {
  // New object identity ⇒ useSyncExternalStore re-renders. Called only when
  // something actually changed, so an unchanged poll causes no render at all —
  // which is the point of the "only refresh the text that changed" work.
  snapshot = { ...shared }
  for (const l of listeners) {
    try { l() } catch { /* one bad subscriber must not stop the rest */ }
  }
}

function readCache() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE))
    const sel = c?.accounts?.find(a => a.accountId === c.selectedAccountId)
    return sel || null
  } catch { return null }
}

// PER-ACCOUNT phases, extracted so the sidebar's switches can force an
// immediate re-read after a write (owner 01-08: switches move into the
// sidebar; a toggle must repaint on the SERVER's answer, not on hope).
// Carries the override map (the ● marker) and the ratchet hold alongside the
// three effective booleans — additive, so PhaseDots keeps reading the same
// keys it always has.
function loadPhases() {
  return agentGet('/state/account-phases').then(v => {
    if (!v?.master) return
    const byId = {}
    for (const a of v.accounts || []) {
      byId[String(a.accountId)] = {
        scan: a.effective?.scan === true,
        analyze: a.effective?.analyze === true,
        autotrade: a.effective?.autotrade === true,
        overrides: a.overrides ?? null,
        ratchet: a.ratchet ?? null,
      }
    }
    const next = { master: { ...v.master }, byId }
    // Cheap deep compare: this object is a handful of booleans per account,
    // and an unchanged poll must not cause a render (the whole point of the
    // "only repaint what changed" pass).
    const sig = JSON.stringify(next)
    if (sig !== shared.phasesSig) {
      shared.phasesSig = sig
      shared.phasesView = next
      emit()
    }
  }).catch(() => {})
}

/** Force the shared phase view to refetch NOW (after a sidebar write). */
export function refreshPhases() { return loadPhases() }

function start() {
  if (started) return
  started = true

  // The roster comes from the switcher's cache; re-read often so a switch shows
  // up without a page reload (and so a switch made in another tab is caught).
  const readRoster = () => {
    const sel = readCache()
    if (sel && sel.accountId !== shared.acct?.accountId) { shared.acct = sel; emit() }
    else if (sel && sel.balance !== shared.acct?.balance) { shared.acct = sel; emit() }
  }
  readRoster()
  setInterval(readRoster, 2_000)

  const load = () => {
    if (!agentConfigured()) return
    // SERVER TRUTH for which account is selected. The sessionStorage cache is
    // an instant-paint hint written by the UI's own switch paths — but a
    // switch can happen in Connect, another tab, or Telegram, and the owner
    // caught the header showing the OLD account after a Connect switch
    // (2026-07-30 screenshot). /state/accounts is the registry's answer, so
    // the header converges on the truth within one poll even when no UI code
    // wrote the cache. Reconciling INTO the cache (via writeSelection) also
    // fires the page-reload notifier, so every polling page repaints too.
    agentGet('/state/accounts').then(r => {
      const sid = r?.selectedAccountId != null ? Number(r.selectedAccountId) : null
      if (sid == null) return
      writeSelection(sid)
      const cached = readCache()
      if (cached && Number(cached.accountId) === sid) {
        if (cached.accountId !== shared.acct?.accountId || cached.balance !== shared.acct?.balance) {
          shared.acct = cached; emit()
        }
        return
      }
      // Selected account is not in the roster cache (fresh browser, or the
      // switch happened elsewhere before the roster loaded). The registry row
      // still names it — label it honestly with balance unknown rather than
      // keep showing the PREVIOUS account's name and money.
      const row = (r.accounts || []).find(a => Number(a.account_id) === sid)
      if (row && shared.acct?.accountId !== sid) {
        shared.acct = {
          accountId: sid,
          traderLogin: row.trader_login ?? null,
          isLive: row.is_live === 1,
          balance: null,
        }
        emit()
      }
    }).catch(() => {})
    // PER-ACCOUNT phases, not the global flags. /state/health still reports the
    // three master flags, and reading those here was correct only while they
    // were the whole truth. Since the per-account switches exist an account can
    // have autotrade off while the master is on, and dots drawn from the master
    // would show the selected account as armed when it is not — the precise
    // kind of decorative status that made the owner ask whether the switches
    // were wired at all. `master` is kept as the fallback for an account the
    // registry does not know (or before the roster resolves).
    loadPhases()
    // Deposit currency rides on the cached broker snapshot's positions. No
    // positions → no currency → the number prints bare rather than guessing $.
    agentGet('/state/broker-cache').then(bc => {
      const dep = bc?.snapshot?.account?.positions?.find(p => p.depositCcy)?.depositCcy
      if (dep && dep !== shared.ccy) { shared.ccy = dep; emit() }
    }).catch(() => {})
  }
  load()
  setInterval(load, POLL_MS)
}

// useSyncExternalStore is the right shape for this: `shared` IS an external
// store, and it removes the setState-inside-an-effect that a hand-rolled
// subscription needs in order to adopt state the poll already fetched before
// this component mounted. getSnapshot must return a STABLE reference when
// nothing changed, so emit() swaps in a new object only on a real change and
// the snapshot is that object rather than a fresh copy per render.
let snapshot = { ...shared }

function subscribe(cb) {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const getSnapshot = () => snapshot

/**
 * @returns {{acct: object|null, phases: {scan:boolean,analyze:boolean,autotrade:boolean}|null,
 *            armed: boolean|null, ccy: string|null}}
 */
export function useActiveAccount() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  // The SELECTED account's effective phases, falling back to the master flags
  // for an account the registry has not answered for yet. Derived here rather
  // than stored so the snapshot identity stays stable when nothing changed.
  const view = state.phasesView
  const phases = !view
    ? null
    : (view.byId[String(state.acct?.accountId)] || view.master)
  return {
    acct: state.acct,
    phases,
    armed: phases ? phases.autotrade : null,
    ccy: state.ccy,
  }
}

/**
 * EVERY account's effective phases, from the same poll — for lists that draw a
 * row per account (the sidebar switcher). Returns null until the first answer.
 *
 * @returns {{master: object, byId: Record<string, {scan:boolean,analyze:boolean,autotrade:boolean}>}|null}
 */
export function useAccountPhases() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).phasesView
}

/** The account's balance, formatted with its own currency. Never a bare "$". */
export function formatBalance(balance, ccy, { decimals = 2 } = {}) {
  if (balance == null) return '—'
  const n = Number(balance)
  if (!Number.isFinite(n)) return '—'
  const num = n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return ccy ? `${ccy} ${num}` : num
}
