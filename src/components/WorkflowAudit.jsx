// WorkflowAudit — the design_claude "Trade Workflow Audit" screen: does
// every trade run the full O-I-A pipeline (Lab analysis → Bridge risk gate
// → Market management), and when one was cut short, was the early stop
// justified or premature? Wired to real closed trades; every claim is
// derived from recorded fields (close_reason, provenance labels,
// postmortem classification, PR-A entry latency) — what was never
// recorded shows "—" or an explicit "no recorded rationale", never a
// guess. GSAP animates the market-path stepper when the filter changes,
// guarded on window.gsap exactly like Risk.
import { useEffect, useMemo, useRef, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'

const nf = (d = 2) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
const signed = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf(d).format(Number(v))}`)
const UP = 'text-[var(--color-up)]'
const DOWN = 'text-[var(--color-down)]'
const WARN = 'text-[var(--color-warning-text)]'
const SUB = 'text-[var(--color-text-sub)]'

const parseTs = (iso) => {
  if (!iso) return null
  const raw = String(iso).replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z')
  return Number.isFinite(t) ? t : null
}
const fmtDur = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${nf(1).format(s)}s`
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 24) return `${nf(1).format(h)}h`
  return `${nf(1).format(h / 24)}d`
}
const fmtWhen = (ms) => (ms == null ? '—' : new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))

// Close kind from the recorded close_reason — TP / Trail / SL / Manual.
function closeKind(reason) {
  const r = String(reason || '').toLowerCase()
  if (/partial|scale/.test(r)) return 'Trail'
  const tp = /\btp\b|take.?profit|target|bank/.test(r)
  const sl = /\bsl\b|stop.?loss|stopped|stop hit/.test(r)
  if (tp && !sl) return 'TP'
  if (sl && !tp) return 'SL'
  if (/trail|break.?even|be moved/.test(r)) return 'Trail'
  return 'Manual'
}

// Rationale keywords that make an early stop JUSTIFIED — every one of
// these is a reason the bot (or owner) records deliberately.
const JUSTIFIED_RE = /time.?cap|invalidat|thesis|weekend|equity|risk|drawdown|news|correlat|session close|margin/

// Build one audit row per closed trade. `pmByTrade` maps trade_id →
// postmortem (classification/detail) when the sweep has run.
function buildRows(trades, pmByTrade) {
  return trades
    .filter(t => t.status === 'closed' && t.net_pnl != null)
    .map(t => {
      const openedMs = parseTs(t.opened_at)
      const closedMs = parseTs(t.closed_at)
      const held = t.hold_duration_ms ?? (openedMs != null && closedMs != null ? closedMs - openedMs : null)
      const pm = pmByTrade[t.id]
      const kind = closeKind(t.close_reason)
      const lab = t.analysis_id != null || !!(t.label_strategy || t.strategy)
      const bridge = t.source === 'autopilot' || t.source === 'copilot'
      let cls = 'full' // full | justified | premature
      if (kind === 'Manual') {
        const justified = JUSTIFIED_RE.test(String(t.close_reason || '').toLowerCase())
          || pm?.classification === 'time_cap'
        cls = justified ? 'justified' : 'premature'
      }
      const reasoning = [
        t.close_reason || 'no recorded rationale — review',
        pm?.classification ? `postmortem: ${pm.classification}` : null,
      ].filter(Boolean).join(' · ')
      return {
        id: t.id, sym: t.symbol, side: t.side,
        strat: t.label_strategy || t.strategy || '—',
        openedMs, closedMs, held,
        p2l: t.entry_latency_ms ?? null, // PR-A collect-forward: submit→fill
        lab, bridge, kind, cls, reasoning,
        pnl: Number(t.net_pnl),
      }
    })
    .sort((a, b) => (b.closedMs ?? 0) - (a.closedMs ?? 0))
}

