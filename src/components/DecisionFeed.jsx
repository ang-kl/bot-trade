// DecisionFeed — "why didn't it trade?", on the page where the question gets
// asked.
//
// decision_log has recorded every upstream skip since the 3A slice and nothing
// read it but a raw-rows endpoint. Raw rows are the wrong shape: one waiting
// setup re-logs the same skip every five-minute cycle, so a hundred identical
// lines is not a hundred findings. The mix is the finding.
//
// The panel therefore leads with the DECOMPOSITION — stage, then the ranked
// reasons under it — and puts the instances behind a disclosure. Each stage
// carries how many distinct instruments produced it, because that is what
// separates "three setups retrying all afternoon" from "a filter rejecting the
// whole universe". Those two look identical in a log and need opposite
// responses.
//
// Scope follows the sidebar account, and says so. Rows with no account stamped
// (they predate per-account stamping, or are account-independent market
// observations) are INCLUDED in a scoped read — that is the convention the
// rest of the read side uses — and counted out loud, so a per-account number
// is never quietly built from shared rows.
import { useCallback, useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import { useAccountSwitch } from '../lib/use-account-switch.js'
import { selectedAccountId, accountLabel } from '../lib/selected-account.js'
import { WINDOWS, DECISION_TONE, repeatReading, ago, toText } from '../lib/decision-feed-view.js'
import Badge from './common/Badge.jsx'
import Segmented from './common/Segmented.jsx'
import SectionTools from './common/SectionTools.jsx'
import { strategyLabel } from '../lib/strategy-labels.js'

const MU = 'var(--color-muted)', SB = 'var(--color-text-sub)', ACC = 'var(--color-accent)'
const GL = 'var(--color-surface)', GBD = 'var(--color-border)'

// Both the desktop and the mobile shell mount this component — the split is
// CSS (`hidden min-[700px]:block` beside `min-[700px]:hidden`), so both are in
// the DOM on every viewport. Without sharing, one page load fires the same
// query twice, and worse, two independent answers can disagree: the phone and
// the desktop would show different counts for the same window. Keyed by the
// query, because window and scope are the only things that change it.
const inFlight = new Map()
function fetchFeed(url) {
  if (!inFlight.has(url)) {
    inFlight.set(url, agentGet(url).finally(() => inFlight.delete(url)))
  }
  return inFlight.get(url)
}

/**
 * @param {{s: object, fill?: boolean}} props
 *   fill — stack full width instead of sitting in a wrapping row. NOT
 *   cosmetic: `flex: 1 1 300px` resolves against the MAIN axis, so the desktop
 *   basis that means "at least 300px wide" in a row container would mean "300px
 *   TALL" in the phone's column container. Same value, different axis, and the
 *   card would have rendered as a stack of 300px-tall boxes.
 */
export function StageBlock({ s, fill = false }) {
  const reading = repeatReading(s)
  return (
    <div style={{
      background: GL, border: `1px solid ${GBD}`, borderRadius: 10, padding: '5px 8px',
      ...(fill ? { width: '100%', minWidth: 0 } : { flex: '1 1 300px', minWidth: 260 }),
    }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold" style={{ color: ACC }}>{s.stage}</span>
        <span className="tabular-nums font-semibold">{s.count.toLocaleString()}</span>
        {Object.entries(s.decisions).map(([d, n]) => (
          <Badge key={d} tone={DECISION_TONE[d] || 'neutral'}>{d} {n.toLocaleString()}</Badge>
        ))}
        <span style={{ marginLeft: 'auto', color: MU }}>{ago(s.lastAt)}</span>
      </div>
      {reading && <div style={{ color: SB }}>{reading}</div>}
      <ul className="mt-0.5">
        {s.reasons.map((r, i) => (
          <li key={`${r.reason}-${r.decision}-${i}`} style={{ color: SB }}>
            <span className="tabular-nums font-semibold">{r.count.toLocaleString()}×</span>{' '}
            {/* An unrecorded reason is named as such rather than rendered as
                an empty line the eye slides past. */}
            {r.reason ?? <em>no reason recorded</em>}
          </li>
        ))}
        {s.moreReasons > 0 && <li style={{ color: MU }}>… and {s.moreReasons} more reasons</li>}
      </ul>
    </div>
  )
}

export function RowsTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr className="text-left" style={{ color: SB }}>
            <th className="py-1 pr-2 font-semibold">When</th>
            <th className="py-1 pr-2 font-semibold">Symbol</th>
            <th className="py-1 pr-2 font-semibold">Strategy</th>
            <th className="py-1 pr-2 font-semibold">Stage</th>
            <th className="py-1 pr-2 font-semibold">Decision</th>
            <th className="py-1 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="py-1 pr-2 whitespace-nowrap" style={{ color: SB }}>{ago(r.created_at)}</td>
              <td className="py-1 pr-2 font-semibold">{r.symbol || '—'}</td>
              <td className="py-1 pr-2" style={{ color: SB }}>{strategyLabel(r.strategy) || '—'}</td>
              <td className="py-1 pr-2">{r.stage}</td>
              <td className="py-1 pr-2"><Badge tone={DECISION_TONE[r.decision] || 'neutral'}>{r.decision}</Badge></td>
              <td className="py-1" style={{ color: SB }}>{r.reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * @param {{variant?: 'full'|'compact'}} props
 *   compact — the phone form. The DECOMPOSITION is the substance, so it stays:
 *   the busiest stages with their reasons and their repeat reading. What goes
 *   is the width — one stage per row — and the depth: the tail of stages and
 *   the individual rows sit behind disclosures rather than filling the screen.
 */
export default function DecisionFeed({ variant = 'full' }) {
  const [hours, setHours] = useState(WINDOWS[1])
  const [scope, setScope] = useState(() => selectedAccountId() ?? 'all')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [showRows, setShowRows] = useState(false)

  const feedUrl = useCallback((h, acct) =>
    `/state/decision-feed?hours=${h}&limit=60${acct && acct !== 'all' ? `&account=${encodeURIComponent(acct)}` : ''}`, [])

  useEffect(() => {
    let alive = true
    fetchFeed(feedUrl(hours, scope))
      .then(d => { if (alive) { setData(d); setErr(d?.error || null) } })
      .catch(e => { if (alive) setErr(e?.message || String(e)) })
    return () => { alive = false }
  }, [hours, scope, feedUrl])

  // Follow the sidebar switch: the question "why didn't it trade" is always
  // about a particular account, and leaving the previous one's decisions on
  // screen under a new account's name is the exact confusion the scope work
  // earlier today was about.
  useAccountSwitch(useCallback((ev) => { setScope(String(ev?.to ?? selectedAccountId() ?? 'all')) }, []))

  // Only render a payload that matches the CURRENT window, so a slow fetch
  // cannot show 6-hour counts under a 72-hour label.
  const shown = data && Number(data.windowHours) === Number(hours) ? data : null

  if (variant === 'compact') {
    const stages = shown?.stages || []
    const top = stages.slice(0, 2)
    const rest = stages.slice(2)
    return (
      <div id="sec-decisions-mobile" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--fs-d12)', fontWeight: 800, color: ACC }}>Why it did or did not trade</span>
          <Segmented label="Decision window" value={String(hours)}
            options={WINDOWS.map(h => ({ value: String(h), label: `${h}h` }))}
            onChange={v => setHours(Number(v))} />
        </span>

        {err && <span style={{ fontSize: 'var(--fs-d9)', color: 'var(--color-down)' }}>Unavailable: {err}</span>}
        {!shown && !err && <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>Loading…</span>}

        {shown && shown.total === 0 && (
          <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
            Nothing recorded in the last {shown.windowHours}h — a quiet window, or a controller that is not
            running. The agent health dot in the sidebar says which.
          </span>
        )}

        {shown && shown.total > 0 && (
          <>
            <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
              {shown.total.toLocaleString()} decisions ·{' '}
              {shown.accountId ? `account ${shown.accountId}` : 'all accounts'}
              {shown.unstamped > 0 && <> · {shown.unstamped.toLocaleString()} unstamped, included</>}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} className="text-[9px]">
              {top.map(s2 => <StageBlock key={s2.stage} s={s2} fill />)}
            </div>
            {rest.length > 0 && (
              <details>
                <summary style={{ fontSize: 'var(--fs-d9)', color: SB, cursor: 'pointer' }}>
                  {rest.length} more {rest.length === 1 ? 'stage' : 'stages'}
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }} className="text-[9px]">
                  {rest.map(s2 => <StageBlock key={s2.stage} s={s2} fill />)}
                </div>
              </details>
            )}
            <details>
              <summary style={{ fontSize: 'var(--fs-d9)', color: SB, cursor: 'pointer' }}>
                {shown.rows.length} newest decisions{shown.truncated ? ' (capped)' : ''}
              </summary>
              <div style={{ marginTop: 4 }}><RowsTable rows={shown.rows} /></div>
            </details>
          </>
        )}
      </div>
    )
  }

  return (
    <div id="sec-decisions" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span style={{ fontSize: 'var(--fs-d12)', fontWeight: 800, color: ACC }}>Decision Feed card</span>
        <Segmented label="Decision window" value={String(hours)}
          options={WINDOWS.map(h => ({ value: String(h), label: `${h}h` }))}
          onChange={v => setHours(Number(v))} />
        <Segmented label="Decision scope" value={String(scope)}
          options={[
            { value: 'all', label: 'All accounts' },
            ...(selectedAccountId() != null
              ? [{ value: String(selectedAccountId()), label: accountLabel(selectedAccountId()) || String(selectedAccountId()) }]
              : []),
          ]}
          onChange={v => setScope(String(v))} />
        {shown && (
          <SectionTools id="decisions" title="Decision Feed card" window={`${hours}H`}
            data={shown} toText={() => toText(shown)}
            render={() => (
              <>
                <div className="flex flex-wrap gap-1.5">{shown.stages.map(s => <StageBlock key={s.stage} s={s} />)}</div>
                <RowsTable rows={shown.rows} />
              </>
            )} />
        )}
      </div>
      <span style={{ fontSize: 'var(--fs-d9)', color: SB }}>
        Every decision taken upstream of the risk gate — what stopped a setup before it became an order.
        Counts include repeats: one waiting setup re-logs its skip every five-minute cycle, so each stage
        also says how many different instruments produced it.
      </span>

      {err && <span style={{ fontSize: 'var(--fs-d9)', color: 'var(--color-down)' }}>Decision feed unavailable: {err}</span>}
      {!shown && !err && <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>Loading…</span>}

      {shown && shown.total === 0 && (
        <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
          No decisions recorded in the last {shown.windowHours}h
          {shown.accountId ? ` for account ${shown.accountId}` : ''}. That is either a quiet window or a
          controller that is not running — the Agent heartbeats say which.
        </span>
      )}

      {shown && shown.total > 0 && (
        <>
          <span style={{ fontSize: 'var(--fs-d9)', color: MU }}>
            {shown.total.toLocaleString()} decisions in {shown.windowHours}h ·{' '}
            {shown.accountId ? `account ${shown.accountId}` : 'all accounts'}
            {shown.unstamped > 0 && (
              <> · <strong>{shown.unstamped.toLocaleString()}</strong> carry no account stamp and are included here</>
            )}
          </span>
          <div className="flex flex-wrap gap-1.5 text-[9px]">
            {shown.stages.map(s => <StageBlock key={s.stage} s={s} />)}
          </div>
          <button
            type="button"
            aria-expanded={showRows}
            onClick={() => setShowRows(v => !v)}
            className="self-start text-[9px] glass-inset rounded-[var(--radius-control)] px-2.5 py-1 cursor-pointer"
          >
            {showRows ? '▾' : '▸'} {shown.rows.length} newest decisions{shown.truncated ? ' (capped)' : ''}
          </button>
          {showRows && <RowsTable rows={shown.rows} />}
        </>
      )}
    </div>
  )
}
