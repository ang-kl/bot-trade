// Account Health — one authoritative reconciliation table per account:
// balance/equity/margin/buffer plus total SL/TP dollar impact, all computed
// server-side from the SAME per-position figures the positions table below
// uses (not a second guess at the numbers — that's what caused the earlier
// 3-way mismatch between this app, cTrader and Pepperstone's own header).
// Owner: "another row gross and nett (for SL and TP) ... column for
// percentage" — reads from acct.health (see /actions/broker-positions).
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'

function fmtMoney(n, ccy) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  const s = Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return ccy ? `${s} ${ccy}` : s
}
function fmtPct(n, signed = true) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(2)}%`
}
function toneFor(n) {
  if (n == null) return 'neutral'
  return n > 0 ? 'up' : n < 0 ? 'down' : 'neutral'
}

// Owner (2026-07-24): fill the "% of balance" column for EVERY row —
// rows without a server-computed pct derive it client-side from the same
// balance figure (v / balance × 100). Signed rows keep their +/-; the
// stock rows (balance/equity/margin) read as plain percentages.
const ROWS = [
  { key: 'balance', label: 'Account balance', pctKey: null },
  { key: 'equity', label: 'Equity (balance + floating P/L)', pctKey: null },
  { key: 'usedMargin', label: 'Margin used', pctKey: null },
  { key: 'freeMargin', label: 'Free margin (your buffer)', pctKey: null },
  { key: 'unrealizedNetPnl', label: 'Unrealized P/L (net)', pctKey: 'unrealizedNetPnlPct', signed: true },
  { key: 'slGrossTotal', label: 'If ALL stop losses hit — gross', pctKey: null, signed: true },
  { key: 'slNetTotal', label: 'If ALL stop losses hit — net', pctKey: 'slNetTotalPct', signed: true },
  { key: 'tpGrossTotal', label: 'If ALL take profits hit — gross', pctKey: null, signed: true },
  { key: 'tpNetTotal', label: 'If ALL take profits hit — net', pctKey: 'tpNetTotalPct', signed: true },
]

export default function AccountHealth({ acct }) {
  const h = acct?.health
  if (!h) return null
  const ccy = acct.currency || ''
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-[12px] font-semibold">Account health</div>
        <Badge tone={acct.isLive ? 'down' : 'info'}>{acct.isLive ? 'LIVE' : 'DEMO'}</Badge>
        {acct.traderLogin && <span className="text-[11px] text-[var(--color-text-sub)]">Login {acct.traderLogin}</span>}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-text-sub)]">
          {(h.positionsInProfit != null || h.positionsInLoss != null) && (
            <span>
              Open book: <span className="font-semibold text-[var(--color-up)]">{h.positionsInProfit ?? 0} winning</span>
              {' · '}
              <span className="font-semibold text-[var(--color-down)]">{h.positionsInLoss ?? 0} losing</span>
            </span>
          )}
          <span>
            Margin level: <span className="font-semibold text-[var(--color-text)]">{h.marginLevelPct != null ? `${h.marginLevelPct.toFixed(0)}%` : '— (no open positions)'}</span>
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[var(--color-text-sub)]">
              <th className="font-medium pb-1 pr-3">Metric</th>
              <th className="font-medium pb-1 pr-3">Amount</th>
              <th className="font-medium pb-1">% of balance</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(r => {
              const v = h[r.key]
              return (
                <tr key={r.key} className="border-t border-[var(--glass-edge)]">
                  <td className="py-1 pr-3">{r.label}</td>
                  <td className={`py-1 pr-3 font-semibold tabular-nums ${r.signed ? `text-[var(--color-${toneFor(v) === 'up' ? 'up' : toneFor(v) === 'down' ? 'down' : 'text'})]` : ''}`}>
                    {fmtMoney(v, ccy)}
                  </td>
                  <td className="py-1 tabular-nums text-[var(--color-text-sub)]">
                    {r.pctKey
                      ? fmtPct(h[r.pctKey])
                      : fmtPct(Number(h.balance) > 0 && v != null ? (Number(v) / Number(h.balance)) * 100 : null, !!r.signed)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
