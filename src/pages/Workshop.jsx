// Workshop — observation-only drill-down for what the bot is thinking.
// Click any row in the activity table to inspect the full minion reports,
// synthesis JSON, or monitor check history. Read-only; no trading actions.

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { agentGet, agentConfigured, ROLES } from '../lib/agent-api.js'

function fmtAgo(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  if (!Number.isFinite(t)) return ''
  const ago = Date.now() - t
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
  return `${Math.floor(ago / 3_600_000)}h ${Math.floor((ago % 3_600_000) / 60_000)}m ago`
}
function fmtTime(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

const KIND_TONE = {
  scan: 'neutral', analysis: 'accent', monitor: 'info',
  trade: 'up', regime: 'neutral', flip: 'warning',
}

// ---------------------------------------------------------------------------
// Drill-down modal — fetches full detail for the selected row
// ---------------------------------------------------------------------------

function DetailModal({ row, role, onClose }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    async function load() {
      try {
        let d = null
        if (row.kind === 'analysis') {
          d = await agentGet(`/state/analysis/${row.id}`, role)
        } else if (row.kind === 'monitor') {
          d = await agentGet(`/state/position/${row.id}`, role)
        } else if (row.kind === 'scan') {
          const all = await agentGet(`/state/scans/${encodeURIComponent(row.symbol)}`, role)
          d = { scan: (all?.scans || []).find(s => s.id === row.id) || null }
        } else {
          d = { raw: row }
        }
        if (live) setDetail(d)
      } catch (e) { if (live) setError(e.message) }
    }
    load()
    return () => { live = false }
  }, [row, role])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" onClick={onClose}>
      <Card className="w-full max-w-3xl my-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Badge tone={KIND_TONE[row.kind] || 'neutral'} className="text-[9px] px-1.5">
              {row.kind.toUpperCase()}
            </Badge>
            <span className="t-label">{row.symbol}</span>
            <span className="text-[10px] text-[var(--color-muted)]">#{row.id} · {fmtTime(row.at)}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>

        {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

        {!detail && !error && (
          <p className="t-sub text-[var(--color-muted)] py-4 text-center">Loading…</p>
        )}

        {detail && row.kind === 'analysis' && <AnalysisDetail analysis={detail.analysis} />}
        {detail && row.kind === 'monitor' && <MonitorDetail detail={detail} />}
        {detail && row.kind === 'scan' && <ScanDetail scan={detail.scan} />}
        {detail && (row.kind === 'trade' || row.kind === 'regime' || row.kind === 'flip') && (
          <pre className="text-[10px] bg-[var(--color-bg)] p-3 rounded-[5px] overflow-x-auto">
            {JSON.stringify(detail.raw || row, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  )
}

function AnalysisDetail({ analysis }) {
  if (!analysis) return <p className="t-sub text-[var(--color-muted)]">Not found.</p>
  const reports = analysis.minion_reports || []
  const synth = analysis.synthesis_parsed || {}
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <div><span className="text-[var(--color-muted)]">Bias</span><br /><b>{synth.consensus_bias || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Conviction</span><br /><b>{synth.overall_conviction ?? '—'}/10</b></div>
        <div><span className="text-[var(--color-muted)]">Strategy</span><br /><b>{synth.strategy || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Auto-trade</span><br /><b>{synth.auto_trade ? 'YES' : 'no'}</b></div>
        <div><span className="text-[var(--color-muted)]">Entry</span><br /><b>{synth.entry ?? synth.entry_price ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">SL</span><br /><b>{synth.sl ?? synth.sl_price ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">TP1</span><br /><b>{synth.tp1 ?? synth.tp1_price ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">TP2</span><br /><b>{synth.tp2 ?? synth.tp2_price ?? '—'}</b></div>
      </div>
      {synth.synthesis && (
        <div className="text-[11px] bg-[var(--color-bg)] p-2 rounded-[5px] italic text-[var(--color-text-sub)]">
          {synth.synthesis}
        </div>
      )}
      {synth.dissent && (
        <div className="text-[11px] bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] text-[var(--color-warning-text)] p-2 rounded-[5px]">
          <b>Dissent:</b> {synth.dissent}
        </div>
      )}

      <div>
        <p className="t-label mb-1">Minion Reports ({reports.length})</p>
        {reports.length === 0 ? (
          <p className="t-sub text-[var(--color-muted)]">No minion reports recorded.</p>
        ) : (
          <div className="space-y-2">
            {reports.map((r, i) => (
              <div key={i} className="bg-[var(--color-bg)] rounded-[5px] p-2 text-[11px]">
                <div className="flex items-center gap-2 mb-1">
                  <b>{r.role || r.name || `minion ${i + 1}`}</b>
                  {r.bias && <Badge tone={r.bias === 'long' ? 'up' : r.bias === 'short' ? 'down' : 'neutral'} className="text-[8px] px-1">{r.bias}</Badge>}
                  {r.conviction != null && <span className="text-[var(--color-muted)]">{r.conviction}/10</span>}
                </div>
                {r.thesis && <p className="text-[var(--color-text-sub)]">{r.thesis}</p>}
                {r.evidence && (
                  <p className="text-[var(--color-muted)] mt-1 text-[10px]">evidence: {Array.isArray(r.evidence) ? r.evidence.join('; ') : r.evidence}</p>
                )}
                {r.error && <p className="text-[var(--color-down)] mt-1 text-[10px]">error: {r.error}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MonitorDetail({ detail }) {
  const { position, trade, recentScans } = detail
  if (!position) return <p className="t-sub text-[var(--color-muted)]">Not found.</p>
  return (
    <div className="space-y-3 text-[11px]">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div><span className="text-[var(--color-muted)]">Side</span><br /><b>{position.side}</b></div>
        <div><span className="text-[var(--color-muted)]">Entry</span><br /><b>{position.entry_price}</b></div>
        <div><span className="text-[var(--color-muted)]">SL</span><br /><b>{position.current_sl ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">TP</span><br /><b>{position.current_tp ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Status</span><br /><b>{position.status}{position.paused ? ' (paused)' : ''}</b></div>
        <div><span className="text-[var(--color-muted)]">Thesis status</span><br /><b>{position.thesis_status || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Last action</span><br /><b>{position.last_check_action || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Last check</span><br /><b>{position.last_check_at ? fmtAgo(position.last_check_at) : '—'}</b></div>
      </div>
      {position.thesis && (
        <div className="bg-[var(--color-bg)] p-2 rounded-[5px] italic text-[var(--color-text-sub)]">
          <b className="not-italic">Thesis:</b> {position.thesis}
        </div>
      )}
      {position.last_check_reasoning && (
        <div className="bg-[var(--color-bg)] p-2 rounded-[5px]">
          <b>Last reasoning:</b> {position.last_check_reasoning}
        </div>
      )}
      {trade && (
        <div className="bg-[var(--color-bg)] p-2 rounded-[5px]">
          <b>Linked trade #{trade.id}:</b> {trade.status} · opened {fmtTime(trade.opened_at)}
          {trade.closed_at && ` · closed ${fmtTime(trade.closed_at)} · P&L ${trade.net_pnl ?? trade.gross_pnl ?? '—'}`}
        </div>
      )}
      {recentScans?.length > 0 && (
        <div>
          <p className="t-label mb-1">Recent scans for {position.symbol}</p>
          <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
            {recentScans.map(s => (
              <div key={s.id} className="flex gap-2 px-2 py-1 rounded-[4px] bg-[var(--color-bg)]">
                <span className={`font-bold w-[50px] shrink-0 ${s.bias === 'long' ? 'text-[var(--color-up)]' : s.bias === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-muted)]'}`}>
                  {s.bias || '—'}
                </span>
                <span className="font-mono w-[32px] shrink-0">{s.confidence ?? '—'}</span>
                <span className="flex-1 min-w-0 text-[var(--color-text-sub)] truncate">{s.thesis || ''}</span>
                <span className="text-[9px] text-[var(--color-muted)]">{fmtAgo(s.scanned_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ScanDetail({ scan }) {
  if (!scan) return <p className="t-sub text-[var(--color-muted)]">Not found.</p>
  return (
    <div className="space-y-2 text-[11px]">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div><span className="text-[var(--color-muted)]">Bias</span><br /><b>{scan.bias || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Confidence</span><br /><b>{scan.confidence ?? '—'}/10</b></div>
        <div><span className="text-[var(--color-muted)]">Timeframe</span><br /><b>{scan.timeframe || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Grade</span><br /><b>{scan.trade_grade || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Price</span><br /><b>{scan.price ?? '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Session fit</span><br /><b>{scan.session_fit || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Trade at</span><br /><b>{scan.trade_at || '—'}</b></div>
        <div><span className="text-[var(--color-muted)]">Scanned</span><br /><b>{fmtAgo(scan.scanned_at)}</b></div>
      </div>
      {scan.thesis && (
        <div className="bg-[var(--color-bg)] p-2 rounded-[5px] italic text-[var(--color-text-sub)]">
          {scan.thesis}
        </div>
      )}
      {scan.desk_note && (
        <div className="bg-[var(--color-bg)] p-2 rounded-[5px]">
          <b>Desk note:</b> {scan.desk_note}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const ROLE_STORAGE_KEY = 'bot-trade:agent-role'

export default function Workshop() {
  const [role, setRoleState] = useState(() => {
    try {
      const saved = localStorage.getItem(ROLE_STORAGE_KEY)
      if (ROLES.includes(saved)) return saved
    } catch {}
    return agentConfigured('autopilot') ? 'autopilot' : (agentConfigured('copilot') ? 'copilot' : 'autopilot')
  })
  const setRole = (r) => {
    setRoleState(r)
    try { localStorage.setItem(ROLE_STORAGE_KEY, r) } catch {}
  }

  const [activity, setActivity] = useState([])
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!agentConfigured(role)) return
    setLoading(true)
    try {
      const a = await agentGet('/state/activity?limit=200', role)
      setActivity(a?.activity || [])
      setError(null)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [role])

  // Discard stale autopilot rows the instant the operator flips roles so the
  // drill-down never tries to resolve an autopilot id against copilot's DB.
  useEffect(() => {
    setActivity([]); setSelected(null); setError(null)
  }, [role])

  useEffect(() => { refresh() }, [refresh])

  if (!agentConfigured('autopilot') && !agentConfigured('copilot')) {
    return (
      <Card>
        <p className="t-label mb-1">Workshop</p>
        <p className="t-sub text-[var(--color-muted)]">
          Agent backend not configured. Set <code>VITE_AGENT_URL_AUTOPILOT</code> + <code>VITE_AGENT_SECRET_AUTOPILOT</code> (and optionally the matching <code>_COPILOT</code> pair) in Vercel, then redeploy.
        </p>
      </Card>
    )
  }

  const filtered = filter === 'all' ? activity : activity.filter(r => r.kind === filter)
  const kinds = ['all', 'scan', 'analysis', 'monitor', 'trade', 'regime', 'flip']

  return (
    <section className="space-y-3">
      {/* Role switcher — mirrors the Trade Window toggle. */}
      <div className="flex items-center gap-1 text-[10px]">
        {ROLES.map(r => {
          const wired = agentConfigured(r)
          const active = r === role
          return (
            <button
              key={r}
              type="button"
              onClick={() => wired && setRole(r)}
              disabled={!wired}
              className={`px-2.5 py-1 rounded-[5px] uppercase font-bold tracking-wider ${
                active
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : wired
                  ? 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                  : 'text-[var(--color-muted)] opacity-40 cursor-not-allowed'
              }`}
              title={wired ? '' : `VITE_AGENT_URL_${r.toUpperCase()} not set`}
            >
              {r}
              {!wired && <span className="ml-1 opacity-60">(off)</span>}
            </button>
          )
        })}
      </div>

      <Card>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="t-label">Workshop</p>
            <p className="text-[10px] text-[var(--color-muted)]">
              Drill into every minion report, monitor check, and trade decision. Observation-only.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
              {loading ? '…' : 'Refresh'}
            </Button>
            <Link to="/agent" className="t-meta text-[var(--color-accent)] underline self-center">← Trade Window</Link>
          </div>
        </div>

        {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

        <div className="flex flex-wrap gap-1 mb-3">
          {kinds.map(k => (
            <Button
              key={k}
              size="sm"
              variant={filter === k ? 'primary' : 'ghost'}
              onClick={() => setFilter(k)}
              className="text-[10px] !px-2 !py-0.5"
            >
              {k} {k !== 'all' && <span className="opacity-60 ml-1">{activity.filter(r => r.kind === k).length}</span>}
            </Button>
          ))}
        </div>

        <div className="space-y-0.5 max-h-[70vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="t-sub text-[var(--color-muted)] py-6 text-center">No events match this filter.</p>
          ) : (
            filtered.map((row, i) => (
              <button
                key={`${row.kind}-${row.id}-${i}`}
                onClick={() => setSelected(row)}
                className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded-[5px] hover:bg-[var(--color-bg)] text-[11px]"
              >
                <Badge tone={KIND_TONE[row.kind] || 'neutral'} className="text-[8px] px-1 shrink-0">
                  {row.kind.toUpperCase()}
                </Badge>
                <span className="font-bold w-[65px] shrink-0 text-[var(--color-text)]">{row.symbol}</span>
                {row.v1 && <span className="w-[52px] shrink-0 text-[var(--color-text-sub)]">{String(row.v1).slice(0, 8)}</span>}
                {row.v2 != null && <span className="font-mono w-[32px] shrink-0 text-[var(--color-text-sub)]">{typeof row.v2 === 'number' ? row.v2.toFixed(1) : row.v2}</span>}
                <span className="flex-1 min-w-0 text-[var(--color-text-sub)] truncate">{row.note || row.extra || ''}</span>
                <span className="text-[9px] text-[var(--color-muted)] shrink-0">{fmtAgo(row.at)}</span>
              </button>
            ))
          )}
        </div>
      </Card>

      {selected && <DetailModal row={selected} role={role} onClose={() => setSelected(null)} />}
    </section>
  )
}
