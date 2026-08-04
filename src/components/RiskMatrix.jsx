// ---------------------------------------------------------------------------
// src/components/RiskMatrix.jsx — every risk setting, global and per account.
//
// Owner, 2026-08-04: "ACCOUNT card, change to a Summary table of the global +
// individual account's Risk setups and each table settings with collapsible
// triangle."
//
// The page could show ONE account's effective settings — whichever was
// selected — so "does 5203012 run tighter than 46130058, and where?" could
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

/** Local title — Risk.jsx's SectionTitle is defined inside that page, not shared. */
function SectionTitle({ children }) {
  return <h3 className="w3-heading text-[11px] font-semibold mb-1">{children}</h3>
}

/** Compact display. Percent-shaped keys are stored as fractions. */
const PCT_KEYS = /Pct$|^deriskTriggerPct$|FracOf/
function show(key, v) {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? `${v.length} listed` : 'none'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number' && PCT_KEYS.test(key)) return `${Number((v * 100).toFixed(4))}%`
  return String(v)
}

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
    <td className="pr-3 py-0.5 whitespace-nowrap" title={title}>
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

  const load = useCallback(() => {
    if (!agentConfigured()) return
    agentGet('/state/risk-matrix').then(setData).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  if (!agentConfigured()) return null
  if (error) return (
    <Card id="sec-risk-matrix" data-risk-card>
      <SectionTitle>Risk Setup Summary — Table</SectionTitle>
      <div className="text-[9px] text-[var(--color-warning-text)]">Could not load: {error}</div>
    </Card>
  )
  if (!data) return null

  const accounts = data.accounts || []
  const globalOverridden = data.global?.overridden || []

  return (
    <Card id="sec-risk-matrix" data-risk-card className="w3-hover-shadow">
      <SectionTitle>Risk Setup Summary — Table</SectionTitle>
      <div className="text-[9px] text-[var(--color-text-sub)] mb-1">
        Global settings and every account&apos;s effective values.{' '}
        <span className="font-semibold text-[var(--color-accent)]">Bold</span> = set on that account ·
        plain = inherited from global · dimmed<span className="opacity-40">·</span> = built-in default.
        {accounts.length === 0 && ' No accounts in the registry yet — the global column is the whole picture.'}
      </div>

      {/* A stored setting nothing reads is invisible in a table built from the
          groups — it has no row to appear in. Saying so here is the only place
          an operator finds out the number they set stopped mattering. */}
      {(data.retired || []).length > 0 && (
        <div className="text-[9px] text-[var(--color-warning-text)] mb-1">
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

      {(data.groups || []).map(g => (
        <div key={g.id} className="overflow-x-auto">
          <Collapse id={`RiskMatrix_${g.id}`} label={g.label} defaultOpen={g.id === 'day'}>
            <table className="w-full text-[9px] tabular-nums">
              <thead>
                <tr className="text-left text-[var(--color-text-sub)]">
                  <th className="pr-3 font-semibold">Setting</th>
                  <th className="pr-3 font-semibold">Global</th>
                  {accounts.map(a => (
                    <th key={a.accountId} className="pr-3 font-semibold whitespace-nowrap">
                      {a.accountId}{' '}
                      {a.isLive ? <Badge tone="down">LIVE</Badge> : <Badge tone="info">DEMO</Badge>}
                      {!a.enabled && <span className="ml-1 text-[var(--color-text-sub)]" title="disabled in the registry">off</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {g.keys.map(k => (
                  <tr key={k} className="border-t border-[var(--color-border)]">
                    <td className="pr-3 py-0.5">
                      {/* Same deep link as the proposal rows — one triangle
                          convention on this page, not two. */}
                      <a href={`#risk-${k}`} className="mr-1 text-[var(--color-text-sub)] hover:text-[var(--color-accent)]"
                         title={`Jump to ${k} below`}>▸</a>
                      {k}
                    </td>
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
          </Collapse>
        </div>
      ))}
    </Card>
  )
}
