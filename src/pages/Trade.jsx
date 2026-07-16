// Trade — the single live view: agent health, current fib signals, open
// positions, recent trades, and the risk manager's latest decisions.
import { useEffect, useState, useCallback } from 'react'
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

// One open-position row with an expandable live chart (entry/SL/TP overlaid).
function PositionRow({ p }) {
  const [showChart, setShowChart] = useState(false)
  const side = String(p.side).toUpperCase()
  return (
    <>
      <tr className="border-t border-[var(--color-border)]">
        <td className="pr-3 py-1.5 font-semibold">{p.symbol}</td>
        <td className="pr-3"><Badge tone={side === 'BUY' ? 'up' : 'down'}>{side}</Badge></td>
        <td className="pr-3">{fmt(p.entry_price)}</td>
        <td className="pr-3">{fmt(p.current_sl)}</td>
        <td className="pr-3">{fmt(p.current_tp)}</td>
        <td className="pr-3">{ago(p.opened_at)}</td>
        <td className="pr-3 text-[var(--color-text-sub)]">{p.last_check_action || '—'} {p.last_checked_at ? `(${ago(p.last_checked_at)})` : ''}</td>
        <td>
          <Button size="sm" variant="ghost" onClick={() => setShowChart(s => !s)}>{showChart ? 'Hide' : 'Chart'}</Button>
        </td>
      </tr>
      {showChart && (
        <tr className="border-t border-[var(--color-border)]">
          <td colSpan={8} className="py-2">
            <PositionChart
              symbol={p.symbol}
              timeframe="1h"
              lines={{ entry: p.entry_price, sl: p.current_sl, tp: p.current_tp }}
            />
          </td>
        </tr>
      )}
    </>
  )
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
        {t.exit_reason && <span className="text-[var(--color-text-sub)]">({t.exit_reason})</span>}
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

// Plain-words provenance labels for order-log rows (proposal_json.source).
const ATTEMPT_SOURCE = {
  validation_fill: 'TEST FILL',
  manual: 'MANUAL',
  execute_analysis: 'EXECUTE',
  pending: 'PENDING',
  auto_signal: 'AUTO',
}

// One order-log row (risk_events) with the proposal's chart on demand — the
// exact entry/SL/TP the gate saw, drawn on real broker bars. Every attempt
// lands here: auto signals, test fills, manual orders, pending arms — fills
// AND refusals, with who fired it and why it was refused.
function RiskEventRow({ ev }) {
  const [showChart, setShowChart] = useState(false)
  let prop = null
  try { prop = ev.proposal_json ? JSON.parse(ev.proposal_json) : null } catch { /* legacy row */ }
  const src = ATTEMPT_SOURCE[prop?.source] || (prop?.source ? String(prop.source).toUpperCase() : 'AUTO')
  return (
    <li className="border-t border-[var(--color-border)] pt-1 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <Badge tone={ev.approved ? 'up' : 'warning'}>{ev.approved ? 'OK' : 'VETO'}</Badge>
        <Badge tone={prop?.source === 'validation_fill' ? 'special' : 'neutral'}>{src}</Badge>
        <span className="font-semibold">{ev.symbol}</span>
        {ev.side && <span className="text-[var(--color-text-sub)]">{ev.side}</span>}
        <span className="text-[var(--color-text-sub)] truncate">{ev.veto_reason || ev.sizing_note || ''}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-[var(--color-text-sub)]">{ago(ev.created_at)}</span>
          {prop && <Button size="sm" variant="ghost" onClick={() => setShowChart(v => !v)}>{showChart ? 'Hide' : 'Chart'}</Button>}
        </span>
      </div>
      {showChart && prop && (
        <div className="py-2">
          <PositionChart
            symbol={ev.symbol}
            timeframe={prop.timeframe || '1h'}
            lines={{ entry: prop.entry, sl: prop.sl, tp: prop.tp1 }}
            at={toMs(ev.created_at)}
            markers={{ entryT: toMs(ev.created_at) }}
          />
        </div>
      )}
    </li>
  )
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
        agentGet('/state/risk-events?limit=30'),
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

      {/* Signals */}
      <Card>
        <h2 className="text-[13px] font-semibold mb-2">Fib 61.8% signals</h2>
        {signalScans.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">No active signals. {skipScans.length > 0 ? `${skipScans.length} symbols scanned without a zone.` : ''}</div>}
        {signalScans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[var(--color-text-sub)]">
                <tr><th className="pr-3 py-1">Symbol</th><th className="pr-3">Bias</th><th className="pr-3">TF</th><th className="pr-3">Conviction</th><th className="pr-3">Price</th><th>Thesis</th></tr>
              </thead>
              <tbody>
                {signalScans.map(sc => (
                  <tr key={sc.symbol} className="border-t border-[var(--color-border)]">
                    <td className="pr-3 py-1.5 font-semibold">{sc.symbol}</td>
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
        {positions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[var(--color-text-sub)]">
                <tr><th className="pr-3 py-1">Symbol</th><th className="pr-3">Side</th><th className="pr-3">Entry</th><th className="pr-3">SL</th><th className="pr-3">TP</th><th className="pr-3">Opened</th><th className="pr-3">Last check</th><th>Chart</th></tr>
              </thead>
              <tbody>
                {positions.map(p => (
                  <PositionRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
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
          <h2 className="text-[13px] font-semibold mb-2">
            At the broker
            {broker.lastReconcileAt && <span className="ml-2 font-normal text-[var(--color-text-sub)]">synced {ago(broker.lastReconcileAt)}</span>}
          </h2>
          {(broker.pendingOrders?.length || 0) > 0 && (
            <div className="mb-2">
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Pending orders ({broker.pendingOrders.length})</div>
              <ul className="space-y-1 text-[13px]">
                {broker.pendingOrders.map((o, i) => (
                  <li key={o.orderId || i} className="flex items-center gap-2">
                    <Badge tone={String(o.tradeData?.tradeSide || o.tradeSide).toUpperCase() === 'BUY' ? 'up' : 'down'}>
                      {String(o.tradeData?.tradeSide || o.tradeSide || '?').toUpperCase()}
                    </Badge>
                    <span className="font-semibold">{o.symbolName || o.tradeData?.symbolId}</span>
                    <span className="text-[var(--color-text-sub)]">{o.orderType || 'order'} @ {fmt(o.limitPrice ?? o.stopPrice)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(broker.externalPositions?.length || 0) > 0 && (
            <div>
              <div className="text-[12px] text-[var(--color-text-sub)] mb-1">Positions opened outside the bot ({broker.externalPositions.length}) — observed, not managed</div>
              <ul className="space-y-1 text-[13px]">
                {broker.externalPositions.map(p => (
                  <li key={p.id} className="flex items-center gap-2">
                    <Badge tone={String(p.side).toUpperCase() === 'BUY' ? 'up' : 'down'}>{String(p.side).toUpperCase()}</Badge>
                    <span className="font-semibold">{p.symbol}</span>
                    <span className="text-[var(--color-text-sub)]">entry {fmt(p.entry_price)}</span>
                  </li>
                ))}
              </ul>
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
          {riskEvents.length === 0 && <div className="text-[13px] text-[var(--color-text-sub)]">None yet.</div>}
          <ul className="space-y-1 text-[13px]">
            {riskEvents.map(ev => <RiskEventRow key={ev.id} ev={ev} />)}
          </ul>
        </Card>
      </div>
    </div>
  )
}
