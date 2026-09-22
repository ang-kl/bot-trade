import { reportGroups, reportStats } from '../../agent/shared/performance-populations.js'
import { MARKET_COLS } from '../../agent/shared/formulas.js'
const UP = 'var(--color-up)', DOWN = 'var(--color-down)', MUTED = 'var(--color-muted)'
const format = v => (v < 0 ? '−' : '+') + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'k' : Math.abs(v).toFixed(2))
function cell(raw, max) {
  if (raw == null) return { v: '—', raw: null, col: MUTED, bg: 'transparent', zero: false }
  const zero = raw === 0, alpha = Math.pow(Math.abs(raw) / (max || 1), 0.6)
  return { v: zero ? '0' : format(raw), raw, zero, col: zero ? MUTED : raw > 0 ? UP : DOWN,
    bg: zero ? 'transparent' : `${raw > 0 ? 'rgba(79,140,255,' : 'rgba(255,77,109,'}${(0.04 + 0.14 * alpha).toFixed(2)})` }
}
export function performanceGradients(report, accounts, strategyLabel) {
  const accountCols = [...accounts.map(a => ({ name: a.name, accountId: a.id })), { name: 'Overall', accountId: 'all' }]
  // Rank by activity; incomparable monetary units cannot rank strategies.
  const counts = new Map()
  for (const g of reportGroups(report, '12m')) counts.set(g.strat, (counts.get(g.strat) || 0) + g.stats.n)
  const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s)
  const top = names.slice(0, 6), rest = new Set(names.slice(6))
  const strategies = [...top.map(name => ({ name: strategyLabel(name) || name, pick: g => g.strat === name })),
    ...(rest.size ? [{ name: 'Other', pick: g => rest.has(g.strat) }] : [])]
  const markets = MARKET_COLS.map(m => ({ name: m.label, pick: g => g.market === m.key }))
  const defs = (report?.windows || []).filter(w => w.ledger).map(w => ({ key: w.key, label: w.label }))
  const build = (rows, cols) => {
    const raw = rows.map(r => cols.map(c => reportStats(report, r.key, c.accountId || 'all', g => (!r.pick || r.pick(g)) && (!c.pick || c.pick(g))).pnl))
    const maxima = cols.map((_, i) => Math.max(1, ...raw.map(r => Math.abs(r[i] ?? 0))))
    return rows.map((r, i) => ({ label: r.label, cells: raw[i].map((v, j) => cell(v, maxima[j])) }))
  }
  // Exact numbers, never reparsed rounded display strings. These windows
  // overlap; their footing is not a unique-period profit measure.
  const subtotal = rows => rows.length ? rows[0].cells.map((_, i) => {
    const values = rows.map(r => r.cells[i].raw)
    return cell(values.some(v => v == null) ? null : values.reduce((s, v) => s + v, 0), 1)
  }) : null
  const tradingAccounts = new Set(reportGroups(report, '30d').map(g => g.accountId).filter(Boolean))
  const assetCols = tradingAccounts.size >= 2 ? accountCols : accountCols.filter(c => c.accountId !== 'all')
  const wide = [...accountCols, ...strategies, ...markets]
  const tWide = build(defs, wide)
  const a = build(MARKET_COLS.map(m => ({ key: '30d', label: m.label, pick: g => g.market === m.key })), assetCols)
  return { cols: accountCols, groups: [{ name: 'Account', span: accountCols.length },
    ...(strategies.length ? [{ name: 'Strategy', span: strategies.length }] : []), { name: 'Asset class', span: markets.length }],
  wideCols: wide, t: build(defs, accountCols), tWide, a, assetCols,
  overallDropped: assetCols.length !== accountCols.length, tWideSub: subtotal(tWide), aSub: subtotal(a) }
}
