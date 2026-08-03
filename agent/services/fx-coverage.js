// ---------------------------------------------------------------------------
// agent/services/fx-coverage.js — which currencies the sizer can actually
// convert to USD right now, and which symbols it therefore cannot size.
//
// WHY. Owner, 2026-08-03: "root cause usd_per_lot_unknown". It was the largest
// veto bucket in the 1-day window — 1,353 entries, AUDPLN 600, EURJPY 244,
// AUDCAD 238, EURGBP 150 — and the root cause could not be settled from
// outside, because the one input that decides it is invisible.
//
// `computeRiskBasedVolume` (risk.js:441) vetoes `usd_per_lot_unknown` when
// `usdLossPerLot` returns NaN, and for a cross that happens for exactly one
// reason: `usdRate(quote, rates)` found no path from the quote currency to
// USD. The rates map comes from scanned closes only (fx-rates.js), and
// `usdRate` takes at most ONE transitive hop, deliberately — chaining two
// derived rates compounds two stale closes into a mis-sized position.
//
// So a cross is sizeable only if the map holds either its own USD major, or a
// scanned pair carrying its quote currency alongside a DIRECTLY resolvable
// second leg. Nothing reports which of those hold. This does.
//
// It is a read-only mirror of the sizing decision — it calls the same
// `usdRate` the gate calls, so it cannot drift into telling a comfortable
// story the sizer disagrees with.
// ---------------------------------------------------------------------------

import { usdRate, fxQuoteCurrency } from '../lib/contracts.js'

// The quote-currency test is IMPORTED, never reimplemented. A local copy of
// the 6-letter rule silently dropped the CONTRACT_SIZE exception — NATGAS,
// COFFEE and COTTON are six uppercase letters and are not currency pairs —
// so this report called NATGAS unsizeable while the sizer sized it happily.
// A diagnostic that disagrees with the thing it diagnoses is worse than none;
// the agreement test below is what caught it.
const quoteOf = fxQuoteCurrency

/**
 * Report conversion coverage for a rates map.
 *
 * @param {Record<string, number>} rates  scanned closes, { SYMBOL: price }
 * @param {string[]} probeSymbols  symbols to test — typically the ones the
 *   veto breakdown named, so the report answers the question that was asked
 * @returns {{symbols:number, currencies:object, unresolvable:string[],
 *            probes:Array<{symbol:string,quote:string|null,rate:number|null,sizeable:boolean}>}}
 */
export function fxCoverage(rates, probeSymbols = []) {
  const map = rates && typeof rates === 'object' ? rates : {}
  const syms = Object.keys(map)

  // Every currency that appears anywhere in the map, and whether it resolves.
  //
  // The census must use the SAME pair test as the probes. It didn't, and
  // NATGAS was split into two invented currencies, NAT and GAS, which then
  // reported as unresolvable — a permanent false alarm on a symbol the sizer
  // handles fine. `quoteOf` is null for anything that is not a currency pair,
  // which is exactly the predicate needed.
  const seen = new Set()
  for (const s of syms) {
    const u = String(s).toUpperCase()
    const q = quoteOf(u)
    if (!q) continue
    seen.add(u.slice(0, 3))
    seen.add(q)
  }
  const currencies = {}
  const unresolvable = []
  for (const c of [...seen].sort()) {
    const r = usdRate(c, map)
    const ok = Number.isFinite(r) && r > 0
    currencies[c] = ok ? Number(r.toPrecision(8)) : null
    if (!ok) unresolvable.push(c)
  }

  const probes = []
  for (const sym of probeSymbols) {
    const q = quoteOf(sym)
    // A non-FX symbol (index, metal, single name) is USD-denominated and needs
    // no conversion at all — reporting it as "unsizeable" would be a false
    // alarm, and false alarms are how a real gap gets ignored.
    if (q == null) { probes.push({ symbol: sym, quote: null, rate: 1, sizeable: true }); continue }
    const r = usdRate(q, map)
    const ok = Number.isFinite(r) && r > 0
    probes.push({ symbol: sym, quote: q, rate: ok ? Number(r.toPrecision(8)) : null, sizeable: ok })
  }

  return { symbols: syms.length, currencies, unresolvable, probes }
}

/**
 * The conversion legs that would fix a currency, named concretely.
 *
 * "PLN does not resolve" is a diagnosis nobody can act on. "add USDPLN or
 * AUDUSD to a watchlist" is. Returns the direct majors first, then the
 * one-hop options the map is already halfway to satisfying.
 */
export function missingLegsFor(currency, rates) {
  const c = String(currency || '').toUpperCase()
  const map = rates && typeof rates === 'object' ? rates : {}
  const direct = [`${c}USD`, `USD${c}`]
  const hops = []
  for (const sym of Object.keys(map)) {
    const s = String(sym).toUpperCase()
    // Same pair test as the census and the probes — a hop "via NATGAS" is not
    // a hop, and suggesting one would send the operator after a symbol that
    // could never supply a rate.
    const quote = quoteOf(s)
    if (!quote) continue
    const base = s.slice(0, 3)
    if (base !== c && quote !== c) continue
    const other = base === c ? quote : base
    if (other === c || other === 'USD') continue
    // This cross IS in the map; it becomes a usable hop the moment the other
    // leg's own USD major is scanned.
    const r = usdRate(other, map)
    if (!Number.isFinite(r) || r <= 0) hops.push({ via: s, needs: [`${other}USD`, `USD${other}`] })
  }
  return { currency: c, direct, hops }
}
