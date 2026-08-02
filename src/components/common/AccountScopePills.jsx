// AccountScopePills — the one way a page says WHICH trading account its
// data is scoped to (owner 02-08-2026: "Right now I don't know the tune is
// for each account. bring the capability to switch account to see. This is
// very important for setups").
//
// Same pill vocabulary as the Performance page's account filter: an All
// pill plus one pill per registry account, labelled Live/Demo + the last
// digits of the broker login. Self-contained: fetches /state/accounts once,
// seeds the selection from the app-selected account, and reports changes up
// via onChange(accountId | 'all'). Pages that only support per-account view
// (no portfolio aggregate) can pass allowAll={false}.
import { useEffect, useState } from 'react'
import { agentGet } from '../../lib/agent-api.js'

// `allLabel` renames the All pill where "all" does not mean "every account's
// data merged". On the watchlist it means the SHARED list that accounts
// inherit until they are given one of their own — a different idea that
// needs a different word.
export default function AccountScopePills({ value, onChange, allowAll = true, note = null, allLabel = 'All' }) {
  const [accounts, setAccounts] = useState([])

  useEffect(() => {
    let alive = true
    agentGet('/state/accounts')
      .then(r => { if (alive) setAccounts(r?.accounts || []) })
      .catch(() => { /* pills render with All only; the page still works */ })
    return () => { alive = false }
  }, [])

  const pills = [
    ...(allowAll ? [{ id: 'all', label: allLabel }] : []),
    ...accounts.map(a => ({
      id: String(a.account_id),
      label: `${a.is_live ? 'Live' : 'Demo'} · ${String(a.trader_login || a.account_id).slice(-4)}`,
      disabled: !a.enabled,
    })),
  ]

  return (
    <div className="flex flex-wrap items-center gap-1 text-[9px]">
      <span className="font-semibold uppercase tracking-[.04em] text-[var(--color-text-sub)]">Account</span>
      {pills.map(p => {
        const on = String(value) === p.id
        return (
          <button key={p.id} type="button" aria-pressed={on} onClick={() => onChange(p.id)}
            title={p.disabled ? 'Disabled in the registry — history still viewable' : undefined}
            className={`rounded-full px-2.5 py-0.5 cursor-pointer border transition-colors ${on
              ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] border-transparent'
              : 'border-[var(--md-outline-variant)] text-[var(--md-on-surface)]'} ${p.disabled ? 'opacity-60' : ''}`}>
            {on ? '✓ ' : ''}{p.label}
          </button>
        )
      })}
      {note && <span className="text-[var(--color-muted)]">{note}</span>}
    </div>
  )
}
