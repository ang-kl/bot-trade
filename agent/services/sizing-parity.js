// ---------------------------------------------------------------------------
// agent/services/sizing-parity.js — does our arithmetic agree with the broker?
//
// Owner, 07-08-2026: "fix it" — on the JPN225 sizing defect.
//
// THE FIX IS THE CHEAP HALF. `JPN225: 'JPY'` became `'USD'` in contracts.js
// and that particular wound is closed. This file exists because of the
// expensive half: THE ERROR WAS INVISIBLE FOR AS LONG AS IT EXISTED. Nothing
// in the system ever asked whether the number it used to size a position bore
// any relation to the number the broker later charged. A 158× discrepancy sat
// in production, produced a 9,171.76 loss on a 45,211 account, and was found
// only because a config controller happened to notice the loss was larger than
// a daily cap — a coincidence, three days late.
//
// So the question this asks is deliberately narrow and deliberately dumb:
//
//     For each closed trade, what P&L does OUR model predict, and what did the
//     broker actually pay? Do those two numbers agree?
//
// It does not try to be right about currencies. It compares two independently
// derived numbers and reports when they disagree. That is strictly more useful
// than a cleverer model, because the failure mode here was a confident model
// nobody checked.
//
// WHY THE MEDIAN, AND WHY ABSOLUTE. One trade's recorded exit price can be
// wrong on its own (trade 641's exit implies a PROFIT while the broker charged
// 9,171.76 — the price capture failed there, separately). A mean would let one
// such row set the verdict; the median needs the symbol to be consistently
// wrong. And the magnitude test uses absolute values, with sign disagreement
// counted SEPARATELY, because "we think this made money and the broker says it
// lost" is a different defect from "right direction, wrong scale" — and
// collapsing them into one ratio hides both.
//
// IT NEVER CHANGES ANYTHING. No writes, no config edits, no auto-correction.
// A service that silently rewrote a currency because five trades disagreed
// would be a faster way to reach a wrong answer.
// ---------------------------------------------------------------------------

import { contractSize, fxQuoteCurrency, usdRate } from '../lib/contracts.js'

/** Ratios beyond this are "the model and the broker disagree", not noise. */
export const DEFAULT_TOLERANCE = 1.5
/** Below this many usable trades a symbol has no verdict, only a count. */
export const DEFAULT_MIN_TRADES = 3

/**
 * What our sizing model says a closed trade should have paid, in USD.
 *
 * This is the SAME arithmetic `usdLossPerLot` uses to size the position —
 * deliberately, because the point is to test that arithmetic and not some
 * parallel reimplementation of it that could be right when sizing is wrong.
 *
 * Returns null when an input is missing, which is not a finding: an unpriced
 * or unclosed trade simply cannot be compared.
 *
 * @param {{symbol:string, side:string, entry_price:number, exit_price:number,
 *          volume:number}} t
 * @param {Record<string,number>|null} rates
 * @returns {number|null} signed USD, positive = model says profit
 */
export function modelledPnlUsd(t, rates = null) {
  const symbol = String(t?.symbol || '').toUpperCase()
  // `Number(null)` is 0 and 0 is finite, so an UNCLOSED trade would otherwise
  // read as "exited at zero" and model a catastrophic loss out of a missing
  // field. Reject the empty values by identity before coercing — the same trap
  // that made an absent position count look like an empty book.
  const num = (v) => (v == null || v === '' ? NaN : Number(v))
  const entry = num(t?.entry_price)
  const exit = num(t?.exit_price)
  const vol = num(t?.volume)
  if (!symbol || !Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(vol) || vol <= 0) return null
  const isShort = /^(SELL|SHORT)$/i.test(String(t?.side || ''))
  const move = isShort ? entry - exit : exit - entry
  const inQuote = move * contractSize(symbol) * vol
  const quote = fxQuoteCurrency(symbol)
  if (quote == null || quote === 'USD') return inQuote
  // USD-base pairs land the loss in the quote currency; divide by the price,
  // exactly as usdLossPerLot does.
  if (symbol.slice(0, 3) === 'USD' && entry > 0) return inQuote / entry
  const rate = usdRate(quote, rates)
  return Number.isFinite(rate) ? inQuote * rate : null
}

/**
 * One trade, compared. `ratio` is |realised| ÷ |modelled| — how many times
 * bigger the broker's number was than ours. 1 is agreement.
 *
 * @returns {{symbol, modelledUsd, realisedUsd, ratio, signAgrees}|null}
 */
