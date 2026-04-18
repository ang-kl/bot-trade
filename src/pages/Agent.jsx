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
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import { parseLabel } from '../../agent/lib/trade-labels.js'

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

function fmtAgo(ts) {
  if (!ts) return ''
  const t = typeof ts === 'number' ? ts : new Date(ts).getTime()
  if (!Number.isFinite(t)) return ''
  const ago = Date.now() - t
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
  return `${Math.floor(ago / 3_600_000)}h ${Math.floor((ago % 3_600_000) / 60_000)}m ago`
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

  const linked = ctrader.accounts.find(a => a.accountId === ctrader.linkedAccountId)
  const isLive = linked?.isLive ?? false

  const refresh = useCallback(async () => {
    if (!ctrader.linkedAccountId || !ctrader.accessToken) return
    setLoading(true); setError(null)
    try {
      const [inf, pos] = await Promise.all([
        fetchAccountInfo(ctrader.accessToken, ctrader.linkedAccountId, isLive),
        fetchOpenPositions(ctrader.accessToken, ctrader.linkedAccountId, isLive),
      ])
      setInfo(inf); setPositions(pos)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [ctrader.accessToken, ctrader.linkedAccountId, isLive])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const iv = setInterval(refresh, 60_000)
    return () => clearInterval(iv)
  }, [refresh])

  if (!ctrader.linkedAccountId) {
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
          {linked && (
            <span className="text-[10px] text-[var(--color-muted)]">
              #{linked.accountNumber || ctrader.linkedAccountId}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="!px-1.5 !py-0.5 text-[10px]">
          {loading ? '…' : '↻'}
        </Button>
      </div>

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

      {positions?.positions?.length > 0 && (() => {
        const priceCache = readPriceCache()
        return (
          <div>
            <p className="t-meta text-[var(--color-muted)] mb-1">Open Positions</p>
            <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
              {positions.positions.map((p, i) => {
                const sym = p.symbolName || `#${p.symbolId}`
                const volLots = p.volume != null ? p.volume / 10000 : null
                const isGold = (p.symbolName || '').startsWith('XAU')
                const ozDisplay = isGold && volLots != null ? ` (${(volLots * 100).toFixed(2)} Oz)` : ''
                const priceDigits = (p.symbolName || '').endsWith('JPY') ? 3 : isGold ? 2 : 5
                const pnl = computePnl(p, priceCache)
                const slPips = pipDist(p.openPrice, p.stopLoss, p.symbolName)
                const tpPips = pipDist(p.openPrice, p.takeProfit, p.symbolName)
                const fees = (p.swap || 0) + (p.commission || 0)
                // Decode the structured cTrader label so we can show a
                // provenance badge. Legacy / unstructured labels fall back
                // to the raw string display.
                const parsedLabel = p.label ? parseLabel(p.label) : null
                const sourceBadge = parsedLabel?.source ? SOURCE_BADGE[parsedLabel.source] : null
                // Match this cTrader position to a bot-monitored position (by ctrader_position_id).
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
      })()}

      {!loading && !info && !error && (
        <p className="t-sub text-[var(--color-muted)]">Loading account data…</p>
      )}
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

export default function Agent() {
  const { state } = useStrategy()
  const [health, setHealth] = useState(null)
  const [config, setConfig] = useState(null)
  const [activity, setActivity] = useState([])
  const [botPositions, setBotPositions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!agentConfigured) return
    try {
      const [h, c, a, p] = await Promise.all([
        agentGet('/health').catch(() => null),
        agentGet('/state/config').catch(() => null),
        agentGet('/state/activity?limit=40').catch(() => ({ activity: [] })),
        agentGet('/state/positions').catch(() => ({ positions: [] })),
      ])
      setHealth(h); setConfig(c)
      setActivity(a?.activity || [])
      setBotPositions(p?.positions || [])
      setError(null)
    } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const iv = setInterval(refresh, 10_000)
    return () => clearInterval(iv)
  }, [refresh])

  const on = config?.armed === true
  const toggleAutopilot = async () => {
    setBusy(true)
    try {
      await agentPost('/actions/autopilot', { on: !on })
      await refresh()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const killAll = async () => {
    if (!window.confirm('Kill switch: disarm autopilot + pause every monitored position. Proceed?')) return
    setBusy(true)
    try { await agentPost('/actions/kill-all'); await refresh() }
    catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  const pausePos = async (id) => { try { await agentPost(`/actions/pause-position/${id}`); refresh() } catch (e) { setError(e.message) } }
  const unpausePos = async (id) => { try { await agentPost(`/actions/unpause-position/${id}`); refresh() } catch (e) { setError(e.message) } }

  // Index bot-monitored positions by their cTrader position id so the
  // AccountPanel can correlate each cTrader row with its bot thesis.
  const botById = {}
  for (const bp of botPositions) {
    if (bp.ctrader_position_id) botById[String(bp.ctrader_position_id)] = bp
  }

  const enabledWatchlist = config?.watchlist?.filter(w => w.enabled !== false) || []

  if (!agentConfigured) {
    return (
      <Card>
        <p className="t-label mb-1">Trade Window</p>
        <p className="t-sub text-[var(--color-muted)]">
          Agent backend not configured. Set <code>VITE_AGENT_URL</code> and <code>VITE_AGENT_SECRET</code> in Vercel, then redeploy.
        </p>
      </Card>
    )
  }

  return (
    <section className="space-y-3">
      {/* Autopilot header */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className={`text-[18px] ${on ? 'animate-pulse text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}>
              {on ? '●' : '○'}
            </span>
            <h1 className="t-label text-lg">Trade Window</h1>
            <Badge tone={on ? 'up' : 'neutral'} pill>{on ? 'AUTOPILOT ON' : 'AUTOPILOT OFF'}</Badge>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={on ? 'ghost' : 'primary'}
              onClick={toggleAutopilot}
              disabled={busy}
            >
              {on ? 'Pause All' : 'Engage'}
            </Button>
            <Button size="sm" variant="ghost" onClick={killAll} disabled={busy} className="text-[var(--color-down)]">
              Kill Switch
            </Button>
            <Link to="/workshop" className="t-meta text-[var(--color-accent)] underline self-center ml-1">
              Open Workshop →
            </Link>
          </div>
        </div>

        {error && <p className="text-[10px] text-[var(--color-down)] mb-2">{error}</p>}

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
            <p className="t-meta text-[var(--color-muted)]">Watchlist</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{enabledWatchlist.length} symbols</p>
          </div>
          <div>
            <p className="t-meta text-[var(--color-muted)]">Bot Positions</p>
            <p className="text-[13px] font-bold text-[var(--color-text)]">{botPositions.length} open</p>
          </div>
        </div>
      </Card>

      {/* cTrader account + positions with bot context */}
      <AccountPanel
        ctrader={state.ctrader}
        botPositionsById={botById}
        onPause={pausePos}
        onUnpause={unpausePos}
      />

      {/* Live activity stream */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <p className="t-label flex-1">Live Activity</p>
          <span className="text-[9px] text-[var(--color-muted)]">
            {activity.length} events · auto-refresh 10s
          </span>
        </div>
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
      </Card>
    </section>
  )
}
