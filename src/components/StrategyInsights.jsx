// Strategy forecast vs. actual — per strategy over CLOSED trades (owner:
// "deep insights in Account page how the strategy forecast to actual
// win/lost"). The forecast column is each strategy's own average planned
// R:R (TP distance ÷ SL distance from its trades' real levels) and the
// win rate that R:R REQUIRES to break even; Edge = actual − required.
// A negative Edge means the strategy is losing by design at its current
// targets, not by bad luck — that's the number to act on.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const pct = (n) => (n == null ? '—' : `${n}%`)

export default function StrategyInsights() {
  const [rows, setRows] = useState(null)
  const [days, setDays] = useState(30)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!agentConfigured()) return
    agentGet(`/state/strategy-insights${days ? `?days=${days}` : ''}`)
      .then(r => { setRows(r.rows || []); setError('') })
      .catch(e => setError(e.message))
  }, [days])

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-[12px] font-semibold">Strategy forecast vs. actual</div>
        <span className="text-[11px] text-[var(--color-text-sub)]">closed trades · Edge = actual win rate − the win rate the strategy's own R:R requires</span>
        <span className="ml-auto flex gap-1">
          {[7, 30, 0].map(d => (
            <button key={d} type="button" onClick={() => setDays(d)}
              className={`rounded-[2px] border px-[4px] py-[3px] text-[10px] cursor-pointer ${days === d
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-normal'
                : 'border-[var(--glass-edge)] text-[var(--color-text-sub)] font-bold uppercase'}`}>
              {d === 0 ? 'All' : `${d}D`}
            </button>
          ))}
        </span>
      </div>
      {error && <div className="text-[12px] text-[var(--color-warning-text)]">{error}</div>}
      {rows && rows.length === 0 && <div className="text-[12px] text-[var(--color-text-sub)]">No closed trades in this range.</div>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[var(--color-text-sub)]">
                <th className="font-medium pb-1 pr-3">Strategy</th>
                <th className="font-medium pb-1 pr-3">Trades</th>
                <th className="font-medium pb-1 pr-3">W / L</th>
                <th className="font-medium pb-1 pr-3">Win rate</th>
                <th className="font-medium pb-1 pr-3">Planned R:R</th>
                <th className="font-medium pb-1 pr-3">Needs</th>
                <th className="font-medium pb-1 pr-3">Edge</th>
                <th className="font-medium pb-1 pr-3">Avg win / loss</th>
                <th className="font-medium pb-1">Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.strategy} className="border-t border-[var(--glass-edge)]">
                  <td className="py-1 pr-3 capitalize">{r.strategy}</td>
                  <td className="py-1 pr-3 tabular-nums">{r.trades}</td>
                  <td className="py-1 pr-3 tabular-nums">{r.wins} / {r.losses}</td>
                  <td className="py-1 pr-3 tabular-nums">{pct(r.winRatePct)}</td>
                  <td className="py-1 pr-3 tabular-nums">{r.plannedRR != null ? `${r.plannedRR}:1` : '—'}</td>
                  <td className="py-1 pr-3 tabular-nums text-[var(--color-text-sub)]">{pct(r.breakevenWinRatePct)}</td>
                  <td className="py-1 pr-3">
                    {r.edgePct == null ? '—' : (
                      <Badge tone={r.edgePct >= 0 ? 'up' : 'down'}>{r.edgePct > 0 ? '+' : ''}{r.edgePct}%</Badge>
                    )}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{fmtMoney(r.avgWin)} / {fmtMoney(r.avgLoss)}</td>
                  <td className={`py-1 tabular-nums font-semibold ${r.netPnl > 0 ? 'text-[var(--color-up)]' : r.netPnl < 0 ? 'text-[var(--color-down)]' : ''}`}>
                    {fmtMoney(r.netPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!rows && !error && <div className="text-[12px] text-[var(--color-text-sub)]">Loading…</div>}
    </Card>
  )
}
