// W3 — the capped hybrid's verdict for each open position (half at 2R).
// Claude · № 13,362 12-Oct (ordered after № 13,350, owner "W1 W2 W3 W4 W11";
// docs/instruction-2026-10-12-decisions.md W3; claude-builder).
// Reads GET /state/capped-hybrid. Read-only: no control on this card. A
// missing pass record reads "not available" on every line, never an empty,
// healthy-looking list (owner principle 6).
import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from '../lib/agent-api.js'
import { verdictLine, reasonWords } from '../lib/hybrid-verdict-words.js'
import Card from './common/Card.jsx'

const ORDER = ['enrolled', 'delegated', 'deferred', 'error', 'excluded', 'not_in_last_pass', 'not_available']
const fmtAge = ms => (ms == null ? 'age not recorded' : ms < 120_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`)

function passSentence(status) {
  if (!status.available) return `Capped hybrid: not available (${reasonWords(status.unavailableReason) ?? 'no pass record'}).`
  const p = status.pass || {}
  return `Capped hybrid: last pass ${p.at ?? 'not recorded'} (${fmtAge(p.ageMs)})${p.ok ? '' : ', which reported a failure'}; ${p.activePlans ?? 0} active plan(s).`
}

export function CappedHybridReading({ status, error }) {
  if (!status) return <p role="status">Capped hybrid status unavailable{error ? `: ${error}` : '.'}</p>
  // One row per Open positions row (an active monitor); a monitor may have no
  // linked trade, so the monitor id keys the row (Codex P2 on #1326 bb9e75a0).
  const rows = [...(status.positions || [])].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict)
    || (a.tradeId ?? 0) - (b.tradeId ?? 0) || (a.monitorId ?? 0) - (b.monitorId ?? 0))
  return <>
    <p>{passSentence(status)}</p>
    {rows.length === 0
      ? <p>No open position in this view.</p>
      : <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
        <thead><tr>{['Position', 'Strategy', 'Capped hybrid verdict'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
        <tbody>{rows.map(p => <tr key={p.monitorId != null ? `m${p.monitorId}` : `${p.accountId}:${p.tradeId}`} className="border-t border-[var(--color-border)]" data-verdict={p.verdict}>
          <td className="pr-3 py-2 whitespace-nowrap">{p.symbol || 'symbol not recorded'} {p.side || ''} · …{String(p.accountId || '').slice(-4)} {p.tradeId != null ? `#${p.tradeId}` : 'no linked trade'}</td>
          <td className="pr-3">{p.strategy || 'not recorded'}</td>
          <td className="pr-3 max-w-md whitespace-normal">{verdictLine(p)}</td>
        </tr>)}</tbody>
      </table></div>}
    {status.positionsTruncated && <p>Showing the first {rows.length} open positions.</p>}
  </>
}

export default function CappedHybridCard({ accountId }) {
  const [reading, setReading] = useState(null)
  useEffect(() => {
    let stopped = false, generation = 0
    const refresh = async () => {
      const mine = ++generation
      let status = null, error = null
      try {
        if (!agentConfigured()) throw new Error('Agent not connected')
        const r = await agentGet(`/state/capped-hybrid?account=${encodeURIComponent(accountId)}`)
        if (r?.accountId !== accountId || !Array.isArray(r.positions)) throw new Error('Status account mismatch')
        status = r
      } catch (e) { error = e.message }
      if (!stopped && mine === generation) setReading({ accountId, status, error })
    }
    const kick = setTimeout(refresh, 0)
    const timer = setInterval(() => { if (!pageAsleep()) refresh() }, 60_000)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer) }
  }, [accountId])
  const valid = reading?.accountId === accountId
  return <Card id="sec-capped-hybrid" className="text-(length:--fs-body)" aria-label="Capped hybrid profit-taking" scope={accountId}>
    <h2 className="t-h3 mb-2">Profit-taking: capped hybrid (a share at its trigger, the runner held)</h2>
    <CappedHybridReading status={valid ? reading.status : null} error={valid ? reading.error : null} />
  </Card>
}
