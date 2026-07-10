// Desk — the one-screen workspace (owner: "why does TradingView fit one
// screen and I swap pages?"). Chart owns the left ⅔; thin docked panels
// carry state on the right; a scan strip runs under the chart. Everything
// reuses the endpoints/components the dedicated pages already trust —
// this page assembles, it does not invent.
import { useCallback, useEffect, useState } from 'react'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import PositionChart from '../components/PositionChart.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'

const REFRESH_MS = 20_000
const fmt = (v, d = 5) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }))

function ago(iso) {
  if (!iso) return ''
  const t = Date.parse(String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z')
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (mins < 60) return `${mins}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

export default function Desk() {
  const [health, setHealth] = useState(null)
  const [scans, setScans] = useState([])
  const [positions, setPositions] = useState([])
  const [events, setEvents] = useState([])
  const [armed, setArmed] = useState(null)
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')
  const [symbol, setSymbol] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — log in on the Connect tab.'); return }
    try {
      const [h, s, p, r, atf, c] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/risk-events?limit=5'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/config').catch(() => null),
      ])
      setHealth(h)
      const rows = s.rows || s.scans || []
      setScans(rows)
      setPositions(p.rows || p.positions || [])
      setEvents(r.rows || [])
      setArmed(atf)
      setConfig(c)
      setError('')
      setSymbol(prev => prev || p.rows?.[0]?.symbol || rows[0]?.symbol || 'EURUSD')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    const kick = setTimeout(load, 0) // async kick keeps the effect render-clean
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  const watch = (config?.symbols || []).filter(w => w.enabled !== false).map(w => w.symbol)
  const chartSymbols = watch.length ? watch : scans.map(sc => sc.symbol)
  const pos = positions.find(p => p.symbol === symbol)
  const scan = scans.find(sc => sc.symbol === symbol)
  const matrix = armed?.matrix && Object.keys(armed.matrix).length > 0 ? armed.matrix : null

  return (
    <div className="space-y-3">
      {error && <Card className="text-[13px]">{error}</Card>}
      <div className="grid gap-3 xl:grid-cols-[2fr_1fr] items-start">
        {/* ---- Chart column ---- */}
        <Card>
          <div className="flex flex-wrap items-center gap-1 mb-2" role="tablist" aria-label="Chart symbol">
            {chartSymbols.map(sym => (
              <button
                key={sym} type="button" role="tab" aria-selected={sym === symbol}
                onClick={() => setSymbol(sym)}
                className={`rounded-full px-2.5 py-0.5 min-h-[28px] text-[12px] font-semibold cursor-pointer ${sym === symbol ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
              >{sym}</button>
            ))}
          </div>
          {symbol && (
            <PositionChart
              symbol={symbol}
              timeframe={scan?.timeframe || '1h'}
              lines={pos ? { entry: pos.entry_price, sl: pos.current_sl, tp: pos.current_tp } : {}}
            />
          )}
          {/* Scan strip — one line per symbol, words not colours */}
          <div className="mt-2 border-t border-[var(--color-border)] pt-1.5 grid gap-x-6 sm:grid-cols-2 text-[12px]">
            {scans.map(sc => (
              <button
                key={sc.symbol} type="button" onClick={() => setSymbol(sc.symbol)}
                className="flex items-center gap-1.5 py-0.5 text-left cursor-pointer min-w-0"
                title={sc.thesis || ''}
              >
                <span className="font-semibold w-16 shrink-0">{sc.symbol}</span>
                <span className={`truncate ${sc.bias && sc.bias !== 'skip' ? 'font-semibold' : 'text-[var(--color-text-sub)]'}`}>
                  {sc.bias && sc.bias !== 'skip'
                    ? `${sc.bias.toUpperCase()} ${sc.timeframe || ''} ${sc.confidence ?? '?'}/10`
                    : 'no setup'}
                </span>
              </button>
            ))}
            {scans.length === 0 && <span className="text-[var(--color-text-sub)] py-1">No scan yet — the loop runs every {config?.loop_interval_min ?? 5} min.</span>}
          </div>
        </Card>

        {/* ---- Docked panels ---- */}
        <div className="space-y-3">
          <Card>
            <h2 className="text-[12px] font-semibold mb-1">Bot</h2>
            <div className="text-[12px] space-y-0.5">
              <div>
                <Badge tone={health?.autotradeEnabled ? 'up' : 'neutral'}>{health?.autotradeEnabled ? 'AUTOTRADE ON' : 'autotrade off'}</Badge>
                {' '}
                <span className="text-[var(--color-text-sub)]">{health?.broker?.isLive ? 'LIVE ⚠' : 'demo'} {health?.broker?.accountId || '—'} · ${fmt(health?.broker?.balance, 2)}</span>
              </div>
              <div className="text-[var(--color-text-sub)]">
                Armed: {matrix
                  ? Object.entries(matrix).map(([sym2, tfs]) => `${sym2} (${tfs.join(', ')})`).join(' · ')
                  : (armed?.timeframes || []).join(', ') || '—'}
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-[12px] font-semibold mb-1">Open positions ({positions.length})</h2>
            {positions.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">Flat.</p>}
            <ul className="text-[12px] space-y-0.5">
              {positions.map(p => (
                <li key={p.id || p.positionId} className="flex items-center gap-1.5">
                  <button type="button" className="font-semibold cursor-pointer underline-offset-2 hover:underline" onClick={() => setSymbol(p.symbol)}>{p.symbol}</button>
                  <span className="text-[var(--color-text-sub)]">{String(p.side || '').toUpperCase()} in {fmt(p.entry_price)} · SL {fmt(p.current_sl)} · TP {fmt(p.current_tp)}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="text-[12px] font-semibold mb-1">Last risk decisions</h2>
            {events.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">None yet.</p>}
            <ul className="text-[12px] space-y-0.5">
              {events.map(ev => (
                <li key={ev.id} className="flex items-center gap-1.5 min-w-0">
                  <Badge tone={ev.approved ? 'up' : 'warning'}>{ev.approved ? 'OK' : 'VETO'}</Badge>
                  <span className="font-semibold shrink-0">{ev.symbol}</span>
                  <span className="text-[var(--color-text-sub)] truncate">{ev.veto_reason || ''}</span>
                  <span className="ml-auto text-[var(--color-text-sub)] shrink-0">{ago(ev.created_at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
