// Trade — the single live view: agent health, current fib signals, open
// positions, recent trades, and the risk manager's latest decisions.
import { Fragment, useEffect, useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { Link } from 'react-router-dom'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import PositionChart from '../components/PositionChart.jsx'

// Inline tab link used by the "Next:" guide line
function NavTab({ to, children }) {
  return <Link to={to} className="font-semibold text-[var(--color-accent)] underline underline-offset-2">{children}</Link>
}

const REFRESH_MS = 30_000

function fmt(n, digits = 5) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits })
}

// SQLite datetimes are UTC without a zone marker — normalise before Date().
function dateTimeParts(iso) {
  if (!iso) return null
  const s = String(iso)
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'))
  if (!Number.isFinite(d.getTime())) return null
  return {
    day: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }
}

function ago(iso) {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

// sqlite writes "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) — parse as UTC.
function toMs(v) {
  if (!v) return null
  const t = Date.parse(String(v).includes('T') ? v : v.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}

// Open (monitored) positions → the standard shape. Time = the broker fill
// time when known (trades.opened_at via the join), else the row's created_at.
function openPositionRows(positions) {
  return positions.map(p => {
    const src = p.source || 'autopilot'
    const checkedAt = p.last_check_at || p.last_checked_at
    return {
      id: `pos-${p.id}`,
      at: p.opened_at || p.created_at,
      symbol: p.symbol,
      result: { text: 'OPEN', tone: 'info' },
      source: { text: ATTEMPT_SOURCE[src] || String(src).toUpperCase(), tone: src === 'validation_fill' ? 'special' : 'neutral' },
      side: String(p.side || '').toUpperCase() || null,
      qty: p.volume,
      entry: p.entry_price,
      sl: p.current_sl,
      tp: p.current_tp,
      reason: `${p.last_check_action || 'not checked yet'}${checkedAt ? ` (${ago(checkedAt)})` : ''}`,
      chart: {
        symbol: p.symbol,
        timeframe: '1h',
        lines: { entry: p.entry_price, sl: p.current_sl, tp: p.current_tp },
      },
    }
  })
}

// Broker resting orders → the standard shape. They carry no creation
// timestamp in the reconcile snapshot, so Time is honestly '—' and the
// expiry lives in Reason. Qty is in UNITS at the broker (not lots) — kept
// explicit with a 'u' suffix rather than guessing a contract size.
function pendingOrderRows(orders) {
  return orders.map((o, i) => ({
    id: `po-${o.orderId || i}`,
    at: null,
    symbol: o.symbolName || '?',
    result: { text: 'PENDING', tone: 'warning' },
    source: { text: o.bot ? 'BOT' : 'MANUAL', tone: o.bot ? 'special' : 'neutral' },
    side: o.side || null,
    qtyText: o.volumeUnits != null ? `${Number(o.volumeUnits).toLocaleString()} u` : '—',
    entry: o.limitPrice ?? o.stopPrice,
    sl: o.sl,
    tp: o.tp,
    reason: `${typeof o.orderType === 'string' ? o.orderType : 'LIMIT'}${o.expiresAt ? ` · expires ${new Date(o.expiresAt).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`,
    chart: {
      symbol: o.symbolName,
      timeframe: '1h',
      lines: { entry: o.limitPrice ?? o.stopPrice, sl: o.sl, tp: o.tp },
    },
  }))
}

// External (non-bot) broker positions → the standard shape; observed only.
function externalPositionRows(positions) {
  return positions.map(p => ({
    id: `ext-${p.id}`,
    at: p.opened_at || p.created_at || null,
    symbol: p.symbol,
    result: { text: 'OPEN', tone: 'info' },
    source: { text: 'EXTERNAL', tone: 'neutral' },
    side: String(p.side || '').toUpperCase() || null,
    qty: p.volume ?? null,
    entry: p.entry_price,
    sl: p.current_sl ?? null,
    tp: p.current_tp ?? null,
    reason: 'observed, not managed',
    chart: { symbol: p.symbol, timeframe: '1h', lines: { entry: p.entry_price } },
  }))
}

// One closed/attempted trade row. UNCONFIRMED = the bot sent an order but
// recorded no broker fill price — until reconciled, treat it as NOT a trade
// (the truthful reading of a null entry on a rejected-order era row).
function TradeRow({ t }) {
  const [showChart, setShowChart] = useState(false)
  const rejected = t.status === 'rejected'
  const unconfirmed = !rejected && t.entry_price == null
  return (
    <li className="border-t border-[var(--color-border)] pt-1 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{t.symbol}</span>
        <span className="text-[var(--color-text-sub)]">{String(t.side || '').toUpperCase()}</span>
        {rejected
          ? <Badge tone="warning">✗ REJECTED — broker has no record (reconciled)</Badge>
          : unconfirmed
          ? <Badge tone="warning">✗ UNCONFIRMED — no broker fill recorded</Badge>
          : (
            <>
              <span className="text-[var(--color-text-sub)]">in {fmt(t.entry_price)}{t.exit_price != null ? ` → out ${fmt(t.exit_price)}` : ''}</span>
              <Badge tone={(t.net_pnl ?? 0) >= 0 ? 'up' : 'down'}>{t.net_pnl != null ? `${t.net_pnl >= 0 ? '+' : ''}${fmt(t.net_pnl, 2)}` : t.status}</Badge>
            </>
          )}
        <span className="text-[var(--color-text-sub)]">SL {fmt(t.sl_price)} · TP {fmt(t.tp_price)}</span>
        {t.close_reason && <span className="text-[var(--color-text-sub)]">({t.close_reason})</span>}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[var(--color-text-sub)]">{ago(t.closed_at || t.opened_at)}</span>
          <Button size="sm" variant="ghost" onClick={() => setShowChart(v => !v)}>{showChart ? 'Hide' : 'Chart'}</Button>
        </span>
      </div>
      {unconfirmed && (
        <p className="text-[12px] text-[var(--color-text-sub)] mt-0.5">
          The order was sent but no execution price came back from cTrader — tap "Reconcile with broker" above to settle it against the broker's deal history.
        </p>
      )}
      {showChart && (
        <div className="py-2">
          <PositionChart
            symbol={t.symbol}
            timeframe={t.label_timeframe || '1h'}
            lines={{ entry: t.entry_price, sl: t.sl_price, tp: t.tp_price }}
            at={toMs(t.closed_at || t.opened_at)}
            markers={{ entryT: toMs(t.opened_at), exitT: toMs(t.closed_at) }}
          />
        </div>
      )}
    </li>
  )
}

// Plain-words strategy names for signal rows (scans.strategy).
const STRATEGY_NAMES = {
  fib_618_fade: 'Fib 61.8% fade',
  cup_handle: 'Cup & Handle',
  ema_pullback: 'EMA pullback',
  donchian_breakout: 'Range breakout',
  rsi_meanrev: 'RSI mean-rev',
}

// Plain-words provenance labels for order-log rows (proposal_json.source).
const ATTEMPT_SOURCE = {
  validation_fill: 'TEST FILL',
  manual: 'MANUAL',
  execute_analysis: 'EXECUTE',
  pending: 'PENDING',
  auto_signal: 'AUTO',
  burnin: 'BURN-IN',
  autopilot: 'AUTO',
  external: 'EXTERNAL',
}

// THE standard trade table (owner: "use the order log table and its columns
// as the standard for opened trades and pending trades"). TradingView-style:
// fixed header, numerics right-aligned in tabular figures, Long/Short
// coloured, sideways scroll with the first two columns (date/time, symbol)
// FROZEN, and 8-row pagination. Callers map their rows to the shared shape:
// { id, at, symbol, result:{text,tone}, source:{text,tone}, side ('BUY'|
//   'SELL'|null), qty | qtyText, entry, sl, tp, reason, reasonTitle?, chart? }
const OL_PAGE = 8
const OL_COL1_W = 76  // px — frozen date/time column; col 2 offset builds on it

function StdTradeTable({ rows, countLabel = 'rows' }) {
  const [page, setPage] = useState(0)
  const [chartFor, setChartFor] = useState(null) // row id with the chart open

  const pages = Math.max(1, Math.ceil(rows.length / OL_PAGE))
  const p = Math.min(page, pages - 1)
  const slice = rows.slice(p * OL_PAGE, p * OL_PAGE + OL_PAGE)

  if (rows.length === 0) return <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>

  const num = (v) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 5 }))
  // Frozen columns need a SOLID background or scrolled cells show through.
  const stick1 = 'sticky left-0 z-10 bg-[var(--color-bg)]'
  const stick2 = `sticky z-10 bg-[var(--color-bg)]`

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-[880px] w-full text-[12px] tabular-nums">
          <thead className="text-left text-[var(--color-text-sub)]">
            <tr className="border-b border-[var(--color-border)]">
              <th className={`py-1.5 pr-2 font-semibold ${stick1}`} style={{ minWidth: OL_COL1_W }}>Time</th>
              <th className={`py-1.5 pr-3 font-semibold ${stick2}`} style={{ left: OL_COL1_W }}>Symbol</th>
              <th className="py-1.5 pr-3 font-semibold">Result</th>
              <th className="py-1.5 pr-3 font-semibold">Source</th>
              <th className="py-1.5 pr-3 font-semibold">Side</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Qty</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Entry</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Stop Loss</th>
              <th className="py-1.5 pr-3 font-semibold text-right">Take Profit</th>
              <th className="py-1.5 pr-3 font-semibold">Reason</th>
              <th className="py-1.5 font-semibold" aria-label="Chart" />
            </tr>
          </thead>
          <tbody>
            {slice.map(r => {
              const w = r.at ? dateTimeParts(r.at) : null
              const long = r.side === 'BUY'
              return (
                <Fragment key={r.id}>
                  <tr className="border-b border-[var(--color-border)] align-middle">
                    <td className={`py-1.5 pr-2 whitespace-nowrap ${stick1}`} style={{ minWidth: OL_COL1_W }}>
                      {w
                        ? <>
                            <span className="block leading-tight">{w.day}</span>
                            <span className="block leading-tight text-[var(--color-text-sub)]">{w.time}</span>
                          </>
                        : '—'}
                    </td>
                    <td className={`py-1.5 pr-3 font-bold whitespace-nowrap ${stick2}`} style={{ left: OL_COL1_W }}>{r.symbol}</td>
                    <td className="py-1.5 pr-3"><Badge tone={r.result.tone}>{r.result.text}</Badge></td>
                    <td className="py-1.5 pr-3"><Badge tone={r.source.tone}>{r.source.text}</Badge></td>
                    <td className={`py-1.5 pr-3 font-semibold ${long ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {r.side ? (long ? 'Long' : 'Short') : '—'}
                    </td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{r.qtyText ?? num(r.qty)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.entry)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.sl)}</td>
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">{num(r.tp)}</td>
                    <td className="py-1.5 pr-3 max-w-[280px] truncate text-[var(--color-text-sub)]" title={r.reasonTitle ?? r.reason ?? ''}>
                      {r.reason || '—'}
                    </td>
                    <td className="py-1.5 whitespace-nowrap">
                      {r.chart && (
                        <Button size="sm" variant="ghost" onClick={() => setChartFor(chartFor === r.id ? null : r.id)}>
                          {chartFor === r.id ? 'Hide' : 'Chart'}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {chartFor === r.id && r.chart && (
                    <tr className="border-b border-[var(--color-border)]">
                      <td colSpan={11} className="py-2">
                        <PositionChart
                          symbol={r.chart.symbol}
                          timeframe={r.chart.timeframe || '1h'}
                          lines={r.chart.lines}
                          at={r.chart.at}
                          markers={r.chart.markers}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* Pagination — keeps every panel the same height */}
      <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-text-sub)]">
        <Button size="sm" variant="subtle" disabled={p === 0} onClick={() => setPage(p - 1)}>‹ Newer</Button>
        <span>page {p + 1} / {pages} · {rows.length} {countLabel}</span>
        <Button size="sm" variant="subtle" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>Older ›</Button>
      </div>
    </div>
  )
}

// Order log rows (risk_events) → the standard shape.
function OrderLogTable({ rows }) {
  const mapped = rows.map(ev => {
    let prop = null
    try { prop = ev.proposal_json ? JSON.parse(ev.proposal_json) : null } catch { /* legacy row */ }
    const src = ATTEMPT_SOURCE[prop?.source] || (prop?.source ? String(prop.source).toUpperCase() : 'AUTO')
    return {
      id: `ol-${ev.id}`,
      at: ev.created_at,
      symbol: ev.symbol,
      result: { text: ev.approved ? 'OK' : 'VETO', tone: ev.approved ? 'up' : 'warning' },
      source: { text: src, tone: prop?.source === 'validation_fill' ? 'special' : 'neutral' },
      side: ev.side || null,
      qty: prop?.requestedVolume,
      entry: prop?.entry,
      sl: prop?.sl,
      tp: prop?.tp1,
      reason: ev.veto_reason || ev.sizing_note || '',
      chart: prop
        ? {
            symbol: ev.symbol,
            timeframe: prop.timeframe || '1h',
            lines: { entry: prop.entry, sl: prop.sl, tp: prop.tp1 },
            at: toMs(ev.created_at),
            markers: { entryT: toMs(ev.created_at) },
          }
        : null,
    }
  })
  return <StdTradeTable rows={mapped} countLabel="attempts" />
}

export default function Trade() {
  const [health, setHealth] = useState(null)
  const [scans, setScans] = useState([])
  const [positions, setPositions] = useState([])
  const [trades, setTrades] = useState([])
  const [riskEvents, setRiskEvents] = useState([])
  const [account, setAccount] = useState(null)   // risk-config derived: balance, leverage
  const [broker, setBroker] = useState(null)     // reconcile snapshot: pending orders, external positions
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reconcileNote, setReconcileNote] = useState('')
  const [armed, setArmed] = useState(null)  // { timeframes, matrix } — what autotrade may act on
  const [pending, setPending] = useState(null)  // { enabled, matrix } — resting-limit pending-order mode

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      // Slot count matters: destructure order must mirror the array below —
      // append new fetches at the END or every later variable shifts.
      const [h, s, p, t, r, rc, bo, atf, cfg] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/trades'),
        agentGet('/state/risk-events?limit=200'),
        agentGet('/state/risk-config').catch(() => null),
        agentGet('/state/broker-orders').catch(() => null),
        agentGet('/state/autotrade-timeframes').catch(() => null),
        agentGet('/state/config').catch(() => null),
      ])
      setHealth(h)
      setScans(s.rows || s.scans || [])
      setPositions(p.rows || p.positions || [])
      setTrades((t.rows || t.trades || []).slice(0, 15))
      setRiskEvents(r.rows || [])
      setAccount(rc?.derived || null)
      setBroker(bo || null)
      setArmed(atf || null)
      setPending(cfg
        ? {
            enabled: cfg.pending_mode_enabled === true || cfg.pending_mode_enabled === 'true',
            matrix: cfg.pending_matrix && typeof cfg.pending_matrix === 'object' ? cfg.pending_matrix : null,
          }
        : null)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const act = async (label, path) => {
    setBusy(label)
    try { await agentPost(path); await load() } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  // Validation fill — one deliberate 0.01-lot order through the REAL
  // auto-trade path (risk gate included). Closes the C++ first-fill watch.
  const [vfillMsg, setVfillMsg] = useState('')
  const validationFill = async () => {
    // Default BTCUSD: crypto quotes 24/7, so the test never dies on the
    // FX dead window (owner hit "no live quote" at 21:20 UTC on EURUSD).
    // Remembers the last symbol used.
    let lastSym = 'BTCUSD'
    try { lastSym = localStorage.getItem('vfill_symbol') || 'BTCUSD' } catch { /* private mode */ }
    const sym = window.prompt(
      'Validation fill: places ONE REAL 0.01-lot market order through the full auto-trade path (market-hours gate, risk gate, sizing, exec engine). The risk gate may veto — that veto is real too.\n\nBTCUSD works 24/7; FX symbols need their market open.\n\nSymbol:',
      lastSym
    )
    if (!sym) return
    try { localStorage.setItem('vfill_symbol', sym.toUpperCase().trim()) } catch { /* private mode */ }
    if (!window.confirm(`Fire a REAL 0.01 ${sym.toUpperCase()} market order on the ${health?.broker?.isLive ? 'LIVE ⚠' : 'DEMO'} account now? SL 0.5% · TP 0.8% ride broker-side. This is the deliberate close of the "C++ first-fill watch".`)) return
    setBusy('vfill')
    setVfillMsg('')
    try {
      const r = await agentPost('/actions/validation-fill', { symbol: sym })
      setVfillMsg(r.ok
        ? `✅ FILLED: ${r.filled.side} ${sym.toUpperCase()} @ ${r.filled.executionPrice ?? 'mkt'} (position ${r.filled.positionId ?? '?'}) — ${r.note}`
        : `🛑 NOT FILLED — ${r.veto}. ${r.note || ''}`)
      await load()
    } catch (e) { setVfillMsg(`🛑 ${e.message}`) } finally { setBusy('') }
  }

  const signalScans = scans.filter(sc => sc.bias && sc.bias !== 'skip')
  const skipScans = scans.filter(sc => !sc.bias || sc.bias === 'skip')

  const [order, setOrder] = useState({ symbol: '', side: 'BUY', lots: '', sl: '', tp: '' })
  const [orderResult, setOrderResult] = useState(null)
  const [placing, setPlacing] = useState(false)

  const placeOrder = async () => {
    const sym = order.symbol.toUpperCase().trim()
    if (!sym || !order.sl) { setOrderResult({ ok: false, text: 'Symbol and stop-loss are required' }); return }
    if (!window.confirm(`Place a REAL ${order.side} market order on ${sym} (SL ${order.sl}${order.tp ? `, TP ${order.tp}` : ''})?`)) return
    setPlacing(true)
    setOrderResult(null)
    try {
      const r = await agentPost('/actions/manual-order', {
        symbol: sym,
        side: order.side,
        lots: order.lots ? Number(order.lots) : undefined,
        sl: Number(order.sl),
        tp: order.tp ? Number(order.tp) : undefined,
      })
      if (r.vetoed) setOrderResult({ ok: false, text: `Risk manager vetoed: ${r.reason}` })
      else {
        setOrderResult({ ok: true, text: `${r.side} ${r.symbol} ${r.volume} lots @ ${r.executionPrice ?? 'market'}` })
        setOrder({ symbol: '', side: 'BUY', lots: '', sl: '', tp: '' })
        await load()
      }
    } catch (e) {
      setOrderResult({ ok: false, text: e.message })
    } finally { setPlacing(false) }
  }

  return (
    <div className="space-y-4">
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}

      {/* Readiness — answers "can this thing trade for me right now?" at a glance */}
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={health ? 'up' : 'down'} pill>{health ? '1 · AGENT CONNECTED' : '1 · AGENT OFFLINE'}</Badge>
          <Badge tone={health?.broker?.linked ? (health.broker.isLive ? 'down' : 'up') : 'neutral'} pill>
            {health?.broker?.linked
              ? `2 · ${health.broker.isLive ? '⚠ LIVE' : 'DEMO'} ACCOUNT LINKED · ${fmt(health.broker.symbolsMapped, 0)} symbols`
              : '2 · NO ACCOUNT — tap one on Connect'}
          </Badge>
          <Badge tone={health?.scanEnabled ? 'up' : 'neutral'} pill>{`3 · SCAN ${health?.scanEnabled ? 'ON' : 'OFF'}`}</Badge>
          <Badge tone={health?.autotradeEnabled ? 'up' : 'neutral'} pill>{`4 · AUTOTRADE ${health?.autotradeEnabled ? 'ARMED' : 'OFF'}`}</Badge>
        </div>
        {/* One-line guide: always name the single next action */}
        <div className="mt-2 text-[13px]">
          {!health && <>Next: connect the agent on the <NavTab to="/connect">Connect</NavTab> tab (or redeploy Railway if it was working before).</>}
          {health && !health.broker?.linked && <>Next: tap your <strong>DEMO</strong> account on the <NavTab to="/connect">Connect</NavTab> tab — one tap links it and downloads the symbol list.</>}
          {health && health.broker?.linked && !health.autotradeEnabled && (
            <>Next: run the <strong>backtest</strong> on the <NavTab to="/tune">Tune</NavTab> tab — if a timeframe shows GO, an "Activate quant trading" button appears right under the results.</>
          )}
          {health && health.broker?.linked && health.autotradeEnabled && (
            <span>
              <span className="font-semibold">Quant trading is ACTIVE on the {health.broker.isLive ? 'LIVE ⚠' : 'demo'} account.</span>
              {' '}Armed{armed?.matrix && Object.keys(armed.matrix).length > 0
                ? <> per instrument: <strong>{Object.entries(armed.matrix).map(([sym, tfs]) => `${sym} (${tfs.join(', ')})`).join(' · ')}</strong></>
                : <> timeframes: <strong>{(armed?.timeframes || []).join(', ') || '—'}</strong> (all watchlist symbols)</>}.
              {' '}The bot scans every 5 minutes; an order reaches cTrader only when a signal passes every gate{pending?.enabled
                ? <> — except where pending mode is armed (below), so an empty cTrader elsewhere means "waiting", not "broken".</>
                : <> — <strong>nothing is parked in advance</strong>, so an empty cTrader means "waiting", not "broken".</>}
              {/* Pending mode changes the "nothing parked" promise — say so
                  right where the trader reads what ACTIVE means. */}
              {pending?.enabled && (
                <>
                  {' '}Resting limit orders are parked at fib levels for:{' '}
                  <strong>
                    {pending.matrix && Object.keys(pending.matrix).length > 0
                      ? Object.entries(pending.matrix).map(([sym, tfs]) => `${sym} (${(tfs || []).join(', ')})`).join(' · ')
                      : '—'}
                  </strong>
                  {' '}— you will see them as Pending orders in cTrader.
                </>
              )}
            </span>
          )}
        </div>
      </Card>

      {/* Health strip */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          {health?.broker?.accountId && (
            <span className="font-semibold" title="Every number on this page belongs to this account — switch on the left panel">
              Account: {health.broker.isLive ? 'LIVE ⚠' : 'DEMO'} {health.broker.traderLogin || health.broker.accountId}
            </span>
          )}
          <Badge tone={health?.status === 'ok' ? 'up' : health ? 'down' : 'neutral'} pill>
            {health ? (health.status === 'ok' ? 'AGENT OK' : health.status.toUpperCase()) : 'NO DATA'}
          </Badge>
          {account?.balance != null && (
            <span className="font-semibold">${fmt(account.balance, 2)}{account.leverage ? ` · 1:${fmt(account.leverage, 0)}` : ''}</span>
          )}
          <span>loop #{fmt(health?.loopCount, 0)}</span>
          <span>phase: {health?.loopPhase || '—'}</span>
          <span>last scan: {ago(health?.lastScanAt)}</span>
          <span>errors today: {fmt(health?.errorsToday, 0)}</span>
          {health?.circuitBreaker && <Badge tone="down">BREAKER TRIPPED</Badge>}
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => act('scan', '/actions/scan')}>
              {busy === 'scan' ? 'Scanning…' : 'Scan now'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={validationFill}
              title="Fire ONE deliberate 0.01-lot market order through the real auto-trade path (risk gate included) — the supervised close of the C++ first-fill watch">
              {busy === 'vfill' ? 'Firing…' : 'Test fill 0.01'}
            </Button>
            {health?.circuitBreaker && (
              <Button size="sm" variant="ghost" onClick={() => act('breaker', '/actions/reset-breaker')}>Reset breaker</Button>
            )}
            <Button
              size="sm" variant="danger" disabled={busy !== ''}
              onClick={() => { if (window.confirm('Close ALL open positions at market?')) act('kill', '/actions/kill-all') }}
            >Kill all</Button>
          </span>
        </div>
        {vfillMsg && <div className="mt-2 text-[13px] font-semibold" role="status">{vfillMsg}</div>}
      </Card>

      {/* Signals — all 5 registry strategies scan (stage matrix), so every
          row names WHICH strategy fired; the old fib-only heading lied. */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Signals — all scanned strategies</h2>
        {signalScans.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">No active signals. {skipScans.length > 0 ? `${skipScans.length} symbols scanned without a setup on any strategy.` : ''}</div>}
        {signalScans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[var(--color-text-sub)]">
                <tr><th className="pr-3 py-1">Symbol</th><th className="pr-3">Strategy</th><th className="pr-3">Bias</th><th className="pr-3">TF</th><th className="pr-3">Conviction</th><th className="pr-3">Price</th><th>Thesis</th></tr>
              </thead>
              <tbody>
                {signalScans.map(sc => (
                  <tr key={sc.symbol} className="border-t border-[var(--color-border)]">
                    <td className="pr-3 py-1.5 font-semibold">{sc.symbol}</td>
                    <td className="pr-3 whitespace-nowrap">{STRATEGY_NAMES[sc.strategy] || sc.strategy || 'Fib 61.8% fade'}</td>
                    <td className="pr-3"><Badge tone={sc.bias === 'long' ? 'up' : 'down'}>{sc.bias?.toUpperCase()}</Badge></td>
                    <td className="pr-3">{sc.timeframe || '—'}</td>
                    <td className="pr-3">{fmt(sc.confidence, 0)}/10</td>
                    <td className="pr-3">{fmt(sc.price)}</td>
                    <td className="text-[var(--color-text-sub)]">{sc.thesis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Open positions */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Open positions ({positions.length})</h2>
        {positions.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">Flat.</div>}
        {positions.length > 0 && <StdTradeTable rows={openPositionRows(positions)} countLabel="open positions" />}
      </Card>

      {/* Manual order — goes through the same risk gate as autopilot trades */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Manual order</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Symbol</span>
            <Input list="watchlist-symbols" value={order.symbol} onChange={e => setOrder(o => ({ ...o, symbol: e.target.value }))} placeholder="EURUSD" className="w-28" />
          </label>
          <datalist id="watchlist-symbols">
            {scans.map(sc => <option key={sc.symbol} value={sc.symbol} />)}
          </datalist>
          <div className="flex rounded-[7px] overflow-hidden border border-[var(--color-border)]">
            {['BUY', 'SELL'].map(s => (
              <button key={s} type="button" onClick={() => setOrder(o => ({ ...o, side: s }))}
                className={`px-3 py-2 text-[13px] font-semibold cursor-pointer ${
                  order.side === s
                    ? (s === 'BUY' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-down)] text-white')
                    : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'
                }`}>{s}</button>
            ))}
          </div>
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Lots</span>
            <Input type="number" step="0.01" value={order.lots} onChange={e => setOrder(o => ({ ...o, lots: e.target.value }))} placeholder="0.01" className="w-20" />
          </label>
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Stop-loss (required)</span>
            <Input type="number" step="any" value={order.sl} onChange={e => setOrder(o => ({ ...o, sl: e.target.value }))} placeholder="price" className="w-28" />
          </label>
          <label className="block text-[12px]">
            <span className="text-[var(--color-text-sub)]">Take-profit</span>
            <Input type="number" step="any" value={order.tp} onChange={e => setOrder(o => ({ ...o, tp: e.target.value }))} placeholder="optional" className="w-28" />
          </label>
          <Button size="md" variant={order.side === 'SELL' ? 'danger' : 'primary'} disabled={placing} onClick={placeOrder}>
            {placing ? 'Placing…' : `${order.side} ${order.symbol.toUpperCase() || '…'}`}
          </Button>
        </div>
        {orderResult && (
          <div className="mt-2"><Badge tone={orderResult.ok ? 'up' : 'warning'}>{orderResult.ok ? `FILLED — ${orderResult.text}` : orderResult.text}</Badge></div>
        )}
        <p className="mt-2 text-[12px] text-[var(--color-text-sub)]">
          Manual orders pass the same risk gate as the bot's (sizing, R:R floor, cooldowns) and are then managed by the position monitor.
        </p>
      </Card>

      {/* Broker snapshot: pending (preset) orders + positions opened outside the bot */}
      {broker && ((broker.pendingOrders?.length || 0) > 0 || (broker.externalPositions?.length || 0) > 0) && (
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[13px] font-semibold">
              At the broker
              {broker.lastReconcileAt && <span className="ml-2 font-normal text-[var(--color-text-sub)]">synced {ago(broker.lastReconcileAt)}</span>}
            </h2>
            {(broker.pendingOrders?.length || 0) > 0 && (
              <Button
                size="sm" variant="subtle" className="ml-auto" disabled={busy === 'pclean'}
                title="Cancel BOT-placed resting orders that the bot's ledger no longer tracks (stale duplicates from before the permanent database). Your own manual cTrader orders are never touched."
                onClick={async () => {
                  if (!window.confirm('Clean up stale pending orders? This cancels BOT-placed resting limit orders that the bot no longer recognises (leftovers from the old database wipes). Orders the bot is actively managing, and ALL of your manual cTrader orders, are kept.')) return
                  setBusy('pclean')
                  try {
                    const r = await agentPost('/actions/reconcile-pending')
                    setReconcileNote(`Pending cleanup: ${r.cancelled.length} stale bot order(s) cancelled · ${r.kept} managed kept · ${r.manual} manual untouched${r.failures?.length ? ` · ${r.failures.length} failed` : ''}.`)
                    await load()
                  } catch (e) { setError(e.message) } finally { setBusy('') }
                }}
              >{busy === 'pclean' ? 'Cleaning…' : 'Clean up stale pending orders'}</Button>
            )}
          </div>
          {(broker.pendingOrders?.length || 0) > 0 && (
            <div className="mb-2">
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Pending orders ({broker.pendingOrders.length})</div>
              <StdTradeTable rows={pendingOrderRows(broker.pendingOrders)} countLabel="pending orders" />
              <p className="mt-1 text-[11px] text-[var(--color-text-sub)]">
                Qty is in broker UNITS (not lots). Stop Loss / Take Profit showing — means the resting order carries none at the broker (it would fill unprotected until the bot's monitor adopts it). Older snapshots need one loop cycle after deploy to enrich.
              </p>
            </div>
          )}
          {(broker.externalPositions?.length || 0) > 0 && (
            <div>
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Positions opened outside the bot ({broker.externalPositions.length}) — observed, not managed</div>
              <StdTradeTable rows={externalPositionRows(broker.externalPositions)} countLabel="external positions" />
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 items-start">
        {/* Recent trades */}
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[13px] font-semibold">Recent trades <span className="font-normal text-[var(--color-text-sub)]">— placed by the BOT on this account. Your manual cTrader trades live on the Accounts page.</span></h2>
            <Button
              size="sm" variant="subtle" className="ml-auto" disabled={busy === 'reconcile'}
              onClick={async () => {
                setBusy('reconcile')
                try {
                  const r = await agentPost('/actions/reconcile-trades', {})
                  setReconcileNote(`Checked ${r.checked} against ${r.dealsSeen} broker deals — ${r.confirmed} confirmed, ${r.repaired} repaired, ${r.rejected} rejected.`)
                  await load()
                } catch (e) { setReconcileNote(`Reconcile failed: ${e.message}`) } finally { setBusy('') }
              }}
            >
              {busy === 'reconcile' ? 'Reconciling…' : 'Reconcile with broker'}
            </Button>
          </div>
          {reconcileNote && <p className="text-[12px] text-[var(--color-text-sub)] mb-2">{reconcileNote}</p>}
          {trades.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>}
          <ul className="space-y-1 text-[13px]">
            {trades.map(t => <TradeRow key={t.id} t={t} />)}
          </ul>
        </Card>

        {/* Order log — the audit trail the owner asked for: EVERY order
            attempt (auto signal, test fill, manual, pending), fill or veto,
            with source and reason. Backed by risk_events; pre-gate refusals
            (no quote, market closed, no creds) are persisted there too. */}
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[13px] font-semibold">Order log — every attempt, fill or veto</h2>
            <Button
              size="sm" variant="subtle" className="ml-auto"
              title="Prove the C++ execution engine matches the JS path: credentials push, broker login, open-position diff. Read-only."
              onClick={async () => {
                setBusy('parity')
                try {
                  const r = await agentPost('/actions/exec-parity', {})
                  setReconcileNote(`C++ parity ${r.pass ? 'PASS ✓' : 'FAIL ✗'} — ${(r.steps || []).join(' · ')}${r.error ? ` · ${r.error}` : ''}`)
                } catch (e) { setReconcileNote(`C++ parity failed to run: ${e.message}`) } finally { setBusy('') }
              }}
              disabled={busy === 'parity'}
            >
              {busy === 'parity' ? 'Testing C++ engine…' : 'Test C++ engine'}
            </Button>
            <Button
              size="sm" variant="subtle"
              title="Every action you sent the agent (orders, toggles, arming, watchlist edits), newest first"
              onClick={async () => {
                try {
                  const r = await agentGet('/state/action-log?limit=1000')
                  const text = (r.rows || []).map(x => `${x.at}Z  ${x.method} ${x.path}  ${x.body || ''}`).join('\n')
                  const url = URL.createObjectURL(new Blob([text || 'no actions logged yet'], { type: 'text/plain' }))
                  const a = document.createElement('a')
                  a.href = url; a.download = 'action-log.txt'; a.click()
                  URL.revokeObjectURL(url)
                } catch (e) { setError(e.message) }
              }}
            >
              Download my action log
            </Button>
          </div>
          <OrderLogTable rows={riskEvents} />
        </Card>
      </div>
    </div>
  )
}
