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
// HONEST LIMIT — scan/analyze/autotrade are still three GLOBAL flags in
// agent_state (scan_enabled / analyze_enabled / autotrade_enabled); no
// per-account pause exists yet (that is task #124, "per-account control:
// mode enforcement, pause disposition"). This header only ever renders the
// SELECTED account, so for the account you are viewing the global flags ARE
// its flags and the dots are truthful. They would NOT be truthful printed
// against every row of a multi-account list, which is exactly why they are
// not — see AccountSwitcher.
import { PHASES, offSummary } from '../lib/account-phases.js'
import { useActiveAccount, formatBalance } from '../lib/use-active-account.js'

// Same session cache AccountSwitcher fills — reading it here costs nothing
// and avoids a second /actions/ctrader-accounts round-trip on every mount.
const CACHE = 'accounts_cache_v1'
const POLL_MS = 30_000

/**
 * Three traffic lights, one per phase: blue on, red off.
 *
 * SIZE OVERRIDES THE 2px SPEC, and the owner is the reason. They asked for 2px
 * dots, then reported "I cannot see the traffic lights of the 3 independent
 * Scan/Analyze/Autotrade." A 2px dot is about one device pixel after this app's
 * 1.1 zoom — smaller than the anti-aliasing around it, so it renders as a
 * smudge or as nothing at all. These are 6px with a ring: still a status light
 * rather than a badge, but actually visible. The initial (S / A / T) rides
 * alongside so the three are distinguishable without a hover, which a bare dot
 * can never be on a touch screen.
 */
function PhaseDots({ phases, className = '', letters = true }) {
  if (!phases) return null
  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}>
      {PHASES.map(p => {
        const on = phases[p.key] === true
        const colour = on ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)'
        return (
          <span
            key={p.key}
            aria-label={`${p.label} ${on ? 'on' : 'off'}`}
            title={`${p.label} is ${on ? 'ON' : 'OFF'}`}
            className="inline-flex items-center gap-[1px] text-[8px] font-bold leading-none"
            style={{ color: colour }}
          >
            <span
              aria-hidden="true"
              className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: colour, boxShadow: `0 0 0 1px ${colour}` }}
            />
            {letters && p.label[0]}
          </span>
        )
      })}
    </span>
  )
}

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