// The market-path stepper: 4 nodes joined by 3 segments, per-segment
// durations above the line. Only pending→live (entry latency) and the
// total managed→close hold are recorded today — the middle segment shows
// an honest "—" until collect-forward stamps it.
function Stepper({ row }) {
  const segTone = row.cls === 'premature' ? 'bg-[var(--color-down)]' : row.cls === 'justified' ? 'bg-[var(--color-warning-text)]' : 'bg-[var(--color-accent)]'
  const nodeTone = row.cls === 'premature' ? 'bg-[var(--color-down)]' : row.cls === 'justified' ? 'bg-[var(--color-warning-text)]' : 'bg-[var(--color-accent)]'
  const seg = (label) => (
    <div className="flex-1 min-w-[36px]">
      <div className={`text-center text-[8px] tabular-nums ${SUB}`}>{label}</div>
      <div data-audit-seg className={`h-[2px] rounded ${segTone} origin-left`} />
    </div>
  )
  const node = (title, terminal = false) => (
    <div data-audit-node title={title}
      className={`w-[7px] h-[7px] shrink-0 ${row.cls === 'premature' && terminal ? 'rounded-[1px] rotate-45' : 'rounded-full'} ${terminal ? nodeTone : 'bg-[var(--glass-edge)]'}`} />
  )
  return (
    <div className="flex items-end gap-1" aria-label={`pipeline: pending → live → managed → ${row.kind === 'Manual' ? 'early stop' : 'closed'}`}>
      {node('pending')}
      {seg(fmtDur(row.p2l))}
      {node('live')}
      {seg('—')}
      {node('managed')}
      {seg(fmtDur(row.held))}
      {node(row.kind === 'Manual' ? 'early stop' : 'closed', true)}
    </div>
  )
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'full', label: 'Full pipeline' },
  { key: 'justified', label: 'Early stop · justified' },
  { key: 'premature', label: 'Early stop · premature' },
]

