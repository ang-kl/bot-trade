import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from '../lib/agent-api.js'
import Card from './common/Card.jsx'

const LABELS = { upstream_stop: 'Upstream stops', risk_refusal: 'Risk refusals', post_approval_failure: 'After-approval failures', tick_refusal: 'Tick sidecar refusals', approved: 'Risk approvals', placement_receipt: 'Placement receipts', other_stop: 'Other recorded stops' }

// V3 C4: whether tick entries were evaluated at all. Zero tick refusals on an
// account the sidecar never checked is not a pass, so the reason is shown.
function tickStatusText(a) {
  if (a.status === 'evaluated') return a.stoppedAt ? `Tick entries: evaluated — held at ${a.stoppedAt}: ${a.stoppedReason}` : 'Tick entries: evaluated'
  if (a.status === 'admitted_not_pushed') return `Tick entries: admitted but not pushed to the sidecar — ${a.because}`
  return `Tick entries: not evaluated — ${a.because}`
}
export function TickEvaluation({ tick }) {
  if (!tick) return <p>Tick entry evaluation was not included in this report.</p>
  return <section aria-label="Tick entry evaluation" className="my-2">
    <h3 className="font-semibold">Tick entries</h3>
    <p>{tick.evaluationNote}</p>
    <ul>{tick.accounts.map(a => {
      const refusals = Object.entries(a.sidecarRefusals || {})
      return <li key={a.accountId}>Account {a.accountId}: {tickStatusText(a)}.
        {' '}Readiness blockers: {a.readiness?.unavailable ? `unavailable (${a.readiness.unavailable})` : a.readiness?.blockedReasons?.length ? a.readiness.blockedReasons.join(', ') : 'none recorded'}.
        {' '}Sidecar refusals by code: {refusals.length ? refusals.map(([code, n]) => `${code} ×${n}`).join(', ') : 'none recorded in this window'}.</li>
    })}</ul>
    {tick.accountsTruncated && <p>Only the first 64 registered accounts are listed.</p>}
    {tick.sides && <ul>{tick.sides.map(s => <li key={s.side}>{s.side}: {s.entry
      ? `${s.entry.fills ?? 'unrecorded'} shadow fills since sidecar boot; ${s.entry.accounts ?? 'unrecorded'} accounts placing (read ${s.statusAt ?? 'time unrecorded'})`
      : 'no sidecar tick status recorded'}; signals in this window: {s.signalsInWindow.shadow} shadow, {s.signalsInWindow.shadow_cost} refused on cost, {s.signalsInWindow.shadow_busy} busy, {s.signalsInWindow.other} other.</li>)}</ul>}
  </section>
}

// V3 WEB-1: roster-wide stops (account-independent gates) are the same
// records under every account, charged to none. An account scope's counts
// above do not include them; the all-accounts scope's do. A server that does
// not report them says so — never a zero it did not measure.
export function RosterWideStops({ report }) {
  const roster = report.rosterWide
  if (!roster) return <p>Roster-wide stops: not reported by this agent version.</p>
  return <section aria-label="Roster-wide stops" className="my-2">
    <h3 className="font-semibold">Roster-wide stops (every account, charged to none): {roster.records} records</h3>
    <p>{roster.includedInTotals ? 'Included in the totals above.' : 'Not included in this account\'s totals above.'} {roster.note}</p>
    {roster.byStage.length > 0 && <ul>{roster.byStage.map(s => <li key={`${s.kind}|${s.stage}`}>
      {s.stage} ({LABELS[s.kind] || s.kind}) ×{s.records}{s.recordedAgainstAnAccount ? ` — ${s.recordedAgainstAnAccount} stored by an older build against the then-selected account` : ''}; latest: {s.lastReason || 'reason not recorded'}
    </li>)}</ul>}
  </section>
}

const accountCell = row => row.attribution === 'roster' ? 'Roster-wide (every account)'
  : `${row.accountId || 'Unattributed'}${row.unsplitHistory ? ' (recorded before the attribution fix; may not be this account\'s)' : ''}`

