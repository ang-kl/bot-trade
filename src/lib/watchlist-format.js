// ---------------------------------------------------------------------------
// src/lib/watchlist-format.js — the small formatting decisions the Tune
// watchlist row makes, out of the JSX so they can be tested.
//
// Owner, 04-08-2026, on the watchlist table (IMG_0782):
//   2. "Add a Description column next to the symbol as second column… Don't
//      set this Description column as too wide column, 10 characters with a
//      scrolling horizontal feature that user can scroll right to see."
//   3. "The CAP field, short to 4 character width and specify in dollar or yen
//      or numeric or integer field-type in tiny symbol font-size to indicate
//      at the start of the field."
//   6. "Live signal to add {last traded date DD/MM in tiny font size}."
// ---------------------------------------------------------------------------

import { describeInstrument } from '../../agent/lib/symbol-taxonomy.js'
import { instrumentType } from '../../agent/lib/contracts.js'

export { describeInstrument }

/**
 * DD/MM for the tiny last-traded stamp. Deliberately no year: the column is a
 * few characters wide and a trade older than a year is not the case this
 * serves. Returns '' rather than 'Invalid Date' for anything unparseable —
 * a blank cell is honest, a garbled one is not.
 */
export function ddmm(value) {
  if (!value) return ''
  const d = new Date(typeof value === 'string' ? value.replace(' ', 'T') + (/[Z+]/.test(value) ? '' : 'Z') : value)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * The tiny marker that sits at the start of the CAP field.
 *
 * A NOTE ON WHAT THIS FIELD ACTUALLY IS, because the request asked for
 * "dollar or yen": Max lots (cap) is a cap in LOTS, not in money. Printing a
 * `$` in front of it would read as a dollar cap and be wrong on every row —
 * the same class of mislabel as the "Scanned" header that sat over the
 * enabled toggle. So the marker names the field TYPE (which is what was
 * asked for) and the tooltip names the money: lots × contract size, in the
 * instrument's own quote currency, which is where the dollar or the yen
 * actually lives.
 *
 * @returns {{mark: string, title: string}}
 */
export function capMarker(symbol) {
  const type = instrumentType(symbol)
  const ccy = quoteCurrency(symbol)
  const per = type === 'equity' ? 'shares' : type === 'crypto' ? 'coins' : 'units'
  return {
    mark: 'lot',
    title: `Cap in LOTS — not money. 1 lot = the instrument's contract size in ${per}; its value is quoted in ${ccy}. Leave empty for pure risk-based sizing.`,
  }
}

/** The currency a symbol's price is quoted in, for the CAP tooltip. */
export function quoteCurrency(symbol) {
  const s = String(symbol || '').toUpperCase()
  if (/^[A-Z]{6}$/.test(s)) return s.slice(3)          // EURJPY → JPY
  if (s.endsWith('.HK')) return 'HKD'
  if (s.endsWith('.JP') || s === 'JPN225') return 'JPY'
  if (/\.(DE|FR|ES|IT|NL|PA|MI|MC|AS)$/.test(s) || ['GER40', 'GER30', 'FRA40', 'SPA35', 'ITA40', 'NETH25', 'EUSTX50'].includes(s)) return 'EUR'
  if (/\.(UK|L|LSE)$/.test(s) || s === 'UK100') return 'GBP'
  if (/\.(AU|AX)$/.test(s) || s === 'AUS200') return 'AUD'
  if (/\.(CH|SW)$/.test(s) || s === 'SWI20') return 'CHF'
  if (/\.(CA|TO)$/.test(s)) return 'CAD'
  if (s === 'SG30') return 'SGD'
  return 'USD'
}

/**
 * The Backtest-trades cell, from the DURABLE rollup with the in-session run as
 * an override.
 *
 * Owner: "4. Backtest trade column isn't filled. Please check or else remove."
 * It was not empty because there is no data — `backtest_runs` has carried the
 * answer since #119. It was empty because the cell read the page's in-memory
 * `bt` state, which only exists after you run a backtest in THAT browser tab,
 * so it was blank on every fresh load. Checked, and filled, rather than
 * removed.
 *
 * @param {number|null} sessionCount trades from a backtest run in this tab
 * @param {{trades?: number, runs?: number, lastRanAt?: string}|null} durable
 * @returns {{text: string, title: string, stale: boolean}}
 */
export function backtestCell(sessionCount, durable) {
  if (sessionCount != null) {
    return { text: String(sessionCount), title: 'Trades produced by the backtest run in this browser session, all timeframes', stale: false }
  }
  const trades = durable?.trades
  if (trades == null) {
    return { text: '—', title: 'This symbol has never been backtested on this account — run one from the Backtest card below', stale: false }
  }
  const when = durable.lastRanAt ? ddmm(durable.lastRanAt) : ''
  return {
    text: String(trades),
    title: `${trades} trade(s) across ${durable.runs ?? '?'} stored backtest run(s)${when ? `, last run ${when}` : ''}`,
    stale: true,          // from the record, not from a run you just watched
  }
}
