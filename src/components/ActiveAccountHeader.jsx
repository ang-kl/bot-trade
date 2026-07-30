// ActiveAccountHeader — WHICH account everything below belongs to, and
// whether it is actually working.
//
// Owner (2026-07-29): "At the side Bar, above the OVERVIEW state the
// Account · {DEMO 5203012} I am viewing now. Account # in Blue text if
// trading now, Bright Grey is stop trading. Below the Account # is the
// Balance: USD/SGD/EUR ###,###.## now."
//
// Owner (2026-07-30): "if I off any of these [Scan, Analyze, Autotrade] for
// that account, the side bar for that account should shows red, red, red dots
// (2px) beside the balance in the side bar. And if the account is selected,
// the heading text of the side bar will be 'All off' / 'Scan off' /
// 'Analyze & Autotrade off' etc. in 8 font size."
//
// Every figure on Performance, Desk, Trade and Risk is scoped to one account,
// and until now the only clue was a highlighted row further down the nav. The
// header states it once, at the top, in the account's OWN deposit currency —
// never a hardcoded "$", because the accounts on this cTID hold SGD as well
// as USD and printing the wrong symbol is worse than printing none.
//
// Colour carries the trading state, per the owner's spec: accent/blue while
// autotrade is armed, bright grey while it is not.
//
// The dots are now the SELECTED ACCOUNT'S OWN state, not the global flags.
// Until the per-account switches shipped they could only be the three master
// flags in agent_state, which happened to be truthful because this header
// renders exactly one account — and stopped being truthful the moment an
// account could have autotrade off under a master that is on. useActiveAccount
// reads /state/account-phases and returns that account's EFFECTIVE phases, with
// the master as the fallback for an account the registry has not answered for.
// The switches themselves live on Tune › Pipeline (AccountPhaseSwitches).
import { offSummary } from '../lib/account-phases.js'
import PhaseDots from './common/PhaseDots.jsx'
import { useActiveAccount, formatBalance } from '../lib/use-active-account.js'

// Same session cache AccountSwitcher fills — reading it here costs nothing
// and avoids a second /actions/ctrader-accounts round-trip on every mount.
const CACHE = 'accounts_cache_v1'
const POLL_MS = 30_000

/**
 * Compact chip for the touch header — the same fact in one line, because a
 * phone header has no room for three (owner: "dense and less screen
 * scrolling"). Same colour rule: accent while trading, grey while not.
 */
export function ActiveAccountHeaderCompact() {
  const { acct, phases, armed, ccy } = useActiveAccount()
  if (!acct) return null
  const trading = armed === true
  return (
    <span
      className={`text-[9px] font-bold tabular-nums whitespace-nowrap ${trading ? 'text-[var(--color-state-on-text)]' : 'text-[var(--color-muted)]'}`}
      title={trading ? 'autotrade is ARMED on this account' : 'autotrade is OFF on this account'}
    >
      {acct.isLive ? 'LIVE' : 'DEMO'} {acct.traderLogin ?? acct.accountId}
      {acct.balance != null && (
        <span className="ml-1 font-normal text-[var(--color-text-sub)]">
          {formatBalance(acct.balance, ccy, { decimals: 0 })}
        </span>
      )}
      <PhaseDots phases={phases} className="ml-1 align-middle" letters={false} />
    </span>
  )
}

export default function ActiveAccountHeader() {
  const { acct, phases, armed, ccy } = useActiveAccount()
  if (!acct) return null

  const label = `${acct.isLive ? 'LIVE' : 'DEMO'} ${acct.traderLogin ?? acct.accountId}`
  const trading = armed === true
  const summary = offSummary(phases)
  return (
    <div className="mb-4 px-3">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[9px] uppercase tracking-wide text-[var(--color-text-sub)]">Account</span>
        {summary && (
          <span
            className="text-[8px] font-semibold uppercase tracking-wide text-[var(--color-state-off-text)]"
            title="Scan finds candidates, Analyze judges them, Autotrade sends the order. Anything off stops the pipeline at that point."
          >
            {summary}
          </span>
        )}
      </div>
      <div
        className={`text-[11px] font-bold tabular-nums ${trading ? 'text-[var(--color-state-on-text)]' : 'text-[var(--color-muted)]'}`}
        title={armed == null
          ? 'checking whether autotrade is armed…'
          : trading ? 'autotrade is ARMED — the bot is trading this account' : 'autotrade is OFF — the bot is not opening new trades on this account'}
      >
        {label}
      </div>
      {/* Owner: "remove the word 'Balance' under the Account name" — the
          currency code and the number already say what it is. */}
      <div className="flex items-center gap-1.5 text-[9px] text-[var(--color-text-sub)] tabular-nums">
        <span>{formatBalance(acct.balance, ccy)}</span>
        <PhaseDots phases={phases} />
      </div>
    </div>
  )
}
