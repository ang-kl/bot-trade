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
// One compact row per account (Claude · № 12,989): a table on a wide screen,
// a tight block on a phone; the 20 rows behind a disclosure. Status
// never by colour alone: every figure carries its sign or its words, and the
// strip's bars sit ABOVE or BELOW a zero line as well as being coloured.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import { selectedAccountId } from '../lib/selected-account.js'
import { R_CLIP, finite, fmtPct, fmtR, fmtMoney, fmtPf, fmtPfR, fmtWhen, stripLabel, startScoreboardPolling } from '../lib/scoreboard-view.js'

const TX = 'var(--color-text)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const UP = 'var(--color-up)', DN = 'var(--color-down)', BD = 'var(--color-border)'

/** The last 20 trades' R as bars about a zero line, oldest on the left. */
export function RStrip({ rows }) {
  const list = [...rows].reverse()
  const W = 200, Hh = 30, mid = Hh / 2, slot = W / Math.max(20, list.length), bar = Math.max(2, slot * 0.7), half = mid - 2
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} width="100%" height={Hh} role="img" aria-label={stripLabel(rows)}
      preserveAspectRatio="none" style={{ display: 'block' }}>
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

// Claude · № 12,989 10-Oct (owner: "too much white spacing, and have to scroll
// down"): one compact ROW per account. Wide screens read it as a table under one
// header row (index.css .sb-*); a phone stacks the same cells in a tight block.
function Cell({ area, label, value, sub }) {
  return (
    <div className={`sb-cell sb-${area}`}>
      <span className="sb-cell-label">{label}</span>
      <span className="sb-big">{value}</span>
      {sub && <span className="sb-sub">{sub}</span>}
    </div>
  )
}

const counts = m => `${m.wins}W · ${m.losses}L${m.zeros ? ` · ${m.zeros} flat` : ''}`

function AccountScore({ a }) {
  const [open, setOpen] = useState(false)
  const m = a.last20, d = a.days30?.bot
  const ccy = a.currency
  const has = m.n > 0
  const avg = `avg win ${fmtMoney(m.avgWin, ccy)} · avg loss ${finite(m.avgLoss) ? fmtMoney(-m.avgLoss, ccy) : '—'}`
  return (
    <article className="sb-row" aria-label={`Account ${a.label}`}>
      <div className="sb-cell sb-acct">
        <span><strong className="sb-name">{a.label}</strong> <span className="sb-sub">{ccy || 'currency unverified'}</span></span>
        <span className="sb-sub">
          {!a.registered && 'not in the account registry · '}{m.n} closed{m.externalN ? ` · ${m.externalN} manual` : ''}
        </span>
        {m.rows.length > 0 && <button type="button" className="sb-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'} Last {m.rows.length} trades
        </button>}
      </div>
      {has ? <>
        <Cell area="wr" label="Win rate" value={fmtPct(m.winRatePct)} sub={counts(m)} />
        <Cell area="pf" label="Profit factor" value={fmtPf(m.profitFactor, m)} sub={`in R: ${fmtPfR(m)}`} />
        <Cell area="exp" label="Expectancy" value={fmtR(m.expectancyR)} sub={`${m.rScored} of ${m.n} with R`} />
        <div className="sb-cell sb-ratio" title={avg}>
          <span>Win ÷ loss <strong>{finite(m.payoff) ? m.payoff.toFixed(2) : '—'}</strong></span>
          <span>Net <strong>{fmtMoney(m.net, ccy)}</strong></span>
        </div>
        <div className="sb-cell sb-strip"><RStrip rows={m.rows} /></div>
      </> : <p className="sb-cell sb-empty">No closed trades recorded.</p>}
      <div className="sb-cell sb-d30">
        {d && <span><span className="sb-d30-label">{a.days30.days} days, bot only: </span>{d.n ? <>{d.n} trades · win {fmtPct(d.winRatePct)} · PF {fmtPf(d.profitFactor, d)} · {fmtR(d.expectancyR)}/trade · net {fmtMoney(d.net, ccy)}</> : 'no closed bot trades.'}</span>}
      </div>
      {open && <ol className="sb-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {m.rows.map(r => (
          <li key={r.id} style={{ borderTop: `1px solid ${BD}`, padding: '3px 0', fontSize: 'var(--fs-body)', color: TX, minWidth: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
            <strong>{r.symbol || '—'}</strong>
            <span>{r.side || '—'}</span>
            <span>{finite(r.realised_rr) ? fmtR(r.realised_rr) : 'R —'}</span>
            <span>{fmtMoney(r.net_pnl, ccy)}</span>
            <span style={{ color: SB, overflowWrap: 'anywhere' }}>{r.strategy || 'no strategy'}</span>
            {r.source && ['external', 'manual'].includes(String(r.source).toLowerCase()) && <span style={{ color: MU }}>({r.source})</span>}
            <span style={{ color: SB, overflowWrap: 'anywhere' }}>{r.close_reason || 'no close reason'}</span>
            <span style={{ color: MU }}>{fmtWhen(r.closed_at)}</span>
          </li>
        ))}
      </ol>}
    </article>
  )
}

/** The column names, shown once above the rows on a wide screen (CSS hides it on a phone). */
function HeadRow({ days }) {
  return (
    <div className="sb-row sb-head" aria-hidden="true">
      <span className="sb-cell sb-acct">Account</span>
      <span className="sb-cell sb-wr">Win rate</span>
      <span className="sb-cell sb-pf">Profit factor</span>
      <span className="sb-cell sb-exp">Expectancy</span>
      <span className="sb-cell sb-ratio">Win ÷ loss · net</span>
      <span className="sb-cell sb-strip">Last 20, R (old → new)</span>
      <span className="sb-cell sb-d30">{days} days, bot only</span>
    </div>
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
    <div className="sb-board">
      <p role="status" style={{ fontSize: 'var(--fs-body)', color: error ? DN : SB, margin: 0 }}>
        {error ? `Last read failed (${error}); showing the read from ${fmtWhen(report.at)}.` : `Read ${fmtWhen(report.at)} · every minute.`}
        {' '}Ledger figures; each account in its own currency, never added together.
        {accounts.length > 1 && p && p.n > 0 && <> <span style={{ color: TX }}>All accounts, {report.days} days, bot only: {p.n} trades · win {fmtPct(p.winRatePct)} · {fmtR(p.expectancyR)} per trade (R pooled; no money total).</span></>}
      </p>
      {accounts.length === 0 && <p style={{ fontSize: 'var(--fs-body)', color: SB, margin: 0 }}>No accounts to show.</p>}
      {accounts.length > 0 && <HeadRow days={report.days} />}
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
