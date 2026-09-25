// Recorded money in the all-accounts views, one line per broker deposit
// currency (V3 WEB-5, 8,989-A rows 5 and 7; owner default 25-09-2026: money
// is pooled only within one currency, never summed across currencies).
//
// The server does the pooling (reportLedger's byCurrency, hourly-activity's
// moneyByCurrency). This file only turns a validated split into display
// lines, and says which closes sit in no currency. It never adds two
// currencies' figures, and a currency with no priced close shows no figure,
// never a zero.
import { ledgerMoneyNote } from './partial-money.js'

const CCY = /^[A-Z]{3}$/
const count = n => Number.isSafeInteger(n) && n >= 0

/** One hourly-activity pool ({ currency, recordedNet, closedN, pricedN,
 * moneyState }) in the ledger's shape, so both use one labelling rule. */
const ledgerShape = p => ({ currency: p.currency, net: p.recordedNet, trades: p.closedN,
  pricedTrades: p.pricedN, moneyState: p.moneyState })

/**
 * Checks one hourly-activity split against its population. `true` when the
 * split is absent (an older server: no per-currency lines, nothing invented),
 * `true` when every pool is well formed and pools + unpooled reconcile to
 * `closedN` exactly, `false` otherwise.
 */
export function validActivitySplit(holder, closedN) {
  if (holder?.moneyByCurrency === undefined && holder?.unpooled === undefined) return true
  const pools = holder.moneyByCurrency, un = holder.unpooled
  if (!Array.isArray(pools) || !un || ![un.closedN, un.pricedN].every(count) || un.pricedN > un.closedN) return false
  const seen = new Set()
  for (const p of pools) {
    if (!p || !CCY.test(p.currency || '') || seen.has(p.currency) || ![p.closedN, p.pricedN].every(count)
      || p.closedN === 0 || p.pricedN > p.closedN) return false
    if (p.recordedNet != null && (!Number.isFinite(p.recordedNet) || p.pricedN === 0)) return false
    seen.add(p.currency)
  }
  return pools.reduce((n, p) => n + p.closedN, un.closedN) === closedN
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * Display lines for a figure that is not one number: [{ key, currency, net,
 * note }] plus the closes in no currency. null when there is nothing to split
 * — no closes, a single figure already (`net` set), or no recorded currency.
 * `w` is ledger-shaped: { trades, net, byCurrency, unpooled }.
 */
export function currencyLines(w) {
  if (!Number.isInteger(w?.trades) || w.trades <= 0 || w.net != null
    || !Array.isArray(w.byCurrency) || !w.byCurrency.length) return null
  const lines = w.byCurrency.map(c => ({ key: c.currency, currency: c.currency, net: c.net ?? null,
    trades: c.trades, note: ledgerMoneyNote(c) }))
  const un = w.unpooled
  const ids = Array.isArray(un?.accountIds) ? un.accountIds : []
  const named = ids.filter(id => id != null)
  const who = [named.length ? `account${named.length === 1 ? '' : 's'} ${named.join(', ')} (no recorded broker deposit currency)` : null,
    ids.includes(null) ? 'rows with no account stamp' : null].filter(Boolean).join(' and ')
  const unpooled = un?.trades > 0 ? {
    trades: un.trades,
    text: `${plural(un.trades, 'close', 'closes')} in no currency`,
    title: `${plural(un.trades, 'close', 'closes')} from ${who || 'no recorded currency'}: in no currency line, so ${un.trades === 1 ? 'its' : 'their'} money is added to none.`,
  } : null
  return { lines, unpooled }
}

/** The same lines for hourly-activity evidence (a whole report or one hour). */
export function activityCurrencyLines(holder, { closedN, net } = {}) {
  if (!holder || !Array.isArray(holder.moneyByCurrency)) return null
  return currencyLines({ trades: closedN, net, byCurrency: holder.moneyByCurrency.map(ledgerShape),
    unpooled: holder.unpooled && { trades: holder.unpooled.closedN, pricedTrades: holder.unpooled.pricedN, accountIds: holder.unpooled.accountIds } })
}

/** Paste-friendly form: "SGD -5.41 · USD -1.57 (2 of 3 priced) · 1 close in no currency". */
export function currencyLinesText(split, signed) {
  if (!split) return null
  const parts = split.lines.map(l => `${l.currency} ${l.net != null ? signed(l.net) : '—'}${l.note ? ` (${l.note.text})` : ''}`)
  if (split.unpooled) parts.push(split.unpooled.text)
  return parts.join(' · ')
}
