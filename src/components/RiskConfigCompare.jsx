// Risk Config Comparison — Tune's side-by-side account view (owner
// 02-08-2026: "Tune Page show static the current account … I cannot see and
// compare the other account"). One column per registry account, rows are
// the effective risk knobs from GET /state/risk-config?account=<id> — i.e.
// global config with that account's overlay merged, exactly what the risk
// gate itself evaluates. Cells that differ from the global value are marked
// so an overlay is visible at a glance.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import Collapse from './common/Collapse.jsx'
import Skeleton from './common/Skeleton.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'

const KNOBS = [
  ['perTradeRiskPct', 'Risk per trade (%)'],
  ['maxRiskCapPct', 'Max risk cap (%)'],
  ['dailyLossPct', 'Daily loss cap (%)'],
  ['dailyLossLimit', 'Daily loss limit ($)'],
  ['maxOpenPositions', 'Max open positions'],
  ['equityStopPct', 'Equity stop (%)'],
  ['minRR', 'Min R:R'],
  ['maxMarginUsagePct', 'Max margin usage (%)'],
  ['maxCurrencyExposure', 'Max currency exposure'],
  ['maxConsecutiveLosses', 'Max consecutive losses'],
]

export default function RiskConfigCompare() {
  const [cols, setCols] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!agentConfigured()) return undefined
    let alive = true
    ;(async () => {
      try {
        const { accounts = [] } = await agentGet('/state/accounts')
        const globalR = await agentGet('/state/risk-config')
        const per = await Promise.all(accounts.map(async a => {
          try {
            const r = await agentGet(`/state/risk-config?account=${encodeURIComponent(a.account_id)}`)
            return { acct: a, config: r?.effective || {}, overlay: r?.overlay || null }
          } catch { return { acct: a, config: {}, overlay: null } }
        }))
        if (alive) setCols({ global: globalR?.effective || {}, per })
      } catch (e) { if (alive) setErr(e.message) }
    })()
    return () => { alive = false }
  }, [])

  if (!agentConfigured()) return null
  return (
    <Card id="sec-risk-compare" className="mt-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-(length:--fs-body) font-semibold">Risk Config Comparison table</div>
        <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">
          effective risk knobs per account (global + that account&rsquo;s overlay) — highlighted cells differ from global
        </span>
      </div>
      {err && <div className="text-(length:--fs-body) text-[var(--color-warning-text)]">{err}</div>}
      {!err && !cols && <Skeleton lines={3} />}
      {cols && (
        <div className="overflow-x-auto">
          <Collapse id="RiskConfigCompare" label="Risk Knob Rows">
            <table className="std-cols w-full text-(length:--fs-body) tabular-nums">
              <thead>
                <tr className="border-b border-[var(--color-border)]">
                  <th className="py-1 pr-3 text-left">Knob</th>
                  <th className="py-1 px-2 text-right">Global</th>
                  {cols.per.map(({ acct }) => (
                    <th key={acct.account_id} className="py-1 px-2 text-right whitespace-nowrap">
                      {acct.trader_login || acct.account_id} <Badge tone={acct.is_live ? 'down' : 'info'}>{acct.is_live ? 'LIVE' : 'DEMO'}</Badge>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {KNOBS.map(([key, label]) => (
                  <tr key={key} className="border-t border-[var(--glass-edge)]">
                    <td className="py-1 pr-3">{label}</td>
                    <td className="py-1 px-2 text-right">{cols.global[key] ?? '—'}</td>
                    {cols.per.map(({ acct, config }) => {
                      const v = config[key]
                      const differs = v != null && cols.global[key] != null && v !== cols.global[key]
                      return (
                        <td key={acct.account_id}
                          className={`py-1 px-2 text-right ${differs ? 'font-semibold bg-[var(--color-accent-soft)]' : ''}`}
                          title={differs ? `overlay — global is ${cols.global[key]}` : undefined}>
                          {v ?? '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Collapse>
        </div>
      )}
    </Card>
  )
}
