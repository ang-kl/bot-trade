// Desk — THE one-screen workspace: a live chart wall on top (up to 30
// charts: 3 columns × 10 rows — open positions first, then whatever the
// scan currently finds active; the full watchlist only fills the wall when
// nothing is), and every detail of what is live below it in collapsible sections
// (expand/collapse triangles, state remembered per section). Nothing from
// the old Monitor was dropped — it lives here behind the triangles.
// Everything reuses the endpoints/components the dedicated pages already
// trust — this page assembles, it does not invent.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import PositionChart from '../components/PositionChart.jsx'
import PositionManager from '../components/PositionManager.jsx'
import OrderManager from '../components/OrderManager.jsx'
import ReportChart from '../components/ReportChart.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import StdTradeTable from '../components/StdTradeTable.jsx'
import { brokerPositionRows, brokerOrderRows, brokerDealRows, priceDp } from '../lib/std-trade-rows.js'
import { humanVeto } from '../lib/veto-words.js'
import { useSort } from '../lib/use-sort.jsx'

const REFRESH_MS = 20_000

// Short strategy tags for signal rows — the scan covers 5 registry
// strategies (stage matrix); Desk must never read as fib-only.
const STRAT_SHORT = {
  fib_618_fade: 'FIB',
  cup_handle: 'C&H',
  ema_pullback: 'EMA',
  donchian_breakout: 'BRK',
  rsi_meanrev: 'RSI',
}
// No-digits calls are PRICES (scale-aware canonical dp); explicit digits
// are money/counts and keep exactly what the caller asked for.
const fmt = (v, d) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d ?? priceDp(v) }))

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
  const [heartbeats, setHeartbeats] = useState(null)       // controller reliability
  const [llmSpend, setLlmSpend] = useState(null)           // token usage + est cost
  const [alphaDecay, setAlphaDecay] = useState(null)       // edge-erosion read
  const [capDraft, setCapDraft] = useState('')             // LLM daily cap editor
  const [capNote, setCapNote] = useState('')
  const [marketHours, setMarketHours] = useState(null)  // { SYM: { open, next_open_at } }
  const [brokerErr, setBrokerErr] = useState('')        // live snapshot fetch failure — shown, not swallowed
  const [error, setError] = useState('')
  const [symbol, setSymbol] = useState('')
  const [gridN, setGridN] = useState(() => {
    try { return Number(localStorage.getItem('desk_grid_n')) || 1 } catch { return 1 }
  })   // 1 | 4 | 9 | 30 charts (30 = 3 columns × 10 rows)

  const pickGrid = (n) => {
    setGridN(n)
    try { localStorage.setItem('desk_grid_n', String(n)) } catch { /* private mode */ }
  }

  // Column sorting for the Edge-health tables (same interaction as the
  // standard table). Streak sorts losses negative so worst floats on desc asc.
  const edgeSort = useSort(alphaDecay?.strategies || [], { key: 'trades', dir: 'desc' }, {
    strategy: s2 => s2.strategy,
    trend: s2 => s2.trend,
    streak: s2 => (s2.streak?.n ?? 0) * (s2.streak?.kind === 'loss' ? -1 : 1),
    trades: s2 => s2.total?.n,
    recent: s2 => s2.recent?.expectancy,
    prior: s2 => s2.prior?.expectancy,
    delta: s2 => s2.delta,
  })
  const baseSort = useSort(alphaDecay?.backtest?.combos || [], { key: 'pf', dir: 'desc' }, {
    combo: c2 => `${c2.symbol} ${c2.tf}`,
    trades: c2 => c2.trades,
    pf: c2 => c2.profitFactor,
    win: c2 => c2.winRatePct,
    total: c2 => c2.totalProfitPct,
  })

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — log in on the Connect tab.'); return }
    // TWO-TIER LOAD (owner: "30s to load — make it 3"). The broker snapshot
    // and deal history are live cTrader WebSocket round-trips (slow, tens of
    // seconds on a cold link); everything else is a SQLite read (<100ms).
    // Paint from the fast tier immediately; the broker sections say
    // "fetching…" and fill in whenever the WS answers.
    agentPost('/actions/broker-positions', { selectedOnly: true })
      .then(b => {
        setBroker(b?.accounts?.[0] ?? null)
        setBrokerErr('')
        setSymbol(prev => prev || b?.accounts?.[0]?.positions?.[0]?.symbol || '')
      })
      // A failed LIVE refresh must be loud — silently keeping the cached
      // snapshot made the Desk look current while showing Friday's data
      // (owner hit this Monday morning). The interval retries every cycle.
      .catch(e => setBrokerErr(`live broker refresh failed: ${e.message} — retrying`))
    agentPost('/actions/broker-history', { days: 7 })
      .then(bh => setBrokerHistory(bh?.ok ? bh : null))
      .catch(() => {})
    // Instant paint: the agent's cached snapshot (refreshed ~every 30s by
    // the monitor) fills the broker sections in milliseconds; the live
    // fetches above overwrite it the moment the WS answers. `prev ??` makes
    // sure cache never clobbers live data that already landed.
    agentGet('/state/broker-cache')
      .then(bc => {
        if (bc?.snapshot?.account) {
          setBroker(prev => prev ?? { ...bc.snapshot.account, _cachedAt: bc.snapshot.fetchedAt })
          setSymbol(prev => prev || bc.snapshot.account.positions?.[0]?.symbol || '')
        }
        if (bc?.history?.ok) setBrokerHistory(prev => prev ?? { ...bc.history, _cachedAt: bc.history.fetchedAt })
      })
      .catch(() => {})
    try {
      const [h, s, p, r, atf, c, t, hb, ls, ad, mh] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/risk-events?limit=200'),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/config').catch(() => null),
        agentGet('/state/trades').catch(() => null),
        agentGet('/state/heartbeats').catch(() => null),
        agentGet('/state/llm-spend').catch(() => null),
        agentGet('/state/alpha-decay').catch(() => null),
        agentGet('/state/market-hours').catch(() => null),
      ])
      setHealth(h)
      const rows = s.rows || s.scans || []
      setScans(rows)
      setPositions(p.rows || p.positions || [])
      setEvents(r.rows || [])
      setAllTrades(t?.rows || t?.trades || [])
      setArmed(atf)
      setConfig(c)
      setHeartbeats(hb?.controllers ?? null)
      setLlmSpend(ls)
      setAlphaDecay(ad)
      setMarketHours(mh?.hours || null)
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
  // Chart wall order: live broker positions first, then bot-tracked, then
  // whatever the scan currently finds ACTIVE (a live bias — hot before
  // warm), never the raw 50+ symbol watchlist (owner: "should based on
  // active list and not all symbols"). The full watchlist is only a
  // last-resort fallback for the empty state — before the first scan runs,
  // or once in a great while when nothing anywhere has a setup — so the
  // wall/dropdown is never blank.
  const activeScans = [...scans]
    .filter(sc => sc.bias && sc.bias !== 'skip')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map(sc => sc.symbol)
  const chartSymbols = [...new Set([
    ...(broker?.positions || []).map(p => p.symbol),
    ...positions.map(p => p.symbol),
    ...activeScans,
    ...(activeScans.length === 0 ? watch : []),
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
  const floating = (broker?.positions || []).reduce((s2, p2) => s2 + (Number(p2.netPnl ?? p2.estNetPnl ?? p2.estPnlQuote) || 0), 0)

  return (
    <div className="space-y-3">
      {error && <Card className="text-[13px]">{error}</Card>}

      {/* ---- Status strip — desk-style: dots + text, no pill clutter.
           Pills are for controls; status is DATA, so it reads as a line. ---- */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
          {/* Tri-state, honestly: "no data yet" must never read as OFF — a
              loading page and a disarmed bot are different facts. */}
          <span className="font-semibold whitespace-nowrap">
            <span aria-hidden="true" style={{ color: !health ? '#94a3b8' : health.autotradeEnabled ? 'var(--color-accent)' : '#94a3b8' }}>● </span>
            {!health ? 'Autotrade: no data yet' : health.autotradeEnabled ? 'Autotrade ON' : 'Autotrade OFF'}
          </span>
          {health?.pendingModeEnabled && <span className="whitespace-nowrap text-[var(--color-warning-text)] font-semibold">⏳ pending armed</span>}
          <span className={`font-semibold whitespace-nowrap ${health?.broker?.isLive ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}>
            {health?.broker?.isLive ? '⚠ LIVE' : 'DEMO'}
          </span>
          <span className="font-semibold whitespace-nowrap">${fmt(health?.broker?.balance, 2)}</span>
          <span className="text-[var(--color-text-sub)] whitespace-nowrap">
            micro-tuned: {armedChips.length || 0} combos ·{' '}
            <Link to="/tune" className="text-[var(--color-accent)] underline underline-offset-2">Tune ›</Link>
          </span>
          {equityStopToday && <span className="text-[var(--color-down)] font-semibold">EQUITY STOP TRIPPED — auto-disarmed today</span>}
          {health && !health.broker?.linked && (
            <span className="text-[var(--color-warning-text)]">No account linked — re-link on Connect (keep DB_PATH on a Railway Volume)</span>
          )}
        </div>
        {/* The bot's GOAL, one line, derived live from config. The armed
            combo list lives behind a disclosure — useful on demand, not as
            a 17-chip wall. */}
        <p className="mt-1 text-[12px] text-[var(--color-text-sub)]">
          <span className="font-semibold text-[var(--color-text)]">Goal:</span>{' '}
          {(config?.autotrade_scope ?? 'all') === 'all'
            ? <>full watchlist — {watch.length || '…'} symbols × armed strategies × any scanned TF</>
            : <>the {armedChips.length} backtest-armed combos only (widen in Tune)</>}
          {' '}· sizing {(config?.burn_in?.sizeMode ?? 'auto') === 'fixed' && config?.burn_in?.on ? `fixed ${config?.burn_in?.lots ?? 0.01} lots (burn-in)` : 'risk-based'}
          {config?.burn_in?.on ? <> · pacing {config?.burn_in?.targetTrades ?? 200} trades/{config?.burn_in?.windowDays ?? 2}d</> : null}
          {' '}· guardrails: risk gate · stage matrix · market hours · equity stop
        </p>
        {armedChips.length > 0 && (
          <details className="mt-0.5 text-[12px]">
            <summary className="cursor-pointer text-[var(--color-text-sub)] select-none">armed combos ({armedChips.length})</summary>
            <p className="mt-0.5 text-[var(--color-text-sub)] leading-relaxed">{armedChips.join(' · ')}</p>
          </details>
        )}
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
          {/* Symbol picker: a dropdown, not 52 chips — one control, no row
              of pills to swipe through (owner: "so many UI controls"). */}
          {gridN === 1 && chartSymbols.length > 0 && (
            <select
              aria-label="Chart symbol"
              value={symbol || ''}
              onChange={e => setSymbol(e.target.value)}
              className="glass-inset rounded-[8px] px-2 min-h-[28px] text-[12px] font-semibold bg-transparent cursor-pointer max-w-[140px]"
            >
              {chartSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>
          )}
          <span className="text-[11px] text-[var(--color-text-sub)]">
            positions first{gridN > 1 ? ' · 60s refresh — tap a symbol to focus' : ''}
          </span>
        </div>
        {gridN === 1 && (
          <>
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
                  ? `${STRAT_SHORT[sc.strategy] || 'FIB'} ${sc.bias.toUpperCase()} ${sc.timeframe || ''} ${sc.confidence ?? '?'}/10`
                  : 'no setup (any strategy)'}
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
        {broker?._cachedAt && (
          <p className="text-[11px] text-[var(--color-text-sub)]">snapshot {ago(broker._cachedAt)} — refreshing live…</p>
        )}
        {brokerErr && <p className="text-[11px] text-[var(--color-warning-text)]">{brokerErr}</p>}
        {(broker?.positions?.length ?? 0) > 0 && (
          <StdTradeTable
            rows={brokerPositionRows(broker.positions, { manageable: true })}
            countLabel="open positions"
            marketHours={marketHours}
            onSymbolClick={(sym3) => { setSymbol(sym3); pickGrid(1) }}
            panel={{ label: 'Manage', render: (row, close) => <PositionManager p={row.raw} onDone={() => { close(); load() }} /> }}
          />
        )}
        {(broker?.orders?.length ?? 0) > 0 && (
          <div className="mt-2">
            <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Pending (set) orders</div>
            <StdTradeTable
              rows={brokerOrderRows(broker.orders, { manageable: true })}
              countLabel="pending orders"
              marketHours={marketHours}
              onSymbolClick={(sym3) => { setSymbol(sym3); pickGrid(1) }}
              panel={{ label: 'Manage', render: (row, close) => <OrderManager o={row.raw} onDone={() => { close(); load() }} /> }}
            />
          </div>
        )}
        {broker && brokerFlat && (
          <p className="text-[12px] text-[var(--color-text-sub)]">Flat at the broker — no live positions or pending orders.</p>
        )}
      </Section>

      <Section
        id="closed7d"
        title="Closed at the broker — 7 days"
        summary={(() => {
          if (brokerHistory?.realized == null) return null
          let s2 = `realised ${brokerHistory.realized >= 0 ? '+' : ''}${fmt(brokerHistory.realized, 2)} · ${brokerHistory.rows?.length ?? 0} deals`
          // Best/worst contributor — the read a CTO wants before the rows.
          const rows2 = (brokerHistory.rows || []).filter(d => d.netPnl != null)
          if (rows2.length >= 2) {
            const best = rows2.reduce((a, b) => (b.netPnl > a.netPnl ? b : a))
            const worst = rows2.reduce((a, b) => (b.netPnl < a.netPnl ? b : a))
            s2 += ` · best ${best.symbol} +${fmt(Math.abs(best.netPnl), 2)} · worst ${worst.symbol} −${fmt(Math.abs(worst.netPnl), 2)}`
          }
          return s2
        })()}
        defaultOpen={false}
      >
        {!brokerHistory && <p className="text-[12px] text-[var(--color-text-sub)]">Fetching deal history…</p>}
        {brokerHistory?._cachedAt && (
          <p className="text-[11px] text-[var(--color-text-sub)]">history {ago(brokerHistory._cachedAt)} — refreshing live…</p>
        )}
        {(brokerHistory?.rows?.length ?? 0) > 0 && (
          <StdTradeTable rows={brokerDealRows(brokerHistory.rows)} countLabel="closed deals" marketHours={marketHours} onSymbolClick={(sym3) => { setSymbol(sym3); pickGrid(1) }} />
        )}
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
        {/* Plain rows, trader words — status is text with colour, not a pill;
            the raw machine code stays in the tooltip. */}
        <ul className="text-[12px]">
          {events.slice(0, 10).map(ev => (
            <li key={ev.id} className="flex items-baseline gap-1.5 min-w-0 py-px" title={ev.veto_reason || ''}>
              <span className={`w-9 shrink-0 text-[10px] font-bold tracking-wide ${ev.approved ? 'text-[var(--color-accent)]' : 'text-[var(--color-warning-text)]'}`}>
                {ev.approved ? 'OK' : 'VETO'}
              </span>
              <span className="font-semibold shrink-0">{ev.symbol}</span>
              <span className="text-[var(--color-text-sub)] truncate">{humanVeto(ev.veto_reason)}</span>
              <span className="ml-auto text-[var(--color-text-sub)] shrink-0">{ago(ev.created_at)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
          Full history on the <Link to="/trade" className="text-[var(--color-accent)] underline">Trade</Link> tab.
        </p>
      </Section>

      {/* Controllers — heartbeat reliability: every background controller's
          last beat, plus the C++ exec engine's probed liveness. A stalled
          controller is a positions-unmanaged incident, so it also alerts on
          Telegram; this panel is the always-on visual. */}
      <Section
        id="controllers"
        title="Controllers — heartbeats"
        summary={(() => {
          if (!heartbeats) return null
          const bad = heartbeats.filter(c => c.status === 'stalled' || c.status === 'error').length
          const live = heartbeats.filter(c => c.status === 'ok' || c.status === 'warn').length
          return bad ? `${bad} STALLED/FAILING` : `${live} beating`
        })()}
        defaultOpen={false}
      >
        {!heartbeats && <p className="text-[12px] text-[var(--color-text-sub)]">No data yet.</p>}
        {heartbeats && (
          // Two-column dot grid — half the height of the old pill list; a
          // healthy controller earns a dot, only trouble earns words.
          <ul className="text-[12px] grid gap-x-6 sm:grid-cols-2">
            {heartbeats.map(c => {
              const dot = c.status === 'ok' ? 'var(--color-accent)' : c.status === 'warn' ? '#c2410c' : c.status === 'idle' ? '#94a3b8' : 'var(--color-down)'
              return (
                <li key={c.name} className="flex items-baseline gap-1.5 min-w-0 py-px" title={c.status === 'idle' ? 'never ran (not armed / not applicable)' : `${c.status} · ${c.runs} runs`}>
                  <span aria-hidden="true" style={{ color: dot }}>●</span>
                  <span className="font-semibold shrink-0">{c.label}</span>
                  {(c.status === 'stalled' || c.status === 'error' || c.consecutive_failures > 0) && (
                    <span className="text-[var(--color-down)] truncate">
                      {c.status.toUpperCase()}{c.consecutive_failures > 0 ? ` · ${c.consecutive_failures} failing` : ''}{c.last_error ? ` · ${c.last_error}` : ''}
                    </span>
                  )}
                  <span className="ml-auto text-[var(--color-text-sub)] shrink-0">{c.status === 'idle' ? 'idle' : ago(c.last_run_at)}</span>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
          A beat means the controller's code ran (even if it chose to do nothing). Stalls alert on Telegram once, and once again on recovery.
        </p>
      </Section>

      {/* LLM spend — the no-bill-shock dashboard: real token usage priced
          in USD (today/7d/30d + projection), with an owner-set daily cap
          that alerts on Telegram once per day when crossed. */}
      <Section
        id="llmspend"
        title="LLM spend"
        summary={llmSpend ? `today $${(llmSpend.today?.cost_usd ?? 0).toFixed(2)} · ~$${(llmSpend.projected_month_usd ?? 0).toFixed(2)}/mo` : null}
        defaultOpen={false}
      >
        {!llmSpend && <p className="text-[12px] text-[var(--color-text-sub)]">No data yet.</p>}
        {llmSpend && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums mb-2">
              <span>Today <span className="font-semibold">${(llmSpend.today?.cost_usd ?? 0).toFixed(2)}</span> · {llmSpend.today?.calls ?? 0} calls</span>
              <span>7 days <span className="font-semibold">${(llmSpend.last7d?.cost_usd ?? 0).toFixed(2)}</span></span>
              <span>30 days <span className="font-semibold">${(llmSpend.last30d?.cost_usd ?? 0).toFixed(2)}</span></span>
              <span>Projected month <span className="font-semibold">${(llmSpend.projected_month_usd ?? 0).toFixed(2)}</span></span>
            </div>
            {(llmSpend.by_purpose?.length ?? 0) > 0 && (
              <div className="overflow-x-auto">
                <table className="std-cols w-full text-[12px] tabular-nums">
                  <thead className="text-left text-[var(--color-text-sub)]">
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-3 font-semibold">Purpose</th>
                      <th className="py-1 pr-3 font-semibold">Model</th>
                      <th className="py-1 pr-3 font-semibold text-right">Calls</th>
                      <th className="py-1 pr-3 font-semibold text-right">In</th>
                      <th className="py-1 pr-3 font-semibold text-right">Out</th>
                      <th className="py-1 font-semibold text-right">Est. cost (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmSpend.by_purpose.map(p2 => (
                      <tr key={`${p2.purpose}|${p2.model}`} className="border-b border-[var(--color-border)]">
                        <td className="py-1 pr-3">{p2.purpose}</td>
                        <td className="py-1 pr-3 text-[var(--color-text-sub)]">{p2.model}</td>
                        <td className="py-1 pr-3 text-right">{p2.calls.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.input_tokens.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.output_tokens.toLocaleString()}</td>
                        <td className="py-1 text-right">${p2.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="block text-[12px]">
                <span className="text-[var(--color-text-sub)]">Daily cost alert (USD, 0 = off) — currently {llmSpend.daily_cap_usd ? `$${llmSpend.daily_cap_usd}` : 'off'}</span>
                <Input type="number" step="0.1" min="0" value={capDraft} onChange={e => setCapDraft(e.target.value)} placeholder={llmSpend.daily_cap_usd ? String(llmSpend.daily_cap_usd) : 'e.g. 1.00'} className="w-28" />
              </label>
              <Button
                size="sm" variant="subtle"
                onClick={async () => {
                  try {
                    const r = await agentPost('/actions/llm-budget', { dailyCapUsd: capDraft === '' ? 0 : Number(capDraft) })
                    setCapNote(r.dailyCapUsd ? `Alert armed at $${r.dailyCapUsd}/day.` : 'Alert disarmed.')
                    await load()
                  } catch (e) { setCapNote(e.message) }
                }}
              >Save cap</Button>
              {capNote && <span className="text-[12px] text-[var(--color-text-sub)]">{capNote}</span>}
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
              Scanning, backtests, and all trading decisions are deterministic — zero tokens. The only LLM consumers are the position monitor and the weekend watch, priced at published per-model rates (estimates, not the invoice).
            </p>
          </>
        )}
      </Section>

      {/* Edge health — banded perspectives: the auto-bot's live edge,
          signal decay, the owner's backtest baseline, and the advisory/
          committed response list — every verdict evidential, every action
          one link from its setting. No "unknown": unlabelled trades are
          explained by source. */}
      <Section
        id="alphadecay"
        title="Edge health"
        summary={(() => {
          if (!alphaDecay) return null
          const bad = (alphaDecay.strategies || []).filter(s2 => s2.trend === 'decaying').length
          const adv = (alphaDecay.advisories || []).length
          return bad ? `${bad} DECAYING · ${adv} advisories` : `${alphaDecay.total_closed ?? 0} trades · ${adv} advisories`
        })()}
        defaultOpen={false}
      >
        {!alphaDecay && <p className="text-[12px] text-[var(--color-text-sub)]">No data yet.</p>}
        {alphaDecay && (
          <>
            {/* Band 1 — the auto-bot's LIVE edge */}
            <div className="text-[12px] font-semibold mb-1">Live edge — auto-bot</div>
            {(alphaDecay.strategies?.length ?? 0) === 0 && (
              <p className="text-[12px] text-[var(--color-text-sub)]">No closed trades yet — decay is measured from live results; <Link to="/tune" className="text-[var(--color-accent)] underline">arm burn-in in Tune</Link> to build the sample fastest.</p>
            )}
            {(alphaDecay.strategies?.length ?? 0) > 0 && (
              <div className="overflow-x-auto">
                <table className="std-cols w-full text-[12px] tabular-nums">
                  <thead className="text-left text-[var(--color-text-sub)]">
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-3 font-semibold">{edgeSort.sortBtn('strategy', 'Strategy')}</th>
                      <th className="py-1 pr-3 font-semibold">{edgeSort.sortBtn('trend', 'Trend')}</th>
                      <th className="py-1 pr-3 font-semibold">{edgeSort.sortBtn('streak', 'Streak')}</th>
                      <th className="py-1 pr-3 font-semibold text-right">{edgeSort.sortBtn('trades', 'Trades')}</th>
                      <th className="py-1 pr-3 font-semibold text-right">{edgeSort.sortBtn('recent', 'Recent exp.')}</th>
                      <th className="py-1 pr-3 font-semibold text-right">{edgeSort.sortBtn('prior', 'Prior exp.')}</th>
                      <th className="py-1 font-semibold text-right">{edgeSort.sortBtn('delta', 'Δ')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {edgeSort.sorted.map(s2 => {
                      const un = s2.strategy === 'unlabelled'
                      const srcNote = un && alphaDecay.unlabelled
                        ? Object.entries(alphaDecay.unlabelled.sources).map(([k, v]) => `${k}: ${v}`).join(' · ')
                        : null
                      return (
                        <tr key={s2.strategy} className="border-b border-[var(--color-border)]">
                          <td className="py-1 pr-3 font-semibold">
                            {un
                              ? <span title={`Trades without a strategy label — ${srcNote}. These are YOUR manual trades, test fills and adopted broker fills, scored separately so bot strategies stay clean.`}>unlabelled <span className="font-normal text-[var(--color-text-sub)]">({srcNote})</span></span>
                              : <Link to="/tune" className="underline underline-offset-2" title="Open Tune — pipeline stage matrix for this strategy">{s2.strategy}</Link>}
                          </td>
                          <td className="py-1 pr-3">
                            <Badge tone={s2.trend === 'improving' ? 'up' : s2.trend === 'decaying' ? 'down' : 'neutral'}>
                              {s2.trend === 'insufficient' ? `NEED ${alphaDecay.window}+` : s2.trend.toUpperCase()}
                            </Badge>
                          </td>
                          <td className={`py-1 pr-3 font-semibold ${s2.streak?.kind === 'win' ? 'text-[var(--color-up)]' : s2.streak?.kind === 'loss' ? 'text-[var(--color-down)]' : 'text-[var(--color-text-sub)]'}`}>
                            {s2.streak?.n ? `${s2.streak.n} ${s2.streak.kind}${s2.streak.n > 1 ? 's' : ''}` : '—'}
                          </td>
                          <td className="py-1 pr-3 text-right">{s2.total?.n ?? 0}</td>
                          <td className="py-1 pr-3 text-right">{s2.recent?.expectancy != null ? `$${s2.recent.expectancy.toFixed(2)}` : '—'}</td>
                          <td className="py-1 pr-3 text-right">{s2.prior?.expectancy != null ? `$${s2.prior.expectancy.toFixed(2)}` : '—'}</td>
                          <td className={`py-1 text-right font-semibold ${s2.delta == null ? '' : s2.delta >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                            {s2.delta != null ? `${s2.delta >= 0 ? '+' : ''}${s2.delta.toFixed(2)}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Band 2 — signal decay */}
            <div className="text-[12px] font-semibold mt-3 mb-1">Signal decay — fills vs their signals</div>
            {(alphaDecay.lag_sampled ?? 0) > 0
              ? (
                <p className="text-[12px] tabular-nums">
                  {alphaDecay.entry_lag.map(b2 => (
                    <span key={b2.key} className="mr-3">{b2.label}: <span className="font-semibold">{b2.expectancy != null ? `$${b2.expectancy.toFixed(2)}` : '—'}</span> ({b2.n})</span>
                  ))}
                  <span className="text-[var(--color-text-sub)]"> — if slow fills earn less, tighten the <Link to="/tune" className="text-[var(--color-accent)] underline">monitor cadence in Tune</Link>.</span>
                </p>
              )
              : <p className="text-[12px] text-[var(--color-text-sub)]">Needs trades that carry their signal timestamp — fills from scanned signals populate this automatically.</p>}

            {/* Band 3 — the OWNER's edge as backtested */}
            <div className="text-[12px] font-semibold mt-3 mb-1">Your edge — backtest baseline</div>
            {alphaDecay.backtest
              ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="std-cols w-full text-[12px] tabular-nums">
                      <thead className="text-left text-[var(--color-text-sub)]">
                        <tr className="border-b border-[var(--color-border)]">
                          <th className="py-1 pr-3 font-semibold">{baseSort.sortBtn('combo', 'Combo')}</th>
                          <th className="py-1 pr-3 font-semibold text-right">{baseSort.sortBtn('trades', 'Trades')}</th>
                          <th className="py-1 pr-3 font-semibold text-right">{baseSort.sortBtn('pf', 'PF')}</th>
                          <th className="py-1 pr-3 font-semibold text-right">{baseSort.sortBtn('win', 'Win %')}</th>
                          <th className="py-1 font-semibold text-right">{baseSort.sortBtn('total', 'Total %')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {baseSort.sorted.slice(0, 10).map(c2 => (
                          <tr key={`${c2.symbol}|${c2.tf}`} className="border-b border-[var(--color-border)]">
                            <td className="py-1 pr-3 font-semibold">{c2.symbol} · {c2.tf}</td>
                            <td className="py-1 pr-3 text-right">{c2.trades}</td>
                            <td className={`py-1 pr-3 text-right font-semibold ${(c2.profitFactor ?? 0) > 1 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{c2.profitFactor != null ? c2.profitFactor.toFixed(2) : '∞'}</td>
                            <td className="py-1 pr-3 text-right">{c2.winRatePct != null ? `${c2.winRatePct.toFixed(0)}%` : '—'}</td>
                            <td className={`py-1 text-right ${(c2.totalProfitPct ?? 0) >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{c2.totalProfitPct != null ? `${c2.totalProfitPct.toFixed(1)}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
                    {alphaDecay.backtest.strategy} · tested {ago(alphaDecay.backtest.ranAt)} ago{alphaDecay.backtest.combos.length > 10 ? ` · showing 10 of ${alphaDecay.backtest.combos.length} combos` : ''} — <Link to="/tune" className="text-[var(--color-accent)] underline">re-run in Tune</Link> after strategy or filter changes.
                  </p>
                </>
              )
              : <p className="text-[12px] text-[var(--color-text-sub)]">No baseline stored yet — <Link to="/tune" className="text-[var(--color-accent)] underline">run a backtest in Tune</Link> and your tested edge will appear here for live-vs-tested comparison.</p>}

            {/* Band 4 — advisory vs committed: what YOU should look at, and
                what the machine will do on its own. AI trading = evidential
                response to streaks, not hope. */}
            <div className="text-[12px] font-semibold mt-3 mb-1">
              Advisories &amp; committed automation
              <span className="ml-2 font-normal text-[var(--color-text-sub)]">breaker {alphaDecay.breaker?.on ? `ARMED at ${alphaDecay.breaker.streak} straight losses` : 'OFF'} · <Link to="/tune" className="text-[var(--color-accent)] underline">change</Link></span>
            </div>
            {(alphaDecay.advisories?.length ?? 0) === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">Nothing needs attention — edges holding, automation armed.</p>}
            <ul className="text-[12px] space-y-1">
              {(alphaDecay.advisories || []).map((a, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Badge tone={a.level === 'committed' ? 'info' : 'warning'}>{a.level === 'committed' ? 'COMMITTED' : 'ADVISORY'}</Badge>
                  <span className="min-w-0">{a.text} {a.link && <Link to={a.link} className="text-[var(--color-accent)] underline whitespace-nowrap">open {a.link === '/trade' ? 'Trade' : 'Tune'} →</Link>}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-[var(--color-text-sub)]">
              Expectancy = average net PnL per trade; "recent vs prior" compares the last {alphaDecay.window} trades against the {alphaDecay.window} before them, per strategy. ADVISORY = your call, with the evidence. COMMITTED = the adaptive breaker acts on its own at the stated threshold.
            </p>
          </>
        )}
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
                  {noZone > 0 && <li>{noZone} of {scans.length} watchlist symbols have no setup on ANY scanned strategy right now (fib zone, cup &amp; handle, EMA pullback, breakout, RSI stretch) — nothing exists to trade.</li>}
                  {found.map(r => <li key={r.symbol}>{r.symbol}: {STRAT_SHORT[r.strategy] || 'FIB'} {String(r.bias).toUpperCase()} signal on {r.timeframe || '?'} at {r.confidence ?? '?'}/10 — waiting on the armed-timeframe and risk gates.</li>)}
                  <li className="text-[var(--color-text-sub)]">
                    Expected pace on {(armed?.timeframes || []).join('/') || 'the armed timeframes'}: roughly 1–2 qualifying trades per month per symbol — a quiet screen for days is the strategy working, not failing. Telegram announces the moment anything changes.
                  </li>
                </>
              )
            })()}
          </ul>
        </Section>
      )}

      {/* Performance — stat tiles first (they work from trade #1, no
          3-day chart warm-up), the decisions/equity chart below. */}
      <Section
        id="performance"
        title="Performance"
        summary={(() => {
          const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
          if (closed.length === 0) return null
          const total = closed.reduce((s2, t2) => s2 + Number(t2.net_pnl), 0)
          return `${closed.length} closed · ${total >= 0 ? '+' : ''}${total.toFixed(2)}`
        })()}
        defaultOpen={false}
      >
        {(() => {
          const closed = allTrades.filter(t2 => t2.status === 'closed' && t2.net_pnl != null)
          if (closed.length === 0) {
            return <p className="text-[12px] text-[var(--color-text-sub)] mb-2">No closed trades yet — tiles and chart fill from the first completed round-trip.</p>
          }
          const pnls = closed.map(t2 => Number(t2.net_pnl))
          const wins = pnls.filter(v => v > 0)
          const losses = pnls.filter(v => v <= 0)
          const total = pnls.reduce((s2, v) => s2 + v, 0)
          const grossWin = wins.reduce((s2, v) => s2 + v, 0)
          const grossLoss = Math.abs(losses.reduce((s2, v) => s2 + v, 0))
          const pf = grossLoss > 0 ? grossWin / grossLoss : null
          // Max drawdown on the cumulative closed-trade equity curve.
          let peak = 0; let equity = 0; let mdd = 0
          for (const v of pnls) { equity += v; peak = Math.max(peak, equity); mdd = Math.max(mdd, peak - equity) }
          const tile = (label, value, tone) => (
            <div key={label} className="glass-inset rounded-[9px] px-2.5 py-1.5 min-w-[92px]">
              <div className="text-[10px] text-[var(--color-text-sub)]">{label}</div>
              <div className={`text-[13px] font-bold tabular-nums ${tone ?? ''}`}>{value}</div>
            </div>
          )
          const up = 'text-[var(--color-up)]'
          const down = 'text-[var(--color-down)]'
          return (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tile('Net P&L', `${total >= 0 ? '+' : ''}${total.toFixed(2)}`, total >= 0 ? up : down)}
              {tile('Trades', String(closed.length))}
              {tile('Win rate', `${((wins.length / closed.length) * 100).toFixed(0)}%`)}
              {tile('Profit factor', pf != null ? pf.toFixed(2) : wins.length ? '∞' : '—', pf == null || pf >= 1 ? up : down)}
              {tile('Expectancy', `${(total / closed.length).toFixed(2)}/trade`, total >= 0 ? up : down)}
              {tile('Avg win', wins.length ? `+${(grossWin / wins.length).toFixed(2)}` : '—', up)}
              {tile('Avg loss', losses.length ? `−${(grossLoss / losses.length).toFixed(2)}` : '—', down)}
              {tile('Max drawdown', mdd > 0 ? `−${mdd.toFixed(2)}` : '—', down)}
              {tile('Best / worst', `${Math.max(...pnls).toFixed(2)} / ${Math.min(...pnls).toFixed(2)}`)}
            </div>
          )
        })()}
        <ReportChart allTrades={allTrades} events={events} />
      </Section>
    </div>
  )
}
