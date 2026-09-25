import { useEffect, useState } from 'react'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
import { HISTORY_PAGE_LIMIT, HISTORY_ROWS_PER_PAGE, fetchAccountHistory } from '../lib/account-history-request.js'
const value = n => n == null ? 'Unavailable' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
const iso = at => new Date(at).toISOString()
const ROWS_PER_PAGE = HISTORY_ROWS_PER_PAGE

function Buckets({ report }) {
  const rows = report.buckets
  if (!Array.isArray(rows) || !rows.length) return null
  const gaps = rows.filter(b => !b.observations).length
  const uncovered = rows.filter(b => b.cashflows && !b.cashflows.covered).length
  const flow = b => !b.cashflows ? 'Outside comparable span' : !b.cashflows.covered ? 'Not covered'
    : b.cashflows.external == null ? `${b.cashflows.unclassified} unclassified` : value(b.cashflows.external)
  return <details><summary>Whole window in {rows.length} buckets of {Math.round(report.bucketMs / 60_000)} minutes · {gaps} with no observation · {uncovered} without cashflow coverage</summary>
    <p>{report.bucketBasis}.</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
      <thead><tr>{['Bucket start (UTC)', 'Observations', 'First', 'Last', 'Low', 'High', 'External flows'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
      <tbody>{rows.slice().reverse().map(b => <tr key={b.from}>
        <td className="pr-3">{iso(b.from)}</td>
        <td className="pr-3">{b.observations ? `${b.observations}${b.mixedUnits ? ' (mixed currency or host)' : ''}` : 'Gap: none retained'}</td>
        <td className="pr-3">{value(b.first?.equity)}</td><td className="pr-3">{value(b.last?.equity)}</td>
        <td className="pr-3">{value(b.min)}</td><td className="pr-3">{value(b.max)}</td>
        <td className="pr-3">{flow(b)}</td>
      </tr>)}</tbody>
    </table></div>
  </details>
}

export function AccountHistoryReading({ report, page = 0 }) {
  if (!report) return <p>Account history unavailable.</p>
  // Only the server's own declaration makes a summary whole-window.
  const whole = report.summaryScope === 'full_window' && report.summaryComplete === true
  return <>
    <p>{report.points.length} retained observations in this page{report.summaryObservations == null ? '' : ` of ${report.summaryObservations} in the window`} · {report.retentionDays} days of observation retention. {report.sampling}.</p>
    {report.recording && <p>Background broker recording: {report.recording.active ? 'active' : 'unavailable'}.
      {' '}Latest observation in this {whole ? 'window' : 'page'}: {report.latestObservationAt ? iso(report.latestObservationAt) : 'Not observed'}.
      {' '}Latest comparable equity: {report.latestEquityAt ? new Date(report.latestEquityAt).toISOString() : 'Not observed'}.
      {(report.recording.dropped > 0 || report.recording.failed > 0) && ` ${report.recording.dropped} observations dropped; ${report.recording.failed} recording failures in this process.`}</p>}
    <p>Equity change: {value(report.equityChange)} {report.currency || '(currency unverified)'}. External-flow-adjusted change: {value(report.externalFlowAdjustedChange)}.</p>
    <p>{report.observationSpan ? `Change covers comparable observations ${whole ? 'across the whole window' : 'on this page'} from ${iso(report.observationSpan.from)} to ${iso(report.observationSpan.to)}.` : 'At least two comparable observations at different times are required to measure change.'}</p>
    <p>Cashflow coverage: {report.cashflows.complete ? 'Complete for comparable equity observations' : report.cashflows.reason}. {report.note}</p>
    {report.cashflowCollection && <p>Cashflow collection: {report.cashflowCollection.status}{report.cashflowCollection.reason ? ` (${report.cashflowCollection.reason})` : ''}.
      {' '}Last successful read: {report.cashflowCollection.lastSuccessAt ? new Date(report.cashflowCollection.lastSuccessAt).toISOString() : 'Not yet observed'}.</p>}
    {report.reconciledSpan && <p>Reconciled portion only: {new Date(report.reconciledSpan.from).toISOString()} to {new Date(report.reconciledSpan.to).toISOString()}.
      {' '}External-flow-adjusted change: {value(report.reconciledSpan.externalFlowAdjustedChange)} {report.reconciledSpan.currency}.
      {' '}{report.reconciledSpan.pendingObservations} later equity observations await cashflow coverage. The full-window change remains unavailable.</p>}
    <p>Sampled drawdown: {value(report.sampledDrawdown)}. {report.drawdownBasis}.</p>
    {!report.summaryComplete && <p>This is a partial history window. Full-window adjusted change and drawdown are unavailable.</p>}
    <Buckets report={report} />
    <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
      <thead><tr>{['Receipt time', 'Source / currency', 'Balance', 'Floating P&L', 'Equity', 'Protection'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
      <tbody>{report.points.slice().reverse().slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE).map(p => <tr key={p.rowId}>
        <td className="pr-3">{new Date(p.receivedAt).toLocaleString()}</td>
        <td className="pr-3">{p.source} / {p.currency || 'Unverified'}</td>
        <td className="pr-3" title={`Balance receipt: ${p.balanceReceivedAt ? new Date(p.balanceReceivedAt).toISOString() : 'unknown'}`}>{value(p.balance)}</td>
        <td className="pr-3">{value(p.openPnl)}</td><td className="pr-3">{value(p.equity)}</td>
        <td className="pr-3">{p.protection ? `${p.protection.missingSL} missing SL / ${p.protection.missingTP} missing TP` : 'Not observed in this record'}{p.error ? ` · ${p.error}` : ''}</td>
      </tr>)}</tbody>
    </table></div>
    <p>Showing observations {report.points.length ? page * ROWS_PER_PAGE + 1 : 0}–{Math.min((page + 1) * ROWS_PER_PAGE, report.points.length)} of {report.points.length} in this batch. Fills and protection amendment events remain separate records.</p>
  </>
}

export default function AccountHistory({ accountId }) {
  const [days, setDays] = useState(1), [reading, setReading] = useState(null)
  const [page, setPage] = useState(0), [cursors, setCursors] = useState([]), [windowEnd, setWindowEnd] = useState(null)
  const before = cursors.at(-1) ?? null
  useEffect(() => {
    let stopped = false, generation = 0
    const refresh = async () => {
      const mine = ++generation
      let report = null
      if (accountId !== 'all' && agentConfigured()) {
        const to = windowEnd ?? Date.now(), from = to - days * 86400_000
        report = await fetchAccountHistory(agentGet, { accountId, from, to, before })
      }
      if (!stopped && mine === generation) setReading({ accountId, days, before, report })
    }
    const kick = setTimeout(refresh, 0)
    const interval = setInterval(() => { if (windowEnd == null && !pageAsleep()) refresh() }, 60_000)
    return () => { stopped = true; clearTimeout(kick); clearInterval(interval) }
  }, [accountId, days, before, windowEnd])
  const report = reading?.accountId === accountId && reading?.days === days && reading?.before === before ? reading.report : null
  const reset = () => { setPage(0); setCursors([]); setWindowEnd(null) }
  const older = () => {
    if (windowEnd == null) setWindowEnd(report.to)
    if ((page + 1) * ROWS_PER_PAGE < report.points.length) setPage(page + 1)
    else { setCursors([...cursors, report.nextBefore]); setPage(0) }
  }
  const newer = () => {
    if (page > 0) setPage(page - 1)
    else { setCursors(cursors.slice(0, -1)); setPage(Math.ceil(HISTORY_PAGE_LIMIT / ROWS_PER_PAGE) - 1) }
  }
  return <section className="my-3 p-3 border border-[var(--color-border)] rounded" aria-label="Account history">
    <p className="font-semibold">History scope: {accountId === 'all' ? 'All accounts — select an account to inspect history' : `Account ${accountId}`}</p>
    <details><summary className="font-semibold">Account balance, equity and cashflows</summary>
    {accountId === 'all' ? <p>Select an account to inspect its native-currency history.</p> : <>
      <label>History window <select value={days} onChange={e => { setDays(Number(e.target.value)); reset() }}>
        <option value={1}>24 hours</option><option value={7}>7 days</option><option value={30}>30 days</option>
      </select></label>
      <AccountHistoryReading report={report} page={page} />
      <div className="flex gap-3 mt-2"><button disabled={!report || (page === 0 && !cursors.length)} onClick={newer}>Newer observations</button>
        <button disabled={!report || ((page + 1) * ROWS_PER_PAGE >= report.points.length && !report.hasMore)} onClick={older}>Older observations</button>
        <button onClick={reset}>Latest history</button></div>
    </>}
  </details></section>
}
