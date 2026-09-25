import { useState } from 'react'
import AccountHistory from './AccountHistory.jsx'
import { serverReadingsNotice } from '../lib/server-readings.js'

const amount = n => n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export default function CurrentAccountReadings({ report, accountId = 'all', history = false }) {
  const [expanded, setExpanded] = useState(null)
  const rows = (report?.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  if (!rows.length) return <p role="status">Current account readings unavailable.</p>
  const notice = serverReadingsNotice(report?.serverReadings)
  return <div className="text-(length:--fs-body)">
    <p>The server reads every account from the broker once a minute, whether or not this page is open; this page re-reads those readings every 10 seconds. Receipt times below show the age of the source.</p>
    {notice && <p role="status">{notice}</p>}
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-(length:--fs-body)">
      <thead><tr>{['Account', 'Currency', 'Balance', 'Floating now', 'Equity', 'Free margin', 'Broker receipt', ...(history ? ['History'] : [])].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
      <tbody>{rows.map(a => <tr key={a.accountId} className="border-t border-[var(--color-border)]">
        <td className="pr-3 py-2">{a.isLive ? 'Live' : 'Demo'} · {a.accountId}</td><td className="pr-3">{a.currency || 'Unverified'}</td>
        <td className="pr-3">{amount(a.balance)}</td><td className="pr-3">{amount(a.openPnl)}</td><td className="pr-3">{amount(a.equity)}</td><td className="pr-3">{amount(a.freeMargin)}</td>
        <td className="pr-3">{a.snapshotAt ? new Date(a.snapshotAt).toLocaleTimeString() : 'Not available'} · {a.status}{a.reason ? ` · ${a.reason.replaceAll('_', ' ')}` : ''}</td>
        {history && <td><button onClick={() => setExpanded(expanded === a.accountId ? null : a.accountId)} aria-expanded={expanded === a.accountId}>{expanded === a.accountId ? 'Hide history' : 'View history'}</button></td>}
      </tr>)}</tbody>
    </table></div>
    {history && rows.some(a => a.accountId === expanded) && <AccountHistory key={expanded} accountId={expanded} />}
  </div>
}
