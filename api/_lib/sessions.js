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
  const commodities = ['NATGAS', 'COCOA', 'COFFEE', 'COPPER', 'ALUMINIUM', 'SOYBEANS', 'SPOTCRUDE']
  if (fx.includes(s)) return 'fx'
  if (crypto.includes(s)) return 'crypto'
  if (indices.includes(s)) return 'index'
  if (metals.includes(s)) return 'metal'
  if (commodities.includes(s)) return 'commodity'
  return 'stock'
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
