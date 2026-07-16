// Desk — THE one-screen workspace: a live chart wall on top (up to 30
// charts: 3 columns × 10 rows — open positions first, then the watchlist),
// and every detail of what is live below it in collapsible sections
// (expand/collapse triangles, state remembered per section). Nothing from
// the old Monitor was dropped — it lives here behind the triangles.
// Everything reuses the endpoints/components the dedicated pages already
// trust — this page assembles, it does not invent.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import PositionChart from '../components/PositionChart.jsx'
import PositionManager from '../components/PositionManager.jsx'
import ReportChart from '../components/ReportChart.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'

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

// Collapsible desk section — triangle + title + right-aligned summary that
// stays informative while collapsed. Open/closed persists per section.
function Section({ id, title, summary, defaultOpen = true, children }) {
  const KEY = `desk_open_${id}`
  const [open, setOpen] = useState(() => {
    try { const v = localStorage.getItem(KEY); return v == null ? defaultOpen : v === '1' } catch { return defaultOpen }
  })
  const toggle = () => setOpen(o => {
    const n = !o
    try { localStorage.setItem(KEY, n ? '1' : '0') } catch { /* private mode */ }
    return n
  })
  return (
    <Card>
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-1.5 text-left cursor-pointer">
        <span aria-hidden="true" className="w-3 text-[10px] shrink-0">{open ? '▾' : '▸'}</span>
        <h2 className="text-[12px] font-semibold">{title}</h2>
        {summary && <span className="ml-auto text-[12px] text-[var(--color-text-sub)] truncate">{summary}</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </Card>
  )
}

export default function Desk() {
  const [health, setHealth] = useState(null)
  const [scans, setScans] = useState([])
  const [positions, setPositions] = useState([])   // bot-tracked rows (chart lines)
  const [events, setEvents] = useState([])
  const [allTrades, setAllTrades] = useState([])
  const [armed, setArmed] = useState(null)
  const [config, setConfig] = useState(null)
  const [broker, setBroker] = useState(null)             // selected account at the BROKER
  const [brokerHistory, setBrokerHistory] = useState(null) // broker's closed deals, 7d
  const [managedId, setManagedId] = useState(null)
  const [error, setError] = useState('')
  const [symbol, setSymbol] = useState('')
  const [gridN, setGridN] = useState(() => {
    try { return Number(localStorage.getItem('desk_grid_n')) || 1 } catch { return 1 }
  })   // 1 | 4 | 9 | 30 charts (30 = 3 columns × 10 rows)

  const pickGrid = (n) => {
    setGridN(n)
    try { localStorage.setItem('desk_grid_n', String(n)) } catch { /* private mode */ }
  }

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — log in on the Connect tab.'); return }
    try {
      const [h, s, p, r, atf, c, t, b, bh] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/risk-events?limit=200'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/config').catch(() => null),
        agentGet('/state/trades').catch(() => null),
        agentPost('/actions/broker-positions', { selectedOnly: true }).catch(() => null),
        agentPost('/actions/broker-history', { days: 7 }).catch(() => null),
      ])
      setHealth(h)
      const rows = s.rows || s.scans || []
      setScans(rows)
      setPositions(p.rows || p.positions || [])
      setEvents(r.rows || [])
      setAllTrades(t?.rows || t?.trades || [])
      setArmed(atf)
      setConfig(c)
      setBroker(b?.accounts?.[0] ?? null)
      setBrokerHistory(bh?.ok ? bh : null)
      setError('')
      setSymbol(prev => prev || b?.accounts?.[0]?.positions?.[0]?.symbol || p.rows?.[0]?.symbol || rows[0]?.symbol || 'EURUSD')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    const kick = setTimeout(load, 0) // async kick keeps the effect render-clean
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  const watch = (config?.symbols || []).filter(w => w.enabled !== false).map(w => w.symbol)
  // Chart wall order: live broker positions first, then bot-tracked, then
  // the watchlist — deduped. The wall shows what you HOLD before what you WATCH.
  const chartSymbols = [...new Set([
    ...(broker?.positions || []).map(p => p.symbol),
    ...positions.map(p => p.symbol),
    ...(watch.length ? watch : scans.map(sc => sc.symbol)),
  ])]
  const linesFor = (sym) => {
    const bp = (broker?.positions || []).find(px => px.symbol === sym)
    if (bp) return { entry: bp.entry, sl: bp.sl, tp: bp.tp }
    const p2 = positions.find(px => px.symbol === sym)
    return p2 ? { entry: p2.entry_price, sl: p2.current_sl, tp: p2.current_tp } : {}
  }
  const scan = scans.find(sc => sc.symbol === symbol)
  const matrix = armed?.matrix && Object.keys(armed.matrix).length > 0 ? armed.matrix : null
  // Armed combos as CHIPS — one per symbol×timeframes pair, never a mashed sentence.
  const armedChips = matrix
    ? Object.entries(matrix).map(([sym2, tfs]) => `${sym2} · ${tfs.join(' ')}`)
    : (armed?.timeframes || []).map(tf => `all symbols · ${tf}`)
  const brokerFlat = (broker?.positions?.length ?? 0) === 0 && (broker?.orders?.length ?? 0) === 0
  const equityStopToday = (health?.equityStopTrippedAt || '').slice(0, 10) === new Date().toISOString().slice(0, 10)
  const floating = (broker?.positions || []).reduce((s2, p2) => s2 + (Number(p2.estNetPnl ?? p2.estPnlQuote) || 0), 0)

  return (
    <div className="space-y-3">
      {error && <Card className="text-[13px]">{error}</Card>}

      {/* ---- Status strip — the whole live picture in one row of chips ---- */}
      <Card>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {/* Tri-state, honestly: "no data yet" must never read as OFF — a
              loading page and a disarmed bot are different facts. */}
          {!health && <Badge tone="neutral">AUTOTRADE: NO DATA YET</Badge>}
          {health && <Badge tone={health.autotradeEnabled ? 'up' : 'neutral'}>{health.autotradeEnabled ? 'AUTOTRADE ON' : 'AUTOTRADE OFF'}</Badge>}
          {health?.pendingModeEnabled && <Badge tone="warning">⏳ PENDING ARMED</Badge>}
          {equityStopToday && <Badge tone="down">EQUITY STOP TRIPPED — autotrade auto-disarmed today</Badge>}
          {health && !health.broker?.linked && (
            <Badge tone="warning">NO ACCOUNT LINKED — fresh agent state? Re-link on Connect (set DB_PATH on a Railway Volume so redeploys stop wiping it)</Badge>
          )}
          <Badge tone={health?.broker?.isLive ? 'down' : 'info'}>{health?.broker?.isLive ? '⚠ LIVE' : 'DEMO'}</Badge>
          <span className="text-[var(--color-text-sub)]">${fmt(health?.broker?.balance, 2)}</span>
          <span className="text-[var(--color-text-sub)]">·</span>
          <span className="text-[var(--color-text-sub)]">armed:</span>
          {armedChips.length === 0 && <span className="text-[var(--color-text-sub)]">—</span>}
          {armedChips.map(chip => (
            <span key={chip} className="glass-inset rounded-full px-2 py-0.5 font-semibold whitespace-nowrap">{chip}</span>
          ))}
        </div>
      </Card>

      {/* ---- Chart wall — full width; 30 = 3 columns × 10 rows ---- */}
      <Card>
        <div className="flex items-center gap-1 mb-1.5 flex-wrap" role="radiogroup" aria-label="Chart grid size">
          {[1, 4, 9, 30].map(n => (
            <button
              key={n} type="button" role="radio" aria-checked={gridN === n}
              onClick={() => pickGrid(n)}
              title={n === 30 ? '30 charts — 3 columns × 10 rows' : `${n} chart${n > 1 ? 's' : ''} on screen`}
              className={`rounded-full px-2 py-0.5 min-h-[28px] text-[11px] font-semibold cursor-pointer ${gridN === n ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
            >{n === 1 ? '1 chart' : n === 30 ? '30 wall' : `${n}`}</button>
          ))}
          <span className="text-[11px] text-[var(--color-text-sub)]">
            positions first, then watchlist{gridN > 1 ? ' · grid charts refresh every 60s — tap a symbol to focus it' : ''}
          </span>
        </div>
        {gridN === 1 && (
          <>
            {/* Single scrollable row (was 2-3 wrapped rows of chips —
                owner: "spacing wasteful"); swipe sideways for the rest. */}
            <div className="flex items-center gap-1 mb-1.5 overflow-x-auto scrollbar-none" role="tablist" aria-label="Chart symbol">
              {chartSymbols.map(sym => (
                <button
                  key={sym} type="button" role="tab" aria-selected={sym === symbol}
                  onClick={() => setSymbol(sym)}
                  className={`shrink-0 rounded-full px-2 py-0.5 min-h-[26px] text-[11px] font-semibold cursor-pointer ${sym === symbol ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
                >{sym}</button>
              ))}
            </div>
            {symbol && (
              <PositionChart
                symbol={symbol}
                timeframe={scan?.timeframe || '1h'}
                lines={linesFor(symbol)}
              />
            )}
          </>
        )}
        {gridN > 1 && (
          <div className={`grid gap-2 ${gridN === 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
            {chartSymbols.slice(0, gridN).map(sym => {
              const held = (broker?.positions || []).some(px => px.symbol === sym) || positions.some(px => px.symbol === sym)
              return (
                <div key={sym} className="min-w-0">
                  <button type="button" className="text-[11px] font-bold cursor-pointer hover:underline" onClick={() => { setSymbol(sym); pickGrid(1) }}>
                    {sym}{held ? ' ●' : ''}
                  </button>
                  <PositionChart
                    grid
                    symbol={sym}
                    timeframe={scans.find(sc => sc.symbol === sym)?.timeframe || '1h'}
                    lines={linesFor(sym)}
                  />
                </div>
              )
            })}
          </div>
        )}
        {/* Scan strip — one line per symbol, words not colours */}
        <div className="mt-2 border-t border-[var(--color-border)] pt-1.5 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3 text-[12px]">
          {scans.map(sc => (
            <button
              key={sc.symbol} type="button" onClick={() => { setSymbol(sc.symbol); if (gridN !== 1) pickGrid(1) }}
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

      {/* ---- Detail sections — everything live, behind triangles ---- */}
      <Section
        id="broker"
        title={`At the broker — positions (${broker?.positions?.length ?? '…'}) & set orders (${broker?.orders?.length ?? '…'})`}
        summary={broker?.positions?.length ? `floating ${floating >= 0 ? '+' : ''}${fmt(floating, 2)}` : null}
      >
        {!broker && <p className="text-[12px] text-[var(--color-text-sub)]">Fetching the account snapshot…</p>}
        {broker?.positions?.map(p => {
          const net = p.estNetPnl ?? p.estPnlQuote
          return (
            <div key={p.positionId} className="border-t border-[var(--color-border)] py-1.5 text-[12px]">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button type="button" className="font-semibold cursor-pointer underline-offset-2 hover:underline" onClick={() => { setSymbol(p.symbol); pickGrid(1) }}>{p.symbol}</button>
                <Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge>
                <span className="text-[var(--color-text-sub)]">{p.lots != null ? `${fmt(p.lots, 2)}` : ''}</span>
                {net != null && <span className={`font-semibold ${net >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{net >= 0 ? '+' : ''}{fmt(net, 2)}{p.estNetPnl == null ? '*' : ''}</span>}
                <Button size="sm" variant="ghost" className="ml-auto"
                  onClick={() => setManagedId(id => id === p.positionId ? null : p.positionId)}>
                  {managedId === p.positionId ? 'Hide' : 'Manage'}
                </Button>
              </div>
              <div className="mt-0.5 text-[var(--color-text-sub)]">
                in {fmt(p.entry)} → {fmt(p.currentPrice)} · SL {fmt(p.sl)} · TP {fmt(p.tp)}
              </div>
              {managedId === p.positionId && (
                <PositionManager p={p} onDone={() => { setManagedId(null); load() }} />
              )}
            </div>
          )
        })}
        {broker?.orders?.map(o => (
          <div key={o.orderId} className="border-t border-[var(--color-border)] py-1.5 text-[12px]">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button type="button" className="font-semibold cursor-pointer underline-offset-2 hover:underline" onClick={() => { setSymbol(o.symbol); pickGrid(1) }}>{o.symbol}</button>
              <Badge tone="info">{o.type}</Badge>
              <Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge>
              <span className="text-[var(--color-text-sub)]">{o.lots != null ? fmt(o.lots, 2) : ''}</span>
            </div>
            <div className="mt-0.5 text-[var(--color-text-sub)]">
              trigger {fmt(o.limitPrice ?? o.stopPrice)} · now {fmt(o.currentPrice)} · SL {fmt(o.sl)} · TP {fmt(o.tp)}
            </div>
          </div>
        ))}
        {broker && brokerFlat && (
          <p className="text-[12px] text-[var(--color-text-sub)]">Flat at the broker — no live positions or pending orders.</p>
        )}
      </Section>

      <Section
        id="closed7d"
        title="Closed at the broker — 7 days"
        summary={brokerHistory?.realized != null ? `realised ${brokerHistory.realized >= 0 ? '+' : ''}${fmt(brokerHistory.realized, 2)} · ${brokerHistory.rows?.length ?? 0} deals` : null}
        defaultOpen={false}
      >
        {!brokerHistory && <p className="text-[12px] text-[var(--color-text-sub)]">Fetching deal history…</p>}
        {brokerHistory?.rows?.map(d => (
          <div key={d.dealId ?? `${d.positionId}-${d.closedAt}`} className="border-t border-[var(--color-border)] py-1 text-[12px] flex items-center gap-1.5 min-w-0">
            <span className="text-[var(--color-text-sub)] shrink-0">{d.closedAt ? ago(new Date(d.closedAt).toISOString()) : ''}</span>
            <span className="font-semibold shrink-0">{d.symbol}</span>
            <Badge tone={d.side === 'BUY' ? 'up' : 'down'}>{d.side}</Badge>
            <span className="text-[var(--color-text-sub)] shrink-0">{d.lots != null ? fmt(d.lots, 2) : ''}</span>
            <span className="text-[var(--color-text-sub)] truncate">in {fmt(d.entryPrice)} → out {fmt(d.closePrice)}</span>
            <span className={`ml-auto font-semibold shrink-0 ${d.netPnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{d.netPnl >= 0 ? '+' : ''}{fmt(d.netPnl, 2)}</span>
          </div>
        ))}
        {brokerHistory && brokerHistory.rows?.length === 0 && (
          <p className="text-[12px] text-[var(--color-text-sub)]">Nothing closed in the last 7 days.</p>
        )}
        <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">Net includes swap + commission — same figures as cTrader's History tab, manual trades included.</p>
      </Section>

      <Section
        id="risk"
        title="Risk decisions"
        summary={events.length ? `${events.filter(e => !e.approved).length} vetoes in last ${events.length}` : null}
        defaultOpen={false}
      >
        {events.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">None yet.</p>}
        <ul className="text-[12px] space-y-0.5">
          {events.slice(0, 10).map(ev => (
            <li key={ev.id} className="flex items-center gap-1.5 min-w-0">
              <Badge tone={ev.approved ? 'up' : 'warning'}>{ev.approved ? 'OK' : 'VETO'}</Badge>
              <span className="font-semibold shrink-0">{ev.symbol}</span>
              <span className="text-[var(--color-text-sub)] truncate">{ev.veto_reason || ''}</span>
              <span className="ml-auto text-[var(--color-text-sub)] shrink-0">{ago(ev.created_at)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
          Full history on the <Link to="/trade" className="text-[var(--color-accent)] underline">Trade</Link> tab.
        </p>
      </Section>

      {/* Why no trades — only when genuinely flat; the product explains
          itself instead of looking dead. */}
      {health && brokerFlat && positions.length === 0 && (
        <Section id="whynotrades" title="Why no trades right now?">
          <ul className="text-[13px] space-y-1 list-disc pl-5">
            {equityStopToday && <li className="font-semibold text-[var(--color-down)]">The daily equity stop tripped today — autotrade disarmed itself after the daily loss cap was hit. It stays off until you re-arm it on <Link to="/tune" className="underline">Tune</Link>.</li>}
            {!health.autotradeEnabled && !equityStopToday && <li className="font-semibold text-[var(--color-down)]">Autotrade is OFF — the bot never places orders. <Link to="/tune" className="underline">Activate on Tune</Link>.</li>}
            {health.autotradeEnabled && health.scanEnabled === false && <li className="font-semibold text-[var(--color-down)]">Scan is OFF — the bot cannot see the market. <Link to="/tune" className="underline">Turn it on in Tune</Link>.</li>}
            {health.autotradeEnabled && health.scanEnabled !== false && (() => {
              const found = scans.filter(r => r.bias && r.bias !== 'skip')
              const noZone = scans.length - found.length
              return (
                <>
                  {noZone > 0 && <li>{noZone} of {scans.length} watchlist symbols have no price at a 61.8% retracement zone right now — no setup exists to trade.</li>}
                  {found.map(r => <li key={r.symbol}>{r.symbol}: {String(r.bias).toUpperCase()} signal on {r.timeframe || '?'} at {r.confidence ?? '?'}/10 — waiting on the armed-timeframe and risk gates.</li>)}
                  <li className="text-[var(--color-text-sub)]">
                    Expected pace on {(armed?.timeframes || []).join('/') || 'the armed timeframes'}: roughly 1–2 qualifying trades per month per symbol — a quiet screen for days is the strategy working, not failing. Telegram announces the moment anything changes.
                  </li>
                </>
              )
            })()}
          </ul>
        </Section>
      )}

      <Section id="performance" title="Performance" defaultOpen={false}>
        <ReportChart allTrades={allTrades} events={events} />
      </Section>
    </div>
  )
}
