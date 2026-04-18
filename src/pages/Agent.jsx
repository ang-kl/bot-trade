// Trade Window — live observation cockpit for the autonomous bot.
// The Railway loop runs Scout → Analyst → Monitor autonomously; this page
// surfaces what it's doing and gives you the kill switches.
// Deep drill-down into minion reports lives on /workshop to keep this lean.

import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import Button from '../components/common/Button.jsx'
import { useStrategy } from '../lib/strategy-store.js'
import { agentGet, agentPost, agentConfigured, ROLES } from '../lib/agent-api.js'
import { fmtAgo } from '../lib/time.js'
import { parseLabel } from '../../agent/lib/trade-labels.js'
import { dispatch as dispatchMinions, MINIONS } from '../../agent/lib/minions.js'
import { isTradingNow, msUntilOpen, fmtDuration } from '../lib/trading-hours.js'

// Map parsed label source → badge tone + display label. Unknown / null
// source falls through and the row just shows the raw label string.
const SOURCE_BADGE = {
  autopilot: { tone: 'info',    text: 'AUTOPILOT' },
  copilot:   { tone: 'special', text: 'COPILOT'   },
  manual:    { tone: 'neutral', text: 'MANUAL'    },
}

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
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

function fmtMoney(v, digits = 2) {
  return v != null && Number.isFinite(v)
    ? Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—'
}

// ---------------------------------------------------------------------------
// Account panel — reads from cTrader directly (serverless /api/ctrader)
// ---------------------------------------------------------------------------

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

