// Shared market session utilities used by scan.js and analyze.js.

export const SESSIONS = [
  { id: 'tokyo',     label: 'Tokyo',     open: 0,  close: 6,  tz: 'Asia/Tokyo' },
  { id: 'sydney',    label: 'Sydney',    open: 22, close: 5,  tz: 'Australia/Sydney' },
  { id: 'singapore', label: 'Singapore', open: 1,  close: 9,  tz: 'Asia/Singapore' },
  { id: 'london',    label: 'London',    open: 8,  close: 16, tz: 'Europe/London' },
  { id: 'frankfurt', label: 'Frankfurt', open: 7,  close: 15, tz: 'Europe/Berlin' },
  { id: 'nyse',      label: 'New York',  open: 14, close: 21, tz: 'America/New_York' },
]

export function getActiveSessions() {
  const utcHour = new Date().getUTCHours()
  return SESSIONS.filter(s => {
    if (s.open < s.close) return utcHour >= s.open && utcHour < s.close
    return utcHour >= s.open || utcHour < s.close
  })
}

export function getSessionContext() {
  const active = getActiveSessions()
  if (active.length === 0) return 'Off-hours - thin liquidity, wide spreads. Careful with entries.'
  const names = active.map(s => s.label)
  const overlaps = []
  if (names.includes('Tokyo') && names.includes('London')) overlaps.push('Tokyo-London overlap')
  if (names.includes('London') && names.includes('New York')) overlaps.push('London-NY overlap - peak liquidity')
  if (names.includes('Sydney') && names.includes('Tokyo')) overlaps.push('Asia session - Sydney/Tokyo overlap')
  let note = `Active sessions: ${names.join(', ')}.`
  if (overlaps.length > 0) note += ` ${overlaps.join('. ')}.`
  return note
}

export function categoriseSymbol(symbol) {
  const s = symbol.toUpperCase()
  const fx = ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'AUDJPY', 'EURJPY', 'GBPJPY']
  const crypto = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD']
  const indices = ['US500', 'US30', 'NAS100', 'GER40', 'JPN225', 'VIX', 'CN50', 'SDY']
  const metals = ['XAUUSD', 'XAGUSD', 'XPTUSD', 'USDX']
  // ICE softs — London/NY daytime exchange windows, NOT 24/5.
  const softs = ['COCOA', 'COFFEE', 'SUGAR', 'COTTON', 'OJUICE']
  // CBOT grains — overnight + daytime sessions with a midday break. CORN was
  // MISSING entirely and fell through to 'stock' → falsely vetoed all night
  // (owner report 2026-07-17).
  const grains = ['CORN', 'WHEAT', 'SOYBEAN', 'SOYBEANS', 'OATS', 'RICE']
  const commodities = ['NATGAS', 'COPPER', 'ALUMINIUM', 'SPOTCRUDE', 'WTI', 'BRENT']
  if (fx.includes(s)) return 'fx'
  if (crypto.includes(s)) return 'crypto'
  if (indices.includes(s)) return 'index'
  if (metals.includes(s)) return 'metal'
  if (softs.includes(s)) return 'soft'
  if (grains.includes(s)) return 'grain'
  if (commodities.includes(s)) return 'commodity'
  return 'stock'
}

/**
 * Per-symbol tradability gate. Backtests run on history and don't care, but
 * a MARKET order into a closed market is a guaranteed broker rejection —
 * stocks/indices only trade their exchange session, FX/metals close on
 * weekends, crypto never closes.
 *
 * Conservative approximations (UTC):
 *   stock/index        → NYSE cash-ish window, Mon–Fri 14:30–20:55
 *   soft (ICE)         → Mon–Fri 09:00–17:15 (cocoa/coffee/sugar/cotton
 *                        daytime exchange window — they were treated as 24/5
 *                        and the BROKER rejected the overnight orders)
 *   grain (CBOT)       → Mon–Fri 00:05–12:40 and 13:35–18:15 (overnight +
 *                        daytime electronic sessions, midday break honoured)
 *   commodity (energy) → 24/5 minus the daily 21:00–22:00 settlement break
 *   fx/metal           → Sun 22:00 → Fri 21:00
 *   crypto             → always
 *
 * @returns {{open: boolean, reason?: string}}
 */
