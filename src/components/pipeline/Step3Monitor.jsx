import { useState, useEffect } from 'react'
import { agentGet, agentPost, agentConfigured } from '../../lib/agent-api.js'
import { fmtAgo, parseSqliteTs } from '../../lib/time.js'
import AccountPanel from '../AccountPanel.jsx'

const SCAN_CACHE_KEY = 'bot-trade:scan-cache'
function readPriceCache() {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY)
    if (!raw) return {}
    return JSON.parse(raw).massiveMetrics || {}
  } catch { return {} }
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return Number(v).toFixed(String(v).includes('.') ? Math.max(2, String(v).split('.')[1]?.length || 2) : 2)
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  const n = Number(v)
  const prefix = n >= 0 ? '+$' : '-$'
  return prefix + Math.abs(n).toFixed(2)
}

function fmtAge(ts) {
  const d = parseSqliteTs(ts)
  if (!d) return '--'
  const ms = Date.now() - d.getTime()
  if (ms < 60_000) return '<1m'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm'
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return h + 'h' + (m > 0 ? m + 'm' : '')
  }
  return Math.floor(ms / 86_400_000) + 'd'
}

function computePnl(position, priceCache) {
  const mm = priceCache[position.symbol] || priceCache[position.symbolName] || {}
  const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
  if (!currentPrice || !position.entry_price || !position.volume) return null
  const volLots = position.volume / 10000
  const side = (position.side || '').toUpperCase()
  const direction = side === 'BUY' || side === 'LONG' ? 1 : -1
  const sym = position.symbol || position.symbolName || ''
  const contractSize = sym.startsWith('XAU') ? 100
    : sym.startsWith('XAG') ? 5000
    : sym.match(/^(US|NAS|GER|UK|JPN|FRA|SPA|HK|AUS)/) ? 1
    : 100000
  return direction * (currentPrice - position.entry_price) * volLots * contractSize
}

