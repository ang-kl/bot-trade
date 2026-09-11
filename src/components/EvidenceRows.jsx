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
          prior admit {cfg.priorAdmit === false ? 'off' : 'on'} · risk scale {fmt(cfg.priorRiskScale)} · every account
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

/**
 * Target review: the pure row. `data` is GET /state/target-review — one line
 * per strategy, numbers only past the sample gates, otherwise the count
 * against the gate so an empty reading is visibly "not enough" rather than a
 * quiet zero.
 */
export function TargetReviewRow({ data, error }) {
  if (error) return <NotVerifiable what="Target review" error={error} />
  if (!data) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>
  const gates = data.gates || { minProposals: 20, minCloses: 30 }
  const rows = Object.entries(data.strategies || {})
  const rr = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(2)}R`)
  const w = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(1)}%`)
  return (
    <div className="flex flex-col gap-0.5 text-(length:--fs-body)">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">Target review</span>
        <span className="text-[var(--color-text-sub)]">
          {data.days}d · hard floor {fmt(data.hardMinRr)}R · prior k={data.k ?? '—'} · recommendations only, nothing enforced
        </span>
      </div>
      {rows.length === 0 && <div className="text-[var(--color-text-sub)]">no strategies</div>}
      {rows.map(([key, s]) => {
        const p = s.proposals || {}
        const pr = s.prior
        const re = s.realised || {}
        return (
          <div key={key} className="tabular-nums">
            <span className="font-semibold">{key}:</span>{' '}
            declared {rr(s.declaredTarget?.rr)} · own floor {rr(s.ownFloor)} ·{' '}
            {p.insufficient
              ? `proposals ${p.withRr ?? 0}/${p.need ?? gates.minProposals}`
              : `median ${rr(p.medianRr)} (${pct(p.shareBelowHard == null ? null : p.shareBelowHard * 100)} below hard)`}
            {' · '}
            {pr
              ? `W′ ${w(pr.shrunkWinRatePct)} E@declared ${fmt(pr.expectancyR?.declared)} break-even ${rr(pr.breakEvenRr)}`
              : 'no prior'}
            {' · '}
            {re.insufficient
              ? `closes ${re.closes ?? 0}/${re.need ?? gates.minCloses}`
              : `realised E ${fmt(re.actual?.expectancyR)}R over ${re.closes} (PF ${pf(re.actual?.profitFactor, re.closes)})`}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Exit chain: the pure row. `data` is GET /state/exit-chain — per family the
 * stamped-close count against the floor and, only when fitted, the outcome by
 * last state before exit. An insufficient family shows its count, never a
 * probability.
 */
export function ExitChainRow({ data, error }) {
  if (error) return <NotVerifiable what="Exit chain" error={error} />
  if (!data) return <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">Loading…</p>
  const fams = Object.entries(data.families || {})
  return (
    <div className="flex flex-col gap-0.5 text-(length:--fs-body)">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold">Exit chain</span>
        <span className="text-[var(--color-text-sub)]">
          {data.days}d · {data.stamped ?? 0} stamped of {data.n ?? 0} closes · floor {data.minCloses} per family · {String(data.verdict || '').toLowerCase()} · scaffold, not advice
        </span>
      </div>
      {fams.length === 0 && <div className="text-[var(--color-text-sub)]">no families</div>}
      {fams.map(([f, c]) => (
        <div key={f} className="tabular-nums">
          <span className="font-semibold">{f}:</span>{' '}
          {c.status === 'fitted'
            ? <>fitted on {c.stamped} · {Object.entries(c.byState || {}).map(([st, b], i) => (
                <span key={st}>{i > 0 ? ' · ' : ''}{st} n={b.n} E {fmt(b.expectancyR)}R ({pct(b.winRate)})</span>
              ))}</>
            : `insufficient ${c.stamped ?? 0}/${c.minCloses ?? data.minCloses} stamped closes`}
        </div>
      ))}
      {Array.isArray(data.biases) && data.biases.length > 0 && (
        <div className="text-[var(--color-text-sub)]">journal biases: {data.biases.length} recorded (see /state/exit-chain)</div>
      )}
    </div>
  )
}

export default function EvidenceRows() {
  const [floor, setFloor] = useState({ data: null, error: null })
  const [review, setReview] = useState({ data: null, error: null })
  const [chain, setChain] = useState({ data: null, error: null })

  useEffect(() => {
    let alive = true
    agentGet('/state/earned-floor')
      .then(d => { if (alive) setFloor({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setFloor({ data: null, error: e?.message || String(e) }) })
    agentGet('/state/target-review')
      .then(d => { if (alive) setReview({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setReview({ data: null, error: e?.message || String(e) }) })
    agentGet('/state/exit-chain')
      .then(d => { if (alive) setChain({ data: d?.error ? null : d, error: d?.error || null }) })
      .catch(e => { if (alive) setChain({ data: null, error: e?.message || String(e) }) })
    return () => { alive = false }
  }, [])

  return (
    <div className="mt-2 pt-1.5 border-t border-[var(--color-border)] flex flex-col gap-1.5">
      <PriorCohortRow data={floor.data} error={floor.error} />
      <TargetReviewRow data={review.data} error={review.error} />
      <ExitChainRow data={chain.data} error={chain.error} />
    </div>
  )
}
