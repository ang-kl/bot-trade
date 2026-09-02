// EvidenceRows — the read-only evidence rows that sit beside DivergenceCard
// on Tune (02-09-2026 plan): the prior cohort watch now, the target review
// and the exit chain as they land. A sibling of DivergenceCard on purpose:
// that card's test pins its exact two fetches, and these rows have their own
// pin (evidence-rows.test.jsx). Every fetch failure renders "not verifiable",
// never the empty shape — a route that cannot be read is failure mode #3.
import { useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import { fmt, pct, money } from '../lib/divergence-view.js'
import { NotVerifiable } from './DivergenceCard.jsx'

const pf = (v, closes) => (v === null && (closes || 0) > 0 ? '∞ (no losses yet)' : fmt(v))

/** Prior cohort: the pure row. `data` is GET /state/earned-floor. */
export function PriorCohortRow({ data, error }) {
  if (error) return <NotVerifiable what="Prior cohort" error={error} />
  if (!data) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>
  const vp = data.viaPrior || {}
  const cfg = data.config || {}
  const by = data.byAccount || {}
  const ids = Object.keys(by).sort()
  // The widening criterion is written in docs/prior-cohort-watch.md; it is
  // read here, never enforced: pooled ≥30 closes at PF ≥1.5 AND the prior
  // population alone ≥15 closes at PF ≥1.5.
  const co = data.closedCohort || {}
  const pooledOk = (co.trades || 0) >= 30 && (co.profitFactor === null || Number(co.profitFactor) >= 1.5)
  const priorOk = (vp.closed || 0) >= 15 && (vp.profitFactor === null || Number(vp.profitFactor) >= 1.5)
  return (
    <div className="flex flex-col gap-0.5 text-(length:--fs-body)">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">Prior cohort</span>
        <span className="text-[var(--color-text-sub)]">
          prior admit {cfg.priorAdmit === false ? 'off' : 'on'} · risk scale {fmt(cfg.priorRiskScale)} · demo only by code
        </span>
      </div>
      <div className="tabular-nums">
        <span className="font-semibold">Prior population:</span>{' '}
        {vp.admittedApprovals ?? 0} admitted · {vp.closed ?? 0} closes · {vp.wins ?? 0} wins ({pct(vp.winRate)}) · PF {pf(vp.profitFactor, vp.closed)} · net {money(vp.net)}
      </div>
      <div className="tabular-nums">
        <span className="font-semibold">Widening criterion:</span>{' '}
        pooled {pooledOk ? 'met' : 'not met'} ({co.trades ?? 0}/30 closes, PF {pf(co.profitFactor, co.trades)}) · prior alone {priorOk ? 'met' : 'not met'} ({vp.closed ?? 0}/15 closes)
        {' '}· <span className="text-[var(--color-text-sub)]">written in docs/prior-cohort-watch.md, not enforced</span>
      </div>
      {ids.length > 0 && (
        <div className="tabular-nums">
          <span className="font-semibold">By account:</span>{' '}
          {ids.map((id, i) => {
            const a = by[id] || {}
            const p = a.viaPrior || {}
            return (
              <span key={id}>
                {i > 0 ? ' · ' : ''}
                <span title={id}>{id === 'unscoped' ? 'unscoped' : `…${String(id).slice(-4)}`}</span>
                {' '}{a.closed ?? 0} closes PF {pf(a.profitFactor, a.closed)} (prior {p.closed ?? 0} PF {pf(p.profitFactor, p.closed)})
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function EvidenceRows() {
  const [floor, setFloor] = useState({ data: null, error: null })

  useEffect(() => {
    let alive = true
    agentGet('/state/earned-floor')
      .then(d => { if (alive) setFloor({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setFloor({ data: null, error: e?.message || String(e) }) })
    return () => { alive = false }
  }, [])

  return (
    <div className="mt-2 pt-1.5 border-t border-[var(--color-border)]">
      <PriorCohortRow data={floor.data} error={floor.error} />
    </div>
  )
}
