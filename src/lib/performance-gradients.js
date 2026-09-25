import { reportGroups, reportStats, reportCurrency, reportCurrencyStats } from '../../agent/shared/performance-populations.js'
import { MARKET_COLS } from '../../agent/shared/formulas.js'
import { pricedNote, partialTitle, moneyGap } from './partial-money.js'
const UP = 'var(--color-up)', DOWN = 'var(--color-down)', MUTED = 'var(--color-muted)'
const format = v => (v < 0 ? '−' : '+') + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'k' : Math.abs(v).toFixed(2))
// One cell from its population statistics. A missing figure carries its own
// reason (`why`); a figure over only some priced closes carries `partial`
// ("2 of 4 priced") so it can never read as the whole.
function cell(st, max) {
  const raw = st?.pnl ?? null
  const n = st?.n ?? null, pricedN = st?.pricedN ?? null
  if (raw == null) {
    const why = moneyGap(st)
    return { v: '—', raw: null, col: MUTED, bg: 'transparent', zero: false, n, pricedN, partial: null, partialTitle: null, why, text: `— (${why.long})` }
  }
  const zero = raw === 0, alpha = Math.pow(Math.abs(raw) / (max || 1), 0.6)
  const v = zero ? '0' : format(raw), partial = pricedNote(pricedN, n)
  return { v, raw, zero, n, pricedN, partial, partialTitle: partialTitle(pricedN, n), why: null,
    text: partial ? `${v} (partial: ${partial})` : v,
    col: zero ? MUTED : raw > 0 ? UP : DOWN,
    bg: zero ? 'transparent' : `${raw > 0 ? 'rgba(79,140,255,' : 'rgba(255,77,109,'}${(0.04 + 0.14 * alpha).toFixed(2)})` }
}
const ROW_MISSING = { key: 'row_missing', short: 'Incomplete', long: 'a row above has no figure, so no subtotal is given' }
/**
 * Money is pooled only within one recorded deposit currency, never across two
 * (owner default 25-09-2026). With currencies recorded, Overall, strategy and
 * asset-class columns come once per currency; without any (a report from an
 * agent that does not yet stamp them) the old single Overall stays, and it
 * adds money only when one account contributes.
 * Every column has a unique `id` (keys, hiding) and a unique `full` label
 * (restore chips, copied data); `name` is the head text.
 */