export function tradeParity(t, rates = null) {
  const modelled = modelledPnlUsd(t, rates)
  const realised = t?.net_pnl == null || t.net_pnl === '' ? NaN : Number(t.net_pnl)
  if (modelled == null || !Number.isFinite(realised)) return null
  // Both near zero carries no information about scale — a scratch trade
  // divides two roundings and produces a meaningless ratio.
  if (Math.abs(modelled) < 0.01 || Math.abs(realised) < 0.01) return null
  return {
    symbol: String(t.symbol).toUpperCase(),
    modelledUsd: round2(modelled),
    realisedUsd: round2(realised),
    ratio: round4(Math.abs(realised) / Math.abs(modelled)),
    signAgrees: (modelled >= 0) === (realised >= 0),
  }
}

/**
 * Per-symbol verdict over a set of closed trades.
 *
 * `impliedFactor` is the median ratio. When the model is right it sits at 1.
 * When a currency assumption is wrong it sits at that currency's FX rate —
 * which is the whole diagnostic value: the number NAMES the mistake. JPN225
 * under the old `'JPY'` entry would have reported ~158, and USDJPY was 158.33.
 *
 * `suggests` is offered only when the factor is close to a rate actually
 * present in `rates`, and it is a HYPOTHESIS — the field is named to be read
 * that way, and nothing acts on it.
 *
 * @param {Array<object>} trades  closed trades, any symbols
 * @param {{rates?:object, minTrades?:number, tolerance?:number}} opts
 */
export function sizingParity(trades, { rates = null, minTrades = DEFAULT_MIN_TRADES, tolerance = DEFAULT_TOLERANCE } = {}) {
  const bySymbol = new Map()
  let compared = 0, skipped = 0
  for (const t of Array.isArray(trades) ? trades : []) {
    const p = tradeParity(t, rates)
    if (!p) { skipped++; continue }
    compared++
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, [])
    bySymbol.get(p.symbol).push(p)
  }
  const symbols = []
  for (const [symbol, rows] of bySymbol) {
    const ratios = rows.map(r => r.ratio).sort((a, b) => a - b)
    const factor = median(ratios)
    const signMismatches = rows.filter(r => !r.signAgrees).length
    const enough = rows.length >= minTrades
    // Disagreement is symmetric in log space: 2x too big and 2x too small are
    // the same size of error, and a plain `factor > tolerance` test would miss
    // every under-sizing.
    const off = factor > tolerance || factor < 1 / tolerance
    symbols.push({
      symbol,
      trades: rows.length,
      quoteCcy: fxQuoteCurrency(symbol),
      impliedFactor: round4(factor),
      worstRatio: round4(ratios[ratios.length - 1]),
      signMismatches,
      verdict: !enough ? 'insufficient' : off ? 'disagrees' : 'ok',
      suggests: enough && off ? nameFactor(factor, rates) : null,
      // Sign disagreement is reported even when the magnitude looks fine,
      // because it means the recorded prices and the broker's money are
      // telling different stories about the same trade.
      note: signMismatches > 0
        ? `${signMismatches}/${rows.length} trade(s) disagree on DIRECTION — recorded prices and broker P&L cannot both be right`
        : null,
    })
  }
  symbols.sort((a, b) => rank(b) - rank(a) || b.trades - a.trades)
  return {
    symbols,
    compared,
    skipped,
    tolerance,
    minTrades,
    // A symbol with no usable trades is not "ok", it is unexamined, and the
    // caller needs to be able to say which.
    disagreeing: symbols.filter(s => s.verdict === 'disagrees').map(s => s.symbol),
  }
}

/**
 * Does any currency in `rates` explain this factor? Returns a sentence, never
 * an instruction — the caller shows it to a human who decides.
 */
function nameFactor(factor, rates) {
  if (!rates || typeof rates !== 'object') return null
  const f = Number(factor)
  if (!Number.isFinite(f) || f <= 0) return null
  const ccys = new Set()
  for (const sym of Object.keys(rates)) {
    const s = String(sym).toUpperCase()
    if (s.length === 6 && /^[A-Z]{6}$/.test(s)) { ccys.add(s.slice(0, 3)); ccys.add(s.slice(3)) }
  }
  for (const c of ccys) {
    if (c === 'USD') continue
    const r = usdRate(c, rates)
    if (!Number.isFinite(r) || r <= 0) continue
    // factor ≈ 1/r  → we converted when we should not have (JPN225's case).
    // factor ≈ r    → we failed to convert when we should have.
    if (close(f, 1 / r)) return `factor ≈ 1/${c}→USD — a ${c} conversion is being applied that the broker does not apply; the symbol may settle in USD`
    if (close(f, r)) return `factor ≈ ${c}→USD — this may need a ${c} conversion that is not being applied`
  }
  return null
}

const close = (a, b) => Math.abs(a - b) / b < 0.1
const rank = (s) => (s.verdict === 'disagrees' ? 2 : s.signMismatches > 0 ? 1 : 0)
function median(sorted) {
  if (!sorted.length) return NaN
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}
function round2(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null }
function round4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10000) / 10000 : null }
