import { useEffect, useState } from 'react'
import { agentGet, agentConfigured, pageAsleep } from '../lib/agent-api.js'
const value = n => n == null ? 'Unavailable' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })

export function AccountHistoryReading({ report, page = 0 }) {
  if (!report) return <p>Account history unavailable.</p>
  return <>
    <p>{report.points.length} retained observations in this page · {report.retentionDays} days of observation retention. {report.sampling}.</p>
    <p>Equity change: {value(report.equityChange)} {report.currency || '(currency unverified)'}. External-flow-adjusted change: {value(report.externalFlowAdjustedChange)}.</p>
    <p>{report.observationSpan ? `Change covers comparable observations on this page from ${new Date(report.observationSpan.from).toISOString()} to ${new Date(report.observationSpan.to).toISOString()}.` : 'At least two comparable observations at different times are required to measure change.'}</p>
    <p>Cashflow coverage: {report.cashflows.complete ? 'Complete for comparable equity observations' : report.cashflows.reason}. {report.note}</p>
    <p>Sampled drawdown: {value(report.sampledDrawdown)}. {report.drawdownBasis}.</p>
    {!report.summaryComplete && <p>This is a partial history window. Full-window adjusted change and drawdown are unavailable.</p>}
    <div className="overflow-x-auto"><table className="w-full text-left text-(length:--fs-body)">
      <thead><tr>{['Receipt time', 'Source / currency', 'Balance', 'Floating P&L', 'Equity', 'Protection'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
      <tbody>{report.points.slice().reverse().slice(page * 24, (page + 1) * 24).map(p => <tr key={p.rowId}>
        <td className="pr-3">{new Date(p.receivedAt).toLocaleString()}</td>
        <td className="pr-3">{p.source} / {p.currency || 'Unverified'}</td>
        <td className="pr-3" title={`Balance receipt: ${p.balanceReceivedAt ? new Date(p.balanceReceivedAt).toISOString() : 'unknown'}`}>{value(p.balance)}</td>
        <td className="pr-3">{value(p.openPnl)}</td><td className="pr-3">{value(p.equity)}</td>
        <td className="pr-3">{p.protection ? `${p.protection.missingSL} missing SL / ${p.protection.missingTP} missing TP` : 'Not observed in this record'}{p.error ? ` · ${p.error}` : ''}</td>
      </tr>)}</tbody>
    </table></div>
    <p>Showing observations {report.points.length ? page * 24 + 1 : 0}–{Math.min((page + 1) * 24, report.points.length)} of {report.points.length} in this batch. Fills and protection amendment events remain separate records.</p>
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
        try {
          const r = await agentGet(`/state/account-history?account=${encodeURIComponent(accountId)}&from=${from}&to=${to}${before == null ? '' : `&before=${before}`}`)
          if (r.accountId === accountId && r.from === from && r.to === to && Array.isArray(r.points)) report = r
        } catch { /* unavailable is not an empty history */ }
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
    if ((page + 1) * 24 < report.points.length) setPage(page + 1)
    else { setCursors([...cursors, report.nextBefore]); setPage(0) }
  }
  const newer = () => {
    if (page > 0) setPage(page - 1)
    else { setCursors(cursors.slice(0, -1)); setPage(Math.ceil(2000 / 24) - 1) }
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
        <button disabled={!report || ((page + 1) * 24 >= report.points.length && !report.hasMore)} onClick={older}>Older observations</button>
        <button onClick={reset}>Latest history</button></div>
    </>}
  </details></section>
}
