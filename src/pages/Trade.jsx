// Trade — the single live view: agent health, current fib signals, open
// positions, recent trades, and the risk manager's latest decisions.
import { Fragment, useEffect, useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import Input from '../components/common/Input.jsx'
import { Link } from 'react-router-dom'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import { tpLadder } from '../lib/tp-ladder.js'
import StdTradeTable from '../components/StdTradeTable.jsx'
import OrderManager from '../components/OrderManager.jsx'
import { toMs, priceDp, brokerOrderRows } from '../lib/std-trade-rows.js'
import { humanVeto } from '../lib/veto-words.js'
import { useSort } from '../lib/use-sort.jsx'

// Inline tab link used by the "Next:" guide line
function NavTab({ to, children }) {
  return <Link to={to} className="font-semibold text-[var(--color-accent)] underline underline-offset-2">{children}</Link>
}

const REFRESH_MS = 30_000

// No-digits calls are PRICES (scale-aware canonical dp); explicit digits
// are money/counts and keep exactly what the caller asked for.
function fmt(n, digits) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits ?? priceDp(n) })
}

function ago(iso) {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

// Live-broker positions → an enrichment map keyed by ctrader position id
// (P&L, ccy, margin, bid/ask, commission, swap) — merged onto Trade's own
// DB-tracked rows so they carry the same fields Desk's live view shows.
function buildEnrichMap(positions) {
  const by = {}
  for (const p of positions || []) {
    if (p.positionId == null) continue
    by[String(p.positionId)] = {
      netPnl: p.netPnl ?? null,
      estNetPnl: p.estNetPnl ?? null,
      quoteCcy: p.quoteCcy ?? null,
      depositCcy: p.depositCcy ?? null,
      usedMargin: p.usedMargin ?? null,
      bid: p.bid ?? null,
      ask: p.ask ?? null,
      commission: p.commission ?? null,
      swap: p.swap ?? null,
    }
  }
  return by
}


// Open (monitored) positions → the standard shape. Time = the broker fill
// time when known (trades.opened_at via the join), else the row's created_at.
// enrichById (keyed by ctrader_position_id) carries the live-broker fields
// this DB-only row never had — ccy, margin, bid/ask, commission, swap —
// matching the richness Desk's "At the broker" table already shows (owner:
// "why you didn't include" the same columns here).
function openPositionRows(positions, prices = {}, enrichById = {}) {
  return positions.map(p => {
    const src = p.source || 'autopilot'
    const checkedAt = p.last_check_at || p.last_checked_at
    const current = Number(prices[String(p.symbol).toUpperCase()]) || null
    const enr = enrichById[String(p.ctrader_position_id)] || {}
    const openedAt = p.opened_at || p.created_at
    return {
      pnl: enr.netPnl ?? enr.estNetPnl ?? null,
      id: `pos-${p.id}`,
      at: openedAt,
      symbol: p.symbol,
      result: { text: 'OPEN', tone: 'info' },
      source: { text: ATTEMPT_SOURCE[src] || String(src).toUpperCase(), tone: src === 'validation_fill' ? 'special' : 'neutral' },
      side: String(p.side || '').toUpperCase() || null,
      qty: p.volume,
      entry: p.entry_price,
      sl: p.current_sl,
      tp: p.current_tp,
      tps: tpLadder(p.current_tp, p.tp2_price, p.volume, { scaledOut: !!p.scaled_out }),
      current,
      ccy: enr.quoteCcy ?? null,
      moneyCcy: enr.depositCcy ?? null,
      margin: enr.usedMargin ?? null,
      bid: enr.bid ?? null,
      ask: enr.ask ?? null,
      commission: enr.commission ?? null,
      swap: enr.swap ?? null,
      positionId: p.ctrader_position_id ?? null,
      durationMs: openedAt ? Math.max(0, Date.now() - toMs(openedAt)) : null,
      reason: `${p.last_check_action || 'not checked yet'}${checkedAt ? ` (${ago(checkedAt)})` : ''}`,
      chart: {
        symbol: p.symbol,
        timeframe: '1h',
        lines: { entry: p.entry_price, sl: p.current_sl, tp: p.current_tp },
      },
    }
  })
}

// External (non-bot) broker positions → the standard shape; observed only.
// prices (latest scan close per symbol) light up the To TP/SL distance —
// the owner's own trades deserve the same live protection read. enrichById
// carries the same live-broker richness as openPositionRows above.
function externalPositionRows(positions, prices = {}, enrichById = {}) {
  return positions.map(p => {
    const enr = enrichById[String(p.ctrader_position_id)] || {}
    const openedAt = p.opened_at || p.created_at || null
    return {
      pnl: enr.netPnl ?? enr.estNetPnl ?? null,
      id: `ext-${p.id}`,
      at: openedAt,
      symbol: p.symbol,
      result: { text: 'OPEN', tone: 'info' },
      source: { text: 'EXTERNAL', tone: 'neutral' },
      side: String(p.side || '').toUpperCase() || null,
      qty: p.volume ?? null,
      entry: p.entry_price,
      sl: p.current_sl ?? null,
      tp: p.current_tp ?? null,
      current: Number(prices[String(p.symbol).toUpperCase()]) || null,
      ccy: enr.quoteCcy ?? null,
      moneyCcy: enr.depositCcy ?? null,
      margin: enr.usedMargin ?? null,
      bid: enr.bid ?? null,
      ask: enr.ask ?? null,
      commission: enr.commission ?? null,
      swap: enr.swap ?? null,
      positionId: p.ctrader_position_id ?? null,
      durationMs: openedAt ? Math.max(0, Date.now() - toMs(openedAt)) : null,
      reason: 'observed, not managed',
      chart: { symbol: p.symbol, timeframe: '1h', lines: { entry: p.entry_price, sl: p.current_sl, tp: p.current_tp } },
      raw: p,
    }
  })
}

// Recent BOT trades → the standard shape (owner: "Recent trades follows the
// same table structure as the order log"). REJECTED = broker has no record
// (reconciled); UNCONFIRMED = order sent but no fill recorded yet.
function closedTradeRows(trades) {
  return trades.map(t => {
    const rejected = t.status === 'rejected'
    const unconfirmed = !rejected && t.entry_price == null
    return {
      id: `tr-${t.id}`,
      at: t.closed_at || t.opened_at,
      symbol: t.symbol,
      result: rejected ? { text: 'REJECTED', tone: 'warning' }
        : unconfirmed ? { text: 'UNCONFIRMED', tone: 'warning' }
        : t.status === 'open' ? { text: 'OPEN', tone: 'info' }
        : { text: 'CLOSED', tone: (Number(t.net_pnl) || 0) >= 0 ? 'up' : 'down' },
      source: { text: ATTEMPT_SOURCE[t.source] || (t.source ? String(t.source).toUpperCase() : 'AUTO'), tone: t.source === 'validation_fill' ? 'special' : 'neutral' },
      side: String(t.side || '').toUpperCase() || null,
      qty: t.volume,
      entry: t.entry_price,
      sl: t.sl_price,
      tp: t.tp_price,
      tps: tpLadder(t.tp_price, t.tp2_price, t.volume, { scaledOut: !!t.scaled_out }),
      pnl: rejected || unconfirmed ? null : t.net_pnl ?? null,
      durationMs: t.hold_duration_ms ?? (t.opened_at && t.closed_at ? Math.max(0, toMs(t.closed_at) - toMs(t.opened_at)) : null),
      reason: rejected ? 'broker has no record (reconciled)'
        : unconfirmed ? 'no broker fill recorded — tap Reconcile above'
        : [t.exit_price != null ? `out ${fmt(t.exit_price)}` : null, t.close_reason || null].filter(Boolean).join(' · '),
      chart: {
        symbol: t.symbol,
        timeframe: t.label_timeframe || '1h',
        lines: { entry: t.entry_price, sl: t.sl_price, tp: t.tp_price },
        at: toMs(t.closed_at || t.opened_at),
        markers: { entryT: toMs(t.opened_at), exitT: toMs(t.closed_at) },
      },
    }
  })
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

// Order log rows (risk_events) → the standard shape.
function OrderLogTable({ rows, marketHours = null }) {
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
      tps: tpLadder(prop?.tp1, prop?.tp2, prop?.requestedVolume),
      // Trader words up front; the raw machine code stays in the tooltip.
      reason: humanVeto(ev.veto_reason) || ev.sizing_note || '',
      reasonTitle: ev.veto_reason || ev.sizing_note || '',
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
  return <StdTradeTable rows={mapped} countLabel="attempts" marketHours={marketHours} />
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
  const [pending, setPending] = useState(null)  // { enabled, matrix } — resting-limit pending-order mode
  const [scope, setScope] = useState('all')     // autotrade scope: all watchlist vs armed combos
  const [marketHours, setMarketHours] = useState(null) // { SYM: { open, next_open_at } }
  const [vetoBd, setVetoBd] = useState(null)    // veto-reason breakdown for the order-log insight
  // Live-broker enrichment per ctrader position id (P&L, ccy, margin,
  // bid/ask, commission, swap) — owner: "Trade tables lack the
  // insightfulness ... as 'At the broker' in desk page". Same fields Desk
  // already shows, joined onto Trade's own DB-tracked rows by positionId.
  const [enrichById, setEnrichById] = useState({})
  const [liveOrders, setLiveOrders] = useState([]) // live resting orders (replaces the stale reconcile-cache list)

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      // Slot count matters: destructure order must mirror the array below —
      // append new fetches at the END or every later variable shifts.
      const [h, s, p, t, r, rc, bo, cfg, mh] = await Promise.all([
        agentGet('/state/health'),
        agentGet('/state/scans'),
        agentGet('/state/positions'),
        agentGet('/state/trades'),
        agentGet('/state/risk-events?limit=200'),
        agentGet('/state/risk-config').catch(() => null),
        agentGet('/state/broker-orders').catch(() => null),
        agentGet('/state/config').catch(() => null),
        agentGet('/state/market-hours').catch(() => null),
      ])
      setHealth(h)
      setScans(s.rows || s.scans || [])
      setPositions(p.rows || p.positions || [])
      setTrades((t.rows || t.trades || []).slice(0, 8)) // match the order log's page size
      setRiskEvents(r.rows || [])
      setAccount(rc?.derived || null)
      setBroker(bo || null)
      setPending(cfg
        ? {
            enabled: cfg.pending_mode_enabled === true || cfg.pending_mode_enabled === 'true',
            matrix: cfg.pending_matrix && typeof cfg.pending_matrix === 'object' ? cfg.pending_matrix : null,
          }
        : null)
      setScope(cfg?.autotrade_scope || 'all')
      setMarketHours(mh?.hours || null)
      setError('')
    } catch (e) {
      setError(e.message)
    }
    // Order-log insight: WHY the vetoes, grouped — non-blocking.
    agentGet('/state/veto-breakdown?days=7').then(setVetoBd).catch(() => {})
    // Live broker enrichment (P&L, ccy, margin, bid/ask, commission, swap)
    // + resting orders — the SAME live call Desk uses. Cache instant-paints
    // (`prev` guards below never let a stale cache clobber live data that
    // already landed, matching Desk's two-tier load pattern); the live
    // fetch overwrites the moment the WS answers.
    agentPost('/actions/broker-positions', { selectedOnly: true })
      .then(b => {
        const acct = b?.accounts?.[0]
        if (acct) {
          setEnrichById(buildEnrichMap(acct.positions))
          setLiveOrders(acct.orders || [])
        }
      })
      .catch(() => {})
    agentGet('/state/broker-cache').then(bc => {
      const acct = bc?.snapshot?.account
      if (!acct) return
      setEnrichById(prev => (Object.keys(prev).length ? prev : buildEnrichMap(acct.positions)))
      setLiveOrders(prev => (prev.length ? prev : (acct.orders || [])))
    }).catch(() => {})
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
  // Signals table sorts like every other table — conviction first by default.
  const sigSort = useSort(signalScans, { key: 'confidence', dir: 'desc' }, {
    strategy: sc => STRATEGY_NAMES[sc.strategy] || sc.strategy || '',
  })

  const [orderOpen, setOrderOpen] = useState(false)
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

      {/* ONE card, ACCOUNT line first (owner spec): row 1 = who/where the
          money is + agent vitals + the page's actions; row 2 = trading
          status/scope. Guidance appears only when NOT ready. */}
      <Card>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          {health?.broker?.accountId
            ? <span className="font-semibold whitespace-nowrap">
                Account: <span className={health.broker.isLive ? 'text-[var(--color-down)]' : ''}>{health.broker.isLive ? '⚠ LIVE' : 'DEMO'} {health.broker.traderLogin || health.broker.accountId}</span>
              </span>
            : <span className="font-semibold whitespace-nowrap text-[var(--color-text-sub)]">No account linked</span>}
          {account?.balance != null && (
            <span className="font-semibold whitespace-nowrap">${fmt(account.balance, 2)}{account.leverage ? ` · 1:${fmt(account.leverage, 0)}` : ''}</span>
          )}
          <span className="text-[var(--color-text-sub)] whitespace-nowrap">
            <span aria-hidden="true" style={{ color: health ? 'var(--color-accent)' : 'var(--color-down)' }}>● </span>
            {health ? `agent ok · loop #${fmt(health.loopCount, 0)} · scan ${ago(health.lastScanAt)}` : 'agent offline'}
          </span>
          {Number(health?.errorsToday) > 0 && <span className="text-[var(--color-warning-text)] whitespace-nowrap">{fmt(health.errorsToday, 0)} errors today</span>}
          {health?.circuitBreaker && <span className="text-[var(--color-down)] font-semibold">BREAKER TRIPPED</span>}
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={() => act('scan', '/actions/scan')}>
              {busy === 'scan' ? 'Scanning…' : 'Scan now'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== ''} onClick={validationFill}
              title="Fire ONE deliberate 0.01-lot market order through the real auto-trade path (risk gate included)">
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
        {/* Row 2 — trading status/scope under the account line */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span className="font-semibold whitespace-nowrap">
            <span aria-hidden="true" style={{ color: !health ? '#94a3b8' : health.autotradeEnabled ? 'var(--color-accent)' : '#94a3b8' }}>● </span>
            {!health ? 'Autotrade: no data yet' : health.autotradeEnabled ? 'Quant trading ACTIVE' : 'Autotrade OFF'}
          </span>
          {health?.autotradeEnabled && (
            <span className="text-[var(--color-text-sub)] whitespace-nowrap">
              scope: {scope === 'all' ? 'full watchlist' : 'armed combos'}{pending?.enabled ? ' · pending armed' : ''} — goal on <NavTab to="/">Desk</NavTab>
            </span>
          )}
        </div>
        {/* Next-step guide ONLY while something is missing */}
        {(!health || !health.broker?.linked || !health.autotradeEnabled) && (
          <div className="mt-1.5 text-[13px]">
            {!health && <>Next: connect the agent on the <NavTab to="/connect">Connect</NavTab> tab (or redeploy Railway if it was working before).</>}
            {health && !health.broker?.linked && <>Next: tap your <strong>DEMO</strong> account on the <NavTab to="/connect">Connect</NavTab> tab — one tap links it and downloads the symbol list.</>}
            {health && health.broker?.linked && !health.autotradeEnabled && (
              <>Next: run the <strong>backtest</strong> on the <NavTab to="/tune">Tune</NavTab> tab — if a timeframe shows GO, an "Activate quant trading" button appears right under the results.</>
            )}
          </div>
        )}
        {vfillMsg && <div className="mt-1.5 text-[13px] font-semibold" role="status">{vfillMsg}</div>}
      </Card>

      {/* Signals — folded by default (owner: "still needed?"). The Desk scan
          strip carries the live read; this stays as the detail table for the
          full thesis text, one tap away instead of a page of rows. */}
      <Card>
        <details open={signalScans.length > 0 && signalScans.length <= 4}>
          <summary className="cursor-pointer select-none text-[13px] font-semibold">
            Signals — {signalScans.length} active{skipScans.length > 0 ? ` · ${skipScans.length} scanned flat` : ''}
          </summary>
        {signalScans.length === 0 && <div className="mt-1 text-[13px] text-[var(--color-text-sub)]">No active signals right now.</div>}
        {signalScans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="std-cols w-full text-[13px]">
              <thead className="text-left text-[var(--color-text-sub)]">
                <tr>
                  <th className="pr-3 py-1">{sigSort.sortBtn('symbol', 'Symbol')}</th>
                  <th className="pr-3">{sigSort.sortBtn('strategy', 'Strategy')}</th>
                  <th className="pr-3">{sigSort.sortBtn('bias', 'Bias')}</th>
                  <th className="pr-3">{sigSort.sortBtn('timeframe', 'TF')}</th>
                  <th className="pr-3">{sigSort.sortBtn('confidence', 'Conviction')}</th>
                  <th className="pr-3">{sigSort.sortBtn('price', 'Price')}</th>
                  <th>Thesis</th>
                </tr>
              </thead>
              <tbody>
                {sigSort.sorted.map(sc => (
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
        </details>
      </Card>

      {/* Open positions */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Open positions ({positions.length})</h2>
        {positions.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">Flat.</div>}
        {positions.length > 0 && <StdTradeTable rows={openPositionRows(positions, Object.fromEntries(scans.map(sc => [String(sc.symbol).toUpperCase(), sc.price])), enrichById)} countLabel="open positions" marketHours={marketHours} />}
      </Card>

      {/* Manual order — a FAB bottom-left (owner spec): the form floats
          above the button on demand instead of occupying a page section. */}
      <div className="fixed bottom-4 left-4 z-40">
        {orderOpen && (
          <div className="glass-panel rounded-[12px] p-3 mb-2 w-[280px] shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[13px] font-semibold">Manual order</h2>
              <Button size="sm" variant="ghost" onClick={() => setOrderOpen(false)}>✕</Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Input list="watchlist-symbols" value={order.symbol} onChange={e => setOrder(o => ({ ...o, symbol: e.target.value }))}
                placeholder="Symbol" aria-label="Symbol" className="w-[120px] text-[12px]" />
              <datalist id="watchlist-symbols">
                {scans.map(sc => <option key={sc.symbol} value={sc.symbol} />)}
              </datalist>
              <div className="flex rounded-[7px] overflow-hidden border border-[var(--color-border)]" role="radiogroup" aria-label="Side">
                {['BUY', 'SELL'].map(s => (
                  <button key={s} type="button" role="radio" aria-checked={order.side === s} onClick={() => setOrder(o => ({ ...o, side: s }))}
                    className={`px-2.5 py-1.5 text-[12px] font-semibold cursor-pointer ${
                      order.side === s
                        ? (s === 'BUY' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-down)] text-white')
                        : 'bg-[var(--color-bg)] text-[var(--color-text-sub)]'
                    }`}>{s}</button>
                ))}
              </div>
              <Input type="number" step="0.01" value={order.lots} onChange={e => setOrder(o => ({ ...o, lots: e.target.value }))}
                placeholder="Lots (auto)" aria-label="Lots — blank sizes by risk" title="Blank = risk-based sizing" className="w-[120px] text-[12px]" />
              <Input type="number" step="any" value={order.sl} onChange={e => setOrder(o => ({ ...o, sl: e.target.value }))}
                placeholder="SL — required" aria-label="Stop loss price (required)" className="w-[120px] text-[12px]" />
              <Input type="number" step="any" value={order.tp} onChange={e => setOrder(o => ({ ...o, tp: e.target.value }))}
                placeholder="TP" aria-label="Take profit price (optional)" className="w-[120px] text-[12px]" />
              <Button size="sm" variant={order.side === 'SELL' ? 'danger' : 'primary'} disabled={placing} onClick={placeOrder}
                className="w-full" title="Same risk gate as the bot (sizing, R:R floor, cooldowns); then managed by the position monitor">
                {placing ? 'Placing…' : `${order.side} ${order.symbol.toUpperCase() || '…'}`}
              </Button>
            </div>
            {orderResult && (
              <div className={`mt-1.5 text-[12px] font-semibold ${orderResult.ok ? 'text-[var(--color-accent)]' : 'text-[var(--color-warning-text)]'}`} role="status">
                {orderResult.ok ? `Filled — ${orderResult.text}` : orderResult.text}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          aria-expanded={orderOpen}
          aria-label="Manual order"
          title="Manual order — same risk gate as the bot"
          onClick={() => setOrderOpen(o => !o)}
          className="h-12 w-12 rounded-full bg-[var(--color-accent)] text-white text-[22px] font-bold shadow-lg cursor-pointer flex items-center justify-center"
        >
          {orderOpen ? '×' : '+'}
        </button>
      </div>

      {/* Broker snapshot: pending (resting) orders + positions opened outside
          the bot. Pending orders now come from the LIVE broker fetch above
          (liveOrders), not the old reconcile-cache — that cache only ever
          refreshed on a periodic background job and could show orders long
          cancelled or missing ones just placed. Same richness (ccy/margin/
          bid/ask/commission/swap) as Desk's "At the broker" table (owner:
          "why you didn't include"). */}
      {broker && ((liveOrders.length || 0) > 0 || (broker.externalPositions?.length || 0) > 0) && (
        <Card>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-[13px] font-semibold">
              At the broker
              {broker.lastReconcileAt && <span className="ml-2 font-normal text-[var(--color-text-sub)]">synced {ago(broker.lastReconcileAt)}</span>}
            </h2>
            {(liveOrders.length || 0) > 0 && (
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
          {(liveOrders.length || 0) > 0 && (
            <div className="mb-2">
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Pending orders ({liveOrders.length})</div>
              <StdTradeTable
                rows={brokerOrderRows(liveOrders, { manageable: true })}
                countLabel="pending orders"
                marketHours={marketHours}
                panel={{ label: 'Manage', render: (row, close) => <OrderManager o={row.raw} onDone={() => { close(); load() }} /> }}
              />
            </div>
          )}
          {(broker.externalPositions?.length || 0) > 0 && (
            <div>
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Positions opened outside the bot ({broker.externalPositions.length}) — observed, not managed</div>
              <StdTradeTable
                rows={externalPositionRows(broker.externalPositions, Object.fromEntries(scans.map(sc => [String(sc.symbol).toUpperCase(), sc.price])), enrichById)}
                countLabel="external positions"
                marketHours={marketHours}
                extraAction={(row) => {
                  const positionId = row.raw?.ctrader_position_id
                  if (!positionId) return null
                  const managed = !row.raw?.keeper_opt_out
                  return (
                    <label
                      className="flex items-center gap-1 text-[11px] cursor-pointer whitespace-nowrap"
                      title="Let the Profit Keeper manage this position (per the policy armed on Tune). Untick to leave this ONE position hands-off regardless of that policy."
                    >
                      <input
                        type="checkbox" checked={managed}
                        aria-label={`${managed ? 'Stop' : 'Let'} the bot manage ${row.symbol}`}
                        onChange={async () => {
                          try {
                            await agentPost('/actions/position-keeper-optout', { positionId, optOut: managed })
                            await load()
                          } catch (e) { setError(e.message) }
                        }}
                      />
                      bot manage
                    </label>
                  )
                }}
              />
            </div>
          )}
        </Card>
      )}

      {/* Recent trades and Order log STACKED full-width (owner: both carry
          too many columns to share a row) with matching row counts. */}
      <div className="space-y-4">
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
          {trades.length > 0 && <StdTradeTable rows={closedTradeRows(trades)} countLabel="trades" marketHours={marketHours} />}
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
          {/* WHY the vetoes — the insight before the rows. Every veto is the
              AUTO-SCAN proposing a trade and the risk gate refusing it: that
              is the system protecting the account, not failing. */}
          {vetoBd && (vetoBd.vetoes?.length > 0 || vetoBd.ok > 0) && (
            <p className="mb-2 text-[12px] text-[var(--color-text-sub)]">
              Last {vetoBd.days}d: {vetoBd.ok} approved · {vetoBd.vetoes.reduce((s, v) => s + v.count, 0)} vetoed.
              Vetoes are the auto-scan's proposals refused by the risk gate — top reasons:{' '}
              {vetoBd.vetoes.slice(0, 3).map(v => `${humanVeto(v.reason)} ×${v.count}`).join(' · ') || '—'}.
              {vetoBd.vetoes[0]?.reason === 'market_closed' && ' Market-closed dominates on weekends — signals re-fire when markets reopen.'}
            </p>
          )}
          <OrderLogTable rows={riskEvents} marketHours={marketHours} />
        </Card>
      </div>
    </div>
  )
}