export default function WorkflowAudit({ allTrades, postmortems }) {
  const [flt, setFlt] = useState('all')
  const wrapRef = useRef(null)

  const pmByTrade = useMemo(() => {
    const map = {}
    for (const pm of postmortems || []) if (pm.trade_id != null) map[pm.trade_id] = pm
    return map
  }, [postmortems])

  const rows = useMemo(() => buildRows(allTrades || [], pmByTrade), [allTrades, pmByTrade])
  const counts = useMemo(() => ({
    all: rows.length,
    full: rows.filter(r => r.cls === 'full').length,
    justified: rows.filter(r => r.cls === 'justified').length,
    premature: rows.filter(r => r.cls === 'premature').length,
  }), [rows])
  const view = useMemo(() => (flt === 'all' ? rows : rows.filter(r => r.cls === flt)).slice(0, 30), [rows, flt])

  // Lab/Bridge phase pass counts across everything shown.
  const phases = useMemo(() => ({
    lab: rows.filter(r => r.lab).length,
    bridge: rows.filter(r => r.bridge).length,
    market: rows.length,
  }), [rows])
  const integrity = counts.all ? Math.round((counts.full / counts.all) * 100) : null

  // GSAP replay on filter change — degrade to static when the CDN is
  // blocked (same guard convention as Risk).
  useEffect(() => {
    const g = typeof window !== 'undefined' ? window.gsap : null
    const el = wrapRef.current
    if (!g || !el) return
    const segs = el.querySelectorAll('[data-audit-seg]')
    const nodes = el.querySelectorAll('[data-audit-node]')
    if (!segs.length) return
    g.fromTo(segs, { scaleX: 0 }, { scaleX: 1, duration: 0.4, stagger: 0.02, ease: 'power2.out' })
    g.fromTo(nodes, { scale: 0.3 }, { scale: 1, duration: 0.35, stagger: 0.015, ease: 'back.out(2)' })
  }, [view])

  const phaseCard = (title, sub, passed, total) => (
    <div className="glass-inset rounded-[10px] px-3 py-2 flex-1 min-w-[150px]">
      <div className={`text-[9px] uppercase font-bold ${SUB}`}>{title}</div>
      <div className="text-[16px] font-black tabular-nums">{total ? `${passed}/${total}` : '—'}</div>
      <div className={`text-[9px] ${SUB}`}>{sub}</div>
    </div>
  )

  return (
    <div ref={wrapRef}>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {phaseCard('Lab · analysis', 'strategy/analysis attached', phases.lab, phases.market)}
        {phaseCard('Bridge · risk gate', 'placed via bot pipeline', phases.bridge, phases.market)}
        {phaseCard('Market · managed', 'closed round-trips audited', phases.market, phases.market)}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-2" role="radiogroup" aria-label="Audit filter">
        {FILTERS.map(f => (
          <button key={f.key} type="button" role="radio" aria-checked={flt === f.key}
            onClick={() => setFlt(f.key)}
            className={`rounded-full px-3 py-1 min-h-[28px] text-[11px] font-semibold cursor-pointer ${flt === f.key
              ? 'bg-[var(--color-accent)] text-white shadow-[var(--glow-accent)]'
              : `glass-inset ${SUB}`}`}>
            {f.label} <span className="opacity-70 tabular-nums">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {view.length === 0 && <p className={`text-[12px] ${SUB}`}>No closed trades in this bucket yet.</p>}
      {view.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] tabular-nums min-w-[900px]">
            <thead>
              <tr className={`border-b border-[var(--color-border)] text-[9px] uppercase tracking-wide ${SUB}`}>
                <th className="py-1 pr-2 font-bold">In → out</th>
                <th className="py-1 px-2 font-bold">Symbol</th>
                <th className="py-1 px-2 font-bold">Strategy</th>
                <th className="py-1 px-2 font-bold text-center">Lab</th>
                <th className="py-1 px-2 font-bold text-center">Bridge</th>
                <th className="py-1 px-2 font-bold min-w-[190px]">Market path</th>
                <th className="py-1 px-2 font-bold">Close</th>
                <th className="py-1 px-2 font-bold min-w-[185px]">Reasoning</th>
                <th className="py-1 pl-2 font-bold text-right">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {view.map(r => (
                <tr key={r.id} className={`border-b border-[var(--color-border)] align-top ${r.cls === 'premature' ? 'bg-[var(--color-error-bg)]' : ''}`}>
                  <td className={`py-1.5 pr-2 whitespace-nowrap ${SUB}`}>
                    {fmtWhen(r.openedMs)}<br />{fmtWhen(r.closedMs)} · held {fmtDur(r.held)}
                  </td>
                  <td className="py-1.5 px-2 whitespace-nowrap">
                    <span className="font-extrabold">{r.sym}</span> <span className={`text-[9px] font-semibold ${String(r.side).toUpperCase() === 'BUY' ? UP : DOWN}`}>{r.side}</span>
                  </td>
                  <td className={`py-1.5 px-2 ${SUB}`}>{r.strat}</td>
                  <td className="py-1.5 px-2 text-center">{r.lab ? <span className={UP}>✓</span> : <span className={DOWN}>✕</span>}</td>
                  <td className="py-1.5 px-2 text-center">{r.bridge ? <span className={UP}>✓</span> : <span className={DOWN} title="not placed through the bot pipeline (manual/external)">✕</span>}</td>
                  <td className="py-1.5 px-2"><Stepper row={r} /></td>
                  <td className="py-1.5 px-2">
                    <Badge tone={r.cls === 'premature' ? 'down' : r.cls === 'justified' ? 'warning' : r.kind === 'SL' ? 'neutral' : 'info'}>{r.kind}</Badge>
                  </td>
                  <td className={`py-1.5 px-2 text-[10px] leading-snug ${r.cls === 'premature' ? WARN : SUB}`}>{r.reasoning}</td>
                  <td className={`py-1.5 pl-2 text-right font-bold ${r.pnl >= 0 ? UP : DOWN}`}>{signed(r.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        <Card className="!px-3 !py-2 flex-1 min-w-[160px]">
          <div className={`text-[9px] uppercase font-bold ${SUB}`}>Pipeline integrity</div>
          <div className={`text-[18px] font-black tabular-nums ${integrity == null ? SUB : integrity >= 80 ? UP : WARN}`}>{integrity == null ? '—' : `${integrity}%`}</div>
          <div className={`text-[9px] ${SUB}`}>closed by plan (TP/Trail/SL) vs all closed</div>
        </Card>
        <Card className="!px-3 !py-2 flex-1 min-w-[160px]">
          <div className={`text-[9px] uppercase font-bold ${SUB}`}>Early stops</div>
          <div className="text-[18px] font-black tabular-nums">
            <span className={WARN}>{counts.justified}</span><span className={SUB}> justified · </span><span className={DOWN}>{counts.premature}</span><span className={SUB}> premature</span>
          </div>
          <div className={`text-[9px] ${SUB}`}>premature = manual close with no recorded rationale</div>
        </Card>
      </div>
      <p className={`mt-1.5 text-[10px] ${SUB}`}>
        Lab = an analysis/strategy is attached · Bridge = placed through the bot's risk-gated pipeline · Market path shows submit→fill latency (collected from the forensics build forward), the managed span, and the close. The middle segment's duration isn't recorded yet — it shows — rather than a guess.
      </p>
    </div>
  )
}