export function BlockerReading({ report, error }) {
  if (!report) return <p role="status">Blocker report unavailable{error ? `: ${error}` : '.'}</p>
  return <>
    <p>{report.totalRecords} retained records in this window. {report.countBasis}</p>
    <p>{report.scopeNote} Unassigned records in the window: {report.unattributedRecordsInWindow}.</p>
    <dl className="flex flex-wrap gap-4 my-2">{Object.entries(LABELS).map(([key, label]) => <div key={key}>
      <dt>{label}</dt><dd className="font-semibold">{report.summary[key]?.records ?? 'Not recorded'} records</dd>
    </div>)}</dl>
    {report.unsplitRecordsInWindow > 0 && <p>{report.unsplitRecordsInWindow} of these records cannot be split. {report.unsplitNote}</p>}
    <RosterWideStops report={report} />
    {report.records.length === 0 ? <p>No retained decision records in this window. This does not prove that scanning ran or found no signals.</p>
      : <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
        <thead><tr>{['Recorded time', 'Account / instrument', 'Observed result', 'First recorded blocker', 'Evidence'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
        <tbody>{report.records.map(row => <tr key={row.recordId} className="border-t border-[var(--color-border)]">
          <td className="pr-3 py-2">{row.at}</td>
          <td className="pr-3">{accountCell(row)} / {row.symbol || 'Account-wide'}</td>
          <td className="pr-3">{LABELS[row.kind]}<br />{row.stage}</td>
          <td className="pr-3 max-w-md whitespace-normal">{row.firstBlocker ? row.firstBlocker.reason || 'Reason not recorded' : row.kind === 'placement_receipt' ? 'None recorded; placement does not prove a fill' : 'None recorded; approval does not prove a fill'}</td>
          <td><details><summary>Recorded checks</summary>
            <p>{row.recordId} · {row.recordedEvaluations} recorded evaluations · {row.disposition || 'No terminal disposition recorded'}</p>
            <ul>{row.diagnostics.map(d => <li key={d.stage}>{d.stage}: {d.status.replaceAll('_', ' ')}</li>)}</ul>
            <p>{row.diagnosticNote}</p>
            <pre className="whitespace-pre-wrap max-w-lg break-words">{JSON.stringify(row.recordedChecks || row.detail || { checks: row.recordedChecksStatus }, null, 2)}</pre>
          </details></td>
        </tr>)}</tbody>
      </table></div>}
    <p>Showing records {report.totalRecords ? report.offset + 1 : 0}–{report.offset + report.records.length} of {report.totalRecords}. Totals include every retained record in the window.</p>
    <TickEvaluation tick={report.tick} />
  </>
}

export default function BlockerReport({ accountId }) {
  const [hours, setHours] = useState(24), [offset, setOffset] = useState(0), [reading, setReading] = useState(null)
  const [windowEnd, setWindowEnd] = useState(null)
  useEffect(() => {
    let stopped = false, generation = 0
    const refresh = async () => {
      const mine = ++generation, to = windowEnd ?? Date.now(), from = to - hours * 3600_000
      let report = null, error = null
      try {
        if (!agentConfigured()) throw new Error('Agent not connected')
        const r = await agentGet(`/state/blocker-report?account=${encodeURIComponent(accountId)}&from=${from}&to=${to}&offset=${offset}`)
        if (r.status !== 'complete' || r.accountId !== accountId || r.from !== from || r.to !== to || r.offset !== offset) throw new Error('Report identity or window mismatch')
        report = r
      } catch (e) { error = e.message }
      if (!stopped && mine === generation) setReading({ accountId, hours, offset, report, error })
    }
    const kick = setTimeout(refresh, 0)
    const timer = setInterval(() => { if (windowEnd == null && !pageAsleep()) refresh() }, 60_000)
    return () => { stopped = true; clearTimeout(kick); clearInterval(timer) }
  }, [accountId, hours, offset, windowEnd])
  const valid = reading?.accountId === accountId && reading?.hours === hours && reading?.offset === offset
  const report = valid ? reading.report : null
  return <Card id="sec-blockers" className="my-3 text-(length:--fs-body)" aria-label="Recorded entry blockers" scope={accountId}
    // PERF-1 (D8/D19 default): the plan measured this card at ~5,400px tall
    // at 390px — by far the longest card on the page — so it starts
    // collapsed until the operator opens it, the same as any other long
    // card would once §8's bare sections get a standard (out of scope here).
    defaultCollapsed loading={!report}>
    <h2 className="font-semibold">Recorded entry blockers</h2>
    <p className="font-semibold">Report scope: {accountId === 'all' ? 'All registered accounts' : `Account ${accountId}`}</p>
    {report && <p>Through {new Date(report.to).toLocaleString()}{windowEnd ? ' · browsing a fixed history window' : ' · updates every minute while active'}. Counts apply only to this account scope; roster-wide stops are listed separately.</p>}
    <label>Decision window <select value={hours} onChange={e => { setHours(Number(e.target.value)); setOffset(0); setWindowEnd(null) }}>
      <option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>72 hours</option>
    </select></label>
    <BlockerReading report={report} error={valid ? reading.error : null} />
    <div className="flex gap-3 mt-2"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer records</button>
      <button disabled={!report?.hasMore} onClick={() => { setWindowEnd(report.to); setOffset(report.nextOffset) }}>Older records</button>
      <button onClick={() => { setWindowEnd(null); setOffset(0) }}>Latest decisions</button></div>
  </Card>
}
