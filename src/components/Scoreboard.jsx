// Scoreboard — the last 20 closed trades per account, readable on a phone.
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// The owner trades from a small phone and could not see the last 20 trades,
// their profit factor or their win rate at a glance: the forward tracker
// withholds every figure until all 20 are broker-proven, so each account read
// "not assessed" with no numbers. This card shows what the LEDGER recorded
// (GET /state/scoreboard), per account, in that account's own currency, and
// leaves the forward verdict beneath it untouched.
//
// Built for 390px: three big figures, one ratio line, one strip of the last
// 20 trades' R, one 30-day line, and the 20 rows behind a disclosure. Status
// never by colour alone: every figure carries its sign or its words, and the
// strip's bars sit ABOVE or BELOW a zero line as well as being coloured.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import { selectedAccountId } from '../lib/selected-account.js'
import { R_CLIP, finite, fmtPct, fmtR, fmtMoney, fmtPf, fmtPfR, fmtWhen, stripLabel, startScoreboardPolling } from '../lib/scoreboard-view.js'

const TX = 'var(--color-text)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const UP = 'var(--color-up)', DN = 'var(--color-down)', BD = 'var(--color-border)'
const BIG = 'calc(var(--fs-title) * 1.6)'

/** The last 20 trades' R as bars about a zero line, oldest on the left. */
export function RStrip({ rows }) {
  const list = [...rows].reverse()
  const W = 200, Hh = 48, mid = Hh / 2, slot = W / Math.max(20, list.length), bar = Math.max(2, slot * 0.7), half = mid - 2
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" height={Hh} role="img" aria-label={stripLabel(rows)}
      preserveAspectRatio="none" style={{ display: 'block', maxWidth: 360 }}>
      <line x1="0" x2={W} y1={mid} y2={mid} stroke={MU} strokeWidth="1" />
      {list.map((r, i) => {
        const x = i * slot + (slot - bar) / 2
        const v = r.realised_rr
        if (!finite(v)) return <rect key={r.id ?? i} x={x} y={mid - 1} width={bar} height={2} fill={MU} />
        const h = Math.max(1.5, Math.min(R_CLIP, Math.abs(v)) / R_CLIP * half)
        return <rect key={r.id ?? i} x={x} y={v >= 0 ? mid - h : mid} width={bar} height={h} fill={v >= 0 ? UP : DN} />
      })}
    </svg>
  )
}