export default function Step3Monitor({ role, health, botPositions, ctrader, botById, onPause, onUnpause }) {
  const [brokerData, setBrokerData] = useState(null)
  const [brokerError, setBrokerError] = useState(null)

  useEffect(() => {
    if (!agentConfigured(role)) return
    let active = true
    const load = () => {
      agentGet('/state/broker-orders', role)
        .then(r => { if (active) { setBrokerData(r); setBrokerError(null) } })
        .catch(e => { if (active) setBrokerError(e.message) })
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => { active = false; clearInterval(iv) }
  }, [role])

  const priceCache = readPriceCache()
  const positions = botPositions || []
  const ext = brokerData?.externalPositions || []
  const pend = brokerData?.pendingOrders || []
  const syncedCount = positions.length
  const extCount = ext.length
  const pendCount = pend.length

  const apis = [
    { key: 'anthropic', label: 'Claude' },
    { key: 'polygon',   label: 'Polygon' },
    { key: 'ctrader',   label: 'cTrader' },
  ]

  return (
    <section style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text)' }}>
      <div style={{ marginBottom: 4, fontWeight: 'bold', fontSize: 12, letterSpacing: '0.05em' }}>
        {'>_ STEP 3  MONITOR'}
      </div>
      <div style={{ borderTop: '1px solid var(--color-border)', marginBottom: 8 }} />

      {/* ACTIVE POSITIONS */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 4 }}>ACTIVE POSITIONS:</div>
        {positions.length === 0 ? (
          <div style={{ color: 'var(--color-muted)', padding: '4px 0' }}>No active positions.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ color: 'var(--color-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '2px 6px 2px 0', fontWeight: 'normal' }}>SYM</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SIDE</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>ENTRY</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>CURRENT</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>SL</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>TP</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>P&L</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>ACTION</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>AGE</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((bp, i) => {
                  const sym = bp.symbol || bp.symbolName || '--'
                  const side = (bp.side || '').toUpperCase()
                  const displaySide = side === 'LONG' ? 'BUY' : side === 'SHORT' ? 'SELL' : side
                  const mm = priceCache[sym] || {}
                  const currentPrice = mm.currentPrice ?? mm.price ?? mm.vwap ?? null
                  const pnl = computePnl(bp, priceCache)
                  const action = (bp.last_check_action || bp.status || 'HOLD').toUpperCase()
                  const actionColor = action === 'HOLD' ? 'var(--color-muted)'
                    : action === 'CLOSE' ? 'var(--color-down)'
                    : 'var(--color-text)'
                  const isPaused = bp.status === 'paused'

                  return [
                    <tr key={bp.id || i} style={{ borderBottom: bp.thesis ? 'none' : '1px solid var(--color-border)' }}>
                      <td style={{ padding: '3px 6px 3px 0', fontWeight: 'bold' }}>{sym}</td>
                      <td style={{ padding: '3px 6px', color: displaySide === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                        {displaySide || '--'}
                      </td>
                      <td style={{ padding: '3px 6px', textAlign: 'right' }}>{fmtPrice(bp.entry_price)}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right' }}>{currentPrice != null ? fmtPrice(currentPrice) : '--'}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-down)' }}>{fmtPrice(bp.current_sl)}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-up)' }}>{fmtPrice(bp.current_tp)}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', color: pnl != null && pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                        {pnl != null ? fmtMoney(pnl) : '--'}
                      </td>
                      <td style={{ padding: '3px 6px', color: actionColor, fontWeight: 'bold' }}>
                        {isPaused ? '[PAUSED]' : `[${action}]`}
                      </td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-muted)' }}>
                        {fmtAge(bp.opened_at)}
                      </td>
                    </tr>,
                    <tr key={(bp.id || i) + '-detail'} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td colSpan={9} style={{ padding: '0 6px 4px 12px', color: 'var(--color-muted)', fontSize: 10 }}>
                        {bp.thesis ? `thesis: ${bp.thesis}` : ''}
                        {bp.mfe_r != null ? ` | MFE ${bp.mfe_r >= 0 ? '+' : ''}${Number(bp.mfe_r).toFixed(1)}R` : ''}
                        {bp.mae_r != null ? `  MAE ${bp.mae_r >= 0 ? '+' : ''}${Number(bp.mae_r).toFixed(1)}R` : ''}
                        {'  '}
                        {bp.id && (
                          isPaused
                            ? <button
                                type="button"
                                onClick={() => onUnpause && onUnpause(bp.id)}
                                style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--color-up)', background: 'none', border: '1px solid var(--color-up)', cursor: 'pointer', padding: '0 4px', marginLeft: 4 }}
                              >[UNPAUSE]</button>
                            : <button
                                type="button"
                                onClick={() => onPause && onPause(bp.id)}
                                style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--color-down)', background: 'none', border: '1px solid var(--color-down)', cursor: 'pointer', padding: '0 4px', marginLeft: 4 }}
                              >[PAUSE]</button>
                        )}
                      </td>
                    </tr>
                  ]
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* BROKER SYNC */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 2 }}>
          BROKER SYNC (last: {brokerData?.lastReconcileAt ? fmtAgo(brokerData.lastReconcileAt) : '--'}):
        </div>
        {brokerError ? (
          <div style={{ color: 'var(--color-down)', fontSize: 10, paddingLeft: 8 }}>[ERR] {brokerError}</div>
        ) : (
          <div style={{ paddingLeft: 8, color: 'var(--color-muted)' }}>
            {syncedCount} positions synced | {extCount} external | {pendCount} pending
          </div>
        )}
      </div>

      {/* ACCOUNT */}
      {ctrader && ctrader.accessToken && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 4 }}>ACCOUNT:</div>
          <AccountPanel ctrader={ctrader} botPositionsById={botById || {}} onPause={onPause} onUnpause={onUnpause} />
        </div>
      )}

      {/* API STATUS */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 2 }}>API:</div>
        <div style={{ paddingLeft: 8 }}>
          {health?.apis ? (
            apis.map(a => {
              const info = health.apis[a.key] || {}
              const ok = !!info.lastCall
              const hasErr = !!info.lastError
              const status = hasErr ? '[ERR]' : ok ? '[OK]' : '[--]'
              const statusColor = hasErr ? 'var(--color-down)' : ok ? 'var(--color-up)' : 'var(--color-muted)'
              const ago = info.lastCall ? fmtAgo(info.lastCall) : '--'
              return (
                <span key={a.key} style={{ marginRight: 16 }}>
                  {a.label}{' '}
                  <span style={{ color: statusColor, fontWeight: 'bold' }}>{status}</span>{' '}
                  <span style={{ color: 'var(--color-muted)' }}>{ago}</span>
                </span>
              )
            })
          ) : (
            <span style={{ color: 'var(--color-muted)' }}>No API health data.</span>
          )}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 4 }} />
    </section>
  )
}
