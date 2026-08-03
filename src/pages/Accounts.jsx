// Accounts — broker truth for every trading account on the connected
// cTrader ID. The bot's account loads first (fast: 1 account), the rest
// load on demand. Positions and pending orders render through the STANDARD
// order-log table (owner: same columns everywhere — Time | Symbol | Result |
// Source | Side | Qty | Entry | Stop Loss | Take Profit | Reason | Chart).
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import { useEffect, useState, useCallback, useRef } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import StdTradeTable from '../components/StdTradeTable.jsx'
import PositionManager from '../components/PositionManager.jsx'
import OrderManager from '../components/OrderManager.jsx'
import AccountHealth from '../components/AccountHealth.jsx'
import AccountCompare from '../components/AccountCompare.jsx'
import AccountPivot from '../components/AccountPivot.jsx'
import MarketClock from '../components/MarketClock.jsx'
import StrategyInsights from '../components/StrategyInsights.jsx'
import AccountScopePills from '../components/common/AccountScopePills.jsx'
import AccountsSubNav from '../components/AccountsSubNav.jsx'
import AccountSwitcher from '../components/AccountSwitcher.jsx'
import { brokerPositionRows, brokerOrderRows, priceDp } from '../lib/std-trade-rows.js'
import { useLensAccount } from '../lib/use-lens-account.js'
import { agentGet, agentPost, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import Skeleton from '../components/common/Skeleton.jsx'

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
        <span className="text-[9px] font-semibold">{acct.traderLogin ? `Login ${acct.traderLogin}` : `Account ${acct.accountId}`}</span>
        {acct.brokerTitle && <span className="text-[9px] text-[var(--color-text-sub)]">{acct.brokerTitle}</span>}
        {acct.balance != null && <span className="text-[9px] font-semibold">{fmt(acct.balance, 2)}{acct.currency ? ` ${acct.currency}` : ''}</span>}
        {acct.selected && <Badge tone="on">BOT TRADES THIS ONE</Badge>}
      </div>
      {acct.error && <div className="text-[9px] text-[var(--color-warning-text)]">Snapshot failed: {acct.error}</div>}
      {acct.metaError && <div className="text-[9px] text-[var(--color-warning-text)]">{acct.metaError} — showing raw ids.</div>}

      <AccountHealth acct={acct} />
      <div className="mt-3">
        <AccountPivot acct={acct} />
      </div>

      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="w-full text-left cursor-pointer mt-3">
        <div className="flex items-center gap-2 text-[9px] text-[var(--color-text-sub)] border-t border-[var(--glass-edge)] pt-2">
          <span className="font-semibold">Live positions &amp; pending orders</span>
          <span className="ml-auto">{acct.positions?.length ?? 0} open · {acct.orders?.length ?? 0} pending {open ? '▾ hide' : '▸ show'}</span>
        </div>
      </button>
      {open && (
        <div className="mt-1">
          {acct.positions?.length > 0 && (
            <>
              <div className="text-[9px] font-semibold mt-1 mb-1">Live positions</div>
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
              <div className="text-[9px] font-semibold mt-2 mb-1">Pending (set) orders</div>
              <StdTradeTable
                rows={brokerOrderRows(acct.orders, { manageable })}
                countLabel="pending orders"
                marketHours={marketHours}
                panel={manageable ? { label: 'Manage', render: (row, close) => <OrderManager o={row.raw} onDone={() => { close(); onChanged?.() }} /> } : null}
              />
            </>
          )}
          {!acct.error && !acct.positions?.length && !acct.orders?.length && (
            <div className="text-[9px] text-[var(--color-text-sub)] mt-1">Flat — no open positions or pending orders.</div>
          )}
        </div>
      )}
    </Card>
  )
}


