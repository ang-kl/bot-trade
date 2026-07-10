// ---------------------------------------------------------------------------
// agent/lib/lot-sizing.js — per-symbol volume math for order placement.
//
// The cTrader Open API expresses volume in CENTS OF UNITS: an FX lot is
// 100,000 units → lotSize = 10,000,000. A hardcoded "10,000 per lot" sent
// every order ~1000× too small and the broker rejected each one with
// TRADING_BAD_VOLUME — the silent killer behind "risk gate said OK, no
// position appeared". Metals/indices/energy have entirely different lot
// sizes, so the only correct source is the symbol's own record
// (SYMBOL_BY_ID: lotSize, minVolume, maxVolume, stepVolume).
// ---------------------------------------------------------------------------

import { wsSymbolsByIds } from './ctrader-ws.js'

// Symbol records are static per broker — cache for the process lifetime.
const metaCache = new Map() // `${accountId}|${symbolId}` -> meta

/**
 * Fetch (and cache) the volume-relevant fields of one symbol.
 * @returns {Promise<{lotSize:number, minVolume:number|null, maxVolume:number|null, stepVolume:number|null}>}
 * @throws when the broker doesn't return the symbol or lotSize is missing —
 *         callers must treat that as "cannot size safely", not guess.
 */
export async function getVolumeMeta(host, clientId, clientSecret, accessToken, accountId, symbolId) {
  const key = `${accountId}|${symbolId}`
  if (metaCache.has(key)) return metaCache.get(key)
  const data = await wsSymbolsByIds(host, clientId, clientSecret, accessToken, accountId, [symbolId])
  const s = (data.symbol || []).find(x => String(x.symbolId) === String(symbolId))
  if (!s || !Number(s.lotSize)) {
    throw new Error(`symbol ${symbolId}: broker returned no lotSize — cannot size the order safely`)
  }
  const meta = {
    lotSize: Number(s.lotSize),
    minVolume: s.minVolume != null ? Number(s.minVolume) : null,
    maxVolume: s.maxVolume != null ? Number(s.maxVolume) : null,
    stepVolume: s.stepVolume != null ? Number(s.stepVolume) : null,
    // Price precision — the broker REJECTS order prices with more decimals
    // than the symbol allows ("more digits than symbol allows").
    digits: s.digits != null ? Number(s.digits) : 5,
  }
  metaCache.set(key, meta)
  return meta
}

/**
 * Convert lots → protocol volume (cents of units), snapped DOWN to the
 * broker's step. Pure function — unit-testable.
 * @returns {{volume:number, lots:number, belowMin:boolean, aboveMax:boolean}}
 */
export function lotsToVolume(lots, meta) {
  let volume = Math.round(Number(lots) * meta.lotSize)
  const step = meta.stepVolume || null
  if (step && step > 0) volume = Math.floor(volume / step) * step
  const belowMin = meta.minVolume != null && volume < meta.minVolume
  const aboveMax = meta.maxVolume != null && volume > meta.maxVolume
  if (aboveMax) volume = meta.maxVolume
  return { volume, lots: volume / meta.lotSize, belowMin, aboveMax }
}

/** Protocol volume (cents of units) → lots. */
export function volumeToLots(volume, meta) {
  return Number(volume) / meta.lotSize
}

// Exposed for tests.
export const _cache = metaCache