export function performanceGradients(report, accounts, strategyLabel) {
  const ccyOf = id => reportCurrency(report, id)
  const acctCols = accounts.map(a => {
    const ccy = ccyOf(a.id)
    return { id: `acct:${a.id}`, accountId: a.id, currency: ccy,
      name: ccy ? `${a.name} ${ccy}` : `${a.name} (ccy?)`, full: ccy ? `${a.name} ${ccy}` : `${a.name} · currency not recorded` }
  })
  const activity = c => reportGroups(report, '12m', 'all', g => ccyOf(g.accountId) === c).reduce((s, g) => s + g.stats.n, 0)
  const currencies = [...new Set(acctCols.map(c => c.currency).filter(Boolean))]
    .sort((a, b) => activity(b) - activity(a) || a.localeCompare(b))
  const scopes = currencies.length ? currencies : [null]
  const tag = s => s ?? 'all', sfx = s => (s ? ` · ${s}` : '')
  const inScope = s => g => s == null || ccyOf(g.accountId) === s
  const overallCols = scopes.map(s => ({ id: `overall:${tag(s)}`, currency: s, name: s ? `Overall ${s}` : 'Overall', full: s ? `Overall ${s}` : 'Overall' }))
  const accountCols = [...acctCols, ...overallCols]
  const stratName = key => { const l = strategyLabel(key) || key; return /^other$/i.test(l) ? 'Other (label)' : l }
  // Rank by activity within the currency; money in different units cannot rank strategies.
  const strategiesOf = s => {
    const counts = new Map()
    for (const g of reportGroups(report, '12m', 'all', inScope(s))) counts.set(g.strat, (counts.get(g.strat) || 0) + g.stats.n)
    const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
    const top = names.slice(0, 6), rest = new Set(names.slice(6))
    return [...top.map(k => ({ id: `strat:${tag(s)}:${k}`, currency: s, name: stratName(k), full: stratName(k) + sfx(s), pick: g => g.strat === k })),
      ...(rest.size ? [{ id: `strat-rest:${tag(s)}`, currency: s, name: 'Other strategies', full: 'Other strategies' + sfx(s), pick: g => rest.has(g.strat) }] : [])]
  }
  // Per currency, only the asset classes that currency closed trades in over
  // 12 months: an empty "Grains · SGD" column is not information.
  const marketsOf = s => {
    const traded = s == null ? null : new Set(reportGroups(report, '12m', 'all', inScope(s)).map(g => g.market))
    return MARKET_COLS.filter(m => traded == null || traded.has(m.key)).map(m => {
      const label = m.key === 'other' ? 'Other markets' : m.label
      return { id: `market:${tag(s)}:${m.key}`, currency: s, name: label, full: label + sfx(s), pick: g => g.market === m.key }
    })
  }
  const strategies = scopes.map(s => [s, strategiesOf(s)]), markets = scopes.map(s => [s, marketsOf(s)])
  const defs = (report?.windows || []).filter(w => w.ledger).map(w => ({ key: w.key, label: w.label }))
  const statsFor = (key, col, rowPick) => {
    const pick = g => (!rowPick || rowPick(g)) && (!col.pick || col.pick(g))
    if (col.accountId) return reportStats(report, key, col.accountId, pick)
    if (col.currency) return reportCurrencyStats(report, key, col.currency, pick)
    return reportStats(report, key, 'all', pick)
  }
  const build = (rows, cols) => {
    const stats = rows.map(r => cols.map(c => statsFor(r.key, c, r.pick)))
    const maxima = cols.map((_, i) => Math.max(1, ...stats.map(r => Math.abs(r[i].pnl ?? 0))))
    return rows.map((r, i) => ({ label: r.label, cells: stats[i].map((st, j) => cell(st, maxima[j])) }))
  }
  // Exact numbers, never reparsed rounded display strings. `countable` rows
  // partition one population (asset classes of one 30D window), so their
  // priced counts add up; overlapping windows do not, and their footing only
  // says that a partial figure went into it.
  const subtotal = (rows, countable) => rows.length ? rows[0].cells.map((_, i) => {
    const cells = rows.map(r => r.cells[i])
    if (cells.some(c => c.raw == null)) return { ...cell({ state: 'observed', n: 0, pnl: null }, 1), why: ROW_MISSING, text: `— (${ROW_MISSING.long})` }
    const pnl = cells.reduce((s, c) => s + c.raw, 0)
    if (countable) return cell({ pnl, n: cells.reduce((s, c) => s + c.n, 0), pricedN: cells.reduce((s, c) => s + c.pricedN, 0) }, 1)
    const out = cell({ pnl }, 1), partials = cells.filter(c => c.partial).length
    return partials ? { ...out, partial: 'incl. partial',
      partialTitle: `Includes ${partials} partial ${partials === 1 ? 'figure' : 'figures'} that sum only their priced closes.`,
      text: `${out.v} (includes ${partials} partial)` } : out
  }) : null
  const tradingOf = s => new Set(reportGroups(report, '30d', 'all', inScope(s)).map(g => g.accountId).filter(Boolean))
  const assetCols = [...acctCols, ...overallCols.filter(c => tradingOf(c.currency).size >= 2)]
  const groups = [{ name: 'Account', span: accountCols.length },
    ...strategies.filter(([, cols]) => cols.length).map(([s, cols]) => ({ name: `Strategy${sfx(s)}`, span: cols.length })),
    ...markets.filter(([, cols]) => cols.length).map(([s, cols]) => ({ name: `Asset class${sfx(s)}`, span: cols.length }))]
  const wide = [...accountCols, ...strategies.flatMap(([, cols]) => cols), ...markets.flatMap(([, cols]) => cols)]
  const tWide = build(defs, wide)
  const a = build(MARKET_COLS.map(m => ({ key: '30d', label: m.label, pick: g => g.market === m.key })), assetCols)
  const pooling = { currencies, perCurrency: currencies.length > 0,
    noCurrency: acctCols.filter(c => !c.currency).map(c => c.full),
    unstampedN: reportGroups(report, '12m', 'all', g => g.accountId == null).reduce((s, g) => s + g.stats.n, 0) }
  return { cols: accountCols, groups, wideCols: wide, t: build(defs, accountCols), tWide, a, assetCols, pooling,
    overallDropped: assetCols.length !== accountCols.length, tWideSub: subtotal(tWide, false), aSub: subtotal(a, true) }
}

// The timeframe card keeps the owner's column footing (2026-07-25), named for
// what it is: the windows overlap, so it counts a close once per window.
export const OVERLAP_LABEL = 'Subtotal (overlapping)'
export const OVERLAP_TITLE = 'The windows overlap, so this adds the same close once for every window it falls in: a footing, not a profit or loss.'

/** Copied table data: keyed by each column's unique label, carrying the
 * partial / missing wording rather than a bare figure. */
export function gradientData(rows, cols, rowKey, subtotals = null, subtotalLabel = 'Subtotal') {
  const line = (label, cells) => ({ [rowKey]: label,
    ...Object.fromEntries(cells.map((c, i) => [cols[i]?.full ?? cols[i]?.name ?? String(i), c?.text ?? c?.v ?? null])) })
  return [...rows.map(r => line(r.label, r.cells)), ...(subtotals && rows.length ? [line(subtotalLabel, subtotals)] : [])]
}

/** The cards' footnotes: what is pooled, what is left out of pooling, why. */
export function gradientFoot(g, kind) {
  const p = g.pooling
  const pool = p.perCurrency
    ? `money is added across accounts only within one deposit currency (${p.currencies.join(', ')}), never across currencies`
    : 'no account deposit currency is recorded, so money is not added across accounts'
  const left = p.perCurrency ? [
    p.noCurrency.length ? `${p.noCurrency.join(', ')}: currency not recorded, so in no pooled column` : null,
    p.unstampedN ? `${p.unstampedN} ${p.unstampedN === 1 ? 'close' : 'closes'} without an account stamp ${p.unstampedN === 1 ? 'is' : 'are'} in no account or currency column` : null,
  ] : []
  const partial = "a figure with 'n of m priced' beneath it sums only its priced closes; it is not a bound in either direction"
  const lines = kind === 't'
    ? ['blue = net gain · red = net loss · each column shaded against its own peak window', pool, partial,
      'the windows overlap, so the overlapping subtotal adds a close once per window: a footing, not a P&L', ...left]
    : [g.overallDropped ? 'a currency shows an Overall only when two or more of its accounts closed trades in these 30 days' : null,
      "asset classes split each account's 30 days, so the subtotal is that account's 30-day total", pool, partial, ...left]
  return lines.filter(Boolean).join(' · ')
}
