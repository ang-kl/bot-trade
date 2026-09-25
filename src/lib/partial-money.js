// How the Performance page labels a money figure that is not the whole story.
//
// PARTIAL: the figure sums only the closes that carry a recorded P&L. It is
// labelled with the priced count, and deliberately NOT as a floor or a
// ceiling: a close with no recorded P&L may be a gain or a loss, so the priced
// sum bounds the true total in neither direction (owner principle 6: no fake
// result — an unearned "≥" would be one).
//
// ABSENT: a cell with no figure says WHY, from the statistics that produced
// it, instead of a blanket "no closed trades" (a column of hundreds of closes
// once carried exactly that tooltip).

const count = v => (Number.isInteger(v) && v >= 0 ? v : null)

/** "2 of 4 priced" when some closes of the population have no P&L, else null. */
export function pricedNote(pricedN, n) {
  const p = count(pricedN), t = count(n)
  return p == null || t == null || t === 0 || p >= t ? null : `${p} of ${t} priced`
}

/** The long form, for a title and for copied text. */
export function partialTitle(pricedN, n) {
  const p = count(pricedN), t = count(n)
  if (p == null || t == null || p >= t) return null
  return `Partial: the sum of the ${p} closes with a recorded P&L. ${t - p} of ${t} closes have none, so the true total is not known in either direction.`
}

/**
 * Why a money figure is absent, from populationStats-shaped input
 * ({ state, n, pricedN, pnl, moneyState }). null when a figure exists.
 */
export function moneyGap(stats) {
  if (!stats || stats.state === 'unavailable' || stats.n == null) {
    return { key: 'report', short: 'Report unavailable', long: 'the performance report is unavailable for this window' }
  }
  if (stats.pnl != null) return null
  if (stats.moneyState === 'unverified_cross_account_units') {
    return { key: 'not_pooled', short: 'Not pooled', long: 'these closes come from accounts not recorded in one deposit currency, so their money is not added together' }
  }
  if (stats.n > 0 && !stats.pricedN) {
    return { key: 'no_pnl', short: 'No P&L recorded', long: `none of its ${stats.n} closes has a recorded P&L` }
  }
  return { key: 'unavailable', short: 'Unavailable', long: 'no money figure is available' }
}

/**
 * The line under a ledger money figure (reportLedger's window / market shape:
 * { net, trades, pricedTrades, moneyState }): the priced count when the figure
 * is partial, or why there is none. null when the figure is whole or there
 * are no closes.
 */
export function ledgerMoneyNote(w) {
  const n = w?.trades, priced = w?.pricedTrades
  if (!Number.isInteger(n) || n <= 0) return null
  if (w.net != null) {
    const note = pricedNote(priced, n)
    return note ? { key: 'partial', text: `partial · ${note}`, title: partialTitle(priced, n) } : null
  }
  const gap = moneyGap({ state: 'observed', n, pricedN: priced, pnl: null, moneyState: w.moneyState })
  return { key: gap.key, text: gap.key === 'no_pnl' ? `${priced ?? 0} of ${n} priced` : gap.short.toLowerCase(), title: gap.long }
}
