// ---------------------------------------------------------------------------
// agent/services/sizing-preview.js — per-symbol dynamic lot-size preview for
// the Watchlist table. Uses the SAME functions the live risk gate uses
// (computeRiskBasedVolume / usdLossPerLot), so the preview can never
// disagree with what the bot actually sizes at trade time.
//
// The formula (fixed-fractional risk):
//   risk budget  = balance × perTradeRiskPct
//   auto lots    = budget ÷ USD-loss-per-lot(SL distance)
// The preview uses the TIGHTEST allowed stop (minSLDistancePct of price),
// i.e. the LARGEST lots the gate could ever approve — real signals with
// wider stops size smaller automatically. The per-symbol "Max lots" column
// is a manual CAP on top, never the size itself.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { loadRiskConfig, getAccountBalance, computeRiskBasedVolume } from './risk.js'
import { contractSize, instrumentType, usdLossPerLot } from '../lib/contracts.js'

export function sizingPreview(db) {
  const cfg = loadRiskConfig(db)
  const balance = getAccountBalance(db)
  const budget = balance != null ? Math.round(balance * cfg.perTradeRiskPct * 100) / 100 : null

  let watch = []
  try {
    watch = JSON.parse(getState(db, 'autopilot_symbols_json') || getState(db, 'watchlist_json') || '[]')
  } catch { /* empty watchlist */ }

  // Latest scan prices — the loop refreshes these every cycle.
  const prices = {}
  try {
    const last = JSON.parse(getState(db, 'last_scan_results') || 'null')
    for (const r of (last?.scans || last?.rows || [])) {
      const px = r.price ?? r.close
      if (r.symbol && px != null) prices[String(r.symbol).toUpperCase()] = Number(px)
    }
  } catch { /* no scan yet */ }

  const rows = watch.map(w => {
    const symbol = String(w.symbol || '').toUpperCase()
    const type = instrumentType(symbol)
    const price = prices[symbol] ?? null
    const maxCap = Number(w.maxVolume) > 0 ? Number(w.maxVolume) : null
    const base = { symbol, type, enabled: w.enabled !== false, price, contractSize: contractSize(symbol), maxCap }
    if (balance == null) return { ...base, autoLots: null, usdPerLot: null, note: 'balance unknown — link the account' }
    if (price == null) return { ...base, autoLots: null, usdPerLot: null, note: 'no scan price yet' }

    const slDistance = price * (cfg.minSLDistancePct / 100)
    const sized = computeRiskBasedVolume(balance, symbol, slDistance, cfg.perTradeRiskPct, price)
    const usdPerLot = usdLossPerLot(symbol, slDistance, price)
    const autoLots = sized.volume
    const effectiveLots = autoLots != null && maxCap != null ? Math.min(autoLots, maxCap) : autoLots
    return {
      ...base,
      autoLots,
      effectiveLots,
      usdPerLot: Number.isFinite(usdPerLot) ? Math.round(usdPerLot * 100) / 100 : null,
      note: autoLots === 0 ? sized.note : null,
    }
  })

  return {
    balance,
    riskPct: cfg.perTradeRiskPct,
    minSLDistancePct: cfg.minSLDistancePct,
    minLotSize: cfg.minLotSize,
    budget,
    rows,
  }
}
