import SectionTools from './common/SectionTools.jsx'
import ScopeDot from './common/ScopeDot.jsx'
import { deriveScopeState, MODES } from '../lib/use-account-scope.js'

const label = {
  met: 'Met', below_target: 'Below target', insufficient_sample: 'Fewer than 20 closes',
  insufficient_days: 'Daily evidence not sufficient', undefined: 'Undefined: no gross losses',
  unmeasurable: 'Evidence incomplete', not_assessed: 'Not yet assessed',
}
const value = (v, digits = 2) => v == null ? '—' : Number(v).toFixed(digits)

/** Forward, per-account reporting; it never controls entry eligibility. */
export default function PerformanceTargets({ report, accounts = [], selected, variant = 'full' }) {
  const registry = new Map(accounts.map(r => [String(r.accountId), r]))
  const rows = [...(report.accounts || [])].sort((a, b) =>
    Number(String(b.accountId) === String(selected)) - Number(String(a.accountId) === String(selected)))
  return (
    <section id={variant === 'compact' ? 'sec-goal-mobile' : 'sec-goal'} style={{ color: 'var(--color-text)', fontSize: 'var(--fs-body)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>Performance targets · per account</strong>
        <span>Win rate ≥ 75% · Profit factor ≥ 1.68</span>
        <SectionTools id={variant === 'compact' ? 'targets-mobile' : 'targets'} title="Performance targets" data={report}
          toText={() => JSON.stringify(report, null, 2)} />
      </div>
      <p>From 4 Oct 2026, 07:35 SGT. Latest 20 whole positions OR consecutive SGT days: win rate 3 days; profit factor 8 days.</p>
      <p>Each completed day requires at least one eligible close and meets its own target. An empty day breaks the streak. Today is provisional. Reporting only.</p>
      {report.unavailable && <p role="status">Evidence unavailable: {report.unavailable}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {rows.map(row => {
          const account = registry.get(String(row.accountId))
          const m = row.latest20
          const scope = deriveScopeState({ id: `targets.card.${row.accountId}`, mode: MODES.ACCOUNT, payload: { scope: row.scope }, selected })
          return <article key={row.accountId} style={{ border: '1px solid var(--color-border)', padding: 8, flex: '1 1 260px', minWidth: 0 }}>
            <strong>{account?.login ? `#${account.login} · ` : ''}{row.accountId} · {row.currency || 'currency unverified'}</strong> <ScopeDot scope={scope} />
            <p>{m.n}/20 recorded whole-position candidates · {m.eligible} complete · {m.pending} pending</p>
            <div>Win rate: {value(m.winRatePct, 1)}{m.winRatePct == null ? '' : '%'} · {label[row.winRate.status]}</div>
            <div>Latest 20: {label[row.winRate.latest20Status]} · Days: {row.winRate.consecutiveDays}/3</div>
            <div>Profit factor: {value(m.profitFactor, 4)} · {label[row.profitFactor.status]}</div>
            <div>Latest 20: {label[row.profitFactor.latest20Status]} · Days: {row.profitFactor.consecutiveDays}/8</div>
            <p>Today ({row.currentDay.day} SGT), provisional: {row.currentDay.n} closes · win {value(row.currentDay.winRatePct, 1)}{row.currentDay.winRatePct == null ? '' : '%'} · PF {value(row.currentDay.profitFactor, 4)}</p>
            {row.unavailable && <p role="status">{row.unavailable}</p>}
            <details><summary>Daily evidence and costs</summary>
              {row.days.map(d => <div key={d.day}>{d.day}: {d.n} closes · win {value(d.winRatePct, 1)}{d.winRatePct == null ? '' : '%'} ({label[d.winRateStatus]}) · PF {value(d.profitFactor, 4)} ({label[d.profitFactorStatus]})</div>)}
              <p>Conversion fee recorded across complete forward positions: {row.currency || 'unverified unit'} {value(row.conversionFee)}. Net follows the existing broker gross + signed commission + signed swap convention.</p>
            </details>
          </article>
        })}
      </div>
      <p>{report.coverageNote}</p>
    </section>
  )
}
