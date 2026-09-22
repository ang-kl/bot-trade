import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from '../lib/agent-api.js'

const LABELS = { upstream_stop: 'Upstream stops', risk_refusal: 'Risk refusals', post_approval_failure: 'After-approval failures', approved: 'Risk approvals', placement_receipt: 'Placement receipts', other_stop: 'Other recorded stops' }

export function BlockerReading({ report, error }) {
  if (!report) return <p role="status">Blocker report unavailable{error ? `: ${error}` : '.'}</p>
  return <>
    <p>{report.totalRecords} retained records in this window. {report.countBasis}</p>
    <p>{report.scopeNote} Unassigned records in the window: {report.unattributedRecordsInWindow}.</p>
    <dl className="flex flex-wrap gap-4 my-2">{Object.entries(LABELS).map(([key, label]) => <div key={key}>
      <dt>{label}</dt><dd className="font-semibold">{report.summary[key]?.records ?? 'Not recorded'} records</dd>
    </div>)}</dl>
    {report.records.length === 0 ? <p>No retained decision records in this window. This does not prove that scanning ran or found no signals.</p>
      : <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
        <thead><tr>{['Recorded time', 'Account / instrument', 'Observed result', 'First recorded blocker', 'Evidence'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
        <tbody>{report.records.map(row => <tr key={row.recordId} className="border-t border-[var(--color-border)]">
          <td className="pr-3 py-2">{row.at}</td>
          <td className="pr-3">{row.accountId || 'Unattributed'} / {row.symbol || 'Account-wide'}</td>
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
  return <section className="my-3 p-3 border border-[var(--color-border)] rounded" aria-label="Recorded entry blockers">
    <h2 className="font-semibold">Recorded entry blockers</h2>
    <label>Decision window <select value={hours} onChange={e => { setHours(Number(e.target.value)); setOffset(0); setWindowEnd(null) }}>
      <option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>72 hours</option>
    </select></label>
    <BlockerReading report={report} error={valid ? reading.error : null} />
    <div className="flex gap-3 mt-2"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer records</button>
      <button disabled={!report?.hasMore} onClick={() => { setWindowEnd(report.to); setOffset(report.nextOffset) }}>Older records</button>
      <button onClick={() => { setWindowEnd(null); setOffset(0) }}>Latest decisions</button></div>
  </section>
}
