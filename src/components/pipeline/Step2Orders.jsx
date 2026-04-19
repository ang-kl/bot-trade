import { useState, useEffect } from 'react'
import { agentGet, agentConfigured } from '../../lib/agent-api.js'
import { fmtAgo, parseSqliteTs } from '../../lib/time.js'

function fmtTime24(ts) {
  const d = parseSqliteTs(ts)
  if (!d) return '--:--:--'
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return Number(v).toFixed(String(v).includes('.') ? Math.max(2, String(v).split('.')[1]?.length || 2) : 2)
}

function statusText(trade) {
  if (trade.status === 'closed') {
    if (trade.close_reason === 'sl_hit') return 'SL HIT'
    if (trade.close_reason === 'tp_hit') return 'TP HIT'
    if (trade.close_reason === 'cancelled') return 'CANCELLED'
    return 'CLOSED'
  }
  if (trade.status === 'pending') return 'PENDING'
  if (trade.status === 'open') return 'FILLED'
  return (trade.status || 'UNKNOWN').toUpperCase()
}

export default function Step2Orders({ role }) {
  const [trades, setTrades] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!agentConfigured(role)) return
    let active = true
    const load = () => {
      agentGet('/state/trades', role)
        .then(r => { if (active) { setTrades(r?.trades || []); setError(null) } })
        .catch(e => { if (active) setError(e.message) })
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => { active = false; clearInterval(iv) }
  }, [role])

  // Show most recent 20, sorted newest first
  const sorted = [...trades]
    .sort((a, b) => new Date(b.opened_at || 0) - new Date(a.opened_at || 0))
    .slice(0, 20)

  const sideColor = (s) =>
    s === 'BUY' || s === 'long' ? 'color: var(--color-up)' : 'color: var(--color-down)'

  return (
    <section style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text)' }}>
      <div style={{ marginBottom: 4, fontWeight: 'bold', fontSize: 12, letterSpacing: '0.05em' }}>
        {'>_ STEP 2  ORDER TRAIL'}
      </div>
      <div style={{ borderTop: '1px solid var(--color-border)', marginBottom: 4 }} />

      {error && (
        <div style={{ color: 'var(--color-down)', marginBottom: 4, fontSize: 10 }}>[ERR] {error}</div>
      )}

      {sorted.length === 0 ? (
        <div style={{ color: 'var(--color-muted)', padding: '8px 0' }}>No orders placed yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ color: 'var(--color-muted)', textAlign: 'left' }}>
                <th style={{ padding: '2px 6px 2px 0', fontWeight: 'normal' }}>TIME</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SYM</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SIDE</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>TYPE</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>LOTS</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>ENTRY</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>SL</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>TP</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const side = (t.side || '').toUpperCase() === 'LONG' ? 'BUY'
                  : (t.side || '').toUpperCase() === 'SHORT' ? 'SELL'
                  : (t.side || '').toUpperCase()
                const lots = t.volume != null ? (t.volume / 10000).toFixed(2) : '--'
                const orderType = t.order_type
                  ? t.order_type.toUpperCase()
                  : t.entry_price ? 'MARKET' : '--'
                const st = statusText(t)
                const stColor = st === 'FILLED' || st === 'TP HIT'
                  ? 'var(--color-up)'
                  : st === 'SL HIT' || st === 'CANCELLED'
                  ? 'var(--color-down)'
                  : st === 'PENDING'
                  ? 'var(--color-muted)'
                  : 'var(--color-text)'

                return (
                  <tr key={t.id || i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap', color: 'var(--color-muted)' }}>
                      {fmtTime24(t.opened_at)}
                    </td>
                    <td style={{ padding: '3px 6px', fontWeight: 'bold' }}>{t.symbol || '--'}</td>
                    <td style={{ padding: '3px 6px', color: side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                      {side || '--'}
                    </td>
                    <td style={{ padding: '3px 6px', color: 'var(--color-muted)' }}>{orderType}</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{lots}</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{fmtPrice(t.entry_price)}</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-down)' }}>
                      {fmtPrice(t.stop_loss ?? t.current_sl)}
                    </td>
                    <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-up)' }}>
                      {fmtPrice(t.take_profit ?? t.current_tp)}
                    </td>
                    <td style={{ padding: '3px 6px', color: stColor, fontWeight: 'bold' }}>{st}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 4 }} />
    </section>
  )
}
