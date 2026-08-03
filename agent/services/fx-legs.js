// ---------------------------------------------------------------------------
// agent/services/fx-legs.js — keep the CONVERSION LEGS fresh, on purpose.
//
// MEASURED IN PRODUCTION, 03-08-2026. The risk gate vetoed 1,859 entries in
// seven days as `insufficient_equity … usd_per_lot_unknown`, concentrated in
// AUDPLN (695), EURJPY (352), AUDCAD (253), EURGBP (158) and GBPNOK (49).
//
// The diagnosis that looked right and was wrong: "USDPLN and USDCAD are not
// on the watchlist". They are. `/state/prices` had all of them:
//
//     USDJPY  157.651   03-08 11:26      ← fresh
//     GBPUSD    1.34915 03-08 11:26      ← fresh
//     USDPLN    3.79427 01-08 05:33      ← 54 hours old
//     USDNOK    9.57644 01-08 05:33      ← 54 hours old
//     USDCAD    1.4095  01-08 05:44      ← 54 hours old
//
// The real cause is a RATE problem, not a coverage problem. The scan rotates
// ~15 of 255 watchlist symbols per five-minute cycle and its selection is
// weighted toward tradeable setups — so USDPLN, USDNOK and USDCAD, which
// nobody is trading, go days between visits. fx-rates.js then does exactly
// what it should: it refuses to serve a rate older than 26 hours. Sizing has
// no conversion path for PLN/NOK/CAD, `usdLossPerLot` returns NaN, and every
// AUDPLN or GBPNOK proposal dies at the sizing step.
//
// So the conversion legs cannot be a by-product of looking for trades. They
// are infrastructure — about a dozen rates that sizing depends on — and they
// get refreshed on their own schedule, from the broker, whether or not the
// scanner is interested in them today.
//
// DELIBERATELY CHEAP. Only legs that are missing or older than
// `refreshAfterMs` are fetched, capped per cycle. In the steady state that is
// zero calls most cycles and one or two when something ages past six hours —
// against a 26-hour usability window, so a leg is refreshed long before the
// gate would have to start refusing it.
import { fxQuoteCurrency } from '../lib/contracts.js'
import { readFxTable, recordFxRate, RATE_MAX_AGE_MS } from './fx-rates.js'

/** Refresh a leg once it is older than this. Well inside RATE_MAX_AGE_MS. */
export const LEG_REFRESH_AFTER_MS = 6 * 3_600_000
/** Never fetch more than this many legs in one cycle. */
export const LEG_FETCH_LIMIT = 8

/**
 * Pure. The currencies sizing must convert to USD for these symbols.
 *
 * A USD-quoted symbol needs nothing. A USD-BASE pair (USDJPY) converts
 * through its own price, not the table — but its quote currency is included
 * anyway, because that same currency is what a CROSS like EURJPY needs, and
 * USDJPY is exactly the leg that resolves it.
 */
export function requiredQuoteCurrencies(symbols) {
  const out = new Set()
  for (const raw of symbols || []) {
    const sym = String(raw?.symbol ?? raw ?? '').toUpperCase()
    if (!sym) continue
    const q = fxQuoteCurrency(sym)
    if (q && q !== 'USD') out.add(q)
  }
  return out
}

/**
 * Pure. The broker symbol that prices one currency against USD.
 * Prefers whichever direction the broker actually lists; `usdRate` handles
 * both (XXXUSD directly, USDXXX inverted), so either is equally usable.
 */
export function legSymbolFor(currency, availableSymbols) {
  const c = String(currency || '').toUpperCase()
  if (!c || c === 'USD') return null
  const has = (s) => availableSymbols == null || (
    availableSymbols instanceof Set ? availableSymbols.has(s) : Object.hasOwn(availableSymbols, s)
  )
  if (has(`${c}USD`)) return `${c}USD`
  if (has(`USD${c}`)) return `USD${c}`
  return null
}

/**
 * Pure. Which legs need fetching right now: missing from the table, or older
 * than `refreshAfterMs`. Returns them oldest-first so a capped run always
 * refreshes the most degraded legs, not an arbitrary slice.
 */