export default function Accounts() {
  const [bot, setBot] = useState(null)         // the selected account (fast path)
  // Lens-defaulted (owner 03-08-2026: "include all pages"). The dropdown
  // still overrides for a one-off comparison.
  const [insightsAcct, setInsightsAcct] = useLensAccount('all') // Strategy Forecast vs. Actual scope
  const [others, setOthers] = useState(null)   // remaining accounts (on demand)

  // accountId → {positions, floating, equity, usedMargin} for the Trading
  // switches rows, computed from whichever broker snapshots this page holds
  // (bot always; others once fetched). Derived, never fetched again.
  const brokerMap = {}
  for (const acct of [bot, ...(others || [])]) {
    if (!acct?.accountId) continue
    const positions = acct.positions || []
    const floating = positions.reduce((s, p) => s + (Number(p.estNetPnl ?? p.estPnlQuote) || 0), 0)
    const usedMargin = positions.reduce((s, p) => s + (Number(p.usedMargin) || 0), 0)
    brokerMap[String(acct.accountId)] = {
      positions,
      floating,
      equity: acct.balance != null ? Number(acct.balance) + floating : null,
      usedMargin: positions.length ? usedMargin : null,
    }
  }
  const [loadingAll, setLoadingAll] = useState(false)
  const [viewAcct, setViewAcct] = useLensAccount('all')
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

  // Account SWITCH (owner 2026-07-29: "I change account - DEMO 5268549 - why
  // the Accounts page, is the loading slow"). Measured on staging:
  // /state/broker-cache 0.73s, /actions/broker-positions {selectedOnly} 5.1s.
  // The cold-load instant paint above is guarded by `prev ?? …`, so after a
  // switch `prev` is the PREVIOUS account's snapshot and the guard keeps it —
  // you stared at the old account's numbers for the whole 5s live call with
  // nothing saying they were stale. Showing the wrong account's balance and
  // positions under the new account's name is worse than showing nothing.
  //
  // So: watch the selected id (the switcher writes it to the same session
  // cache), and on a change clear the card, name what is loading, and refetch.
  const [switchingTo, setSwitchingTo] = useState(null)
  const selectedRef = useRef(null)
  useEffect(() => {
    if (!agentConfigured()) return undefined
    const tick = () => {
      let c = null
      try { c = JSON.parse(sessionStorage.getItem('accounts_cache_v1')) } catch { return }
      const id = c?.selectedAccountId ?? null
      if (id == null) return
      if (selectedRef.current == null) { selectedRef.current = id; return }
      if (id === selectedRef.current) return
      selectedRef.current = id
      const a = c?.accounts?.find(x => x.accountId === id)
      setSwitchingTo(a?.traderLogin ?? String(id))
      setBot(null)
      setOthers(null)
      loadBot().finally(() => setSwitchingTo(null))
    }
    const t = setInterval(tick, 1_000)
    return () => clearInterval(t)
  }, [loadBot])

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
    timer.current = setInterval(() => { if (!pageAsleep()) loadBot() }, REFRESH_MS)
    return () => { clearTimeout(kick); clearInterval(timer.current) }
  }, [loadBot])

  return (
    <div className="space-y-8">
      <SectionNavFab />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-bold t-heading">Accounts</h1>
        <span className="text-[9px] text-[var(--color-text-sub)]">
          broker truth for ALL your accounts — manual trades show here · auto-refresh 30s{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString()}` : ''}
        </span>
        <span className="ml-auto">
          <Button size="sm" variant="ghost" onClick={loadAll} disabled={loadingAll}>
            {loadingAll ? 'Fetching all accounts…' : others ? 'Refresh all accounts' : 'Show my other accounts'}
          </Button>
        </span>
      </div>
      {error && <Card className="border-[var(--color-down)] text-[9px]">{error}</Card>}

      <AccountsSubNav />

      {/* S.A.T. switches — moved here from the sidebar (owner 2026-08-01;
          master row removed same day, the master veto lives on Tune ›
          Pipeline). The broker map feeds the per-row equity/margin/floating
          figures from the snapshots this page already fetches. */}
      <Card id="sec-switches">
        <AccountSwitcher title="Trading switches" broker={brokerMap} />
      </Card>

      <div id="sec-clock"><MarketClock /></div>

      {/* A named wait reads as work; an unnamed one reads as a hang. The
          broker call is ~5s and there is no making it instant, so say whose
          account is on its way. */}
      {!bot && !error && (
        <Card>
          {switchingTo && (
            <div className="mb-2 text-[9px] font-semibold text-[var(--color-text-sub)]">
              Loading {switchingTo} from the broker — about 5 seconds.
            </div>
          )}
          <Skeleton lines={4} />
        </Card>
      )}
      {/* Owner 02-08: "cannot switch account to see other Account health" —
          view pills pick WHICH account's card(s) render below. 'All' shows
          every fetched card; picking one shows that account alone. The
          other-account cards need the all-accounts snapshot, fetched on
          demand the first time a non-bot account is picked. */}
      <Card>
        <AccountScopePills value={viewAcct} onChange={(id) => {
          setViewAcct(id)
          if (id !== 'all' && !others) loadAll()
        }} note="which account's health/positions to show below · All = every fetched account" />
      </Card>

      <div id="sec-primary">{bot && (viewAcct === 'all' || String(bot.accountId) === String(viewAcct)) && <AccountCard acct={bot} marketHours={marketHours} onChanged={loadBot} />}</div>

      <div id="sec-others" className="space-y-8">{others?.filter(a => viewAcct === 'all' || String(a.accountId) === String(viewAcct)).map(acct => <AccountCard key={acct.accountId} acct={acct} marketHours={marketHours} />)}</div>
      {others && others.length === 0 && <p className="text-[9px] text-[var(--color-text-sub)]">No other accounts on this cTrader ID.</p>}
      {viewAcct !== 'all' && !others && <p className="text-[9px] text-[var(--color-text-sub)]">Fetching that account from the broker…</p>}

      <AccountCompare accounts={bot ? [bot, ...(others || [])] : []} onNeedAll={loadAll} loading={loadingAll} />

      <div id="sec-insights" className="space-y-1">
        {/* Owner 02-08: "must have the option to switch trading-accounts to
            see the information per trading-account" */}
        <AccountScopePills value={insightsAcct} onChange={setInsightsAcct} />
        <StrategyInsights account={insightsAcct} />
      </div>

      <p className="text-[9px] text-[var(--color-text-sub)]">
        *Est. P&L is the price move in the symbol's quote currency (lots × contract size × Δprice), excluding swap and commission — cTrader's own app shows the exact figure.
      </p>
    </div>
  )
}
