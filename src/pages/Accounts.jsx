// Accounts — broker truth for every trading account on the connected
// cTrader ID. The bot's account loads first (fast: 1 account), the rest
// load on demand. Positions/orders are readable stacked rows (primary line
// + muted detail line), not a 17-column sideways scroll. Auto-refreshes.
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import PositionChart from '../components/PositionChart.jsx'
import { agentPost, agentConfigured } from '../lib/agent-api.js'

const REFRESH_MS = 30_000

function fmt(n, digits = 5) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits })
}
function money(n) {
  if (n == null) return '—'
  const v = Number(n)
  return `${v >= 0 ? '' : '−'}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function ts(msOrIso) {
  if (!msOrIso) return '—'
  const d = new Date(typeof msOrIso === 'number' ? msOrIso : msOrIso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function PositionRow({ p }) {
  const [chart, setChart] = useState(false)
  return (
    <div className="border-t border-[var(--color-border)] py-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold">{p.symbol}{p.guaranteedSl ? ' 🔒' : ''}</span>
        <Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge>
        <span>{p.lots != null ? `${fmt(p.lots, 2)} lots` : ''}</span>
        <span>in {fmt(p.entry)} → now {fmt(p.currentPrice)}</span>
        {p.deltaPips != null && <Badge tone={p.deltaPips >= 0 ? 'up' : 'down'}>{p.deltaPips >= 0 ? '+' : ''}{fmt(p.deltaPips, 1)} pips</Badge>}
        {p.estPnlQuote != null && (
          <span className={`font-semibold ${p.estPnlQuote >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>{money(p.estPnlQuote)}*</span>
        )}
        <span className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => setChart(c => !c)}>{chart ? 'Hide' : 'Chart'}</Button>
        </span>
      </div>
      <div className="mt-0.5 text-[12px] text-[var(--color-text-sub)] flex flex-wrap gap-x-4 gap-y-0.5">
        <span>SL {fmt(p.sl)} · TP {fmt(p.tp)}</span>
        <span>swap {money(p.swap)} · comm. {money(p.commission)} · margin {money(p.usedMargin)}</span>
        <span>min lot {p.minLot != null ? fmt(p.minLot, 2) : '—'}</span>
        <span>opened {ts(p.openedAt)}</span>
        {(p.label || p.comment) && <span className="truncate max-w-[220px]" title={p.comment || p.label}>{p.label || p.comment}</span>}
      </div>
      {chart && (
        <div className="mt-2">
          <PositionChart symbol={p.symbol} timeframe="1h" lines={{ entry: p.entry, sl: p.sl, tp: p.tp }} />
        </div>
      )}
    </div>
  )
}

function OrderRow({ o }) {
  return (
    <div className="border-t border-[var(--color-border)] py-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-semibold">{o.symbol}</span>
        <Badge tone="info">{o.type}</Badge>
        <Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge>
        <span>{o.lots != null ? `${fmt(o.lots, 2)} lots` : ''}</span>
        <span>trigger {fmt(o.limitPrice ?? o.stopPrice)} · now {fmt(o.currentPrice)}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-[var(--color-text-sub)] flex flex-wrap gap-x-4">
        <span>SL {fmt(o.sl)} · TP {fmt(o.tp)}</span>
        <span>expires {ts(o.expiresAt)}</span>
        {(o.label || o.comment) && <span className="truncate max-w-[220px]">{o.label || o.comment}</span>}
      </div>
    </div>
  )
}

