import { populationStats } from '../../agent/shared/performance-populations.js'

export default function AllTimeAccounts({ report, overview, accountId }) {
  const accounts = (overview?.accounts || []).filter(a => accountId === 'all' || a.accountId === String(accountId))
  return <div className="overflow-x-auto">
    <p>All-time recorded closes per account · historical P&amp;L in recorded account units; current equity in the broker’s stated currency.</p>
    <table className="w-full min-w-[650px] text-left text-(length:--fs-body)">
      <thead><tr>{['Account', 'Closes', 'Priced', 'Win rate', 'Recorded realised P&L', 'Current equity'].map(h => <th key={h} className="pr-3">{h}</th>)}</tr></thead>
      <tbody>{accounts.map(a => {
        const s = populationStats((report?.daily || []).filter(g => g.accountId === a.accountId), { accountId: a.accountId, available: report?.status === 'complete' })
        return <tr key={a.accountId}><td className="pr-3 py-1">{a.accountId}</td><td>{s.n ?? '—'}</td><td>{s.pricedN ?? '—'}</td>
          <td>{s.wr == null ? '—' : `${s.wr.toFixed(1)}%`}</td><td>{s.pnl?.toFixed(2) ?? '—'}</td><td>{a.equity?.toFixed(2) ?? '—'} {a.currency}</td></tr>
      })}</tbody>
    </table>
  </div>
}
