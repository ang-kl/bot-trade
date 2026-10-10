// ---------------------------------------------------------------------------
// src/components/RiskMatrix.jsx — every risk setting, global and per account.
//
// Owner, 2026-08-04: "ACCOUNT card, change to a Summary table of the global +
// individual account's Risk setups and each table settings with collapsible
// triangle."
//
// The page could show ONE account's effective settings — whichever was
// selected — so "does LOGIN-3 run tighter than ACCT-DEMO-2, and where?" could
// only be answered by switching accounts and remembering. Overlays make that
// worse rather than better: an overlay is a PARTIAL config merged over the
// global one, so the same number can be an override on one account and an
// inherited value on the next, and nothing said which.
//
// THE ORIGIN IS THE POINT, not the number. Two accounts showing 1.00% for two
// different reasons behave differently the moment a default or the global
// value moves. A grid that renders both identically hides exactly what the
// operator opened it to see, so every cell says where its value came from:
//
//   bold          — this account's own overlay
//   plain         — inherited from the global config
//   dimmed with · — nobody has ever set it; still on the built-in default
// ---------------------------------------------------------------------------

import { useEffect, useState, useCallback } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import Collapse from './common/Collapse.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import { originOf } from '../lib/risk-origin.js'
import { showRiskValue, sameRiskValue } from '../lib/risk-format.js'

/** Local title — Risk.jsx's SectionTitle is defined inside that page, not shared. */
function SectionTitle({ children }) {
  return <h3 className="w3-heading text-(length:--fs-h) font-semibold mb-1">{children}</h3>
}

// Display: the shared formatter (src/lib/risk-format.js). Claude · № 12,812
// 10-Oct: one formatter for this table and the page's override list; it also
// stops whole-percent keys printing ×100 (margin level floor 200% read 20000%).
const show = showRiskValue

const stamp = (iso) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** One cell, carrying its own provenance. */
function Cell({ k, values, overridden, globalOverridden, changed }) {
  const origin = originOf(k, { accountOverridden: overridden, globalOverridden })
  const ch = changed?.[k]
  const title = [
    origin === 'account' ? 'set on this account (overlay)'
      : origin === 'global' ? 'inherited from the global config'
        : 'built-in default — never set',
    ch ? `last changed ${stamp(ch.at)}${ch.by ? ` by ${ch.by}` : ''}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <td className="px-2 py-1.5" title={title}>
      <span className={
        origin === 'account' ? 'font-semibold text-[var(--color-accent)]'
          : origin === 'global' ? '' : 'text-[var(--color-text-sub)]'
      }>
        {show(k, values?.[k])}
      </span>
      {origin === 'default' && <span className="opacity-40 ml-0.5" title="still on the built-in default">·</span>}
    </td>
  )
}

export default function RiskMatrix() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  // View filter only (Claude · № 12,812 10-Oct): hides rows whose value is the
  // same on every account and the global config. Nothing is changed or saved.
  const [onlyDiff, setOnlyDiff] = useState(false)

  const load = useCallback(() => {
    if (!agentConfigured()) return
    agentGet('/state/risk-matrix').then(setData).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  if (!agentConfigured()) return null
  if (error) return (
    <Card id="sec-risk-matrix" data-risk-card>
      <SectionTitle>Risk Setup Summary — Table</SectionTitle>
      <div className="text-(length:--fs-body) text-[var(--color-warning-text)]">Could not load: {error}</div>
    </Card>
  )
  if (!data) return null

  const accounts = data.accounts || []
  const globalOverridden = data.global?.overridden || []
  const differs = (k) => accounts.some(a => !sameRiskValue(a.values?.[k], data.global?.values?.[k]))

  return (
    <Card id="sec-risk-matrix" data-risk-card className="w3-hover-shadow">
      <SectionTitle>Risk Setup Summary — Table</SectionTitle>
      <div className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-1">
        Global settings and every account&apos;s effective values.{' '}
        <span className="font-semibold text-[var(--color-accent)]">Bold</span> = set on that account ·
        plain = inherited from global · dimmed<span className="opacity-40">·</span> = built-in default.
        {accounts.length === 0 && ' No accounts in the registry yet — the global column is the whole picture.'}
      </div>
      <label className="flex items-center gap-2 text-(length:--fs-body) min-h-[44px] cursor-pointer">
        <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} className="w-5 h-5 accent-[var(--color-accent)]" />
        <span className="font-semibold">Only rows that differ between accounts</span>
        <span className="text-[var(--color-text-sub)]">· swipe the table sideways; the setting column stays put</span>
      </label>

      {/* A stored setting nothing reads is invisible in a table built from the
          groups — it has no row to appear in. Saying so here is the only place
          an operator finds out the number they set stopped mattering. */}
      {(data.retired || []).length > 0 && (
        <div className="text-(length:--fs-body) text-[var(--color-warning-text)] mb-1">
          Stored but no longer enforced:{' '}
          {data.retired.map(r => (
            <span key={`${r.key}@${r.where}`} className="mr-2" title={r.why}>
              <span className="font-semibold">{r.key}</span>
              {' = '}{show(r.key, r.value)}
              {' on '}{r.where}
            </span>
          ))}
          — safe to delete from the overlay.
        </div>
      )}

      {(data.groups || []).map(g => {
        const keys = onlyDiff ? g.keys.filter(differs) : g.keys
        return (
        <div key={g.id}>
          <Collapse id={`RiskMatrix_${g.id}`} label={onlyDiff ? `${g.label} · ${keys.length} of ${g.keys.length} differ` : g.label} defaultOpen={g.id === 'day'}>
            {keys.length === 0 ? (
              <div className="text-(length:--fs-body) text-[var(--color-text-sub)] py-1">Identical on every account and the global config.</div>
            ) : (
            <div className="risk-matrix-scroll overflow-x-auto rounded-[10px] border border-[var(--glass-edge)]">
            <table className="risk-matrix-table text-(length:--fs-body) tabular-nums min-w-max w-full">
              <thead>
                <tr className="text-left text-[var(--color-text-sub)]">
                  <th className="risk-matrix-key font-semibold">Setting</th>
                  <th className="px-2 font-semibold whitespace-nowrap">Global</th>
                  {accounts.map(a => (
                    <th key={a.accountId} className="px-2 font-semibold whitespace-nowrap" title={a.accountId}>
                      <span className="block">…{String(a.accountId).slice(-4)}</span>
                      {a.isLive ? <Badge tone="down">LIVE</Badge> : <Badge tone="info">DEMO</Badge>}
                      {!a.enabled && <span className="ml-1 text-[var(--color-text-sub)]" title="disabled in the registry">off</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k} className="border-t border-[var(--color-border)]">
                    <th scope="row" className="risk-matrix-key font-normal text-left">
                      {/* Same deep link as the proposal rows — one triangle
                          convention on this page, not two. */}
                      <a href={`#risk-${k}`} className="mr-1 text-[var(--color-text-sub)] hover:text-[var(--color-accent)]"
                         title={`Jump to ${k} below`}>▸</a>
                      {k}
                    </th>
                    <Cell k={k} values={data.global?.values} overridden={globalOverridden}
                          globalOverridden={globalOverridden} changed={data.global?.changed} />
                    {accounts.map(a => (
                      <Cell key={a.accountId} k={k} values={a.values} overridden={a.overridden}
                            globalOverridden={globalOverridden} changed={a.changed} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            )}
          </Collapse>
        </div>
        )
      })}
    </Card>
  )
}
