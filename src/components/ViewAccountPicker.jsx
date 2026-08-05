// ViewAccountPicker — the sidebar dropdown that changes WHICH ACCOUNT YOU ARE
// LOOKING AT, and nothing else.
//
// Owner: "I find it difficult to switch account to check, do you think each
// page should have a dropdown change?" — and the answer, agreed 2026-08-03,
// is ONE picker in the sidebar rather than a dropdown per page. Per-page
// switchers let two pages disagree about which account you are viewing, which
// is the same class of failure as the pooled Go-Live card.
//
// VIEWING IS NOT ARMING. This is the whole design, and it is why the control
// is safe to put in the chrome:
//
//   · This picker writes a LOCAL lens. Every /state read then carries
//     ?account=<id> (agent-api.js withViewedAccount). Nothing is sent that
//     changes the agent.
//   · The OTHER switch — POST /actions/ctrader-select-account, on Accounts and
//     Connect — rewrites the server's traded account: symbol_id_map, balance,
//     leverage, roles. That one moves the bot, and it stays where it is,
//     behind its own confirmations.
//
// Wiring a dropdown in the page chrome to the second kind would mean a stray
// click could re-point live trading. It cannot, and the control says so.
//
// While a lens is active the block is visibly marked and offers one tap back
// to the traded account — a lens you cannot tell you are wearing is worse than
// no lens, because every number below it is then unlabelled.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  viewedAccountId, setViewedAccount, isViewingOther,
  selectedAccountId, onAccountSwitch,
} from '../lib/selected-account.js'

const CACHE = 'accounts_cache_v1'

function readRoster() {
  try { return JSON.parse(sessionStorage.getItem(CACHE))?.accounts || [] } catch { return [] }
}

/** Subscribe to switches so the picker repaints when anything moves it. */
function subscribe(cb) { return onAccountSwitch(cb) }
function snapshot() { return `${viewedAccountId() ?? ''}|${selectedAccountId() ?? ''}` }

export default function ViewAccountPicker() {
  const [roster, setRoster] = useState(readRoster)
  useSyncExternalStore(subscribe, snapshot, snapshot)

  // The roster is filled by AccountSwitcher / Connect. Re-read on a slow beat
  // rather than fetching: a second /actions/ctrader-accounts round-trip from
  // the chrome on every mount would cost every page load for no new fact.
  useEffect(() => {
    const iv = setInterval(() => setRoster(readRoster()), 5_000)
    return () => clearInterval(iv)
  }, [])

  if (roster.length < 2) return null   // one account — a picker would be furniture

  const viewed = viewedAccountId()
  const lensOn = isViewingOther()

  return (
    <div className="mb-3 px-3">
      <label
        className="mb-0.5 flex items-center gap-1 text-(length:--fs-body) uppercase tracking-wide text-[var(--color-text-sub)]"
        htmlFor="view-account-picker"
      >
        Viewing
        {lensOn && (
          <span
            className="rounded-[3px] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]
                       px-1 text-(length:--fs-body) font-bold not-italic text-[var(--color-warning-text)]"
            title="You are looking at an account the bot is NOT trading. Reads only — nothing here changes the agent."
          >
            LENS
          </span>
        )}
      </label>
      <select
        id="view-account-picker"
        value={viewed == null ? '' : String(viewed)}
        onChange={(e) => setViewedAccount(e.target.value === '' ? null : e.target.value)}
        title="Changes which account these pages SHOW. It does not change which account the bot trades — that switch lives on Accounts."
        className="w-full cursor-pointer rounded-[6px] border border-[var(--color-border)]
                   bg-transparent px-1.5 py-1 text-(length:--fs-body) font-semibold tabular-nums
                   text-[var(--color-text)]"
      >
        {roster.map(a => (
          <option key={a.accountId} value={String(a.accountId)}>
            {a.isLive ? 'LIVE' : 'DEMO'} {a.traderLogin ?? a.accountId}
            {String(a.accountId) === String(selectedAccountId()) ? ' · trading' : ''}
          </option>
        ))}
      </select>
      {lensOn && (
        <button
          type="button"
          onClick={() => setViewedAccount(null)}
          className="mt-1 w-full cursor-pointer rounded-[5px] border border-transparent px-1
                     text-left text-(length:--fs-body) text-[var(--color-text-sub)]
                     hover:border-[var(--color-border)]"
          title="Return to the account the bot is trading"
        >
          ← back to the traded account
        </button>
      )}
    </div>
  )
}
