// Reasons — PR-F (owner principle 4: "every trade has a reason"). The twelve
// attribution endpoints the agent has served since the ledger / plan /
// refusal work, read by no page until now. Each block renders the
// endpoint's OWN fields (src/lib/reasons-view.js shapes them generically);
// an endpoint that cannot be read says so per block — 401, network, 500 —
// rather than the page hiding it. No client-side arithmetic anywhere.
import { useCallback, useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import Button from '../components/common/Button.jsx'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { REASON_ENDPOINTS, shapeBody, blockState, fmtCell } from '../lib/reasons-view.js'

export function ReasonsBlock({ def, result, at }) {
  const st = blockState(result)
  return (
    <Card className="p-3" kind="reasons" data-reasons-block={def.key} data-status={st.status} scope="all">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
        <h3 className="text-(length:--fs-h) font-bold">{def.title}</h3>
        <code className="text-(length:--fs-body) text-[var(--color-text-sub)]">GET {def.path}</code>
        {at && <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">read {at}</span>}
      </div>
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-2">{def.why}</p>
      {st.status === 'error'
        ? <p className="text-(length:--fs-body) font-semibold text-[var(--color-down)]" data-not-read>{st.message}</p>
        : <BodyView body={st.body} />}
    </Card>
  )
}

function KV({ pairs }) {
  if (!pairs.length) return null
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-(length:--fs-body)">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--color-text-sub)] whitespace-nowrap">{k}</dt>
          <dd className="font-semibold break-words">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function BodyView({ body }) {
  const s = shapeBody(body)
  const empty = !s.scalars.length && !s.objects.length && !s.tables.length && !s.lists.length
  if (empty) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">the endpoint returned no fields</p>
  return (
    <div className="space-y-2">
      <KV pairs={s.scalars} />
      {s.lists.length > 0 && <KV pairs={s.lists} />}
      {s.objects.map(o => (
        <div key={o.key} className="border-t border-[var(--color-border)] pt-1">
          <div className="text-(length:--fs-body) font-semibold mb-0.5">{o.key}</div>
          <KV pairs={[...o.scalars, ...o.nested]} />
        </div>
      ))}
      {s.tables.map(t => (
        <div key={t.key} className="border-t border-[var(--color-border)] pt-1">
          <div className="text-(length:--fs-body) font-semibold mb-0.5">{t.key} <span className="font-normal text-[var(--color-text-sub)]">— {t.rows.length === t.total ? `${t.total} row${t.total === 1 ? '' : 's'}` : `first ${t.rows.length} of ${t.total} rows`}</span></div>
          <div className="overflow-x-auto">
            <table className="text-(length:--fs-body) whitespace-nowrap">
              <thead><tr>{t.columns.map(c => <th key={c} className="text-left pr-3 font-semibold text-[var(--color-text-sub)]">{c}</th>)}</tr></thead>
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    {t.columns.map(c => <td key={c} className="pr-3 py-0.5 max-w-[280px] truncate" title={fmtCell(r[c])}>{fmtCell(r[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function Reasons() {
  const [results, setResults] = useState({})
  const [at, setAt] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    if (!agentConfigured()) {
      setResults(Object.fromEntries(REASON_ENDPOINTS.map(d => [d.key, { ok: false, error: 'agent not connected — configure it on the Connect tab' }])))
      return
    }
    setBusy(true)
    const entries = await Promise.all(REASON_ENDPOINTS.map(async d => {
      try { return [d.key, { ok: true, body: await agentGet(d.path) }] } catch (e) { return [d.key, { ok: false, error: e.message }] }
    }))
    setResults(Object.fromEntries(entries))
    setAt(new Date().toLocaleTimeString())
    setBusy(false)
  }, [])
  useEffect(() => {
    // Deferred first read (the same async-apply shape the cockpit uses) so
    // the effect body itself sets no state.
    const t0 = setTimeout(load, 0)
    const t = setInterval(() => { if (!pageAsleep()) load() }, 60_000)
    return () => { clearTimeout(t0); clearInterval(t) }
  }, [load])
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-(length:--fs-title) font-extrabold tracking-tight">Reasons</h1>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">twelve attribution reads, each shown with the agent's own fields — nothing computed here</span>
        <Button size="sm" variant="subtle" className="ml-auto" disabled={busy} onClick={load}>{busy ? 'reading…' : 'Re-read'}</Button>
      </div>
      {REASON_ENDPOINTS.map(d => <ReasonsBlock key={d.key} def={d} result={results[d.key]} at={at} />)}
    </div>
  )
}
