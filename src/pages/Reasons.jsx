// Reasons — PR-F (owner principle 4: "every trade has a reason"). The
// attribution endpoints the agent has served since the ledger / plan /
// refusal work. Each block renders the endpoint's OWN fields
// (src/lib/reasons-view.js shapes them generically); an endpoint that
// cannot be read says so per block — 401, network, 500 — rather than the
// page hiding it. No client-side arithmetic anywhere.
//
// UI-6 (26-09 UI plan §2 RS-1b/RS-2, "Reasons restructure and tables"):
// ReasonsBlockContent is the endpoint-rendering half with no outer Card, so
// it can sit alone (ReasonsBlock, unchanged for every existing caller) or
// grouped with other endpoints under one shared heading (ReasonsGroup — "one
// Ledger integrity card", "Vetoes: count and cost", Unknown P/L absorbing
// Unresolvable plan). PhaseAuditSection and ExitCounterfactualSection are the
// two blocks RS-1 moves off this page onto Desk and Tune; they fetch their
// own endpoint independently so Desk/Tune need nothing from Reasons' own
// load() loop.
import { useCallback, useEffect, useState } from 'react'
import Card from '../components/common/Card.jsx'
import Button from '../components/common/Button.jsx'
import ScopeChip from '../components/common/ScopeChip.jsx'
import DataTable from '../components/common/DataTable.jsx'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { REASON_ENDPOINTS, REASONS_PAGE_KEYS, REASONS_PAGE_LAYOUT, shapeBody, blockState, fmtCell, reasonScope, reasonsGroupId } from '../lib/reasons-view.js'

