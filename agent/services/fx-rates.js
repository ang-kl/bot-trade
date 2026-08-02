// FX rate table — the freshest close this agent has seen for each symbol,
// ACCUMULATED across scan cycles.
//
// WHY (production 02-08-2026, second look). Cross-pair position sizing
// converts a quote-currency loss to USD through a rates map, and that map
// was built from `last_scan_results` — the LAST SCAN BATCH. The scan
// rotates `batchSize = 15` symbols per 5-minute cycle out of a 221-symbol
// watchlist, so the map holds ~15 entries at a time. EURJPY and the
// USDJPY/EURUSD leg it needs are on the watchlist together but are almost
// never in the same batch, so the conversion failed and the risk gate
// vetoed: 736 entries in one day on EURJPY, AUDPLN and EURGBP alone, all
// reported as `insufficient_equity … usd_per_lot_unknown`.
//
// The first fix (transitive derivation in usdRate) was necessary but not
// sufficient: it can hop through a scanned cross, and with 15 of 221
// symbols visible the hop target is usually missing too. A rate does not
// stop being true when the scanner moves on to other symbols, so the map
// should not forget it. This table remembers the newest close per symbol
// and ages entries out instead of losing them every cycle.
//
// STALENESS IS ENFORCED, NOT ASSUMED. A remembered rate is only usable
// while it is recent enough that sizing on it is honest. Past the window an
// entry is dropped and the gate goes back to vetoing — refusing to size is
// correct; sizing off a two-day-old cross rate is not.
import { getState, setState } from '../db.js'

const STATE_KEY = 'fx_rates_json'
// 26 hours: comfortably spans a weekend gap's Friday close into Monday's
// open for the majors, and still refuses anything older than about a day
// of trading. Sizing tolerates this (a 1-day FX drift is small against a
// stop distance); entry PRICING never reads this table.
export const RATE_MAX_AGE_MS = 26 * 3_600_000
// Bound the table so a long-lived agent cannot grow state without limit.
const MAX_ENTRIES = 400

/**
 * Merge a scan's closes into the persistent table. Best-effort by
 * contract: a malformed payload leaves the previous table untouched.
 * @param {object} db
 * @param {{scans?: Array<{symbol?: string, price?: number}>}} scanResult
 * @param {number} now
 * @returns {number} how many symbols the table now holds
 */
export function recordFxRates(db, scanResult, now = Date.now()) {
  try {
    const table = readTable(db)
    for (const sc of scanResult?.scans || []) {
      const sym = String(sc?.symbol || '').toUpperCase()
      const price = Number(sc?.price)
      if (!sym || !Number.isFinite(price) || price <= 0) continue
      table[sym] = { p: price, t: now }
    }
    // Drop what has aged out, then cap by recency.
    let entries = Object.entries(table).filter(([, v]) => now - (v?.t ?? 0) <= RATE_MAX_AGE_MS)
    if (entries.length > MAX_ENTRIES) {
      entries = entries.sort((a, b) => (b[1].t ?? 0) - (a[1].t ?? 0)).slice(0, MAX_ENTRIES)
    }
    const next = Object.fromEntries(entries)
    setState(db, STATE_KEY, JSON.stringify(next))
    return entries.length
  } catch {
    return 0
  }
}

/**
 * The usable rate map: { SYMBOL: price }, stale entries removed.
 * Shape matches what usdRate()/usdLossPerLot() already expect, so callers
 * swap the source without changing the maths.
 */
export function loadFxRates(db, now = Date.now()) {
  const table = readTable(db)
  const out = {}
  for (const [sym, v] of Object.entries(table)) {
    if (!v || !Number.isFinite(v.p) || v.p <= 0) continue
    if (now - (v.t ?? 0) > RATE_MAX_AGE_MS) continue
    out[sym] = v.p
  }
  return out
}

/** Diagnostics for the UI/logs: how many rates, and how old the oldest is. */
export function fxRatesStatus(db, now = Date.now()) {
  const table = readTable(db)
  const fresh = Object.entries(table).filter(([, v]) => v && now - (v.t ?? 0) <= RATE_MAX_AGE_MS)
  const ages = fresh.map(([, v]) => now - (v.t ?? 0))
  return {
    symbols: fresh.length,
    stale: Object.keys(table).length - fresh.length,
    oldestAgeMin: ages.length ? Math.round(Math.max(...ages) / 60_000) : null,
    newestAgeMin: ages.length ? Math.round(Math.min(...ages) / 60_000) : null,
    maxAgeHours: RATE_MAX_AGE_MS / 3_600_000,
  }
}

function readTable(db) {
  try {
    const parsed = JSON.parse(getState(db, STATE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
