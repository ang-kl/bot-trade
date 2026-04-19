import { useState, useEffect, useCallback } from 'react'
import Badge from './common/Badge.jsx'
import Button from './common/Button.jsx'
import { fmtAgo } from '../lib/time.js'
import { parseLabel } from '../../agent/lib/trade-labels.js'

const SOURCE_BADGE = {
  autopilot: { tone: 'info',    text: 'AUTOPILOT' },
  copilot:   { tone: 'special', text: 'COPILOT'   },
  manual:    { tone: 'neutral', text: 'MANUAL'    },
  external:  { tone: 'warning', text: 'EXTERNAL'  },
}

const PIP_SIZE = {
  XAUUSD: 0.01, XAGUSD: 0.001,
  USDJPY: 0.01, EURJPY: 0.01, GBPJPY: 0.01, AUDJPY: 0.01, CADJPY: 0.01, CHFJPY: 0.01, NZDJPY: 0.01,
}
function pipDist(from, to, symbol) {
  if (from == null || to == null) return null
  const size = PIP_SIZE[symbol] ?? (symbol?.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1 : 0.0001)
  return (to - from) / size
}

function fmtMoney(v, digits = 2) {
  return v != null && Number.isFinite(v)
    ? Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
}

function computePnl(position, priceCache) {
  const mm = priceCache[position.symbolName] || {}
  const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
  if (!currentPrice || !position.openPrice || !position.volume) return null
  const volLots = position.volume / 10000
  const direction = position.side === 'BUY' ? 1 : -1
  const sym = position.symbolName || ''
  const contractSize = sym.startsWith('XAU') ? 100
    : sym.startsWith('XAG') ? 5000
    : sym.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1
    : 100000
  return direction * (currentPrice - position.openPrice) * volLots * contractSize
}

async function fetchAccountInfo(accessToken, accountId, isLive) {
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'account-info', accessToken, accountId, isLive }),
  })
  return res.ok ? res.json() : null
}
async function fetchOpenPositions(accessToken, accountId, isLive) {
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'open-positions', accessToken, accountId, isLive }),
  })
  return res.ok ? res.json() : null
}
async function fetchDealHistory(accessToken, accountId, isLive) {
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'deals', accessToken, accountId, isLive }),
  })
  return res.ok ? res.json() : null
}

const DEPOSIT_ASSET = { 14: 'USD', 6: 'EUR', 7: 'GBP', 3: 'AUD', 4: 'JPY', 5: 'CHF', 8: 'CAD', 9: 'NZD' }
const ACCT_TAB = { positions: 'Live Positions', orders: 'Pending Orders', deals: 'Deal History (30d)' }