function Big({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ fontSize: 'var(--fs-body)', color: MU, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      <span style={{ fontSize: BIG, fontWeight: 800, color: TX, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>{value}</span>
      {sub && <span style={{ fontSize: 'var(--fs-body)', color: SB }}>{sub}</span>}
    </div>
  )
}

const counts = m => `${m.wins}W · ${m.losses}L${m.zeros ? ` · ${m.zeros} flat` : ''}`

function AccountScore({ a }) {
  const m = a.last20, d = a.days30?.bot
  const ccy = a.currency
  return (
    <article aria-label={`Account ${a.label}`} style={{ borderTop: `1px solid ${BD}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 'var(--fs-h)', color: TX }}>{a.label}</strong>
        <span style={{ fontSize: 'var(--fs-body)', color: SB }}>{ccy || 'currency unverified'}</span>
        {!a.registered && <span style={{ fontSize: 'var(--fs-body)', color: MU }}>· not in the account registry</span>}
        <span style={{ fontSize: 'var(--fs-body)', color: MU }}>· last {m.n} closed{m.externalN ? ` (${m.externalN} manual/external)` : ''}</span>
      </div>
      {m.n === 0 ? <p style={{ fontSize: 'var(--fs-body)', color: SB, margin: 0 }}>No closed trades recorded.</p> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <Big label="Win rate" value={fmtPct(m.winRatePct)} sub={counts(m)} />
          <Big label="Profit factor" value={fmtPf(m.profitFactor, m)} sub={`in R: ${fmtPfR(m)}`} />
          <Big label="Expectancy" value={fmtR(m.expectancyR)} sub={`${m.rScored} of ${m.n} with R`} />
        </div>
        <div style={{ fontSize: 'var(--fs-body)', color: TX }}>
          Win size ÷ loss size: <strong>{finite(m.payoff) ? m.payoff.toFixed(2) : '—'}</strong>
          {' '}({fmtMoney(m.avgWin, ccy)} ÷ {finite(m.avgLoss) ? fmtMoney(-m.avgLoss, ccy) : '—'}) · Net <strong>{fmtMoney(m.net, ccy)}</strong>
        </div>
        <RStrip rows={m.rows} />
      </>}
      {d && <div style={{ fontSize: 'var(--fs-body)', color: SB }}>
        {a.days30.days} days, bot only: {d.n ? <>{d.n} trades · win {fmtPct(d.winRatePct)} · PF {fmtPf(d.profitFactor, d)} · {fmtR(d.expectancyR)} per trade · net {fmtMoney(d.net, ccy)}</> : 'no closed bot trades.'}
      </div>}
      {m.rows.length > 0 && <details>
        <summary style={{ fontSize: 'var(--fs-body)', color: TX, cursor: 'pointer', minHeight: 32, display: 'flex', alignItems: 'center' }}>Last {m.rows.length} trades</summary>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {m.rows.map(r => (
            <li key={r.id} style={{ borderTop: `1px solid ${BD}`, padding: '4px 0', fontSize: 'var(--fs-body)', color: TX, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <strong>{r.symbol || '—'}</strong>
                <span>{r.side || '—'}</span>
                <span style={{ color: SB, overflowWrap: 'anywhere' }}>{r.strategy || 'no strategy'}</span>
                {r.source && ['external', 'manual'].includes(String(r.source).toLowerCase()) && <span style={{ color: MU }}>({r.source})</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
                <span>{finite(r.realised_rr) ? fmtR(r.realised_rr) : 'R —'}</span>
                <span>{fmtMoney(r.net_pnl, ccy)}</span>
                <span style={{ color: SB, overflowWrap: 'anywhere' }}>{r.close_reason || 'no close reason'}</span>
                <span style={{ color: MU }}>{fmtWhen(r.closed_at)}</span>
              </div>
            </li>
          ))}
        </ol>
      </details>}
    </article>
  )
}

/** Pure view: one report in, the card's body out. */
export function ScoreboardView({ report, error = null, selected = null }) {
  if (!report) {
    return <p role="status" style={{ fontSize: 'var(--fs-body)', color: error ? DN : SB }}>
      {error ? `Scoreboard unavailable: ${error}` : 'Reading the scoreboard…'}
    </p>
  }
  const accounts = [...(report.accounts || [])].sort((a, b) =>
    Number(String(b.accountId) === String(selected)) - Number(String(a.accountId) === String(selected))
    || (Date.parse(b.lastCloseAt || '') || 0) - (Date.parse(a.lastCloseAt || '') || 0))
  const p = report.pooled?.days30Bot
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <p role="status" style={{ fontSize: 'var(--fs-body)', color: error ? DN : SB, margin: 0 }}>
        {error ? `Last read failed (${error}); showing the read from ${fmtWhen(report.at)}.` : `Read ${fmtWhen(report.at)} · refreshes every minute while active.`}
        {' '}Recorded ledger figures, each account in its own currency; money is never added across accounts.
      </p>
      {accounts.length > 1 && p && p.n > 0 && <p style={{ fontSize: 'var(--fs-body)', color: TX, margin: 0 }}>
        All accounts, {report.days} days, bot only: {p.n} trades · win {fmtPct(p.winRatePct)} · {fmtR(p.expectancyR)} per trade (R pooled; no money total).
      </p>}
      {accounts.length === 0 && <p style={{ fontSize: 'var(--fs-body)', color: SB, margin: 0 }}>No accounts to show.</p>}
      {accounts.map(a => <AccountScore key={a.accountId} a={a} />)}
    </div>
  )
}

export default function Scoreboard() {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => startScoreboardPolling({
    onReport: r => { setReport(r); setError(null) },
    onError: message => setError(message),
  }), [])
  return (
    <Card id="sec-scoreboard" scope="all" loading={!report && !error}>
      <h2 className="t-h3">Scoreboard — last 20 closed trades per account</h2>
      <ScoreboardView report={report} error={error} selected={selectedAccountId()} />
    </Card>
  )
}