export function staleLegs(table, legSymbols, {
  now = Date.now(), refreshAfterMs = LEG_REFRESH_AFTER_MS,
} = {}) {
  const scored = []
  for (const sym of legSymbols) {
    const row = table?.[sym]
    const age = row && Number.isFinite(row.t) ? now - row.t : Infinity
    const usable = row && Number.isFinite(row.p) && row.p > 0
    if (usable && age <= refreshAfterMs) continue
    scored.push({ symbol: sym, ageMs: age, everSeen: !!usable })
  }
  return scored.sort((a, b) => b.ageMs - a.ageMs)
}

/**
 * Fetch the stale conversion legs from the broker and record them.
 *
 * Injected deps rather than imports so this is testable without a socket:
 *   getSpot(symbolId) → { bid, ask } | { price }
 *
 * @returns {{checked:number, stale:number, fetched:string[], failed:string[],
 *            skipped?:string, currencies:string[]}}
 */
export async function refreshFxLegs(db, {
  symbols, symbolMap, getSpot,
  now = Date.now(), refreshAfterMs = LEG_REFRESH_AFTER_MS, limit = LEG_FETCH_LIMIT,
} = {}) {
  const currencies = [...requiredQuoteCurrencies(symbols)].sort()
  const legs = []
  for (const c of currencies) {
    const leg = legSymbolFor(c, symbolMap)
    if (leg) legs.push(leg)
  }
  const unique = [...new Set(legs)]
  if (!unique.length) return { checked: 0, stale: 0, fetched: [], failed: [], currencies, skipped: 'no_legs' }
  if (typeof getSpot !== 'function') {
    return { checked: unique.length, stale: 0, fetched: [], failed: [], currencies, skipped: 'no_quote_source' }
  }

  const stale = staleLegs(readFxTable(db), unique, { now, refreshAfterMs })
  const fetched = []
  const failed = []
  for (const s of stale.slice(0, limit)) {
    const symbolId = symbolMap?.[s.symbol]
    if (symbolId == null) { failed.push(s.symbol); continue }
    try {
      const q = await getSpot(symbolId)
      // The MID. A conversion rate is not a tradeable price — using bid or
      // ask alone would bias every cross-pair size by half a spread in the
      // same direction, always.
      const bid = Number(q?.bid)
      const ask = Number(q?.ask)
      const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2
        : Number(q?.price ?? q?.mid ?? bid ?? ask)
      if (!Number.isFinite(mid) || mid <= 0) { failed.push(s.symbol); continue }
      if (recordFxRate(db, s.symbol, mid, now)) fetched.push(s.symbol)
      else failed.push(s.symbol)
    } catch {
      // One dead symbol must not cost the rest of the sweep — the next
      // cycle retries it, and it is still inside the 26-hour window.
      failed.push(s.symbol)
    }
  }
  return { checked: unique.length, stale: stale.length, fetched, failed, currencies }
}

/**
 * Report, for the operator: every currency sizing needs, its leg, and whether
 * that leg is fresh / stale / missing. This is the view that would have made
 * the 1,859 vetoes obvious in a glance instead of a day of inference.
 */
export function fxLegReport(db, { symbols, symbolMap, now = Date.now() } = {}) {
  const table = readFxTable(db)
  const rows = []
  for (const c of [...requiredQuoteCurrencies(symbols)].sort()) {
    const leg = legSymbolFor(c, symbolMap)
    const row = leg ? table[leg] : null
    const ageMs = row && Number.isFinite(row.t) ? now - row.t : null
    rows.push({
      currency: c,
      leg,
      price: row?.p ?? null,
      ageMin: ageMs == null ? null : Math.round(ageMs / 60_000),
      state: !leg ? 'no_leg'
        : ageMs == null ? 'missing'
          : ageMs > RATE_MAX_AGE_MS ? 'expired'
            : ageMs > LEG_REFRESH_AFTER_MS ? 'stale'
              : 'fresh',
    })
  }
  const bad = rows.filter(r => r.state !== 'fresh')
  return { rows, unusable: rows.filter(r => r.state === 'no_leg' || r.state === 'missing' || r.state === 'expired').length, degraded: bad.length }
}
