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

/**
 * The FX/CFD WEEKEND — Fri 21:00 UTC → Sun 22:00 UTC. This is a real
 * multi-day close (gap-risk territory), NOT the ~1-hour daily lull between
 * NY close and Sydney open that getActiveSessions() reads as "no session".
 * The weekend watch must key on THIS, or it fires (and mislabels
 * "WEEKEND:HOLD") every weekday night. Owner-reported 2026-07-17.
 */
export function isWeekend(now = new Date()) {
  const day = now.getUTCDay()          // 0 Sun … 6 Sat
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes()
  return day === 6 ||
    (day === 5 && mins >= 21 * 60) ||
    (day === 0 && mins < 22 * 60)
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

// ISO-4217 fiat codes, so an FX pair can be RECOGNISED rather than enumerated.
// Deliberately excludes the metal codes (XAU/XAG/XPT/XPD), which are valid
// ISO-4217 but must classify as 'metal' — they are checked before this anyway.
const FIAT = new Set([
  'USD', 'EUR', 'JPY', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF',
  'CNH', 'CNY', 'HKD', 'SGD', 'KRW', 'TWD', 'INR', 'IDR', 'THB', 'MYR', 'PHP', 'VND',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'RUB', 'UAH', 'ISK',
  'ZAR', 'MXN', 'BRL', 'CLP', 'COP', 'PEN', 'ARS',
  'ILS', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP', 'MAD', 'NGN', 'KES',
])

/**
 * Is this symbol a currency pair, structurally?
 *
 * WHY THIS IS DERIVED AND NOT LISTED (owner report 02-08-2026: "some of the
 * forex are in the single stock"). categoriseSymbol used to recognise FX from
 * a hardcoded list of TEN pairs and fall through to 'stock' for everything
 * else. That is not a display bug: isSymbolMarketOpen gates 'stock' to the New
 * York session (Mon–Fri 14:30–20:55 UTC), so every cross outside those ten —
 * AUDPLN, EURGBP, USDPLN, GBPAUD, USDSGD, USDIDR, all of which this bot
 * trades — was refused for ~17½ hours a day and all weekend, with the reason
 * "trades the New York session only". They also drew equity-shaped tuning from
 * asset-controllers.js and fib-strategy.js.
 *
 * This is the THIRD time a hardcoded list with a 'stock' fallback has done
 * this: CORN was missing and "falsely vetoed all night" (2026-07-17), then
 * LTC/ADA/DOGE fell through the same way (2026-08-01). Enumeration cannot keep
 * up with a 221-symbol universe, so FX is now recognised by its shape — six
 * letters, two ISO-4217 codes — which covers every major, minor and exotic
 * without anyone remembering to add it.
 */
export function isFxPair(symbol) {
  const s = String(symbol || '').toUpperCase()
  if (s.length !== 6) return false
  const base = s.slice(0, 3), quote = s.slice(3)
  return base !== quote && FIAT.has(base) && FIAT.has(quote)
}

export function categoriseSymbol(symbol) {
  const s = String(symbol || '').toUpperCase()
  // Production trades LTC/ADA/DOGE too (2026-08-01: they were falling through
  // to 'stock' — wrongly market-hours-gated AND excluded from the weekend
  // quiet crypto exemption). Full Pepperstone crypto set, all 24/7.
  const crypto = ['BTCUSD', 'ETHUSD', 'XRPUSD', 'SOLUSD', 'LTCUSD', 'ADAUSD',
    'DOGEUSD', 'BCHUSD', 'BNBUSD', 'DOTUSD', 'LINKUSD', 'XLMUSD', 'AVAXUSD',
    'UNIUSD', 'MATICUSD']
  const indices = ['US500', 'US30', 'NAS100', 'GER40', 'JPN225', 'VIX', 'CN50', 'SDY']
  const metals = ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD', 'USDX']
  // ICE softs — London/NY daytime exchange windows, NOT 24/5.
  const softs = ['COCOA', 'COFFEE', 'SUGAR', 'COTTON', 'OJUICE']
  // CBOT grains — overnight + daytime sessions with a midday break. CORN was
  // MISSING entirely and fell through to 'stock' → falsely vetoed all night
  // (owner report 2026-07-17).
  const grains = ['CORN', 'WHEAT', 'SOYBEAN', 'SOYBEANS', 'OATS', 'RICE']
  const commodities = ['NATGAS', 'COPPER', 'ALUMINIUM', 'SPOTCRUDE', 'WTI', 'BRENT']
  // METALS BEFORE FX, always: XAU/XAG/XPT/XPD are real ISO-4217 codes, so
  // XAUUSD would otherwise satisfy the structural pair test and lose its own
  // session rules.
  if (crypto.includes(s)) return 'crypto'
  if (metals.includes(s)) return 'metal'
  if (indices.includes(s)) return 'index'
  if (softs.includes(s)) return 'soft'
  if (grains.includes(s)) return 'grain'
  if (commodities.includes(s)) return 'commodity'
  if (isFxPair(s)) return 'fx'
  // Still 'stock' — the CONSERVATIVE default, on purpose. An unrecognised
  // symbol treated as 24/5 would send market orders into a closed exchange and
  // collect broker rejections; treated as a stock it simply waits. The fix for
  // the FX case is that FX is no longer unrecognised, not that the fallback
  // became permissive.
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