export function isSymbolMarketOpen(symbol, now = new Date()) {
  const cat = categoriseSymbol(symbol)
  if (cat === 'crypto') return { open: true }

  const day = now.getUTCDay()            // 0 Sun … 6 Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()

  if (cat === 'stock' || cat === 'index') {
    const inSession = day >= 1 && day <= 5 && mins >= 14 * 60 + 30 && mins <= 20 * 60 + 55
    return inSession
      ? { open: true }
      : { open: false, reason: `${symbol} trades the New York session only (Mon–Fri 14:30–20:55 UTC) — signal skipped until the market opens` }
  }

  if (cat === 'soft') {
    const inSession = day >= 1 && day <= 5 && mins >= 9 * 60 && mins <= 17 * 60 + 15
    return inSession
      ? { open: true }
      : { open: false, reason: `${symbol} trades the ICE daytime window only (Mon–Fri 09:00–17:15 UTC) — signal skipped until the market opens` }
  }

  if (cat === 'grain') {
    const overnight = mins >= 5 && mins <= 12 * 60 + 40
    const daytime = mins >= 13 * 60 + 35 && mins <= 18 * 60 + 15
    const inSession = day >= 1 && day <= 5 && (overnight || daytime)
    return inSession
      ? { open: true }
      : { open: false, reason: `${symbol} trades CBOT sessions only (Mon–Fri 00:05–12:40 & 13:35–18:15 UTC) — signal skipped until the market opens` }
  }

  // fx / metal / commodity: closed from Fri 21:00 UTC to Sun 22:00 UTC
  const weekendClosed =
    day === 6 ||
    (day === 5 && mins >= 21 * 60) ||
    (day === 0 && mins < 22 * 60)
  if (weekendClosed) {
    return { open: false, reason: `${symbol}: FX/CFD market is closed for the weekend (reopens Sun 22:00 UTC)` }
  }
  // Energies observe a daily 21:00–22:00 UTC settlement break.
  if (cat === 'commodity' && mins >= 21 * 60 && mins < 22 * 60) {
    return { open: false, reason: `${symbol}: daily settlement break (21:00–22:00 UTC) — reopens at 22:00` }
  }
  return { open: true }
}

// Next session opening — returns { label, minsUntil } or null.
export function nextSessionOpening() {
  const now = new Date()
  const utcHour = now.getUTCHours()
  const utcMin = now.getUTCMinutes()
  const nowMins = utcHour * 60 + utcMin
  let best = null
  for (const s of SESSIONS) {
    const openMins = s.open * 60
    let diff = openMins - nowMins
    if (diff <= 0) diff += 1440
    if (!best || diff < best.minsUntil) {
      best = { label: s.label, minsUntil: diff }
    }
  }
  return best
}

/**
 * Prime-liquidity gate for a symbol at an arbitrary time — the backtest's
 * session filter. Categories map to when their market actually trades well:
 *   crypto             → always
 *   stock/index        → its exchange window (isSymbolMarketOpen)
 *   fx/metal/commodity → London + New York hours, Mon-Fri 08:00-21:00 UTC
 * @param {string} symbol
 * @param {number} t - epoch ms
 */
export function inPrimeSession(symbol, t) {
  const cat = categoriseSymbol(symbol)
  if (cat === 'crypto') return true
  const now = new Date(t)
  if (cat === 'stock' || cat === 'index' || cat === 'soft' || cat === 'grain') return isSymbolMarketOpen(symbol, now).open
  const day = now.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = now.getUTCHours()
  return h >= 8 && h < 21
}
