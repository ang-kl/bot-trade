// Accounts — full broker snapshot: every trading account on the connected
// cTrader ID, each with its live positions and pending (set) orders in
// trader-grade detail. Read-only view; the bot only trades the account
// marked SELECTED.
import { useEffect, useState, useCallback } from 'react'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { agentPost, agentConfigured } from '../lib/agent-api.js'

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

const th = 'pr-3 py-1 text-left font-medium text-[var(--color-text-sub)] whitespace-nowrap'
const td = 'pr-3 py-1.5 whitespace-nowrap'

export default function Accounts() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!agentConfigured()) { setError('Agent not connected — configure it on the Connect tab.'); return }
    setLoading(true)
    try {
      const r = await agentPost('/actions/broker-positions')
      setData(r)
      setError('')
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-[14px] font-bold">All trading accounts</h1>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading}>{loading ? 'Fetching from broker…' : 'Refresh'}</Button>
        {data?.fetchedAt && <span className="text-[12px] text-[var(--color-text-sub)]">snapshot {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
      </div>
      {error && <Card className="border-[var(--color-down)] text-[13px]">{error}</Card>}
      {!data && !error && <Card className="text-[13px] text-[var(--color-text-sub)]">Loading account snapshot from the broker…</Card>}

      {data?.accounts?.map(acct => (
        <Card key={acct.accountId}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <Badge tone={acct.isLive ? 'down' : 'info'}>{acct.isLive ? 'LIVE' : 'DEMO'}</Badge>
            <span className="text-[13px] font-semibold">{acct.traderLogin ? `Login ${acct.traderLogin}` : `Account ${acct.accountId}`}</span>
            {acct.brokerTitle && <span className="text-[12px] text-[var(--color-text-sub)]">{acct.brokerTitle}</span>}
            <span className="text-[12px] text-[var(--color-text-sub)]">id {acct.accountId}</span>
            {acct.balance != null && <span className="text-[13px] font-semibold ml-2">balance ${fmt(acct.balance, 2)}</span>}
            {acct.selected && <Badge tone="up">BOT TRADES THIS ONE</Badge>}
            <span className="ml-auto text-[12px] text-[var(--color-text-sub)]">
              {acct.positions.length} open · {acct.orders.length} pending
            </span>
          </div>

          {acct.error && <div className="text-[13px] text-[var(--color-warning-text)]">Snapshot failed: {acct.error}</div>}

          {acct.positions.length > 0 && (
            <div className="overflow-x-auto mb-2">
              <div className="text-[12px] font-semibold mb-1">Live positions</div>
              <table className="w-full text-[13px]">
                <thead><tr>
                  <th className={th}>Symbol</th><th className={th}>Side</th><th className={th}>Lots</th>
                  <th className={th}>Entry</th><th className={th}>Now</th><th className={th}>Δ pips</th>
                  <th className={th}>Est. P&L*</th><th className={th}>SL</th><th className={th}>TP</th>
                  <th className={th}>Swap</th><th className={th}>Comm.</th><th className={th}>Margin</th>
                  <th className={th}>Opened</th><th className={th}>Label</th>
                </tr></thead>
                <tbody>
                  {acct.positions.map(p => (
                    <tr key={p.positionId} className="border-t border-[var(--color-border)]">
                      <td className={`${td} font-semibold`}>{p.symbol}{p.guaranteedSl ? ' 🔒' : ''}</td>
                      <td className={td}><Badge tone={p.side === 'BUY' ? 'up' : 'down'}>{p.side}</Badge></td>
                      <td className={td}>{fmt(p.lots, 2)}</td>
                      <td className={td}>{fmt(p.entry)}</td>
                      <td className={td}>{fmt(p.currentPrice)}</td>
                      <td className={td}>{p.deltaPips != null ? <Badge tone={p.deltaPips >= 0 ? 'up' : 'down'}>{p.deltaPips >= 0 ? '+' : ''}{fmt(p.deltaPips, 1)}</Badge> : '—'}</td>
                      <td className={td}>{p.estPnlQuote != null ? <span className={p.estPnlQuote >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{money(p.estPnlQuote)}</span> : '—'}</td>
                      <td className={td}>{fmt(p.sl)}</td>
                      <td className={td}>{fmt(p.tp)}</td>
                      <td className={td}>{money(p.swap)}</td>
                      <td className={td}>{money(p.commission)}</td>
                      <td className={td}>{money(p.usedMargin)}</td>
                      <td className={td}>{ts(p.openedAt)}</td>
                      <td className={`${td} text-[var(--color-text-sub)] max-w-[160px] truncate`} title={p.comment || p.label || ''}>{p.label || p.comment || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {acct.orders.length > 0 && (
            <div className="overflow-x-auto">
              <div className="text-[12px] font-semibold mb-1">Pending orders</div>
              <table className="w-full text-[13px]">
                <thead><tr>
                  <th className={th}>Symbol</th><th className={th}>Type</th><th className={th}>Side</th>
                  <th className={th}>Lots</th><th className={th}>Trigger</th><th className={th}>Now</th>
                  <th className={th}>SL</th><th className={th}>TP</th><th className={th}>Expires</th><th className={th}>Label</th>
                </tr></thead>
                <tbody>
                  {acct.orders.map(o => (
                    <tr key={o.orderId} className="border-t border-[var(--color-border)]">
                      <td className={`${td} font-semibold`}>{o.symbol}</td>
                      <td className={td}>{o.type}</td>
                      <td className={td}><Badge tone={o.side === 'BUY' ? 'up' : 'down'}>{o.side}</Badge></td>
                      <td className={td}>{fmt(o.lots, 2)}</td>
                      <td className={td}>{fmt(o.limitPrice ?? o.stopPrice)}</td>
                      <td className={td}>{fmt(o.currentPrice)}</td>
                      <td className={td}>{fmt(o.sl)}</td>
                      <td className={td}>{fmt(o.tp)}</td>
                      <td className={td}>{ts(o.expiresAt)}</td>
                      <td className={`${td} text-[var(--color-text-sub)] max-w-[160px] truncate`}>{o.label || o.comment || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!acct.error && acct.positions.length === 0 && acct.orders.length === 0 && (
            <div className="text-[13px] text-[var(--color-text-sub)]">Flat — no open positions or pending orders.</div>
          )}
        </Card>
      ))}

      <p className="text-[12px] text-[var(--color-text-sub)]">
        *Est. P&L is the price move in the symbol's quote currency (lots × contract size × Δprice), excluding swap and commission — cTrader's own platform shows the exact figure. Prices are the last 1-minute close at snapshot time.
      </p>
    </div>
  )
}
