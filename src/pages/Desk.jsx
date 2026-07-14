// Desk — THE one-screen workspace (Desk + Monitor merged). Chart owns the
// left ⅔ with the scan strip under it; the right rail carries live state as
// STRUCTURED rows (never prose): broker positions with net P&L and the
// per-position Manage sheet, set orders, risk decisions. Below the fold:
// the broker's closed-trade record, performance, and the why-no-trades
// explainer. Everything reuses the endpoints/components the dedicated pages
// already trust — this page assembles, it does not invent.
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
  const [gridN, setGridN] = useState(1)   // 1 | 4 | 9 | 16 charts

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
  // Armed combos as CHIPS — one per symbol×timeframes pair, never a mashed sentence.
  const armedChips = matrix
    ? Object.entries(matrix).map(([sym2, tfs]) => `${sym2} · ${tfs.join(' ')}`)
    : (armed?.timeframes || []).map(tf => `all symbols · ${tf}`)
  const brokerFlat = (broker?.positions?.length ?? 0) === 0 && (broker?.orders?.length ?? 0) === 0

  return (
    <div className="space-y-3">
      {error && <Card className="text-[13px]">{error}</Card>}

      {/* ---- Status strip — the whole picture in one row of chips ---- */}
      <Card>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <Badge tone={health?.autotradeEnabled ? 'up' : 'neutral'}>{health?.autotradeEnabled ? 'AUTOTRADE ON' : 'autotrade off'}</Badge>
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

      <div className="grid gap-3 xl:grid-cols-3 items-start">
        {/* ---- Chart column — the point of the page gets 2 of 3 tracks ---- */}
        <Card className="xl:col-span-2">
          <div className="flex flex-wrap items-center gap-1 mb-2" role="tablist" aria-label="Chart symbol">
            {chartSymbols.map(sym => (
              <button
                key={sym} type="button" role="tab" aria-selected={sym === symbol}
                onClick={() => setSymbol(sym)}
                className={`rounded-full px-2.5 py-0.5 min-h-[28px] text-[12px] font-semibold cursor-pointer ${sym === symbol ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
              >{sym}</button>
            ))}
          </div>
          <div className="flex items-center gap-1 mb-1.5" role="radiogroup" aria-label="Chart grid size">
            {[1, 4, 9, 16].map(n => (
              <button
                key={n} type="button" role="radio" aria-checked={gridN === n}
                onClick={() => setGridN(n)}
                title={`${n} chart${n > 1 ? 's' : ''} on screen`}
                className={`rounded-full px-2 py-0.5 min-h-[28px] text-[11px] font-semibold cursor-pointer ${gridN === n ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}
              >{n === 1 ? '1 chart' : `${n}`}</button>
            ))}
            {gridN > 1 && <span className="text-[11px] text-[var(--color-text-sub)]">grid charts refresh every 60s (no tick stream) — tap a symbol name to focus it</span>}
          </div>
          {gridN === 1 && symbol && (
            <PositionChart
              symbol={symbol}
              timeframe={scan?.timeframe || '1h'}
              lines={pos ? { entry: pos.entry_price, sl: pos.current_sl, tp: pos.current_tp } : {}}
            />
          )}
          {gridN > 1 && (
            <div className={`grid gap-2 ${gridN === 4 ? 'sm:grid-cols-2' : gridN === 9 ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
              {chartSymbols.slice(0, gridN).map(sym => {
                const p2 = positions.find(px => px.symbol === sym)
                return (
                  <div key={sym} className="min-w-0">
                    <button type="button" className="text-[11px] font-bold cursor-pointer hover:underline" onClick={() => { setSymbol(sym); setGridN(1) }}>{sym}</button>
                    <PositionChart
                      grid
                      symbol={sym}
                      timeframe={scans.find(sc => sc.symbol === sym)?.timeframe || '1h'}
                      lines={p2 ? { entry: p2.entry_price, sl: p2.current_sl, tp: p2.current_tp } : {}}
                    />
                  </div>
                )
              })}
            </div>
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

        {/* ---- Right rail: live broker state, structured — not prose ---- */}
        <div className="space-y-3">
          <Card>
            <h2 className="text-[12px] font-semibold mb-1">
              At the broker — positions ({broker?.positions?.length ?? '…'}) & set orders ({broker?.orders?.length ?? '…'})
            </h2>
            {!broker && <p className="text-[12px] text-[var(--color-text-sub)]">Fetching the account snapshot…</p>}
            {broker?.positions?.map(p => {
              const net = p.estNetPnl ?? p.estPnlQuote
              return (
                <div key={p.positionId} className="border-t border-[var(--color-border)] py-1.5 text-[12px]">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button type="button" className="font-semibold cursor-pointer underline-offset-2 hover:underline" onClick={() => setSymbol(p.symbol)}>{p.symbol}</button>
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
                  <button type="button" className="font-semibold cursor-pointer underline-offset-2 hover:underline" onClick={() => setSymbol(o.symbol)}>{o.symbol}</button>
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
          </Card>

          <Card>
            <h2 className="text-[12px] font-semibold mb-1 flex items-center gap-2">
              Closed at the broker — 7d
              {brokerHistory?.realized != null && (
                <span className={brokerHistory.realized >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>
                  {brokerHistory.realized >= 0 ? '+' : ''}{fmt(brokerHistory.realized, 2)}
                </span>
              )}
            </h2>
            {!brokerHistory && <p className="text-[12px] text-[var(--color-text-sub)]">Fetching deal history…</p>}
            {brokerHistory?.rows?.slice(0, 8).map(d => (
              <div key={d.dealId ?? `${d.positionId}-${d.closedAt}`} className="border-t border-[var(--color-border)] py-1 text-[12px] flex items-center gap-1.5 min-w-0">
                <span className="text-[var(--color-text-sub)] shrink-0">{d.closedAt ? ago(new Date(d.closedAt).toISOString()) : ''}</span>
                <span className="font-semibold shrink-0">{d.symbol}</span>
                <Badge tone={d.side === 'BUY' ? 'up' : 'down'}>{d.side}</Badge>
                <span className="text-[var(--color-text-sub)] shrink-0">{d.lots != null ? fmt(d.lots, 2) : ''}</span>
                <span className={`ml-auto font-semibold shrink-0 ${d.netPnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{d.netPnl >= 0 ? '+' : ''}{fmt(d.netPnl, 2)}</span>
              </div>
            ))}
            {brokerHistory && brokerHistory.rows?.length === 0 && (
              <p className="text-[12px] text-[var(--color-text-sub)]">Nothing closed in the last 7 days.</p>
            )}
            {(brokerHistory?.rows?.length ?? 0) > 8 && (
              <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">Showing 8 of {brokerHistory.rows.length} — net includes swap + commission, same as cTrader's History.</p>
            )}
          </Card>

          <Card>
            <h2 className="text-[12px] font-semibold mb-1">Last risk decisions</h2>
            {events.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">None yet.</p>}
            <ul className="text-[12px] space-y-0.5">
              {events.slice(0, 5).map(ev => (
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
          </Card>
        </div>
      </div>

      {/* ---- Why no trades — only when genuinely flat; the product explains
           itself instead of looking dead. ---- */}
      {health && brokerFlat && positions.length === 0 && (
        <Card>
          <h2 className="text-[13px] font-semibold mb-1">Why no trades right now?</h2>
          <ul className="text-[13px] space-y-1 list-disc pl-5">
            {!health.autotradeEnabled && <li className="font-semibold text-[var(--color-down)]">Autotrade is OFF — the bot never places orders. <Link to="/tune" className="underline">Activate on Tune</Link>.</li>}
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
        </Card>
      )}

      {/* ---- Performance — equity curve + decision markers ---- */}
      <ReportChart allTrades={allTrades} events={events} />
    </div>
  )
}