function AccountCard({ acct, defaultOpen }) {
  const busyCount = (acct.positions?.length ?? 0) + (acct.orders?.length ?? 0)
  const [open, setOpen] = useState(defaultOpen || busyCount > 0)
  return (
    <Card>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full text-left cursor-pointer">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={acct.isLive ? 'down' : 'info'}>{acct.isLive ? 'LIVE' : 'DEMO'}</Badge>
          <span className="text-[13px] font-semibold">{acct.traderLogin ? `Login ${acct.traderLogin}` : `Account ${acct.accountId}`}</span>
          {acct.brokerTitle && <span className="text-[12px] text-[var(--color-text-sub)]">{acct.brokerTitle}</span>}
          {acct.balance != null && <span className="text-[13px] font-semibold">{fmt(acct.balance, 2)}{acct.currency ? ` ${acct.currency}` : ''}</span>}
          {acct.selected && <Badge tone="up">BOT TRADES THIS ONE</Badge>}
          <span className="ml-auto text-[12px] text-[var(--color-text-sub)]">
            {acct.positions?.length ?? 0} open · {acct.orders?.length ?? 0} pending {open ? '▾' : '▸'}
          </span>
        </div>
      </button>
      {open && (
        <div className="mt-1">
          {acct.error && <div className="text-[13px] text-[var(--color-warning-text)]">Snapshot failed: {acct.error}</div>}
          {acct.metaError && <div className="text-[13px] text-[var(--color-warning-text)]">{acct.metaError} — showing raw ids.</div>}
          {acct.positions?.length > 0 && <div className="text-[12px] font-semibold mt-1">Live positions</div>}
          {acct.positions?.map(p => <PositionRow key={p.positionId} p={p} />)}
          {acct.orders?.length > 0 && <div className="text-[12px] font-semibold mt-2">Pending (set) orders</div>}
          {acct.orders?.map(o => <OrderRow key={o.orderId} o={o} />)}
          {!acct.error && !acct.positions?.length && !acct.orders?.length && (
            <div className="text-[13px] text-[var(--color-text-sub)] mt-1">Flat — no open positions or pending orders.</div>
          )}
        </div>
      )}
    </Card>
  )
}

export default function Accounts() {
  const [bot, setBot] = useState(null)         // the selected account (fast path)
  const [others, setOthers] = useState(null)   // remaining accounts (on demand)
  const [loadingAll, setLoadingAll] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  const loadBot = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const r = await agentPost('/actions/broker-positions', { selectedOnly: true })
      setBot(r.accounts?.[0] ?? null)
      setUpdatedAt(new Date())
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  const loadAll = useCallback(async () => {
    setLoadingAll(true)
    try {
      const r = await agentPost('/actions/broker-positions')
      const accounts = r.accounts || []
      setBot(accounts.find(a => a.selected) ?? accounts[0] ?? null)
      setOthers(accounts.filter(a => !a.selected))
      setUpdatedAt(new Date())
      setError('')
    } catch (e) { setError(e.message) } finally { setLoadingAll(false) }
  }, [])

  useEffect(() => {
    const kick = setTimeout(loadBot, 0)
    timer.current = setInterval(loadBot, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(timer.current) }
  }, [loadBot])

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-bold t-heading">Accounts</h1>
        <span className="text-[12px] text-[var(--color-text-sub)]">
          broker truth for ALL your accounts — manual trades show here · auto-refresh 30s{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString()}` : ''}
        </span>
        <span className="ml-auto">
          <Button size="sm" variant="ghost" onClick={loadAll} disabled={loadingAll}>
            {loadingAll ? 'Fetching all accounts…' : others ? 'Refresh all accounts' : 'Show my other accounts'}
          </Button>
        </span>
      </div>
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}

      {!bot && !error && <Card className="text-[13px] text-[var(--color-text-sub)]">Loading the bot's account from the broker…</Card>}
      {bot && <AccountCard acct={bot} defaultOpen />}

      {others?.map(acct => <AccountCard key={acct.accountId} acct={acct} />)}
      {others && others.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">No other accounts on this cTrader ID.</p>}

      <p className="text-[12px] text-[var(--color-text-sub)]">
        *Est. P&L is the price move in the symbol's quote currency (lots × contract size × Δprice), excluding swap and commission — cTrader's own app shows the exact figure.
      </p>
    </div>
  )
}
