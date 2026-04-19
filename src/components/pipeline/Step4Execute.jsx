import { useState, useEffect } from 'react'
import { agentGet, agentConfigured } from '../../lib/agent-api.js'
import { fmtAgo, parseSqliteTs } from '../../lib/time.js'
import { parseLabel } from '../../../agent/lib/trade-labels.js'

const SOURCE_LABEL = {
  autopilot: 'AUTOPILOT',
  copilot:   'COPILOT',
  manual:    'MANUAL',
  external:  'EXTERNAL',
}

function fmtDate(ts) {
  const d = parseSqliteTs(ts)
  if (!d) return '--'
  const mon = d.toLocaleString('en-US', { month: 'short' })
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${mon} ${day} ${hh}:${mm}`
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return Number(v).toFixed(String(v).includes('.') ? Math.max(2, String(v).split('.')[1]?.length || 2) : 2)
}

export default function Step4Execute({ role }) {
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

  // Filter trades opened within last 7 days, sort newest first, limit 20
  const now = Date.now()
  const sevenDays = 7 * 86_400_000
  const recent = trades
    .filter(t => {
      const d = parseSqliteTs(t.opened_at)
      return d && (now - d.getTime()) < sevenDays
    })
    .sort((a, b) => new Date(b.opened_at || 0) - new Date(a.opened_at || 0))
    .slice(0, 20)

  return (
    <section style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text)' }}>
      <div style={{ marginBottom: 4, fontWeight: 'bold', fontSize: 12, letterSpacing: '0.05em' }}>
        {'>_ STEP 4  EXECUTION LOG'}
      </div>
      <div style={{ borderTop: '1px solid var(--color-border)', marginBottom: 4 }} />

      {error && (
        <div style={{ color: 'var(--color-down)', marginBottom: 4, fontSize: 10 }}>[ERR] {error}</div>
      )}

      {recent.length === 0 ? (
        <div style={{ color: 'var(--color-muted)', padding: '8px 0' }}>No executions yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
            <thead>
              <tr style={{ color: 'var(--color-muted)', textAlign: 'left' }}>
                <th style={{ padding: '2px 6px 2px 0', fontWeight: 'normal' }}>TIME</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SYM</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SIDE</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>LOTS</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal', textAlign: 'right' }}>FILL</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>STRATEGY</th>
                <th style={{ padding: '2px 6px', fontWeight: 'normal' }}>SOURCE</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((t, i) => {
                const side = (t.side || '').toUpperCase() === 'LONG' ? 'BUY'
                  : (t.side || '').toUpperCase() === 'SHORT' ? 'SELL'
                  : (t.side || '').toUpperCase()
                const lots = t.volume != null ? (t.volume / 10000).toFixed(2) : '--'
                const label = parseLabel(t.label)
                const strategy = t.label_strategy || t.strategy || label.strategy || '--'
                const source = t.source || label.source || '--'
                const sourceDisplay = SOURCE_LABEL[source] || source.toUpperCase()

                return (
                  <tr key={t.id || i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '3px 6px 3px 0', whiteSpace: 'nowrap', color: 'var(--color-muted)' }}>
                      {fmtDate(t.opened_at)}
                    </td>
                    <td style={{ padding: '3px 6px', fontWeight: 'bold' }}>{t.symbol || '--'}</td>
                    <td style={{ padding: '3px 6px', color: side === 'BUY' ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 'bold' }}>
                      {side || '--'}
                    </td>
                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{lots}</td>
                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>{fmtPrice(t.entry_price)}</td>
                    <td style={{ padding: '3px 6px', color: 'var(--color-text)' }}>{strategy}</td>
                    <td style={{ padding: '3px 6px', color: 'var(--color-muted)' }}>{sourceDisplay}</td>
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
