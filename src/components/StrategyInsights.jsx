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
import { strategyLabel, STRATEGY_KEYS } from '../lib/strategy-labels.js'
import Skeleton from './common/Skeleton.jsx'
import Collapse from './common/Collapse.jsx'
import Segmented from './common/Segmented.jsx'

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const pct = (n) => (n == null ? '—' : `${n}%`)

export default function StrategyInsights({ account = 'all' }) {
  const [rows, setRows] = useState(null)
  const [days, setDays] = useState(30)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!agentConfigured()) return
    // Scoped per account (owner 02-08: "is this for current account or which
    // account?" — before this it silently mixed every account's trades).
    agentGet(`/state/strategy-insights?days=${days || ''}&account=${encodeURIComponent(account)}`)
      .then(r => {
        // Full 12-strategy roster always (owner 02-08) — zero-trade
        // strategies show as dashes instead of vanishing.
        const got = r.rows || []
        const have = new Set(got.map(x => x.strategy))
        for (const k of STRATEGY_KEYS) if (!have.has(k)) got.push({ strategy: k, trades: 0, wins: 0, losses: 0 })
        setRows(got); setError('')
      })
      .catch(e => setError(e.message))
  }, [days, account])

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-[9px] font-semibold">Strategy Forecast vs. Actual table</div>
        <span className="text-[9px] text-[var(--color-text-sub)]">
          {account === 'all' ? 'all accounts' : `account ${account} only`} · closed trades · Edge = actual win rate − the win rate the strategy's own R:R requires
        </span>
        {/* Emphasis follows selection (inventory: unselected was the BOLD
            UPPERCASE one) and the group is a real radiogroup. */}
        <span className="ml-auto">
          <Segmented label="Insight range" value={days} onChange={setDays}
            options={[7, 30, 0].map(d => ({ value: d, label: d === 0 ? 'All' : `${d}D` }))} />
        </span>
      </div>
      {error && <div className="text-[9px] text-[var(--color-warning-text)]">{error}</div>}
      {rows && rows.length === 0 && <div className="text-[9px] text-[var(--color-text-sub)]">No closed trades in this range.</div>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Collapse id="StrategyInsights_59" label="Strategy Rows">
          <table className="w-full text-[9px]">
            <thead>
              <tr>
                <th className="pb-1 pr-3">Strategy</th>
                <th className="pb-1 pr-3">Trades</th>
                <th className="pb-1 pr-3">W / L</th>
                <th className="pb-1 pr-3">Win rate</th>
                <th className="pb-1 pr-3">Planned R:R</th>
                <th className="pb-1 pr-3">Needs</th>
                <th className="pb-1 pr-3">Edge</th>
                <th className="pb-1 pr-3">Avg win / loss</th>
                <th className="pb-1">Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.strategy} className="border-t border-[var(--glass-edge)]">
                  {/* strategyLabel, NOT `capitalize`: CSS capitalises the first
                      letter of each word and cannot know RSI or VWAP is an acronym,
                      which is how this column came to read "Rsi2_reversion". The
                      raw key stays in the title for anyone matching it to a log. */}
                  <td className="py-1 pr-3" title={r.strategy}>{strategyLabel(r.strategy)}</td>
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
                  <td className={`py-1 tabular-nums ${r.netPnl > 0 ? 'text-[var(--color-up)]' : r.netPnl < 0 ? 'text-[var(--color-down)]' : ''}`}>
                    {fmtMoney(r.netPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </Collapse>
        </div>
      )}
      {!rows && !error && <Skeleton lines={3} />}
    </Card>
  )
}