export default function AccountPanel({ ctrader, botPositionsById, onPause, onUnpause }) {
  const [info, setInfo] = useState(null)
  const [positions, setPositions] = useState(null)
  const [deals, setDeals] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fetched, setFetched] = useState(false)
  const [tab, setTab] = useState('positions')
  const fallbackId = ctrader.linkedAccountId || ctrader.accounts?.[0]?.accountId || null
  const [selectedAccountId, setSelectedAccountId] = useState(fallbackId)
  useEffect(() => {
    if (!selectedAccountId && fallbackId) setSelectedAccountId(fallbackId)
  }, [fallbackId, selectedAccountId])

  const selected = ctrader.accounts?.find(a => a.accountId === selectedAccountId)
  const isLive = selected?.isLive ?? false
  const roles = ctrader.accountRoles || {}
  const selectedRole = roles[String(selectedAccountId)] || {}

  const refresh = useCallback(async () => {
    if (!selectedAccountId || !ctrader.accessToken) return
    setLoading(true); setError(null)
    try {
      const [inf, pos, dh] = await Promise.all([
        fetchAccountInfo(ctrader.accessToken, selectedAccountId, isLive),
        fetchOpenPositions(ctrader.accessToken, selectedAccountId, isLive),
        fetchDealHistory(ctrader.accessToken, selectedAccountId, isLive),
      ])
      setInfo(inf); setPositions(pos); setDeals(dh?.trades || []); setFetched(true)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [ctrader.accessToken, selectedAccountId, isLive])

  useEffect(() => { setFetched(false); setDeals(null); setPositions(null); setInfo(null) }, [selectedAccountId])
  useEffect(() => { if (!fetched) refresh() }, [fetched, refresh])

  if (!selectedAccountId || !ctrader.accounts?.length) {
    return <p className="t-sub text-[var(--color-muted)]">No account linked. Connect via the bottom status bar.</p>
  }

  const equityPct = info?.balance && info?.equity ? ((info.equity - info.balance) / info.balance) * 100 : null
  const currency = info?.depositAssetId ? (DEPOSIT_ASSET[info.depositAssetId] || '') : ''
  const posArr = positions?.positions || []
  const ordArr = positions?.orders || []
  const priceCache = readPriceCache()

  return (
    <div>
      {/* Account selector */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="t-label">Trading Account</p>
          <Badge tone={isLive ? 'down' : 'accent'} pill>{isLive ? 'LIVE' : 'DEMO'}</Badge>
          {selected && <span className="text-[10px] text-[var(--color-muted)]">#{selected.accountNumber || selectedAccountId}</span>}
          {selectedRole.autopilot && <Badge tone="info" className="text-[10px] px-1">AUTO</Badge>}
          {selectedRole.copilot && <Badge tone="special" className="text-[10px] px-1">COPILOT</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="!px-1.5 !py-0.5 text-[10px]">
          {loading ? '…' : '↻'}
        </Button>
      </div>

      {ctrader.accounts.length > 1 && (
        <div className="flex items-center gap-1 mb-2 overflow-x-auto scrollbar-none">
          {ctrader.accounts.map(a => {
            const r = roles[String(a.accountId)] || {}
            const active = a.accountId === selectedAccountId
            return (
              <button key={a.accountId} type="button" onClick={() => setSelectedAccountId(a.accountId)}
                className={`px-2 py-1 rounded-[5px] text-[10px] whitespace-nowrap flex items-center gap-1 ${active ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold' : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'}`}>
                <span>#{a.accountNumber || a.accountId}</span>
                <span className="opacity-70">{a.isLive ? 'LIVE' : 'DEMO'}</span>
                {r.autopilot && <span className="text-[var(--color-info)]">A</span>}
                {r.copilot && <span className="text-[var(--color-special)]">C</span>}
              </button>
            )
          })}
        </div>
      )}

      {error && <div className="px-3 py-2 mb-3 rounded-[5px] bg-[var(--color-error-bg)] border border-[var(--color-error-border)] text-[12px] text-[var(--color-error-text)] font-medium">{error}</div>}

      {/* Account summary */}
      {info && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Balance</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{fmtMoney(info.balance)} {currency}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Equity</p>
            <p className={`text-[15px] font-bold ${equityPct == null ? 'text-[var(--color-text)]' : equityPct > 0 ? 'text-[var(--color-up)]' : equityPct < 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
              {fmtMoney(info.equity)}
              {equityPct != null && <span className="text-[10px] font-normal ml-1">({equityPct > 0 ? '+' : ''}{equityPct.toFixed(2)}%)</span>}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Leverage</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{info.leverage ? `1:${info.leverage}` : '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Open Trades</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{posArr.length}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Pending</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{ordArr.length}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-2 border-b border-[var(--color-border)] overflow-x-auto scrollbar-none">
        {Object.entries(ACCT_TAB).map(([key, label]) => {
          const count = key === 'positions' ? posArr.length : key === 'orders' ? ordArr.length : (deals?.length || 0)
          return (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-[11px] font-bold whitespace-nowrap border-b-2 -mb-px ${tab === key ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-text)]'}`}>
              {label} <span className="text-[10px] opacity-70">({count})</span>
            </button>
          )
        })}
      </div>

      {/* Tab: Live Positions */}
      {tab === 'positions' && (
        <div className="overflow-x-auto">
          {posArr.length === 0 ? (
            <p className="t-sub text-[var(--color-muted)] py-2 text-center">No open positions.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[var(--color-muted)] text-left bg-[var(--color-surface)]">
                  <th className="px-2 py-1 font-medium">Symbol</th>
                  <th className="px-2 py-1 font-medium">Side</th>
                  <th className="px-2 py-1 font-medium text-right">Lots</th>
                  <th className="px-2 py-1 font-medium text-right">Entry</th>
                  <th className="px-2 py-1 font-medium text-right">SL</th>
                  <th className="px-2 py-1 font-medium text-right">TP</th>
                  <th className="px-2 py-1 font-medium text-right">Est. P&L</th>
                  <th className="px-2 py-1 font-medium text-right">Swap</th>
                  <th className="px-2 py-1 font-medium text-right">Comm.</th>
                  <th className="px-2 py-1 font-medium text-right">Margin</th>
                  <th className="px-2 py-1 font-medium">Source</th>
                  <th className="px-2 py-1 font-medium">Strategy</th>
                  <th className="px-2 py-1 font-medium">Opened</th>
                  <th className="px-2 py-1 font-medium">Bot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {posArr.map((p, i) => {
                  const sym = p.symbolName || `#${p.symbolId}`
                  const volLots = p.volume != null ? p.volume / 10000 : null
                  const priceDigits = sym.endsWith('JPY') ? 3 : sym.startsWith('XAU') ? 2 : 5
                  const pnl = computePnl(p, priceCache)
                  const slPips = pipDist(p.openPrice, p.stopLoss, sym)
                  const tpPips = pipDist(p.openPrice, p.takeProfit, sym)
                  const parsed = p.label ? parseLabel(p.label) : null
                  const src = parsed?.source ? SOURCE_BADGE[parsed.source] : null
                  const botPos = botPositionsById[String(p.positionId)]
                  const paused = botPos?.paused === 1
                  return (
                    <tr key={p.positionId || i} className="hover:bg-[var(--color-bg)]">
                      <td className="px-2 py-1 font-mono font-bold">{sym}</td>
                      <td className={`px-2 py-1 font-semibold ${p.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                        {p.side === 'BUY' ? '▲ BUY' : '▼ SELL'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{volLots != null ? volLots.toFixed(2) : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono">{p.openPrice != null ? p.openPrice.toFixed(priceDigits) : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono text-[var(--color-down)]">
                        {p.stopLoss != null ? <>{p.stopLoss.toFixed(priceDigits)}{slPips != null && <span className="text-[10px] opacity-70"> ({slPips.toFixed(0)}p)</span>}</> : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-[var(--color-up)]">
                        {p.takeProfit != null ? <>{p.takeProfit.toFixed(priceDigits)}{tpPips != null && <span className="text-[10px] opacity-70"> ({tpPips.toFixed(0)}p)</span>}</> : '—'}
                      </td>
                      <td className={`px-2 py-1 text-right font-mono font-semibold ${pnl > 0 ? 'text-[var(--color-up)]' : pnl < 0 ? 'text-[var(--color-down)]' : ''}`}>
                        {pnl != null ? <>{pnl >= 0 ? '+' : ''}{fmtMoney(pnl)}<span className="text-[10px] opacity-50 ml-0.5">est</span></> : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">{fmtMoney(p.swap)}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmtMoney(p.commission)}</td>
                      <td className="px-2 py-1 text-right font-mono">{p.usedMargin != null ? fmtMoney(p.usedMargin) : '—'}</td>
                      <td className="px-2 py-1">{src ? <Badge tone={src.tone} className="text-[10px] px-1">{src.text}</Badge> : '—'}</td>
                      <td className="px-2 py-1 text-[10px] uppercase">{parsed?.strategy || '—'}</td>
                      <td className="px-2 py-1 text-[var(--color-muted)]">{p.openTimestamp ? fmtAgo(p.openTimestamp) : '—'}</td>
                      <td className="px-2 py-1">
                        {botPos ? (paused
                          ? <Button size="sm" variant="ghost" onClick={() => onUnpause(botPos.id)} className="!px-1 !py-0 text-[10px]">resume</Button>
                          : <Button size="sm" variant="ghost" onClick={() => onPause(botPos.id)} className="!px-1 !py-0 text-[10px]">pause</Button>
                        ) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Tab: Pending Orders */}
      {tab === 'orders' && (
        <div className="overflow-x-auto">
          {ordArr.length === 0 ? (
            <p className="t-sub text-[var(--color-muted)] py-2 text-center">No pending orders.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[var(--color-muted)] text-left bg-[var(--color-surface)]">
                  <th className="px-2 py-1 font-medium">Symbol</th>
                  <th className="px-2 py-1 font-medium">Side</th>
                  <th className="px-2 py-1 font-medium">Type</th>
                  <th className="px-2 py-1 font-medium text-right">Lots</th>
                  <th className="px-2 py-1 font-medium text-right">Trigger</th>
                  <th className="px-2 py-1 font-medium text-right">SL</th>
                  <th className="px-2 py-1 font-medium text-right">TP</th>
                  <th className="px-2 py-1 font-medium">Status</th>
                  <th className="px-2 py-1 font-medium">Source</th>
                  <th className="px-2 py-1 font-medium">Strategy</th>
                  <th className="px-2 py-1 font-medium">Expires</th>
                  <th className="px-2 py-1 font-medium">Created</th>
                  <th className="px-2 py-1 font-medium">Label</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {ordArr.map((o, i) => {
                  const sym = o.symbolName || `#${o.symbolId}`
                  const volLots = o.volume != null ? o.volume / 10000 : null
                  const priceDigits = sym.endsWith('JPY') ? 3 : sym.startsWith('XAU') ? 2 : 5
                  const triggerPrice = o.limitPrice ?? o.stopPrice ?? null
                  const typeLabel = String(o.orderType ?? '').replace(/^ORDER_TYPE_/, '') || '—'
                  const statusLabel = String(o.orderStatus ?? '').replace(/^ORDER_STATUS_/, '') || '—'
                  const parsed = o.label ? parseLabel(o.label) : null
                  const src = parsed?.source ? SOURCE_BADGE[parsed.source] : null
                  const slPips = pipDist(triggerPrice, o.stopLoss, sym)
                  const tpPips = pipDist(triggerPrice, o.takeProfit, sym)
                  return (
                    <tr key={o.orderId || i} className="hover:bg-[var(--color-bg)]">
                      <td className="px-2 py-1 font-mono font-bold">{sym}</td>
                      <td className={`px-2 py-1 font-semibold ${o.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                        {o.side === 'BUY' ? '▲ BUY' : '▼ SELL'}
                      </td>
                      <td className="px-2 py-1"><Badge tone="accent" className="text-[10px] px-1">{typeLabel}</Badge></td>
                      <td className="px-2 py-1 text-right font-mono">{volLots != null ? volLots.toFixed(2) : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono">{triggerPrice != null ? triggerPrice.toFixed(priceDigits) : '—'}</td>
                      <td className="px-2 py-1 text-right font-mono text-[var(--color-down)]">
                        {o.stopLoss != null ? <>{o.stopLoss.toFixed(priceDigits)}{slPips != null && <span className="text-[10px] opacity-70"> ({slPips.toFixed(0)}p)</span>}</> : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-[var(--color-up)]">
                        {o.takeProfit != null ? <>{o.takeProfit.toFixed(priceDigits)}{tpPips != null && <span className="text-[10px] opacity-70"> ({tpPips.toFixed(0)}p)</span>}</> : '—'}
                      </td>
                      <td className="px-2 py-1 text-[10px]">{statusLabel}</td>
                      <td className="px-2 py-1">{src ? <Badge tone={src.tone} className="text-[10px] px-1">{src.text}</Badge> : '—'}</td>
                      <td className="px-2 py-1 text-[10px] uppercase">{parsed?.strategy || '—'}</td>
                      <td className="px-2 py-1 text-[var(--color-muted)]">{o.expirationTimestamp ? fmtAgo(o.expirationTimestamp) : '—'}</td>
                      <td className="px-2 py-1 text-[var(--color-muted)]">{o.utcLastUpdateTimestamp ? fmtAgo(o.utcLastUpdateTimestamp) : (o.openTimestamp ? fmtAgo(o.openTimestamp) : '—')}</td>
                      <td className="px-2 py-1 text-[10px] truncate max-w-[100px]" title={o.label || o.comment || ''}>{o.label || o.comment || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Tab: Deal History */}
      {tab === 'deals' && (
        <div className="overflow-x-auto">
          {!deals || deals.length === 0 ? (
            <p className="t-sub text-[var(--color-muted)] py-2 text-center">No closed trades in the last 30 days.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[var(--color-muted)] text-left bg-[var(--color-surface)]">
                  <th className="px-2 py-1 font-medium">Symbol</th>
                  <th className="px-2 py-1 font-medium">Direction</th>
                  <th className="px-2 py-1 font-medium text-right">Volume</th>
                  <th className="px-2 py-1 font-medium text-right">Entry</th>
                  <th className="px-2 py-1 font-medium text-right">Exit</th>
                  <th className="px-2 py-1 font-medium text-right">Gross</th>
                  <th className="px-2 py-1 font-medium text-right">Comm.</th>
                  <th className="px-2 py-1 font-medium text-right">Swap</th>
                  <th className="px-2 py-1 font-medium text-right">Net P&L</th>
                  <th className="px-2 py-1 font-medium">Entry Time</th>
                  <th className="px-2 py-1 font-medium">Exit Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {deals.map((d, i) => (
                  <tr key={d.dealId || i} className="hover:bg-[var(--color-bg)]">
                    <td className="px-2 py-1 font-mono font-bold">{d.symbol || `#${d.symbolId}`}</td>
                    <td className={`px-2 py-1 font-semibold ${d.direction === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                      {d.direction === 'BUY' ? '▲ BUY' : '▼ SELL'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{d.volume != null ? (d.volume / 10000).toFixed(2) : '—'}</td>
                    <td className="px-2 py-1 text-right font-mono">{d.entryPrice != null ? Number(d.entryPrice).toFixed(5) : '—'}</td>
                    <td className="px-2 py-1 text-right font-mono">{d.exitPrice != null ? Number(d.exitPrice).toFixed(5) : '—'}</td>
                    <td className={`px-2 py-1 text-right font-mono ${d.grossProfit > 0 ? 'text-[var(--color-up)]' : d.grossProfit < 0 ? 'text-[var(--color-down)]' : ''}`}>
                      {fmtMoney(d.grossProfit)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{fmtMoney(d.commission)}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmtMoney(d.swap)}</td>
                    <td className={`px-2 py-1 text-right font-mono font-semibold ${d.netProfit > 0 ? 'text-[var(--color-up)]' : d.netProfit < 0 ? 'text-[var(--color-down)]' : ''}`}>
                      {d.netProfit != null ? <>{d.netProfit >= 0 ? '+' : ''}{fmtMoney(d.netProfit)}</> : '—'}
                    </td>
                    <td className="px-2 py-1 text-[var(--color-muted)]">{d.entryTime ? fmtAgo(d.entryTime) : '—'}</td>
                    <td className="px-2 py-1 text-[var(--color-muted)]">{d.exitTime ? fmtAgo(d.exitTime) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!loading && !info && !error && (
        <p className="t-sub text-[var(--color-muted)]">Loading account data…</p>
      )}
    </div>
  )
}
