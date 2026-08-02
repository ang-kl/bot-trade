// GoalTracker — the go-live gate, per account, with the deadline attached.
//
// The Performance page already shows win rate and profit factor. What it does
// not show is whether those numbers can still become 68% and 1.68 by 12 Aug,
// which is the actual decision in front of the owner. This card answers that
// per account, and it is deliberately blunt about the three ways a green tick
// would be a lie:
//
//   • too few trades  -> "not enough trades", never a tick, however good the
//                        rate looks. 3-for-3 is 100% and means nothing.
//   • below target    -> "needs N of the next M" with the required hit rate
//                        printed NEXT TO the achieved one, so the size of the
//                        lift is visible rather than implied.
//   • unreachable     -> "out of reach by 12 Aug" stated plainly. The server
//                        computes this arithmetically (more winners required
//                        than trades expected to close), so it is a fact, not
//                        a mood.
//
// The profit-factor requirement rests on an assumption — that the remaining
// trades keep the size they have had — and the card prints that assumption
// underneath rather than hiding it behind a number.
import { useCallback, useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import { selectedAccountId } from '../lib/selected-account.js'
import SectionTools from './common/SectionTools.jsx'

const TX = 'var(--color-text)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const UP = 'var(--color-up)', DN = 'var(--color-down)', WRN = 'var(--color-warning-text)'
const GL = 'var(--color-surface)', GBD = 'var(--color-border)', ACC = 'var(--color-accent)'

const VERDICT = {
  met: { label: 'Met', tone: UP },
  at_risk: { label: 'Needs a lift', tone: WRN },
  out_of_reach: { label: 'Out of reach', tone: DN },
  insufficient_sample: { label: 'Not enough trades', tone: MU },
  no_data: { label: 'No closed trades', tone: MU },
}

const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`)
const num2 = (v) => (v == null ? '—' : Number(v).toFixed(2))

/** One metric line: achieved vs target, then what the remainder must do. */
// The desktop and mobile shells are a CSS split (`hidden min-[700px]:block`
// beside `min-[700px]:hidden`), so BOTH variants mount on every viewport and
// both would fetch. One shared in-flight promise means the two instances make
// one request and paint from the same answer — which removes a subtler bug
// than the wasted call: two independent fetches can land with different data,
// so the phone card and the desktop card could disagree about the same gate.
let inFlight = null
function fetchGoal() {
  if (!inFlight) {
    inFlight = agentGet('/state/goal-tracker').finally(() => { inFlight = null })
  }
  return inFlight
}

function MetricRow({ m, label, fmt, row }) {
  const v = VERDICT[m.verdict] || VERDICT.no_data
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-d9)', color: MU, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
        <span style={{ fontSize: 'var(--fs-d11)', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: m.verdict === 'met' ? UP : TX }}>
          {fmt(m.value)}
        </span>
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>vs {fmt(m.target)}</span>
        <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 700, color: v.tone }}>{v.label}</span>
      </span>
      {/* The requirement, only where there is one to state. */}
      {m.verdict === 'at_risk' && m.winsNeeded > 0 && row.expectedRemaining > 0 && (
        <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
          needs <strong>{m.winsNeeded}</strong> winners of the ~{row.expectedRemaining} trades still expected
          {m.requiredRateOnRemaining != null && (
            <> — a <strong>{pct(m.requiredRateOnRemaining)}</strong> hit rate, against {pct(row.winRate.value)} so far</>
          )}
        </span>
      )}
      {m.verdict === 'out_of_reach' && (
        <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
          {row.expectedRemaining > 0
            ? <>would need <strong>{m.winsNeeded}</strong> winners from only ~{row.expectedRemaining} trades before the deadline</>
            : <>no trades expected to close before the deadline</>}
        </span>
      )}
      {m.verdict === 'insufficient_sample' && (
        <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
          {row.trades} of {row.minTrades} closed trades — too few to read as evidence
        </span>
      )}
      {m.assumes && m.verdict !== 'met' && m.verdict !== 'no_data' && (
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>assumes {m.assumes}</span>
      )}
    </div>
  )
}

function AccountRow({ row }) {
  const v = VERDICT[row.verdict] || VERDICT.no_data
  return (
    <div style={{
      background: GL, border: `1px solid ${row.verdict === 'out_of_reach' ? DN : GBD}`, borderRadius: 12,
      padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 320px', minWidth: 280,
    }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-d10)', fontWeight: 800, color: ACC }}>
          {row.label || row.accountId}
        </span>
        {row.isLive && <span style={{ fontSize: 'var(--fs-d9)', fontWeight: 800, color: DN }}>LIVE</span>}
        {row.enabled === false && <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>disabled</span>}
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-d9)', fontWeight: 800, color: v.tone }}>{v.label}</span>
      </span>
      <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
        {row.trades} closed · {row.wins}W / {row.losses}L
        {row.tradesPerDay != null && <> · {row.tradesPerDay}/day over {row.spanDays}d</>}
        {row.expectedRemaining != null && <> · ~{row.expectedRemaining} more expected</>}
      </span>
      <MetricRow m={row.winRate} label="Win rate" fmt={pct} row={row} />
      <MetricRow m={row.profitFactor} label="Profit factor" fmt={num2} row={row} />
    </div>
  )
}

/**
 * @param {{variant?: 'full'|'compact'}} props
 *   compact — the phone form. Same numbers, same readings, different shape:
 *   the account you are LOOKING AT first and full width, everything else
 *   behind a disclosure. A five-card grid at the top of a phone screen pushes
 *   the day's actual figures below the fold to answer a question you only ask
 *   once a day.
 */
export default function GoalTracker({ variant = 'full' }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  const load = useCallback(() => fetchGoal()
    .then(d => { setData(d); setErr(null) })
    .catch(e => setErr(e?.message || String(e))), [])

  useEffect(() => {
    let alive = true
    fetchGoal()
      .then(d => { if (alive) { setData(d); setErr(null) } })
      .catch(e => { if (alive) setErr(e?.message || String(e)) })
    return () => { alive = false }
  }, [])
  // The tracker shows every account at once, so an account switch changes
  // nothing about WHAT is fetched — it is reloaded anyway so the highlighted
  // row and the numbers arrive from the same read.
  useAccountSwitch(load)

  const sel = selectedAccountId()
  if (err) return <span style={{ fontSize: 'var(--fs-d9)', color: DN }}>Goal tracker unavailable: {err}</span>
  if (!data) return null

  const rows = data.accounts || []
  // Selected account first, then the ones with a real record, then the rest.
  const ordered = [...rows].sort((a, b) => {
    const s = (r) => (String(r.accountId) === String(sel) ? 0 : r.trades > 0 ? 1 : 2)
    return s(a) - s(b) || (b.trades - a.trades)
  })
  const p = data.portfolio

  if (variant === 'compact') {
    // The selected account is the subject; the pooled row is context. If no
    // account is selected there is no subject, so the pooled row becomes one —
    // never a silent pick of whichever account sorted first.
    const subject = ordered.find(r => String(r.accountId) === String(sel)) || p
    const others = [p, ...ordered].filter(r => r !== subject)
    return (
      <div id="sec-goal-mobile" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--fs-d10)', fontWeight: 800, color: ACC }}>Go-Live Gate</span>
          <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
            {data.goal.winRatePct}% win · PF {data.goal.profitFactor} ·{' '}
            <strong style={{ color: data.daysRemaining <= 3 ? WRN : MU }}>
              {data.daysRemaining === 0 ? 'deadline passed' : `${data.daysRemaining}d left`}
            </strong>
          </span>
        </span>
        <AccountRow row={subject} />
        {others.length > 0 && (
          <details>
            <summary style={{ fontSize: 'var(--fs-d9)', color: SB, cursor: 'pointer' }}>
              {others.length} more {others.length === 1 ? 'row' : 'rows'} — all accounts and the rest
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              {others.map(r => <AccountRow key={r.accountId} row={r} />)}
            </div>
          </details>
        )}
      </div>
    )
  }

  return (
    <div id="sec-goal" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--fs-d11)', fontWeight: 800, color: ACC, flexShrink: 0 }}>
          Go-Live Gate — Progress card
        </span>
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
          win rate {data.goal.winRatePct}% · profit factor {data.goal.profitFactor} · by {data.goal.deadline}
          {' · '}
          <strong style={{ color: data.daysRemaining <= 3 ? WRN : MU }}>
            {data.daysRemaining === 0 ? 'deadline passed' : `${data.daysRemaining} day${data.daysRemaining === 1 ? '' : 's'} left`}
          </strong>
        </span>
        <SectionTools id="goal" title="Go-Live Gate — Progress card" data={data}
          toText={() => [
            `Go-live gate: win rate ${data.goal.winRatePct}% · profit factor ${data.goal.profitFactor} · by ${data.goal.deadline} (${data.daysRemaining}d left)`,
            ...[p, ...ordered].map(r => `${r.label || r.accountId} · ${r.trades} closed · win ${pct(r.winRate.value)} (${VERDICT[r.winRate.verdict]?.label}) · PF ${num2(r.profitFactor.value)} (${VERDICT[r.profitFactor.verdict]?.label})`),
          ].join('\n')}
          render={() => (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[p, ...ordered].map(r => <AccountRow key={r.accountId} row={r} />)}
            </div>
          )} />
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <AccountRow row={p} />
        {ordered.map(r => <AccountRow key={r.accountId} row={r} />)}
      </div>
      {/* Said once, here, rather than repeated per card: the pooled row is not
          an average of the account rows. */}
      <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
        “All accounts” is rebuilt from every closed trade, not averaged from the per-account rates.
      </span>
    </div>
  )
}
