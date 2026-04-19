import { useState, useEffect } from 'react'
import { agentGet, agentConfigured } from '../../lib/agent-api.js'
import { fmtAgo, parseSqliteTs } from '../../lib/time.js'

function fmtDate(ts) {
  const d = parseSqliteTs(ts)
  if (!d) return '--'
  const mon = d.toLocaleString('en-US', { month: 'short' })
  const day = d.getDate()
  return `${mon} ${day}`
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  const n = Number(v)
  const prefix = n >= 0 ? '+$' : '-$'
  return prefix + Math.abs(n).toFixed(2)
}

function fmtMoneyPlain(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return '$' + Math.abs(Number(v)).toFixed(2)
}

export default function Step5Close({ role }) {
  const [attribution, setAttribution] = useState(null)
  const [riskEvents, setRiskEvents] = useState([])
  const [trades, setTrades] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!agentConfigured(role)) return
    let active = true
    const load = () => {
      agentGet('/state/attribution?groupBy=source&days=30', role)
        .then(r => { if (active) setAttribution(r) })
        .catch(() => {})
      agentGet('/state/risk-events?limit=10', role)
        .then(r => { if (active) setRiskEvents(r?.events || []) })
        .catch(() => {})
      agentGet('/state/trades', role)
        .then(r => { if (active) { setTrades(r?.trades || []); setError(null) } })
        .catch(e => { if (active) setError(e.message) })
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => { active = false; clearInterval(iv) }
  }, [role])

  // Compute 30d summary from attribution rows
  const rows = attribution?.rows || []
  const totalTrades = rows.reduce((s, r) => s + (r.trades || 0), 0)
  const totalWins = rows.reduce((s, r) => s + (r.wins || 0), 0)
  const totalPnl = rows.reduce((s, r) => s + (r.total_pnl || 0), 0)
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '--'
  const totalGrossWin = rows.reduce((s, r) => s + (r.gross_win || 0), 0)
  const totalGrossLoss = rows.reduce((s, r) => s + Math.abs(r.gross_loss || 0), 0)
  const profitFactor = totalGrossLoss > 0 ? (totalGrossWin / totalGrossLoss).toFixed(2) : totalGrossWin > 0 ? 'inf' : '--'
  const avgWin = rows.reduce((s, r) => s + (r.avg_win || 0), 0)
  const avgLoss = rows.reduce((s, r) => s + (r.avg_loss || 0), 0)
  const avgWinDisplay = totalWins > 0 && avgWin ? fmtMoneyPlain(avgWin / rows.filter(r => r.avg_win).length) : '--'
  const totalLosses = totalTrades - totalWins
  const avgLossDisplay = totalLosses > 0 && avgLoss ? fmtMoneyPlain(avgLoss / rows.filter(r => r.avg_loss).length) : '--'

  // Closed trades
  const closedTrades = trades
    .filter(t => t.status === 'closed')
    .sort((a, b) => new Date(b.closed_at || b.opened_at || 0) - new Date(a.closed_at || a.opened_at || 0))
    .slice(0, 20)

  // Vetoes: risk events where approved=false
  const vetoes = riskEvents.filter(e => e.approved === false || e.approved === 0)

  return (
    <section style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text)' }}>
      <div style={{ marginBottom: 4, fontWeight: 'bold', fontSize: 12, letterSpacing: '0.05em' }}>
        {'>_ STEP 5  CLOSE'}
      </div>
      <div style={{ borderTop: '1px solid var(--color-border)', marginBottom: 8 }} />

      {error && (
        <div style={{ color: 'var(--color-down)', marginBottom: 4, fontSize: 10 }}>[ERR] {error}</div>
      )}

      {/* 30D SUMMARY */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 4 }}>30D SUMMARY:</div>
        {totalTrades > 0 ? (
          <div style={{ paddingLeft: 8 }}>
            <span>Trades: <span style={{ fontWeight: 'bold' }}>{totalTrades}</span></span>
            {'  '}
            <span>Win: <span style={{ fontWeight: 'bold', color: 'var(--color-up)' }}>{winRate}%</span></span>
            {'  '}
            <span>PF: <span style={{ fontWeight: 'bold' }}>{profitFactor}</span></span>
            {'  '}
            <span>P&L: <span style={{ fontWeight: 'bold', color: totalPnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{fmtMoney(totalPnl)}</span></span>
            {'  '}
            <span>Avg W: <span style={{ color: 'var(--color-up)' }}>{avgWinDisplay}</span></span>
            {'  '}
            <span>Avg L: <span style={{ color: 'var(--color-down)' }}>{avgLossDisplay}</span></span>
          </div>
        ) : (
          <div style={{ paddingLeft: 8, color: 'var(--color-muted)' }}>No attribution data.</div>
        )}
      </div>

      {/* CLOSED POSITIONS */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 4 }}>CLOSED POSITIONS:</div>
        {closedTrades.length === 0 ? (
          <div style={{ paddingLeft: 8, color: 'var(--color-muted)' }}>No closed trades.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ color: 'var(--color-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '2px 6px 2px 0', fontWeight: 'normal' }}>DATE</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SYM</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SIDE</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>P&L</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>REASON</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>STRATEGY</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>CONV</th>
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((t, i) => {
                  const side = (t.side || '').toUpperCase() === 'LONG' ? 'BUY'
                    : (t.side || '').toUpperCase() === 'SHORT' ? 'SELL'
                    : (t.side || '').toUpperCase()
                  const pnl = t.net_pnl ?? t.gross_pnl ?? t.realized_pnl ?? null
                  const reason = (t.close_reason || '--').toUpperCase().replace(/_/g, ' ')
                  const strategy = t.label_strategy || t.strategy || '--'
                  const conviction = t.label_conviction ?? t.conviction ?? null
                  const convDisplay = conviction != null ? `${conviction}/10` : '--'

                  return (
                    <tr key={t.id || i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap', color: 'var(--color-muted)' }}>
                        {fmtDate(t.closed_at || t.opened_at)}
                      </td>
                      <td style={{ padding: '3px 6px', fontWeight: 'bold' }}>{t.symbol || '--'}</td>
                      <td style={{ padding: '3px 6px', color: side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                        {side || '--'}
                      </td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', fontWeight: 'bold', color: pnl != null && pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                        {pnl != null ? fmtMoney(pnl) : '--'}
                      </td>
                      <td style={{ padding: '3px 6px', color: 'var(--color-muted)' }}>{reason}</td>
                      <td style={{ padding: '3px 6px' }}>{strategy}</td>
                      <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--color-muted)' }}>{convDisplay}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* VETOES */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ color: 'var(--color-muted)', fontWeight: 'bold', marginBottom: 4 }}>VETOES:</div>
        {vetoes.length === 0 ? (
          <div style={{ paddingLeft: 8, color: 'var(--color-muted)' }}>No vetoes.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
              <thead>
                <tr style={{ color: 'var(--color-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '2px 6px 2px 0', fontWeight: 'normal' }}>DATE</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SYM</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SIDE</th>
                  <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>REASON</th>
                </tr>
              </thead>
              <tbody>
                {vetoes.map((e, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap', color: 'var(--color-muted)' }}>
                      {fmtDate(e.created_at)}
                    </td>
                    <td style={{ padding: '3px 6px', fontWeight: 'bold' }}>{e.symbol || '--'}</td>
                    <td style={{ padding: '3px 6px', color: (e.side || '').toUpperCase() === 'BUY' || (e.side || '').toUpperCase() === 'LONG' ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                      {(e.side || '--').toUpperCase()}
                    </td>
                    <td style={{ padding: '3px 6px', color: 'var(--color-down)' }}>{e.veto_reason || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 4 }} />
    </section>
  )
}
