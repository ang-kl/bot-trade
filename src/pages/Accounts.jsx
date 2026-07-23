// Accounts — broker truth for every trading account on the connected
// cTrader ID. The bot's account loads first (fast: 1 account), the rest
// load on demand. Positions and pending orders render through the STANDARD
// order-log table (owner: same columns everywhere — Time | Symbol | Result |
// Source | Side | Qty | Entry | Stop Loss | Take Profit | Reason | Chart).
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import StdTradeTable from '../components/StdTradeTable.jsx'
import PositionManager from '../components/PositionManager.jsx'
import OrderManager from '../components/OrderManager.jsx'
import AccountHealth from '../components/AccountHealth.jsx'
import AccountPivot from '../components/AccountPivot.jsx'
import MarketClock from '../components/MarketClock.jsx'
import { brokerPositionRows, brokerOrderRows, priceDp } from '../lib/std-trade-rows.js'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'

const REFRESH_MS = 30_000

// No-digits calls are PRICES (scale-aware canonical dp); explicit digits
// are money/counts and keep exactly what the caller asked for.
function fmt(n, digits) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits ?? priceDp(n) })
}

function AccountCard({ acct, marketHours, onChanged }) {
  // Manage pop-ups only on the SELECTED account — the position/order action
  // endpoints act through the bot's creds on that account, so offering
  // Manage on other accounts would hit the wrong one.
  const manageable = !!acct.selected
  // Live positions/orders table starts CLOSED regardless of how busy the
  // account is (owner: "close the current live positions table") — Account
  // Health above is now the at-a-glance view; the raw table is opt-in.
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Badge tone={acct.isLive ? 'down' : 'info'}>{acct.isLive ? 'LIVE' : 'DEMO'}</Badge>
        <span className="text-[13px] font-semibold">{acct.traderLogin ? `Login ${acct.traderLogin}` : `Account ${acct.accountId}`}</span>
        {acct.brokerTitle && <span className="text-[12px] text-[var(--color-text-sub)]">{acct.brokerTitle}</span>}
        {acct.balance != null && <span className="text-[13px] font-semibold">{fmt(acct.balance, 2)}{acct.currency ? ` ${acct.currency}` : ''}</span>}
        {acct.selected && <Badge tone="up">BOT TRADES THIS ONE</Badge>}
      </div>
      {acct.error && <div className="text-[13px] text-[var(--color-warning-text)]">Snapshot failed: {acct.error}</div>}
      {acct.metaError && <div className="text-[13px] text-[var(--color-warning-text)]">{acct.metaError} — showing raw ids.</div>}

      <AccountHealth acct={acct} />
      <div className="mt-3">
        <AccountPivot acct={acct} />
      </div>

      <button type="button" onClick={() => setOpen(o => !o)} className="w-full text-left cursor-pointer mt-3">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-sub)] border-t border-[var(--glass-edge)] pt-2">
          <span className="font-semibold">Live positions &amp; pending orders</span>
          <span className="ml-auto">{acct.positions?.length ?? 0} open · {acct.orders?.length ?? 0} pending {open ? '▾ hide' : '▸ show'}</span>
        </div>
      </button>
      {open && (
        <div className="mt-1">
          {acct.positions?.length > 0 && (
            <>
              <div className="text-[12px] font-semibold mt-1 mb-1">Live positions</div>
              <StdTradeTable
                rows={brokerPositionRows(acct.positions, { manageable })}
                countLabel="open positions"
                marketHours={marketHours}
                panel={manageable ? { label: 'Manage', render: (row, close) => <PositionManager p={row.raw} onDone={() => { close(); onChanged?.() }} /> } : null}
              />
            </>
          )}
          {acct.orders?.length > 0 && (
            <>
              <div className="text-[12px] font-semibold mt-2 mb-1">Pending (set) orders</div>
              <StdTradeTable
                rows={brokerOrderRows(acct.orders, { manageable })}
                countLabel="pending orders"
                marketHours={marketHours}
                panel={manageable ? { label: 'Manage', render: (row, close) => <OrderManager o={row.raw} onDone={() => { close(); onChanged?.() }} /> } : null}
              />
            </>
          )}
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
  const [marketHours, setMarketHours] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  const loadBot = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    try {
      const r = await agentPost('/actions/broker-positions', { selectedOnly: true })
      setBot(r.accounts?.[0] ?? null)
      agentGet('/state/market-hours').then(x => setMarketHours(x?.hours || null)).catch(() => {})
      setUpdatedAt(new Date())
      setError('')
    } catch (e) { setError(e.message) }
  }, [])

  // Instant paint — owner: "don't have to keep loading, I want to see now."
  // A fresh snapshot is ~4 authenticated WS round-trips (seconds, not
  // instant); the DB already holds the last one (refreshed by this same
  // route + the 30s monitor loop), so paint that FIRST, then let loadBot's
  // live call replace it a moment later.
  useEffect(() => {
    if (!agentConfigured()) return
    agentGet('/state/broker-cache').then(r => {
      if (r?.snapshot?.account) setBot(prev => prev ?? r.snapshot.account)
    }).catch(() => {})
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

      <MarketClock />

      {!bot && !error && <Card className="text-[13px] text-[var(--color-text-sub)]">Loading the bot's account from the broker…</Card>}
      {bot && <AccountCard acct={bot} marketHours={marketHours} onChanged={loadBot} />}

      {others?.map(acct => <AccountCard key={acct.accountId} acct={acct} marketHours={marketHours} />)}
      {others && others.length === 0 && <p className="text-[12px] text-[var(--color-text-sub)]">No other accounts on this cTrader ID.</p>}

      <p className="text-[12px] text-[var(--color-text-sub)]">
        *Est. P&L is the price move in the symbol's quote currency (lots × contract size × Δprice), excluding swap and commission — cTrader's own app shows the exact figure.
      </p>
    </div>
  )
}