function AccountPanel({ ctrader, botPositionsById, onPause, onUnpause }) {
  const [info, setInfo] = useState(null)
  const [positions, setPositions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Per-account tab — defaults to the primary linked account but the user can
  // flip between any connected account (autopilot / copilot / observer).
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
      const [inf, pos] = await Promise.all([
        fetchAccountInfo(ctrader.accessToken, selectedAccountId, isLive),
        fetchOpenPositions(ctrader.accessToken, selectedAccountId, isLive),
      ])
      setInfo(inf); setPositions(pos)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [ctrader.accessToken, selectedAccountId, isLive])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const iv = setInterval(refresh, 60_000)
    return () => clearInterval(iv)
  }, [refresh])

  if (!selectedAccountId || !ctrader.accounts?.length) {
    return (
      <Card>
        <p className="t-label mb-1">Trading Account</p>
        <p className="t-sub text-[var(--color-muted)]">
          No account linked. Go to Settings → cTrader to connect your Pepperstone account.
        </p>
      </Card>
    )
  }

  const equityPct = info?.balance && info?.equity
    ? ((info.equity - info.balance) / info.balance) * 100
    : null

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <p className="t-label">Trading Account</p>
          <Badge tone={isLive ? 'down' : 'accent'} pill>{isLive ? 'LIVE' : 'DEMO'}</Badge>
          {selected && (
            <span className="text-[10px] text-[var(--color-muted)]">
              #{selected.accountNumber || selectedAccountId}
            </span>
          )}
          {selectedRole.autopilot && <Badge tone="info" className="text-[8px] px-1">AUTO</Badge>}
          {selectedRole.copilot && <Badge tone="special" className="text-[8px] px-1">COPILOT</Badge>}
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
              <button
                key={a.accountId}
                type="button"
                onClick={() => setSelectedAccountId(a.accountId)}
                className={`px-2 py-1 rounded-[5px] text-[10px] whitespace-nowrap flex items-center gap-1 ${
                  active
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-bold'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                }`}
              >
                <span>#{a.accountNumber || a.accountId}</span>
                <span className="opacity-70">{a.isLive ? 'LIVE' : 'DEMO'}</span>
                {r.autopilot && <span className="text-[8px] text-[var(--color-info)]">A</span>}
                {r.copilot && <span className="text-[8px] text-[var(--color-special)]">C</span>}
              </button>
            )
          })}
        </div>
      )}

      {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

      {info && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Balance</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{fmtMoney(info.balance)}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Equity</p>
            <p className={`text-[15px] font-bold ${
              equityPct == null ? 'text-[var(--color-text)]'
              : equityPct > 0 ? 'text-[var(--color-up)]'
              : equityPct < 0 ? 'text-[var(--color-down)]'
              : 'text-[var(--color-text)]'
            }`}>
              {fmtMoney(info.equity)}
              {equityPct != null && (
                <span className="text-[10px] font-normal ml-1">
                  ({equityPct > 0 ? '+' : ''}{equityPct.toFixed(2)}%)
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Leverage</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{info.leverage ? `1:${info.leverage}` : '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Open Trades</p>
            <p className="text-[15px] font-bold text-[var(--color-text)]">{positions?.count ?? '—'}</p>
          </div>
        </div>
      )}

      {positions?.orders?.length > 0 && (() => {
        const oGroups = { autopilot: [], copilot: [], manual: [] }
        for (const o of positions.orders) {
          const parsed = o.label ? parseLabel(o.label) : null
          const src = parsed?.source || 'manual'
          ;(oGroups[src] || oGroups.manual).push(o)
        }
        const ORDER_GROUP_META = {
          autopilot: { label: 'Orders (Auto-Trade)', tone: 'info' },
          copilot:   { label: 'Orders (Copilot)',    tone: 'special' },
          manual:    { label: 'Orders (Manual)',      tone: 'neutral' },
        }
        return (
          <div className="space-y-3 mb-3">
            {['autopilot', 'copilot', 'manual'].map(src => {
              const items = oGroups[src]
              if (!items || items.length === 0) return null
              const meta = ORDER_GROUP_META[src]
              return (
                <div key={src}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <p className="t-meta text-[var(--color-muted)]">{meta.label}</p>
                    <Badge tone={meta.tone} className="text-[8px] px-1">{items.length}</Badge>
                  </div>
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {items.map((o, i) => {
                      const sym = o.symbolName || `#${o.symbolId}`
                      const volLots = o.volume != null ? o.volume / 10000 : null
                      const isGold = (o.symbolName || '').startsWith('XAU')
                      const ozDisplay = isGold && volLots != null ? ` (${(volLots * 100).toFixed(2)} Oz)` : ''
                      const priceDigits = (o.symbolName || '').endsWith('JPY') ? 3 : isGold ? 2 : 5
                      const triggerPrice = o.limitPrice ?? o.stopPrice ?? null
                      const typeLabel = o.orderType?.replace(/^ORDER_TYPE_/, '') || o.orderType || '—'
                      const parsedLabel = o.label ? parseLabel(o.label) : null
                      const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
                      const slPips = pipDist(triggerPrice, o.stopLoss, o.symbolName)
                      const tpPips = pipDist(triggerPrice, o.takeProfit, o.symbolName)
                      return (
                        <div key={o.orderId || i} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={`font-bold w-[12px] ${o.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                              {o.side === 'BUY' ? '▲' : '▼'}
                            </span>
                            <span className="font-bold text-[var(--color-text)]">{sym}</span>
                            <Badge tone="neutral" className="text-[8px] px-1">{typeLabel}</Badge>
                            {sourceBadge && (
                              <Badge tone={sourceBadge.tone} className="text-[8px] px-1" title={parsedLabel.raw}>
                                {sourceBadge.text}
                              </Badge>
                            )}
                            <span className="text-[var(--color-muted)]">
                              {volLots != null ? `${volLots.toFixed(2)} lots${ozDisplay}` : '—'}
                            </span>
                            <span className="text-[var(--color-muted)]">
                              @ {triggerPrice != null ? triggerPrice.toFixed(priceDigits) : '—'}
                            </span>
                            <span className="flex-1" />
                            <span className="text-[9.5px] text-[var(--color-muted)]">
                              {o.utcLastUpdateTimestamp ? fmtAgo(o.utcLastUpdateTimestamp) : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[9.5px] text-[var(--color-muted)] mt-0.5 flex-wrap">
                            {o.stopLoss != null && (
                              <span>
                                <span className="text-[var(--color-down)]">SL</span> {o.stopLoss.toFixed(priceDigits)}
                                {slPips != null && <span className="opacity-70"> ({slPips > 0 ? '+' : ''}{slPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {o.takeProfit != null && (
                              <span>
                                <span className="text-[var(--color-up)]">TP</span> {o.takeProfit.toFixed(priceDigits)}
                                {tpPips != null && <span className="opacity-70"> ({tpPips > 0 ? '+' : ''}{tpPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {o.expirationTimestamp && <span>expires {fmtAgo(o.expirationTimestamp)}</span>}
                            {parsedLabel?.strategy && (
                              <span className="uppercase tracking-wide">
                                {parsedLabel.strategy}
                                {parsedLabel.conviction && <span className="opacity-70"> · {parsedLabel.conviction}</span>}
                                {parsedLabel.session && <span className="opacity-70"> · {parsedLabel.session}</span>}
                              </span>
                            )}
                            {o.label && !sourceBadge && (
                              <span className="italic truncate max-w-[80px]" title={o.label}>{o.label}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {positions?.positions?.length > 0 && (() => {
        const priceCache = readPriceCache()
        // Group positions by source from label parsing
        const groups = { autopilot: [], copilot: [], manual: [] }
        for (const p of positions.positions) {
          const parsed = p.label ? parseLabel(p.label) : null
          const src = parsed?.source || 'manual'
          ;(groups[src] || groups.manual).push(p)
        }
        const GROUP_META = {
          autopilot: { label: 'Autopilot Positions', tone: 'info', icon: '●' },
          copilot:   { label: 'Copilot Positions',   tone: 'special', icon: '◐' },
          manual:    { label: 'Manual / External',    tone: 'neutral', icon: '○' },
        }
        return (
          <div className="space-y-3">
            {['autopilot', 'copilot', 'manual'].map(src => {
              const items = groups[src]
              if (!items || items.length === 0) return null
              const meta = GROUP_META[src]
              return (
                <div key={src}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px]">{meta.icon}</span>
                    <p className="t-meta text-[var(--color-muted)]">{meta.label}</p>
                    <Badge tone={meta.tone} className="text-[8px] px-1">{items.length}</Badge>
                  </div>
                  <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                    {items.map((p, i) => {
                      const sym = p.symbolName || `#${p.symbolId}`
                      const volLots = p.volume != null ? p.volume / 10000 : null
                      const isGold = (p.symbolName || '').startsWith('XAU')
                      const ozDisplay = isGold && volLots != null ? ` (${(volLots * 100).toFixed(2)} Oz)` : ''
                      const priceDigits = (p.symbolName || '').endsWith('JPY') ? 3 : isGold ? 2 : 5
                      const pnl = computePnl(p, priceCache)
                      const slPips = pipDist(p.openPrice, p.stopLoss, p.symbolName)
                      const tpPips = pipDist(p.openPrice, p.takeProfit, p.symbolName)
                      const fees = (p.swap || 0) + (p.commission || 0)
                      const parsedLabel = p.label ? parseLabel(p.label) : null
                      const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
                      const botPos = botPositionsById[String(p.positionId)]
                      const paused = botPos?.paused === 1
                      const lastCheck = botPos?.last_check_action
                      const lastCheckAt = botPos?.last_check_at
                      return (
                        <div key={p.positionId || i} className="px-2 py-1.5 rounded-[5px] bg-[var(--color-bg)]">
                          <div className="flex items-center gap-2 text-[11px]">
                            <span className={`font-bold w-[12px] ${p.side === 'BUY' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                              {p.side === 'BUY' ? '▲' : '▼'}
                            </span>
                            <span className="font-bold text-[var(--color-text)]">{sym}</span>
                            {sourceBadge && (
                              <Badge tone={sourceBadge.tone} className="text-[8px] px-1" title={parsedLabel.raw}>
                                {sourceBadge.text}
                              </Badge>
                            )}
                            <span className="text-[var(--color-muted)]">
                              {volLots != null ? `${volLots.toFixed(2)} lots${ozDisplay}` : '—'}
                            </span>
                            <span className="text-[var(--color-muted)]">
                              @ {p.openPrice != null ? p.openPrice.toFixed(priceDigits) : '—'}
                            </span>
                            <span className="flex-1" />
                            {pnl != null && (
                              <span className={`font-mono font-semibold ${pnl > 0 ? 'text-[var(--color-up)]' : pnl < 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>
                                {pnl >= 0 ? '+' : ''}{fmtMoney(pnl)}
                                <span className="text-[8px] text-[var(--color-muted)] ml-0.5">est</span>
                              </span>
                            )}
                            {botPos && (paused
                              ? <Button size="sm" variant="ghost" onClick={() => onUnpause(botPos.id)} className="!px-1.5 !py-0.5 text-[9px]">resume</Button>
                              : <Button size="sm" variant="ghost" onClick={() => onPause(botPos.id)} className="!px-1.5 !py-0.5 text-[9px]">pause</Button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-[9.5px] text-[var(--color-muted)] mt-0.5 flex-wrap">
                            {p.stopLoss != null && (
                              <span>
                                <span className="text-[var(--color-down)]">SL</span> {p.stopLoss.toFixed(priceDigits)}
                                {slPips != null && <span className="opacity-70"> ({slPips > 0 ? '+' : ''}{slPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {p.takeProfit != null && (
                              <span>
                                <span className="text-[var(--color-up)]">TP</span> {p.takeProfit.toFixed(priceDigits)}
                                {tpPips != null && <span className="opacity-70"> ({tpPips > 0 ? '+' : ''}{tpPips.toFixed(1)}p)</span>}
                              </span>
                            )}
                            {p.usedMargin != null && <span>margin {fmtMoney(p.usedMargin)}</span>}
                            {p.openTimestamp && <span>opened {fmtAgo(p.openTimestamp)}</span>}
                            {fees !== 0 && <span>fees {fmtMoney(fees)}</span>}
                            {parsedLabel?.strategy && (
                              <span className="uppercase tracking-wide">
                                {parsedLabel.strategy}
                                {parsedLabel.conviction && <span className="opacity-70"> · {parsedLabel.conviction}</span>}
                                {parsedLabel.session && <span className="opacity-70"> · {parsedLabel.session}</span>}
                              </span>
                            )}
                            {p.label && !sourceBadge && (
                              <span className="italic truncate max-w-[80px]" title={p.label}>{p.label}</span>
                            )}
                          </div>
                          {botPos && (
                            <div className="flex items-center gap-2 text-[9.5px] mt-0.5">
                              {paused && <Badge tone="warning" className="text-[8px] px-1">PAUSED</Badge>}
                              {lastCheck && (
                                <span className="text-[var(--color-text-sub)]">
                                  <span className="text-[var(--color-muted)]">Monitor:</span> {lastCheck}
                                  {lastCheckAt && <span className="text-[var(--color-muted)]"> · {fmtAgo(lastCheckAt)}</span>}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {!loading && !info && !error && (
        <p className="t-sub text-[var(--color-muted)]">Loading account data…</p>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Market Status — which watchlist markets are tradeable right now,
// which are closed with next open time, and what the agent is doing
// during closure (crypto continues, rest goes into analysis-only mode).
// ---------------------------------------------------------------------------

const CRYPTO_RE = /^(BTC|ETH|XRP|SOL|LTC|BCH|DOT|ADA|DOGE)USD$/

function MarketStatus({ symbols }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(iv)
  }, [])

  if (!symbols || symbols.length === 0) return null

  const liveTrading = []   // open market → analyse + trade
  const analyseOnly = []   // closed market → analyse, queue orders for next open
  for (const sym of symbols) {
    if (isTradingNow(sym)) liveTrading.push(sym)
    else analyseOnly.push({ symbol: sym, msUntil: msUntilOpen(sym) })
  }
  analyseOnly.sort((a, b) => a.msUntil - b.msUntil)

  const nextOpen = analyseOnly[0]
  const cryptoLive = liveTrading.filter(s => CRYPTO_RE.test(s))
  const nonCryptoLive = liveTrading.filter(s => !CRYPTO_RE.test(s))

  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <p className="t-label">Market Status</p>
        <Badge tone={liveTrading.length > 0 ? 'up' : 'neutral'} pill>
          {liveTrading.length > 0 ? `${liveTrading.length} LIVE` : 'ALL CLOSED'}
        </Badge>
        {cryptoLive.length > 0 && <Badge tone="special" className="text-[8px] px-1">CRYPTO 24/7</Badge>}
      </div>

      {/* Crypto — always analyse + trade */}
      {cryptoLive.length > 0 && (
        <div className="mb-2">
          <p className="t-meta text-[var(--color-muted)] mb-1">
            Analyse + Trade <span className="opacity-60">(crypto — OTC, 24/7)</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {cryptoLive.map(s => (
              <span key={s} className="px-1.5 py-0.5 rounded-[4px] text-[10px] bg-[color-mix(in_srgb,var(--color-up)_15%,transparent)] text-[var(--color-up)] font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Non-crypto live markets */}
      {nonCryptoLive.length > 0 && (
        <div className="mb-2">
          <p className="t-meta text-[var(--color-muted)] mb-1">
            Analyse + Trade <span className="opacity-60">(session open)</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {nonCryptoLive.map(s => (
              <span key={s} className="px-1.5 py-0.5 rounded-[4px] text-[10px] bg-[color-mix(in_srgb,var(--color-up)_15%,transparent)] text-[var(--color-up)] font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Closed markets */}
      {analyseOnly.length > 0 && (
        <div className="mb-2">
          <p className="t-meta text-[var(--color-muted)] mb-1">
            Analyse only — orders queued for open ({analyseOnly.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {analyseOnly.slice(0, 12).map(({ symbol, msUntil }) => (
              <span
                key={symbol}
                className="px-1.5 py-0.5 rounded-[4px] text-[10px] bg-[var(--color-bg)] text-[var(--color-muted)] font-mono"
                title={`Opens in ${fmtDuration(msUntil)}`}
              >
                {symbol} <span className="opacity-60">{fmtDuration(msUntil)}</span>
              </span>
            ))}
            {analyseOnly.length > 12 && (
              <span className="px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                +{analyseOnly.length - 12} more
              </span>
            )}
          </div>
        </div>
      )}

      {nextOpen && (
        <p className="text-[9.5px] text-[var(--color-muted)] mt-1">
          Next market open: <span className="text-[var(--color-text)] font-mono">{nextOpen.symbol}</span> in {fmtDuration(nextOpen.msUntil)}
          {cryptoLive.length > 0 && ' — crypto continues uninterrupted'}
        </p>
      )}
      {liveTrading.length === 0 && (
        <p className="text-[9.5px] text-[var(--color-muted)] mt-1">
          All watchlist markets closed. Agent analyses setups and queues orders for next session open. Monitor continues on open positions.
        </p>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Team Roster Desk — per-symbol agent roster with status + timing
// ---------------------------------------------------------------------------

const ROLE_COLORS = {
  trader:    'text-[var(--color-up)]',
  journalist:'text-[var(--color-info)]',
  researcher:'text-[var(--color-accent)]',
  economist: 'text-[var(--color-warning)]',
  political: 'text-[var(--color-down)]',
}

function agentStatus(minionId, symbol, activity) {
  const analysisEvent = activity.find(r => r.kind === 'analysis' && r.symbol === symbol)
  const scanEvent = activity.find(r => r.kind === 'scan' && r.symbol === symbol)
  const latestEvent = analysisEvent || scanEvent
  if (!latestEvent) return { status: 'idle' }

  const ageMs = Date.now() - new Date(latestEvent.at).getTime()
  const ageMins = Math.round(ageMs / 60000)
  const m = MINIONS[minionId]

  if (ageMins < 3) return { status: 'active', since: ageMins, label: `${ageMins}m ago` }
  if (m?.role === 'trader' || m?.role === 'researcher') {
    return { status: 'waiting', label: 'next cycle' }
  }
  return { status: 'done', label: `${ageMins}m ago` }
}

function TeamRoster({ activity }) {
  const hotSymbols = []
  const seen = new Set()
  for (const row of activity) {
    if (row.kind === 'scan' && row.extra === 'potential' && !seen.has(row.symbol)) {
      seen.add(row.symbol)
      hotSymbols.push(row.symbol)
    }
    if (hotSymbols.length >= 6) break
  }
  for (const row of activity) {
    if (row.kind === 'analysis' && !seen.has(row.symbol)) {
      seen.add(row.symbol)
      hotSymbols.push(row.symbol)
    }
    if (hotSymbols.length >= 6) break
  }

  if (hotSymbols.length === 0) return null

  return (
    <Card>
      <p className="t-label mb-2">Team Roster Desk</p>
      <div className="space-y-2">
        {hotSymbols.map(symbol => {
          const minionIds = dispatchMinions(symbol)
          return (
            <div key={symbol} className="rounded-[5px] bg-[var(--color-bg)] overflow-hidden">
              <div className="px-2 py-1 flex items-center gap-2 border-b border-[var(--color-border)]">
                <span className="text-[12px] font-bold font-mono text-[var(--color-text)]">{symbol}</span>
                <span className="text-[9px] text-[var(--color-muted)]">{minionIds.length} agents</span>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {minionIds.map(id => {
                  const m = MINIONS[id]
                  if (!m) return null
                  const st = agentStatus(id, symbol, activity)
                  return (
                    <div key={id} className="px-2 py-1 flex items-center gap-2 text-[11px]">
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                        st.status === 'active' ? 'bg-[var(--color-up)]'
                        : st.status === 'waiting' ? 'bg-[var(--color-warning-text)]'
                        : st.status === 'done' ? 'bg-[var(--color-muted)]'
                        : 'bg-[var(--color-border)]'
                      }`} />
                      <span className="text-[13px] leading-none">{m.icon}</span>
                      <span className={`font-medium w-28 truncate ${ROLE_COLORS[m.role] || ''}`}>{m.name}</span>
                      <span className="text-[9px] text-[var(--color-muted)] uppercase w-16">{m.role}</span>
                      <span className="ml-auto text-[10px] font-mono text-[var(--color-muted)]">
                        {st.label || st.status}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[9px] text-[var(--color-muted)] mt-2">
        4-6 specialists dispatched per symbol. Hover for focus area.
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Scan Feed — dedicated panel showing scan + analysis results with desk info
// ---------------------------------------------------------------------------

function ScanFeed({ activity }) {
  const scans = activity.filter(r => r.kind === 'scan' || r.kind === 'analysis')
  if (scans.length === 0) return null

  return (
    <Card>
      <p className="t-label mb-2">Scan Feed</p>
      <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
        {scans.map((row, i) => {
          const minionIds = dispatchMinions(row.symbol)
          const deskNames = minionIds.slice(0, 3).map(id => MINIONS[id]?.name).filter(Boolean).join(', ')
          const gradeColor = row.extra === 'potential' ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-bg)] text-[var(--color-muted)] border border-[var(--color-border)]'
          const biasColor = (row.v1 === 'long') ? 'text-[var(--color-up)]'
            : (row.v1 === 'short') ? 'text-[var(--color-down)]'
            : 'text-[var(--color-muted)]'
          return (
            <div key={`${row.kind}-${row.id}-${i}`} className="rounded-[5px] bg-[var(--color-bg)] p-2 space-y-1">
              <div className="flex items-center gap-2 text-[11px]">
                {row.kind === 'scan' && (
                  <span className={`w-5 h-5 grid place-items-center rounded text-[9px] font-bold ${gradeColor}`}>
                    {row.extra === 'potential' ? 'A' : row.extra === 'weak' ? 'B' : 'C'}
                  </span>
                )}
                {row.kind === 'analysis' && (
                  <Badge tone="accent" className="text-[8px] px-1">DEEP</Badge>
                )}
                <span className="font-mono font-bold text-[var(--color-text)]">{row.symbol}</span>
                {row.v1 && <span className={`font-semibold ${biasColor}`}>{String(row.v1).toUpperCase()}</span>}
                {row.v2 != null && <span className="text-[10px] text-[var(--color-muted)] font-mono">{row.v2}/10</span>}
                {row.extra === 'potential' && row.kind === 'scan' && <Badge tone="up" className="text-[8px] px-1">TRADEABLE</Badge>}
                <span className="ml-auto text-[9px] text-[var(--color-muted)]">{fmtAgo(row.at)}</span>
              </div>
              {row.note && <p className="text-[10px] text-[var(--color-muted)] truncate">{row.note}</p>}
              <p className="text-[9px] text-[var(--color-muted)]">Desk: {deskNames}</p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// History — recent trade lifecycle events (open/close/SL/TP/cancel)
// ---------------------------------------------------------------------------

function TradeHistory({ activity, role }) {
  const [trades, setTrades] = useState([])
  useEffect(() => {
    if (!agentConfigured(role)) return
    agentGet('/state/trades', role).then(r => setTrades(r?.trades || [])).catch(() => {})
  }, [role])

  const tradeEvents = activity.filter(r => r.kind === 'trade' || r.kind === 'monitor')
  const allRows = [
    ...trades.map(t => ({
      time: t.closed_at || t.opened_at,
      action: t.status === 'closed' ? (t.close_reason === 'sl_hit' ? 'SL HIT' : t.close_reason === 'tp_hit' ? 'TP HIT' : 'CLOSE') : 'OPEN',
      sym: t.symbol,
      detail: `${t.side} ${t.volume ? (t.volume / 10000).toFixed(2) : '?'} @ ${t.entry_price || '—'}`,
      pnl: t.realized_pnl,
      desk: dispatchMinions(t.symbol).slice(0, 2).map(id => MINIONS[id]?.name).filter(Boolean).join(' + '),
      strategy: t.strategy || null,
    })),
    ...tradeEvents.map(r => ({
      time: r.at,
      action: r.kind === 'trade' ? (r.v1 === 'BUY' || r.v1 === 'SELL' ? 'OPEN' : String(r.v1).toUpperCase()) : 'MONITOR',
      sym: r.symbol,
      detail: r.note || '',
      pnl: null,
      desk: dispatchMinions(r.symbol).slice(0, 2).map(id => MINIONS[id]?.name).filter(Boolean).join(' + '),
      strategy: r.extra || null,
    })),
  ]
  allRows.sort((a, b) => new Date(b.time) - new Date(a.time))
  const unique = allRows.slice(0, 20)

  if (unique.length === 0) return null

  const actionColor = (a) => {
    if (a === 'OPEN' || a === 'TP HIT') return 'text-[var(--color-up)]'
    if (a === 'SL HIT' || a === 'CLOSE') return 'text-[var(--color-down)]'
    return 'text-[var(--color-muted)]'
  }

  return (
    <Card>
      <p className="t-label mb-2">History</p>
      <div className="space-y-1 max-h-[320px] overflow-y-auto">
        {unique.map((r, i) => (
          <div key={i} className="rounded-[5px] bg-[var(--color-bg)] px-2 py-1.5 space-y-0.5">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-[9px] text-[var(--color-muted)] w-12 shrink-0">{r.time ? new Date(r.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              <span className={`font-semibold text-[10px] w-14 ${actionColor(r.action)}`}>{r.action}</span>
              <span className="font-mono font-bold text-[var(--color-text)]">{r.sym}</span>
              <span className="text-[var(--color-muted)] text-[10px] truncate flex-1">{r.detail}</span>
              {r.pnl != null && (
                <span className={`font-mono font-semibold text-[11px] ${r.pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}`}>
                  {r.pnl >= 0 ? '+' : ''}{fmtMoney(r.pnl)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[9px] text-[var(--color-muted)]">
              {r.desk && <span>Desk: {r.desk}</span>}
              {r.strategy && <span className="uppercase">{r.strategy}</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Activity row styling
// ---------------------------------------------------------------------------

const KIND_TONE = {
  scan: 'neutral', analysis: 'accent', monitor: 'info',
  trade: 'up', regime: 'neutral', flip: 'warning',
}
const KIND_LABEL = {
  scan: 'SCAN', analysis: 'ANALYSIS', monitor: 'MONITOR',
  trade: 'TRADE', regime: 'REGIME', flip: 'FLIP',
}

function ActivityRow({ row }) {
  const biasColor = row.v1 === 'long' || row.v1 === 'BUY'
    ? 'text-[var(--color-up)]'
    : row.v1 === 'short' || row.v1 === 'SELL'
    ? 'text-[var(--color-down)]'
    : 'text-[var(--color-muted)]'
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 rounded-[5px] hover:bg-[var(--color-bg)] text-[11px]">
      <Badge tone={KIND_TONE[row.kind] || 'neutral'} className="text-[8px] px-1 shrink-0">
        {KIND_LABEL[row.kind] || row.kind.toUpperCase()}
      </Badge>
      <span className="font-bold w-[65px] shrink-0 text-[var(--color-text)]">{row.symbol}</span>
      {row.v1 && (
        <span className={`font-bold w-[52px] shrink-0 ${biasColor}`}>{String(row.v1).slice(0, 8)}</span>
      )}
      {row.v2 != null && (
        <span className="font-mono w-[32px] shrink-0 text-[var(--color-text-sub)]">
          {typeof row.v2 === 'number' ? row.v2.toFixed(1) : row.v2}
        </span>
      )}
      <span className="flex-1 min-w-0 text-[var(--color-text-sub)] truncate">
        {row.note || row.extra || ''}
      </span>
      <span className="text-[9px] text-[var(--color-muted)] shrink-0">{fmtAgo(row.at)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const ROLE_STORAGE_KEY = 'bot-trade:agent-role'

export default function Agent() {
  const { state } = useStrategy()
  // Which Railway backend to talk to. Autopilot = trades autonomously;
  // copilot = monitors user-entered trades only. Persisted so a reload keeps
  // the operator on the same cockpit.
  const [role, setRoleState] = useState(() => {
    try {
      const saved = localStorage.getItem(ROLE_STORAGE_KEY)
      if (ROLES.includes(saved)) return saved
    } catch {}
    return ROLES.find(r => agentConfigured(r)) || 'autopilot'
  })
  const setRole = (r) => {
    setRoleState(r)
    try { localStorage.setItem(ROLE_STORAGE_KEY, r) } catch {}
  }

  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [activity, setActivity] = useState([])
  const [botPositions, setBotPositions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Collapse-toggle for the activity log — persisted so operator preference
  // survives page refreshes.
  const [activityCollapsed, setActivityCollapsed] = useState(() => {
    try { return localStorage.getItem('bot-trade:activity-collapsed') === 'true' } catch { return false }
  })
  const toggleActivity = () => {
    setActivityCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('bot-trade:activity-collapsed', String(next)) } catch {}
      return next
    })
  }

  const refresh = useCallback(async () => {
    if (!agentConfigured(role)) return
    try {
      const [h, c, a, p] = await Promise.all([
        agentGet('/health', role).catch(() => null),
        agentGet('/state/config', role).catch(() => null),
        agentGet('/state/activity?limit=40', role).catch(() => ({ activity: [] })),
        agentGet('/state/positions', role).catch(() => ({ positions: [] })),
      ])
      setHealth(h); setConfig(c)
      setActivity(a?.activity || [])
      setBotPositions(p?.positions || [])
      setError(null)
    } catch (e) { setError(e.message) }
  }, [role])

  // Reset visible state the moment the operator flips roles so they never
  // see stale autopilot data bleeding into the copilot view.
  useEffect(() => {
    setHealth(null); setConfig(null); setActivity([]); setBotPositions([]); setError(null)
  }, [role])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const iv = setInterval(refresh, 10_000)
    return () => clearInterval(iv)
  }, [refresh])

  const scanOn = config?.scan_enabled !== false
  const analyzeOn = config?.analyze_enabled !== false
  const autotradeOn = config?.autotrade_enabled === true

  const toggle = async (endpoint, on) => {
    setBusy(true)
    try {
      await agentPost(endpoint, { on }, role)
      await refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const killAll = async () => {
    if (!window.confirm(`Kill switch: disarm ${role} + pause every monitored position. Proceed?`)) return
    setBusy(true)
    try { await agentPost('/actions/kill-all', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pausePos = async (id) => { try { await agentPost(`/actions/pause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }
  const unpausePos = async (id) => { try { await agentPost(`/actions/unpause-position/${id}`, undefined, role); refresh() } catch (e) { setError(e.message) } }

  // Index bot-monitored positions by their cTrader position id so the
  // AccountPanel can correlate each cTrader row with its bot thesis.
  const botById = {}
  for (const bp of botPositions) {
    if (bp.ctrader_position_id) botById[String(bp.ctrader_position_id)] = bp
  }

  const enabledSymbols = (config?.symbols || config?.watchlist || []).filter(w => w.enabled !== false)

  if (!agentConfigured('autopilot') && !agentConfigured('copilot')) {
    return (
      <Card>
        <p className="t-label mb-1">Trade Window</p>
        <p className="t-sub text-[var(--color-muted)]">
          Agent backend not configured. Set <code>VITE_AGENT_URL_AUTOPILOT</code> + <code>VITE_AGENT_SECRET_AUTOPILOT</code> (and optionally the matching <code>_COPILOT</code> pair) in Vercel, then redeploy.
        </p>
      </Card>
    )
  }

  const circuitBreaker = health?.circuitBreaker
  const resetBreaker = async () => {
    setBusy(true)
    try { await agentPost('/actions/reset-breaker', undefined, role); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const statusBadge = role === 'copilot'
    ? { tone: 'special', text: 'COPILOT STANDBY' }
    : circuitBreaker
      ? { tone: 'down', text: 'CIRCUIT BREAKER' }
      : autotradeOn
        ? { tone: 'up', text: 'AUTO-TRADE ON' }
        : analyzeOn
          ? { tone: 'accent', text: 'ANALYZE ONLY' }
          : scanOn
            ? { tone: 'neutral', text: 'SCAN ONLY' }
            : { tone: 'neutral', text: 'ALL OFF' }

  return (
    <section className="space-y-3">
      {/* Role switcher — one cockpit per Railway backend. */}
      {(agentConfigured('autopilot') || agentConfigured('copilot')) && (
        <div className="flex items-center gap-1 text-[10px]">
          {ROLES.map(r => {
            const wired = agentConfigured(r)
            const active = r === role
            return (
              <button
                key={r}
                type="button"
                onClick={() => wired && setRole(r)}
                disabled={!wired}
                className={`px-2.5 py-1 rounded-[5px] uppercase font-bold tracking-wider ${
                  active
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : wired
                    ? 'text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg)]'
                    : 'text-[var(--color-muted)] opacity-40 cursor-not-allowed'
                }`}
                title={wired ? '' : `VITE_AGENT_URL_${r.toUpperCase()} not set`}
              >
                {r}
                {!wired && <span className="ml-1 opacity-60">(off)</span>}
              </button>
            )
          })}
        </div>
      )}

      {/* Autopilot header */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-[18px] ${autotradeOn && role !== 'copilot' ? 'animate-pulse text-[var(--color-accent)]' : (scanOn || analyzeOn) && role !== 'copilot' ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}>
              {autotradeOn && role !== 'copilot' ? '●' : (scanOn || analyzeOn) ? '◐' : '○'}
            </span>
            <h1 className="t-label text-lg">Trade Window</h1>
            <Badge tone={statusBadge.tone} pill>{statusBadge.text}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={killAll} disabled={busy} className="text-[var(--color-down)]">
              Kill Switch
            </Button>
            <Link to="/workshop" className="t-meta text-[var(--color-accent)] underline self-center ml-1">
              Workshop →
            </Link>
          </div>
        </div>

        {/* Granular toggles — scan / analyze / auto-trade */}
        {role === 'autopilot' && (
          <div className="flex items-center gap-1.5 mb-3">
            <Button
              size="sm"
              variant={scanOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/scan-toggle', !scanOn)}
              disabled={busy}
              title="24/7 market scanning"
            >
              {scanOn ? '■' : '▶'} Scan
            </Button>
            <Button
              size="sm"
              variant={analyzeOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/analyze-toggle', !analyzeOn)}
              disabled={busy}
              title="Deep analysis on hot symbols + alerts"
            >
              {analyzeOn ? '■' : '▶'} Analyze
            </Button>
            <Button
              size="sm"
              variant={autotradeOn ? 'primary' : 'ghost'}
              onClick={() => toggle('/actions/autotrade-toggle', !autotradeOn)}
              disabled={busy}
              className={autotradeOn ? '!bg-[var(--color-up)] !border-[var(--color-up)] !text-white' : ''}
              title="Auto-place orders when conviction passes threshold"
            >
              {autotradeOn ? '■' : '▶'} Trade
            </Button>
          </div>
        )}

        {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

        {circuitBreaker && (
          <div className="mb-3 px-3 py-2 rounded-[5px] bg-[color-mix(in_srgb,var(--color-down)_15%,transparent)] border border-[var(--color-down)]">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--color-down)] font-bold">CIRCUIT BREAKER TRIPPED</span>
              <span className="text-[var(--color-muted)]">·</span>
              <span className="text-[var(--color-text-sub)]">{fmtAgo(circuitBreaker)}</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={resetBreaker} disabled={busy} className="text-[var(--color-accent)]">
                Reset
              </Button>
            </div>
            {health?.lastError && (
              <p className="text-[9.5px] text-[var(--color-text-sub)] mt-1 truncate">{health.lastError}</p>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <p className="t-meta text-[var(--color-muted)]">Loops</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{health?.loopCount ?? '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Last Scan</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{fmtAgo(health?.lastScanAt) || '—'}</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Symbols</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{enabledSymbols.length} configured</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Bot Positions</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{botPositions.length} open</p>
          </div>
        </div>
        {health && (
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mt-2 text-[9.5px]">
            <div>
              <p className="text-[var(--color-muted)]">Loop Time</p>
              <p className="font-mono text-[var(--color-text)]">{health.lastLoopMs ? `${(health.lastLoopMs / 1000).toFixed(1)}s` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Uptime</p>
              <p className="font-mono text-[var(--color-text)]">{health.uptime ? `${(health.uptime / 3600).toFixed(1)}h` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Memory</p>
              <p className="font-mono text-[var(--color-text)]">{health.memoryMB ? `${health.memoryMB}MB` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">DB Size</p>
              <p className="font-mono text-[var(--color-text)]">{health.dbSizeMB ? `${health.dbSizeMB}MB` : '—'}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Errors Today</p>
              <p className={`font-mono ${health.errorsToday > 0 ? 'text-[var(--color-down)]' : 'text-[var(--color-text)]'}`}>{health.errorsToday ?? 0}</p>
            </div>
            <div>
              <p className="text-[var(--color-muted)]">Open Trades</p>
              <p className="font-mono text-[var(--color-text)]">{health.openTrades ?? 0}</p>
            </div>
          </div>
        )}
      </Card>

      {/* Market status — which watchlist markets are live vs closed */}
      <MarketStatus symbols={enabledSymbols.map(s => s.symbol || s).filter(Boolean)} />

      {/* Team roster desk — per-agent status + timing */}
      <TeamRoster activity={activity} />

      {/* Scan feed — dedicated scan + analysis results with desk info */}
      <ScanFeed activity={activity} />

      {/* cTrader account + positions with bot context */}
      <AccountPanel
        ctrader={state.ctrader}
        botPositionsById={botById}
        onPause={pausePos}
        onUnpause={unpausePos}
      />

      {/* Trade history — open/close/SL/TP lifecycle events */}
      <TradeHistory activity={activity} role={role} />

      {/* Live activity stream */}
      <Card>
        <button
          type="button"
          onClick={toggleActivity}
          className="w-full flex items-center gap-2 mb-2 text-left hover:opacity-80"
          title={activityCollapsed ? 'Expand activity log' : 'Collapse activity log'}
        >
          <span className="text-[10px] text-[var(--color-muted)] w-3">
            {activityCollapsed ? '▸' : '▾'}
          </span>
          <p className="t-label flex-1">Live Activity</p>
          <span className="text-[9px] text-[var(--color-muted)]">
            {activity.length} events · auto-refresh 10s
          </span>
        </button>
        {!activityCollapsed && (
          <>
            {activity.length === 0 ? (
              <p className="t-sub text-[var(--color-muted)] py-4 text-center">
                No events yet. The loop scans every 5 min — first activity should appear shortly after autopilot is engaged.
              </p>
            ) : (
              <div className="space-y-0.5 max-h-[520px] overflow-y-auto">
                {activity.map((row, i) => (
                  <ActivityRow key={`${row.kind}-${row.id}-${i}`} row={row} />
                ))}
              </div>
            )}
            <div className="mt-2 pt-2 border-t border-[var(--color-border)] flex items-center justify-between">
              <span className="text-[9px] text-[var(--color-muted)]">
                Drill into any analysis, trade, or monitor check in the Workshop.
              </span>
              <Link to="/workshop" className="text-[10px] text-[var(--color-accent)] underline">
                Workshop →
              </Link>
            </div>
          </>
        )}
      </Card>
    </section>
  )
}