export function ReasonsBlockContent({ def, result, at }) {
  const st = blockState(result)
  const scope = reasonScope(def, result)
  return (
    <div data-reasons-block={def.key} data-status={st.status}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
        <h3 className="text-(length:--fs-h) font-bold">{def.title}</h3>
        <code className="text-(length:--fs-body) text-[var(--color-text-sub)]">GET {def.path}</code>
        {at && <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">read {at}</span>}
        {scope !== undefined && <ScopeChip scope={scope} style={{ opacity: .85 }} />}
      </div>
      {scope === undefined && <p className="text-(length:--fs-body) text-[var(--color-warning-text)]" data-scope-unavailable>Scope unavailable for this read</p>}
      <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-2">{def.why}</p>
      {st.status === 'error'
        ? <p className="text-(length:--fs-body) font-semibold text-[var(--color-down)]" data-not-read>{st.message}</p>
        : <BodyView body={st.body} maxRows={def.maxRows} keyedTables={def.keyedTables} expand={def.expand} blockKey={def.key} />}
    </div>
  )
}

/**
 * A single endpoint, in its own Card — unchanged shape for every existing
 * caller. W1-FU (26-09 plan §5): `id`/`loading`/`defaultCollapsed` are
 * forwarded straight to Card (its own `loading` reserves height while the
 * read is in flight, PERF-1; `id` also lets Card derive its T/F/C content-kind
 * badge from lib/nav-tree.js instead of the old literal "reasons" string).
 * Every prop is optional, so a caller (the tests) that passes none keeps the
 * old behaviour.
 */
export function ReasonsBlock({ def, result, at, id, loading, defaultCollapsed }) {
  return (
    <Card className="p-3" id={id} loading={loading} defaultCollapsed={defaultCollapsed} lazy>
      <ReasonsBlockContent def={def} result={result} at={at} />
    </Card>
  )
}

/**
 * Several endpoints folded under ONE shared heading and ONE Card (RS-1:
 * "Absorb Unresolvable plan", "One 'Ledger integrity' card", the refusal-cost
 * card merged with the veto breakdown; W1-FU's "fold Trade consistency into
 * Ledger integrity"). Each endpoint keeps its own data-reasons-block/
 * data-status and its own per-block error/scope state — folding is
 * presentation only, never a merged read.
 */
export function ReasonsGroup({ heading, blocks, id, loading, defaultCollapsed }) {
  return (
    <Card className="p-3" id={id} loading={loading} defaultCollapsed={defaultCollapsed} lazy data-reasons-group={heading}>
      <h2 className="text-(length:--fs-h) font-bold mb-1">{heading}</h2>
      <div className="space-y-3">
        {blocks.map(({ def, result, at }, i) => (
          <div key={def.key} className={i > 0 ? 'border-t border-[var(--color-border)] pt-2' : ''}>
            <ReasonsBlockContent def={def} result={result} at={at} />
          </div>
        ))}
      </div>
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

// RS-2 (26-09 UI plan §2/§3, "Reasons tables"): the old improvised table
// (cells clipped at 280px with the full text only on hover, a hard 25-row
// cut, no sort/pager/sticky header) replaced with §3's shared DataTable — a
// 15-row viewport that scrolls both ways instead of squashing columns, a
// sticky header, and tap-to-sort. Reasons' own tables have no common "at"
// field to group by day (unlike the blockers table this component was built
// for), so each renders as ONE ungrouped section, named and counted exactly
// as the old table said it ("first N of M rows"/"N rows") — nothing computed
// that the endpoint did not already return in `total`/`rows.length`.
function GenericTable({ blockKey, t }) {
  const columns = t.columns.map(c => ({
    key: c, label: c, sortAccessor: r => r[c],
    render: r => <span className="max-w-[280px] truncate inline-block align-top" title={fmtCell(r[c])}>{fmtCell(r[c])}</span>,
  }))
  const groups = [{
    key: 'all', label: t.key,
    sub: ` — ${t.rows.length === t.total ? `${t.total} row${t.total === 1 ? '' : 's'}` : `first ${t.rows.length} of ${t.total} rows`}`,
    rows: t.rows,
  }]
  return (
    <div className="border-t border-[var(--color-border)] pt-1">
      <DataTable id={`reasons-${blockKey}-${t.key}`} columns={columns} groups={groups} emptyMessage="No rows returned." />
    </div>
  )
}

function BodyView({ body, maxRows, keyedTables, expand, blockKey }) {
  const s = shapeBody(body, { ...(maxRows ? { maxRows } : {}), ...(keyedTables ? { keyedTables } : {}), ...(expand ? { expand } : {}) })
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
          {/* UI-6 (RS-1: "make the origin breakdown the headline") — a nested
              flat count map the endpoint's def opted into `expand`ing, shown
              as its own KV list instead of hidden behind "N field(s)". */}
          {o.expanded?.map(e => (
            <div key={e.key} className="mt-1 pl-2 border-l-2 border-[var(--color-border)]">
              <div className="text-(length:--fs-body) font-semibold text-[var(--color-text-sub)] mb-0.5">{e.key}</div>
              <KV pairs={e.pairs} />
            </div>
          ))}
        </div>
      ))}
      {s.tables.map(t => <GenericTable key={t.key} blockKey={blockKey} t={t} />)}
    </div>
  )
}
export default function Reasons() {
  const [results, setResults] = useState({})
  const [at, setAt] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    // UI-6 (RS-1b): Reasons fetches only the endpoints it still shows —
    // phase-audit and exit-counterfactual moved to Desk/Tune and fetch
    // themselves there (PhaseAuditSection/ExitCounterfactualSection below).
    const pageEndpoints = REASON_ENDPOINTS.filter(d => REASONS_PAGE_KEYS.includes(d.key))
    if (!agentConfigured()) {
      setResults(Object.fromEntries(pageEndpoints.map(d => [d.key, { ok: false, error: 'agent not connected — configure it on the Connect tab' }])))
      return
    }
    setBusy(true)
    const entries = await Promise.all(pageEndpoints.map(async d => {
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
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">thirteen attribution reads, each shown with the agent's own fields — nothing computed here (Phase audit is on Desk, Exit counterfactual on Tune)</span>
        <Button size="sm" variant="subtle" className="ml-auto" disabled={busy} onClick={load}>{busy ? 'reading…' : 'Re-read'}</Button>
      </div>
      {/* UI-6 (RS-1: "New order: Order lifecycle, Entry intents, Trade
          plans, Unknown P/L, Trade origin, Ledger integrity, then 'Vetoes:
          count and cost'"; Trade consistency folded into Ledger integrity,
          W1-FU — see reasons-view.js's REASONS_PAGE_LAYOUT comment).
          W1-FU (26-09 plan §5): every card past the first two on the page
          opens COLLAPSED by default (`defaultCollapsed`, Card's own
          card-open.js still remembers whatever the operator later chooses),
          and each card's own `loading` is true only until ITS OWN
          endpoint(s) have a result — never gated on every endpoint the page
          fetches, so a slow read on one block does not hold every other
          block at its loading-height floor (PERF-1). */}
      {REASONS_PAGE_LAYOUT.map((group, i) => {
        const defs = group.keys.map(k => REASON_ENDPOINTS.find(d => d.key === k)).filter(Boolean)
        if (defs.length === 0) return null
        const id = reasonsGroupId(group)
        const loading = defs.some(d => !results[d.key])
        const defaultCollapsed = i >= 2
        if (!group.heading && defs.length === 1) {
          const d = defs[0]
          return <ReasonsBlock key={d.key} def={d} result={results[d.key]} at={at} id={id} loading={loading} defaultCollapsed={defaultCollapsed} />
        }
        return (
          <ReasonsGroup key={group.heading || defs[0].key} heading={group.heading}
            blocks={defs.map(d => ({ def: d, result: results[d.key], at }))}
            id={id} loading={loading} defaultCollapsed={defaultCollapsed} />
        )
      })}
    </div>
  )
}

// UI-6 (RS-1: "Phase audit ... Move to Desk"; "Exit counterfactual ... Move
// to Tune"): both endpoints keep living here (reasons-view.js still owns
// their def and the shared shaping/rendering), but each fetches ITSELF —
// Desk and Tune need nothing added to their own already-large load()
// functions, and neither page's poll cadence has to match the other's.
function useReasonRead(key, { intervalMs = 60_000 } = {}) {
  const def = REASON_ENDPOINTS.find(d => d.key === key)
  const [result, setResult] = useState(null)
  const [at, setAt] = useState(null)
  useEffect(() => {
    if (!def) return undefined
    let stopped = false
    const read = async () => {
      if (!agentConfigured()) { if (!stopped) setResult({ ok: false, error: 'agent not connected — configure it on the Connect tab' }); return }
      try {
        const body = await agentGet(def.path)
        if (!stopped) { setResult({ ok: true, body }); setAt(new Date().toLocaleTimeString()) }
      } catch (e) {
        if (!stopped) setResult({ ok: false, error: e.message })
      }
    }
    const t0 = setTimeout(read, 0)
    const t = setInterval(() => { if (!pageAsleep()) read() }, intervalMs)
    return () => { stopped = true; clearTimeout(t0); clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `def` is looked up once from a static, module-level array
  }, [key, intervalMs])
  return { def, result, at }
}

/**
 * Phase audit, moved onto Desk (RS-1). No outer Card of its own — Desk's own
 * <Section> already provides the collapsible Card chrome, and nesting a
 * second Card inside it would double the glass-panel border for no reason.
 */
export function PhaseAuditSection() {
  const { def, result, at } = useReasonRead('phase-audit')
  if (!def) return null
  return <ReasonsBlockContent def={def} result={result} at={at} />
}

/** Exit counterfactual, moved onto Tune (RS-1). Same reasoning as above. */
export function ExitCounterfactualSection() {
  const { def, result, at } = useReasonRead('exit-counterfactual')
  if (!def) return null
  return <ReasonsBlockContent def={def} result={result} at={at} />
}
