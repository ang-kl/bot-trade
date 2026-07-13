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
import ReportChart from '../components/ReportChart.jsx'
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

// Proactive burst — scan NOW, place up to N risk-gated trades on the selected
// demo account without waiting for the loop or the backtest ritual.
function TradeNowCard({ onDone }) {
  const [count, setCount] = useState(2)
  const [minConviction, setMinConviction] = useState(5)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const fire = async () => {
    if (!window.confirm(`Scan the watchlist now and place up to ${count} REAL orders (demo account) on the best setups at conviction ≥${minConviction}/10? Every one still passes the risk gate — it may veto some or all.`)) return
    setBusy(true)
    setErr('')
    setResult(null)
    try {
      const r = await agentPost('/actions/trade-now', { count, minConviction })
      setResult(r)
      onDone?.()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">Trade now</h2>
        <span className="text-[12px] text-[var(--color-text-sub)]">place up to</span>
        {[2, 3, 5].map(n => (
          <button key={n} type="button" onClick={() => setCount(n)}
            className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold cursor-pointer min-h-[32px] ${count === n ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}>{n}</button>
        ))}
        <span className="text-[12px] text-[var(--color-text-sub)]">trades at conviction ≥</span>
        {[5, 6, 8].map(n => (
          <button key={n} type="button" onClick={() => setMinConviction(n)}
            className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold cursor-pointer min-h-[32px] ${minConviction === n ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'}`}>{n}/10</button>
        ))}
        <span className="ml-auto">
          <Button size="sm" onClick={fire} disabled={busy}>{busy ? 'Scanning & placing…' : 'Scan & trade now'}</Button>
        </span>
      </div>
      <p className="mt-1 text-[12px] text-[var(--color-text-sub)]">
        Skips the backtest ritual, not the safety: real market orders with SL/TP attached at cTrader, sized and vetoable by the risk gate. Lower conviction = more (weaker) setups qualify.
      </p>
      {err && <p className="mt-1.5 text-[13px] text-[var(--color-warning-text)]">{err}</p>}
      {result && (
        <div className="mt-1.5 text-[13px]">
          <span className="font-semibold">{result.placed}/{result.requested} placed</span>
          <span className="text-[var(--color-text-sub)]"> — {result.candidates} setup{result.candidates === 1 ? '' : 's'} found at ≥{result.minConviction}/10</span>
          {result.note && <span className="block text-[12px] text-[var(--color-text-sub)]">{result.note}</span>}
          {result.attempts?.map((a, i) => (
            <span key={i} className="block text-[12px]">
              {a.placed ? '✓' : '✗'} {a.symbol} {a.bias?.toUpperCase()} {a.timeframe || ''} ({a.conviction}/10)
              {a.placed ? ` — filled @ ${fmt(a.executionPrice)} (position ${a.positionId ?? '—'})` : ' — vetoed or rejected (see Risk manager decisions below)'}
            </span>
          ))}
        </div>
      )}
    </Card>
  )
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

// One scan result row: what was found, what the trade WOULD be (entry/SL/TP),
// whether the bot will act on it (armed timeframe + conviction ≥8), and a
// chart with the levels drawn.
function ScanRow({ s, signal, armedTfs, matrix, autotradeOn }) {
  const [showChart, setShowChart] = useState(false)
  const found = s.bias !== 'skip'
  // Per-instrument arming beats the TF-wide list — mirror of loop.js gates.
  const symArmed = matrix?.[s.symbol] ?? armedTfs
  const tfArmed = signal ? symArmed.includes(signal.timeframe) : false
  const willTrade = found && autotradeOn && tfArmed && (s.confidence ?? 0) >= 8
  let verdict = null
  if (found) {
    if (willTrade) verdict = { tone: 'up', text: 'WILL AUTO-TRADE next loop (risk gate permitting)' }
    else if (!autotradeOn) verdict = { tone: 'neutral', text: 'autotrade off — signal only' }
    else if (!tfArmed) verdict = { tone: 'neutral', text: `no trade: ${signal?.timeframe} not armed for ${s.symbol} (armed: ${symArmed.join(', ') || 'none'})` }
    else verdict = { tone: 'neutral', text: `no trade: conviction ${s.confidence}/10 below the 8/10 auto bar` }
  }
  return (
    <div className="border-t border-[var(--color-border)] py-1.5">
      <div className="text-[13px] flex flex-wrap items-center gap-2">
        <span className="font-semibold w-20">{s.symbol}</span>
        {found
          ? <>
              <Badge tone={s.bias === 'short' ? 'down' : 'up'}>{String(s.bias).toUpperCase()} {s.timeframe}</Badge>
              <span>conviction {s.confidence}/10</span>
              {verdict && <Badge tone={verdict.tone}>{verdict.text}</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setShowChart(v => !v)}>{showChart ? 'Hide' : 'Chart'}</Button>
            </>
          : <span className="text-[var(--color-text-sub)]">{String(s.thesis || '').startsWith('SCAN ERROR') ? s.thesis : 'no setup — price not at a 61.8% zone'}</span>}
        {s.price != null && <span className="ml-auto text-[var(--color-text-sub)]">{fmt(s.price)}</span>}
      </div>
      {found && signal && (
        <div className="mt-1 text-[12px] text-[var(--color-text-sub)]">
          plan: enter {fmt(signal.entry)} · SL {fmt(signal.sl)} · TP1 {fmt(signal.tp1)} · TP2 {fmt(signal.tp2)} · R:R {signal.rr ?? '—'}
        </div>
      )}
      {showChart && signal && (
        <div className="mt-2">
          <PositionChart symbol={s.symbol} timeframe={signal.timeframe || '1h'} lines={{ entry: signal.entry, sl: signal.sl, tp: signal.tp1 }} />
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
  const [allTrades, setAllTrades] = useState(cached?.allTrades ?? [])
  const [benchmarks, setBenchmarks] = useState(null)   // {"SYM|tf": {profitFactor,...}} stored at Apply time
  const [events, setEvents] = useState(cached?.events ?? [])
  const [broker, setBroker] = useState(cached?.broker ?? null)  // selected account at the BROKER: live + pending
  const [brokerHistory, setBrokerHistory] = useState(cached?.brokerHistory ?? null) // broker's closed deals, last 7 days
  const [scan, setScan] = useState(cached?.scan ?? null)        // last fib scan: proof of life
  const [armedTfs, setArmedTfs] = useState(cached?.armedTfs ?? ['4h', '1d'])
  const [matrix, setMatrix] = useState(cached?.matrix ?? null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — set it up on the Connect tab.'); return }
    try {
      // 7 requests need 7 slots — a missing slot shifts every response one
      // to the left and the page dies on <shifted>.rows (undefined).
      const [h, p, t, , r, b, sc, bh] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/positions'),
        agentGet('/state/trades'),
        agentGet('/state/arm-benchmarks').then(r => setBenchmarks(r?.benchmarks || null)).catch(() => {}),
        agentGet('/state/risk-events?limit=200'),
        agentPost('/actions/broker-positions', { selectedOnly: true }).catch(() => null),
        agentGet('/state/scans').catch(() => null),
        agentPost('/actions/broker-history', { days: 7 }).catch(() => null),
      ])
      const fullTrades = t.rows || t.trades || []
      const next = {
        health: h,
        positions: p.rows || p.positions || [],
        trades: fullTrades.slice(0, 5),
        allTrades: fullTrades,
        events: (r?.rows || []),
        broker: b?.accounts?.[0] ?? null,
        brokerHistory: bh?.ok ? bh : null,
        scan: sc ? { at: sc.lastScanAt, rows: sc.lastResults?.scans || [], signals: sc.lastResults?.signals || {} } : null,
        atf: await agentGet('/state/autotrade-timeframes').catch(() => null),
      }
      next.armedTfs = next.atf?.timeframes || ['4h', '1d']
      next.matrix = next.atf?.matrix || null
      setHealth(next.health)
      setScan(next.scan)
      setArmedTfs(next.armedTfs)
      setMatrix(next.matrix)
      setPositions(next.positions)
      setTrades(next.trades)
      setAllTrades(next.allTrades)
      setEvents(next.events)
      setBroker(next.broker)
      setBrokerHistory(next.brokerHistory)
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
        {health && active && health.scanEnabled === false && (
          <p className="mt-2 text-[13px] font-semibold text-[var(--color-down)]">
            ⚠ Scan is OFF — autotrade is armed but the bot cannot see the market, so it will never trade.
            Turn <Link to="/tune" className="underline">Scan ON in Tune</Link>.
          </p>
        )}
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

      <TradeNowCard onDone={load} />

      {/* REALITY GAP — live results vs the backtest that justified arming.
          The forward test is the real exam (algo-quant-practice-notes §3.3). */}
      {benchmarks && Object.keys(benchmarks).length > 0 && (() => {
        const rows = Object.entries(benchmarks).map(([pair, bench]) => {
          const [sym, tf] = pair.split('|')
          const closed = allTrades.filter(t =>
            t.status !== 'open' && t.symbol === sym && (t.label_timeframe == null || t.label_timeframe === tf))
          const pnls = closed.map(t => Number(t.net_pnl ?? t.gross_pnl)).filter(Number.isFinite)
          const wins = pnls.filter(v => v > 0).reduce((a, b) => a + b, 0)
          const losses = Math.abs(pnls.filter(v => v < 0).reduce((a, b) => a + b, 0))
          const livePf = losses > 0 ? Math.round((wins / losses) * 100) / 100 : (pnls.length > 0 && wins > 0 ? Infinity : null)
          return { pair: `${sym} ${tf}`, bench, n: pnls.length, livePf }
        })
        const ready = rows.filter(r => r.n >= 5)
        return (
          <Card>
            <h2 className="text-[13px] font-semibold mb-1">Reality gap — live vs the backtest that armed it</h2>
            {ready.length === 0 && (
              <p className="text-[13px] text-[var(--color-text-sub)]">
                Building evidence: {rows.map(r => `${r.pair} ${r.n}/5 closed trades`).join(' · ')} — each armed pair compares live profit factor against its backtest once 5 real trades close.
              </p>
            )}
            {ready.map(r => {
              const btPf = r.bench.profitFactor
              const gap = btPf != null && r.livePf != null && r.livePf !== Infinity && r.livePf < btPf * 0.6
              return (
                <div key={r.pair} className="border-t border-[var(--color-border)] py-1.5 text-[13px] flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.pair}</span>
                  <span>backtest PF {btPf ?? '∞'}</span>
                  <span className={r.livePf != null && (r.livePf === Infinity || r.livePf >= 1) ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>
                    live PF {r.livePf === Infinity ? '∞' : r.livePf ?? '—'} ({r.n} trades)
                  </span>
                  {gap && <Badge tone="down">GAP — live is under 60% of backtest; consider disarming this pair</Badge>}
                </div>
              )
            })}
          </Card>
        )
      })()}

      {/* WHY NO TRADES — the product explains itself instead of looking dead.
          Every line is computed from live state, not canned text. */}
      {health && positions.length === 0 && (broker?.positions?.length ?? 0) === 0 && (
        <Card>
          <h2 className="text-[13px] font-semibold mb-1">Why no trades right now?</h2>
          <ul className="text-[13px] space-y-1 list-disc pl-5">
            {!active && <li className="font-semibold text-[var(--color-down)]">Autotrade is OFF — the bot never places orders. <Link to="/tune" className="underline">Activate on Tune</Link>.</li>}
            {active && health.scanEnabled === false && <li className="font-semibold text-[var(--color-down)]">Scan is OFF — the bot cannot see the market. <Link to="/tune" className="underline">Turn it on in Tune</Link>.</li>}
            {active && health.scanEnabled !== false && (() => {
              const rows = scan?.rows || []
              const found = rows.filter(r => r.bias !== 'skip')
              const noZone = rows.length - found.length
              const rejected = found.map(r => {
                const sig = scan?.signals?.[r.symbol]
                if (sig && !armedTfs.includes(sig.timeframe)) return `${r.symbol}: signal on ${sig.timeframe}, but only ${armedTfs.join('/')} are armed (your backtest only proved those)`
                if ((r.confidence ?? 0) < 8) return `${r.symbol}: conviction ${r.confidence}/10 — below the 8/10 bar for automatic entry`
                return `${r.symbol}: passed the signal checks — waiting on the risk gate at the next 5-min loop`
              })
              return (
                <>
                  {noZone > 0 && <li>{noZone} of {rows.length} watchlist symbols have no price at a 61.8% retracement zone at this moment — no setup exists to trade.</li>}
                  {rejected.map(txt => <li key={txt}>{txt}</li>)}
                  <li className="text-[var(--color-text-sub)]">
                    Expected pace on {armedTfs.join('/')}: your own backtest produced roughly 1–2 qualifying trades per month per symbol — a quiet screen for days is the strategy working, not failing. Telegram announces the moment anything changes.
                  </li>
                </>
              )
            })()}
          </ul>
        </Card>
      )}

      {/* Proof of life: what the last 5-minute scan actually looked at */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[13px] font-semibold">Latest scan</h2>
          {scan?.at && <span className="text-[12px] text-[var(--color-text-sub)]">{ago(scan.at)} — every symbol on the watchlist, all timeframes</span>}
        </div>
        {(!scan || scan.rows.length === 0) && (
          <div className="text-[13px] text-[var(--color-text-sub)]">
            No scan results yet — if Scan is ON, the next 5-minute loop fills this. If it stays empty, check Tune → Scan and the watchlist.
          </div>
        )}
        {/* Symbols WITH a signal get full rows; the quiet ones collapse to a
            single line — a screen of "no setup" rows was pure scrolling. */}
        {scan?.rows?.filter(s => scan.signals?.[s.symbol]).map(s => (
          <ScanRow key={s.symbol} s={s} signal={scan.signals?.[s.symbol]} armedTfs={armedTfs} matrix={matrix} autotradeOn={!!active} />
        ))}
        {(() => {
          const quiet = (scan?.rows || []).filter(s => !scan.signals?.[s.symbol])
          if (quiet.length === 0) return null
          return (
            <div className="border-t border-[var(--color-border)] pt-1.5 mt-1 text-[12px] text-[var(--color-text-sub)]">
              {quiet.length} quiet — no price at a 61.8% zone: {quiet.map(s => `${s.symbol} ${s.price != null ? fmt(s.price) : ''}`.trim()).join(' · ')}
            </div>
          )
        })()}
      </Card>

      <ReportChart allTrades={allTrades} events={events} />

      {/* THE BROKER'S TRUTH for the bot's account: live positions + set (pending) orders */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-1">
          At the broker — live positions ({broker?.positions?.length ?? '…'}) & set orders ({broker?.orders?.length ?? '…'})
        </h2>
        {!broker && <div className="text-[13px] text-[var(--color-text-sub)]">Fetching the account snapshot from the broker…</div>}
        {broker?.positions?.map(p => {
          // Net (incl. swap + commission) is what cTrader's Positions tab
          // shows — lead with it; fall back to price-only gross (marked *).
          const net = p.estNetPnl ?? p.estPnlQuote
          const hasCosts = (p.swap != null && p.swap !== 0) || (p.commission != null && p.commission !== 0)
          return (
            <div key={p.positionId} className="border-t border-[var(--color-border)] py-1.5 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{p.symbol}</span>
                <Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge>
                <span>{p.lots != null ? `${fmt(p.lots, 2)} lots` : ''}</span>
                <span>in {fmt(p.entry)} → now {fmt(p.currentPrice)}</span>
                {net != null && <span className={net >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{net >= 0 ? '+' : ''}{fmt(net, 2)}{p.estNetPnl == null ? '*' : ''}</span>}
                <span className="text-[var(--color-text-sub)]">SL {fmt(p.sl)} · TP {fmt(p.tp)}</span>
              </div>
              {(p.estNetPnl != null && hasCosts) && (
                <div className="mt-0.5 text-[12px] text-[var(--color-text-sub)]">
                  price {p.estPnlQuote >= 0 ? '+' : ''}{fmt(p.estPnlQuote, 2)} · swap {fmt(p.swap ?? 0, 2)} · commission {fmt(p.commission ?? 0, 2)}
                </div>
              )}
            </div>
          )
        })}
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

      {/* THE BROKER'S CLOSED-TRADE RECORD — every closing deal (bot-placed or
          manual) with realised net P&L, mirroring cTrader's History tab. */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-1 flex flex-wrap items-center gap-2">
          Closed at the broker — last 7 days ({brokerHistory?.rows?.length ?? '…'})
          {brokerHistory?.realized != null && (
            <span className={brokerHistory.realized >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>
              realised {brokerHistory.realized >= 0 ? '+' : ''}{fmt(brokerHistory.realized, 2)}
            </span>
          )}
        </h2>
        {!brokerHistory && <div className="text-[13px] text-[var(--color-text-sub)]">Fetching the broker's deal history…</div>}
        {brokerHistory?.rows?.map(d => (
          <div key={d.dealId ?? `${d.positionId}-${d.closedAt}`} className="border-t border-[var(--color-border)] py-1.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[var(--color-text-sub)]">{d.closedAt ? ago(new Date(d.closedAt).toISOString()) : ''}</span>
              <span className="font-semibold">{d.symbol}</span>
              <Badge tone={d.side === 'BUY' ? 'up' : 'down'}>{d.side}</Badge>
              <span>{d.lots != null ? `${fmt(d.lots, 2)} lots` : ''}</span>
              <span className="text-[var(--color-text-sub)]">in {fmt(d.entryPrice)} → out {fmt(d.closePrice)}</span>
              <span className={d.netPnl >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{d.netPnl >= 0 ? '+' : ''}{fmt(d.netPnl, 2)}</span>
            </div>
            {((d.swap != null && d.swap !== 0) || (d.commission != null && d.commission !== 0)) && (
              <div className="mt-0.5 text-[12px] text-[var(--color-text-sub)]">
                price {d.grossProfit >= 0 ? '+' : ''}{fmt(d.grossProfit, 2)} · swap {fmt(d.swap ?? 0, 2)} · commission {fmt(d.commission ?? 0, 2)}
              </div>
            )}
          </div>
        ))}
        {brokerHistory && brokerHistory.rows?.length === 0 && (
          <div className="text-[13px] text-[var(--color-text-sub)]">No positions closed at the broker in the last 7 days.</div>
        )}
        <p className="mt-1.5 text-[12px] text-[var(--color-text-sub)]">
          Straight from the broker's deal ledger — includes manual trades the bot never placed. Net = price P&L + swap + commission, the same figure as cTrader's History tab.
        </p>
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
            <span className="text-[var(--color-text-sub)]">in {fmt(t.entry_price)} → out {fmt(t.exit_price)}</span>
            <span className="text-[var(--color-text-sub)]">SL {fmt(t.sl_price)} · TP {fmt(t.tp_price)}</span>
            <span>closed {t.exit_reason ? `(${t.exit_reason})` : ''}</span>
            {t.pnl != null && <span className={Number(t.pnl) >= 0 ? 'text-[var(--color-up)] font-semibold' : 'text-[var(--color-down)] font-semibold'}>{Number(t.pnl) >= 0 ? '+' : ''}{fmt(t.pnl, 2)}</span>}
          </div>
        ))}
        {events.slice(0, 5).map(e => (
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
