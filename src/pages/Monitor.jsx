// Monitor — the single glanceable answer to "what is my bot doing right now?"
// One screen, no scroll on desktop: status line, open positions (with chart),
// the last few closed trades, and the risk manager's latest decisions.
// Deep controls stay on Trade/Tune; this page is read-only.
import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import PositionChart from '../components/PositionChart.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'

const REFRESH_MS = 20_000

// Survive tab switches: cache the last snapshot in sessionStorage so
// navigating away and back shows data instantly (then refreshes live).
const CACHE_KEY = 'monitor_cache_v1'
function readCache() {
  try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)) || null } catch { return null }
}
function writeCache(data) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch { /* quota — skip */ }
}

function fmt(n, digits = 5) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits })
}

function ago(iso) {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function MonitorPositionRow({ p }) {
  const [showChart, setShowChart] = useState(false)
  const side = String(p.side).toUpperCase()
  return (
    <div className="border-t border-[var(--color-border)] py-1.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold">{p.symbol}</span>
        <Badge tone={side === 'BUY' ? 'up' : 'down'}>{side}</Badge>
        <span>in {fmt(p.entry_price)}</span>
        <span className="text-[var(--color-text-sub)]">SL {fmt(p.current_sl)} · TP {fmt(p.current_tp)}</span>
        <span className="text-[var(--color-text-sub)]">{ago(p.opened_at)}</span>
        <Button size="sm" variant="ghost" onClick={() => setShowChart(s => !s)}>{showChart ? 'Hide' : 'Chart'}</Button>
      </div>
      {showChart && (
        <div className="mt-2">
          <PositionChart symbol={p.symbol} timeframe="1h" lines={{ entry: p.entry_price, sl: p.current_sl, tp: p.current_tp }} />
        </div>
      )}
    </div>
  )
}

export default function Monitor() {
  const cached = readCache()
  const [health, setHealth] = useState(cached?.health ?? null)
  const [positions, setPositions] = useState(cached?.positions ?? [])
  const [trades, setTrades] = useState(cached?.trades ?? [])
  const [events, setEvents] = useState(cached?.events ?? [])
  const [broker, setBroker] = useState(cached?.broker ?? null)  // selected account at the BROKER: live + pending
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — set it up on the Connect tab.'); return }
    try {
      const [h, p, t, r, b] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/positions'),
        agentGet('/state/trades'),
        agentGet('/state/risk-events?limit=5'),
        agentPost('/actions/broker-positions', { selectedOnly: true }).catch(() => null),
      ])
      const next = {
        health: h,
        positions: p.rows || p.positions || [],
        trades: (t.rows || t.trades || []).slice(0, 5),
        events: r.rows || [],
        broker: b?.accounts?.[0] ?? null,
      }
      setHealth(next.health)
      setPositions(next.positions)
      setTrades(next.trades)
      setEvents(next.events)
      setBroker(next.broker)
      writeCache(next)
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => {
    const kick = setTimeout(load, 0)   // async fetch — avoid sync setState in effect body
    const t = setInterval(load, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(t) }
  }, [load])

  const active = health?.autotradeEnabled
  const linked = health?.broker?.linked

  return (
    <div className="space-y-8">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}

      {/* The one-line answer */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          {health == null && !error && <span>Checking the bot…</span>}
          {health && (
            <>
              <Badge tone={active ? 'up' : 'neutral'} pill>{active ? '● QUANT TRADING ACTIVE' : '○ AUTOTRADE OFF'}</Badge>
              {linked && <Badge tone={health.broker.isLive ? 'down' : 'info'}>{health.broker.isLive ? '⚠ LIVE' : 'DEMO'} account</Badge>}
              <span className="text-[13px] text-[var(--color-text-sub)]">
                last scan {ago(health.lastScanAt)} · scans every 5 min · loop #{fmt(health.loopCount, 0)}
              </span>
            </>
          )}
        </div>
        {health && (
          <p className="mt-2 text-[13px] text-[var(--color-text-sub)]">
            {positions.length > 0
              ? `The bot is managing ${positions.length} open position${positions.length > 1 ? 's' : ''} below — stops are attached at the broker.`
              : active
                ? 'No open positions — the bot is waiting for a valid 61.8% fib setup on an armed timeframe. That can take days on 4h; you will get a Telegram alert the moment it acts. Nothing on this screen means nothing has happened.'
                : <>Autotrade is off — the bot only watches. <Link to="/tune" className="text-[var(--color-accent)] underline">Run the backtest on Tune</Link> to activate.</>}
          </p>
        )}
      </Card>

      {/* THE BROKER'S TRUTH for the bot's account: live positions + set (pending) orders */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-1">
          At the broker — live positions ({broker?.positions?.length ?? '…'}) & set orders ({broker?.orders?.length ?? '…'})
        </h2>
        {!broker && <div className="text-[13px] text-[var(--color-text-sub)]">Fetching the account snapshot from the broker…</div>}
        {broker?.positions?.map(p => (
          <div key={p.positionId} className="border-t border-[var(--color-border)] py-1.5 text-[13px] flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.symbol}</span>
            <Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge>
            <span>{p.lots != null ? `${fmt(p.lots, 2)} lots` : ''}</span>
            <span>in {fmt(p.entry)} → now {fmt(p.currentPrice)}</span>
            {p.estPnlQuote != null && <span className={p.estPnlQuote >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{p.estPnlQuote >= 0 ? '+' : ''}{fmt(p.estPnlQuote, 2)}</span>}
            <span className="text-[var(--color-text-sub)]">SL {fmt(p.sl)} · TP {fmt(p.tp)}</span>
          </div>
        ))}
        {broker?.orders?.map(o => (
          <div key={o.orderId} className="border-t border-[var(--color-border)] py-1.5 text-[13px] flex flex-wrap items-center gap-2">
            <span className="font-semibold">{o.symbol}</span>
            <Badge tone="info">{o.type}</Badge>
            <Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge>
            <span>{o.lots != null ? `${fmt(o.lots, 2)} lots` : ''}</span>
            <span>trigger {fmt(o.limitPrice ?? o.stopPrice)} · now {fmt(o.currentPrice)}</span>
            <span className="text-[var(--color-text-sub)]">SL {fmt(o.sl)} · TP {fmt(o.tp)}</span>
          </div>
        ))}
        {broker && broker.positions?.length === 0 && broker.orders?.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-sub)]">Flat at the broker — no live positions or pending orders on the bot's account.</div>
        )}
      </Card>

      {/* Bot-managed positions (with charts) */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-1">Bot-managed positions ({positions.length})</h2>
        {positions.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">None — positions the bot opens (or adopts) appear here with charts.</div>}
        {positions.map(p => <MonitorPositionRow key={p.id} p={p} />)}
      </Card>

      {/* Last actions: closed trades + latest risk decisions, compact */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-1">What the bot did recently</h2>
        {trades.length === 0 && events.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-sub)]">Nothing yet — trades and vetoes will appear here the moment they happen.</div>
        )}
        {trades.map(t => (
          <div key={`t${t.id}`} className="border-t border-[var(--color-border)] py-1.5 text-[13px] flex flex-wrap items-center gap-2">
            <span className="text-[var(--color-text-sub)]">{ago(t.closed_at)}</span>
            <span className="font-semibold">{t.symbol}</span>
            <Badge tone={String(t.side).toUpperCase() === 'BUY' ? 'up' : 'down'}>{String(t.side).toUpperCase()}</Badge>
            <span>closed {t.exit_reason ? `(${t.exit_reason})` : ''}</span>
            {t.pnl != null && <span className={Number(t.pnl) >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{Number(t.pnl) >= 0 ? '+' : ''}{fmt(t.pnl, 2)}</span>}
          </div>
        ))}
        {events.map(e => (
          <div key={`e${e.id}`} className="border-t border-[var(--color-border)] py-1.5 text-[13px] flex flex-wrap items-center gap-2">
            <span className="text-[var(--color-text-sub)]">{ago(e.created_at)}</span>
            <span className="font-semibold">{e.symbol}</span>
            <Badge tone={e.approved ? 'up' : 'down'}>{e.approved ? 'APPROVED' : 'VETOED'}</Badge>
            <span className="text-[var(--color-text-sub)] truncate max-w-[380px]">{e.veto_reason || e.sizing_note || ''}</span>
          </div>
        ))}
        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          Full history and controls live on the <Link to="/trade" className="text-[var(--color-accent)] underline">Trade</Link> tab · every action is also sent to Telegram.
        </p>
      </Card>
    </div>
  )
}
