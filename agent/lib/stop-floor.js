// E·1 (owner, 18-09-2026 — "build E·1 to E·3"): a stop no tighter than one
// hourly ATR.
//
// The four-statement analysis (§7,925·C) measured the losses that motivated
// this: NatGas mean-reversion / value entries and the 21:31 SGT US-open
// scalps were stopped inside the hour's ordinary range — 23 deals held under
// 15 minutes for −682, seven NatGas fills for −679 — because
// `minSLDistancePct` (0.15 % of price) is a floor in PRICE terms and knows
// nothing about how far the instrument moves in an hour. NatGas moves ~1 %
// an hour; a 0.2 % stop there is noise, not risk.
//
// The floor is denominated in the symbol's own hourly ATR, so it is wide on
// NatGas and irrelevant on a stock whose strategy already stops 2 ATR away.
// A stop already wider than the floor is untouched — the momentum book's
// ATR-based stops never see it. A stop tighter than the floor is WIDENED to
// it before the R:R check and before sizing, so the trade either keeps a
// target that still clears the floor at the wider stop, or is refused as
// `bad_rr` for what it really is, and the volume is sized on the stop that
// will actually be sent.
//
// ATR SOURCES ARE REGISTERED, NOT IMPORTED. risk.js is imported by
// profit-keeper.js and (indirectly) by the scan, so importing either from
// here would close a cycle. Instead each owner of an ATR registers a reader
// at module load: fib-strategy.js offers the scan's cached 1h bars (fresh
// for a full bar, fetched for every scanned symbol), profit-keeper.js offers
// its own ATR cache (only symbols the keeper has fetched, on its own
// timeframe). The first source that answers wins; none → the gate records
// `no_atr` and applies no floor. Silence is visible, never a fabricated
// number.
import { getState } from '../db.js'

const sources = new Map() // name -> (db, symbol, symbolId) => atr | null

export function registerAtrSource(name, fn) {
  if (typeof fn !== 'function') throw new Error('registerAtrSource needs a function')
  sources.set(String(name), fn)
}

/** Test seam: drop every registered source (or one by name). */
export function clearAtrSources(name = null) {
  if (name == null) sources.clear()
  else sources.delete(String(name))
}

export function atrFromBars(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const prevC = bars[i - 1].c
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)))
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
}

function symbolIdFor(db, symbol) {
  try {
    const map = JSON.parse(getState(db, 'symbol_id_map') || '{}')
    const id = map[String(symbol || '').toUpperCase()]
    return id != null ? id : null
  } catch { return null }
}

/**
 * The hourly ATR for `symbol` from the first registered source that has one.
 * Returns `{ atr, source }` or `{ atr: null, source: null }`. Never throws:
 * a source that throws is skipped, because the gate must not die on a
 * cache read.
 */
export function hourlyAtrFor(db, symbol) {
  const symbolId = symbolIdFor(db, symbol)
  for (const [name, fn] of sources) {
    try {
      const atr = Number(fn(db, symbol, symbolId))
      if (Number.isFinite(atr) && atr > 0) return { atr, source: name }
    } catch { /* next source */ }
  }
  return { atr: null, source: null }
}

/**
 * Pure: where the stop must sit so that |entry − sl| ≥ mult × atr. Returns
 * null when no widening is needed (or the inputs cannot be judged), else
 * `{ sl, from, floor }` with `sl` rounded to `digits` decimals on the stop's
 * own side of entry.
 */
export function stopFloor({ entry, sl, atr, mult, digits = null }) {
  const e = Number(entry); const s = Number(sl); const a = Number(atr); const m = Number(mult)
  if (![e, s, a, m].every(Number.isFinite) || a <= 0 || m <= 0 || e === s) return null
  const floor = a * m
  const dist = Math.abs(e - s)
  if (dist >= floor) return null
  const side = s < e ? -1 : 1
  const d = digits != null ? digits : Math.max(decimalsOf(e), decimalsOf(s))
  const widened = Number((e + side * floor).toFixed(Math.min(10, Math.max(0, d))))
  return { sl: widened, from: s, floor: Number(floor.toFixed(10)) }
}

function decimalsOf(n) {
  const str = String(n)
  const i = str.indexOf('.')
  return i < 0 ? 0 : str.length - i - 1
}
