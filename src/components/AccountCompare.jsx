// Account Comparison — the side-by-side view the Accounts page exists for
// (owner 02-08-2026: "capable to switch account and compare the account
// capabilities and competency and efficiency"). One column per account,
// the same server-computed health metrics AccountHealth shows one account
// at a time, so the numbers agree by construction. Columns are filterable
// with M3 filter chips; needs the all-accounts snapshot (the page's "Show
// my other accounts" fetch) — until then it explains what to press.
import { useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import Collapse from './common/Collapse.jsx'
import { accountNumbers } from "../lib/scope-label.js"

const METRICS = [
  { key: 'balance', label: 'Account balance' },
  { key: 'equity', label: 'Equity (balance + floating P/L)' },
  { key: 'usedMargin', label: 'Margin used' },
  { key: 'freeMargin', label: 'Free margin (your buffer)' },
  { key: 'unrealizedNetPnl', label: 'Unrealized P/L (net)', signed: true, pctKey: 'unrealizedNetPnlPct' },
  { key: 'slNetTotal', label: 'If ALL stop losses hit — net', signed: true, pctKey: 'slNetTotalPct' },
  { key: 'tpNetTotal', label: 'If ALL take profits hit — net', signed: true, pctKey: 'tpNetTotalPct' },
]

const money = (n) => (n == null || Number.isNaN(Number(n))
  ? '—'
  : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export default function AccountCompare({ accounts, onNeedAll, loading }) {
  const [hidden, setHidden] = useState(() => new Set())
  const all = accounts || []
  const shown = all.filter(a => !hidden.has(a.accountId))
  const toggle = (id) => setHidden(h => {
    const n = new Set(h)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  return (
    <Card id="sec-compare">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-(length:--fs-body) font-semibold">Account Comparison table</div>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">
          every account side by side — same broker-truth health figures as each Account Health table
        </span>
      </div>
      {all.length < 2 && (
        <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">
          Needs the all-accounts snapshot —{' '}
          <button type="button" onClick={onNeedAll} disabled={loading}
            className="text-[var(--color-accent)] underline cursor-pointer disabled:opacity-50">
            {loading ? 'fetching all accounts…' : 'fetch all accounts'}
          </button>{' '}
          (~5s per account, broker round-trips).
        </p>
      )}
      {all.length >= 2 && (
        <>
          {/* M3 filter chips — many-of-N column filter. */}
          <div className="flex flex-wrap items-center gap-1 mb-2 text-(length:--fs-body)" role="group" aria-label="Accounts to compare">
            {all.map(a => {
              const on = !hidden.has(a.accountId)
              return (
                <button key={a.accountId} type="button" aria-pressed={on} onClick={() => toggle(a.accountId)}
                  className={`rounded-[8px] px-2 h-[32px] font-semibold cursor-pointer border transition-colors ${on
                    ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] border-transparent'
                    : 'border-[var(--md-outline-variant)] text-[var(--md-on-surface)]'}`}>
                  {on ? '✓ ' : ''}{a.isLive ? 'Live' : 'Demo'} · {accountNumbers(a)}
                </button>
              )
            })}
          </div>
          <div className="overflow-x-auto">
            <Collapse id="AccountCompare" label="Comparison Rows">
              <table className="std-cols w-full text-(length:--fs-body) tabular-nums">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="py-1 pr-3 text-left">Metric</th>
                    {shown.map(a => (
                      <th key={a.accountId} className="py-1 px-2 text-right whitespace-nowrap">
                        {accountNumbers(a)} <Badge tone={a.isLive ? 'down' : 'info'}>{a.isLive ? 'LIVE' : 'DEMO'}</Badge>
                        {a.selected && <span className="block font-normal text-[var(--color-muted)]">bot trades this one</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map(m => (
                    <tr key={m.key} className="border-t border-[var(--glass-edge)]">
                      <td className="py-1 pr-3">{m.label}</td>
                      {shown.map(a => {
                        const v = a.health?.[m.key]
                        const pct = m.pctKey ? a.health?.[m.pctKey] : null
                        return (
                          <td key={a.accountId}
                            className={`py-1 px-2 text-right whitespace-nowrap ${m.signed && v != null ? (v > 0 ? 'text-[var(--color-up)]' : v < 0 ? 'text-[var(--color-down)]' : '') : ''}`}>
                            {m.signed && v > 0 ? '+' : ''}{money(v)}{a.currency ? ` ${a.currency}` : ''}
                            {pct != null && <span className="text-[var(--color-muted)]"> · {pct > 0 ? '+' : ''}{Number(pct).toFixed(2)}%</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  <tr className="border-t border-[var(--glass-edge)]">
                    <td className="py-1 pr-3">Open positions · pending orders</td>
                    {shown.map(a => (
                      <td key={a.accountId} className="py-1 px-2 text-right whitespace-nowrap">
                        {a.positions?.length ?? 0} · {a.orders?.length ?? 0}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </Collapse>
          </div>
        </>
      )}
    </Card>
  )
}
