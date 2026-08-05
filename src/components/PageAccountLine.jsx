// PageAccountLine — the account and its balance, on EVERY page.
//
// Owner (2026-07-30): "If the page isn't refresh in the web-app, i needed an
// account number in every webpage below the page title text to know which
// account I am using and what is the balance in 1 font size smaller than the
// page title."
//
// Page title is 12px (.t-h1/.t-heading in index.css), so one size smaller is
// 11px — .t-h2's size, used here directly rather than by class because this is
// not a heading and must not take the accent colour.
//
// PLACEMENT, stated because it is a deviation. This is mounted ONCE in App.jsx
// directly above the routed page content, not inserted under each page's title.
// Only three of the app's pages actually render an <h1> (Accounts,
// Accounts·Workflow audit, Risk); the rest open straight into cards. Inserting
// per page would have missed most of them and silently drifted as pages change,
// and the owner's requirement is that the account is on EVERY page. One mount
// point gets that guarantee. On those three pages the line sits just above the
// title rather than just below it.
//
// It also carries the three phase lights, so "which account am I on and is it
// actually working" is one glance on every page rather than a trip to the
// sidebar.
import { PHASES } from '../lib/account-phases.js'
import { useActiveAccount, formatBalance } from '../lib/use-active-account.js'
import { accountNumbers } from "../lib/scope-label.js"

export default function PageAccountLine() {
  const { acct, phases, armed, ccy } = useActiveAccount()
  if (!acct) return null
  const trading = armed === true
  const label = `${acct.isLive ? 'LIVE' : 'DEMO'} ${accountNumbers(acct)}`
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 text-(length:--fs-body) leading-[1.35]">
      <span
        className={`font-bold tabular-nums ${trading ? 'text-[var(--color-state-on-text)]' : 'text-[var(--color-muted)]'}`}
        title={trading
          ? 'Autotrade is ARMED on this account'
          : 'Autotrade is OFF on this account — no new entries'}
      >
        {label}
      </span>
      <span className="font-semibold tabular-nums text-[var(--color-text-sub)]">
        {formatBalance(acct.balance, ccy)}
      </span>
      {/* Phase lights, same vocabulary as the sidebar: blue on, red off. */}
      {phases && (
        <span className="inline-flex items-center gap-1">
          {PHASES.map(p => {
            const on = phases[p.key] === true
            return (
              <span
                key={p.key}
                title={`${p.label} is ${on ? 'ON' : 'OFF'}`}
                className="inline-flex items-center gap-[3px] text-(length:--fs-body) font-semibold uppercase tracking-wide"
                style={{ color: on ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)' }}
              >
                <span
                  aria-hidden="true"
                  className="h-[6px] w-[6px] rounded-full"
                  style={{ background: on ? 'var(--color-state-on-text)' : 'var(--color-state-off-text)' }}
                />
                {p.label}
              </span>
            )
          })}
        </span>
      )}
    </div>
  )
}
