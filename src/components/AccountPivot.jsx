// Pivot: rows = type of trading (strategy), columns = market open / market
// closed right now. Owner: "pivot table of my account and columns of types
// of trading, market open trading, market close trading." Built from the
// SAME per-position rows the positions table renders (acct.positions),
// each already carrying `strategy` and `marketOpen` (server-computed via
// agent/lib/sessions.js isSymbolMarketOpen — real broker-hours logic, not a
// guess) — so this table can't drift from what's actually open.
import Card from './common/Card.jsx'

function fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function AccountPivot({ acct }) {
  const positions = acct?.positions || []
  if (positions.length === 0) return null

  const rows = new Map() // strategy -> { open: {count,pnl}, closed: {count,pnl} }
  for (const p of positions) {
    const key = p.strategy || 'manual / external'
    if (!rows.has(key)) rows.set(key, { open: { count: 0, pnl: 0 }, closed: { count: 0, pnl: 0 } })
    const bucket = p.marketOpen === false ? 'closed' : 'open' // unknown market status defaults to "open" bucket
    const cell = rows.get(key)[bucket]
    cell.count += 1
    cell.pnl += p.netPnl ?? 0
  }

  const totals = { open: { count: 0, pnl: 0 }, closed: { count: 0, pnl: 0 } }
  for (const r of rows.values()) {
    totals.open.count += r.open.count; totals.open.pnl += r.open.pnl
    totals.closed.count += r.closed.count; totals.closed.pnl += r.closed.pnl
  }

  return (
    <Card>
      <div className="text-[12px] font-semibold mb-2">By trading type — market open vs. closed</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[var(--color-text-sub)]">
              <th className="font-medium pb-1 pr-3">Type of trading</th>
              <th className="font-medium pb-1 pr-3">Market open trading</th>
              <th className="font-medium pb-1">Market closed trading</th>
            </tr>
          </thead>
          <tbody>
            {[...rows.entries()].map(([strategy, r]) => (
              <tr key={strategy} className="border-t border-[var(--glass-edge)]">
                <td className="py-1 pr-3 capitalize">{strategy}</td>
                <td className="py-1 pr-3 tabular-nums">{r.open.count} pos · {fmtMoney(r.open.pnl)}</td>
                <td className="py-1 tabular-nums">{r.closed.count} pos · {fmtMoney(r.closed.pnl)}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--glass-edge)] font-semibold">
              <td className="py-1 pr-3">Total</td>
              <td className="py-1 pr-3 tabular-nums">{totals.open.count} pos · {fmtMoney(totals.open.pnl)}</td>
              <td className="py-1 tabular-nums">{totals.closed.count} pos · {fmtMoney(totals.closed.pnl)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-[var(--color-text-sub)] mt-1">
        "Market closed" positions are still open trades whose symbol's market is shut right now (weekend/after-hours) — they carry gap risk until it reopens.
      </p>
    </Card>
  )
}
