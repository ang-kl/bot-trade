// ---------------------------------------------------------------------------
// agent/lib/exchange-regions.js — WHERE an instrument trades.
//
// A LEAF module: it imports nothing, on purpose. Both sessions.js (which
// decides whether a market is open, and therefore whether an order may be
// sent) and symbol-taxonomy.js (which decides how the watchlist is banded)
// need the same region facts. If either owned them the other would have to
// import it, and sessions.js is the one thing in this tree that must stay
// dependency-free — categoriseSymbol sits at the bottom of the trading path.
//
// Owner, 04-08-2026: "JPN225 is Japanese Index trade at Tokyo market hours.
// GER40 is Germany." That is a display complaint on its face and a TRADING
// defect underneath: isSymbolMarketOpen gated every `index` to the New York
// cash session, so the Nikkei and the DAX were treated as closed for the whole
// of their own trading day and open for a New York afternoon in which the
// Tokyo cash market has been shut for eight hours.
// ---------------------------------------------------------------------------

/**
 * Exchange regions. `tz` is the IANA zone of the CASH market — what the owner
 * means by "Tokyo market hours". `session` names a window implemented in
 * sessions.js, so a region can never claim hours the gate does not honour.
 */
export const REGIONS = Object.freeze({
  us: { label: 'United States', flag: '🇺🇸', tz: 'America/New_York', session: 'us' },
  japan: { label: 'Japan', flag: '🇯🇵', tz: 'Asia/Tokyo', session: 'tokyo' },
  hongkong: { label: 'Hong Kong', flag: '🇭🇰', tz: 'Asia/Hong_Kong', session: 'hongkong' },
  china: { label: 'China', flag: '🇨🇳', tz: 'Asia/Shanghai', session: 'hongkong' },
  singapore: { label: 'Singapore', flag: '🇸🇬', tz: 'Asia/Singapore', session: 'hongkong' },
  australia: { label: 'Australia', flag: '🇦🇺', tz: 'Australia/Sydney', session: 'sydney' },
  germany: { label: 'Germany', flag: '🇩🇪', tz: 'Europe/Berlin', session: 'europe' },
  uk: { label: 'United Kingdom', flag: '🇬🇧', tz: 'Europe/London', session: 'uk' },
  france: { label: 'France', flag: '🇫🇷', tz: 'Europe/Paris', session: 'europe' },
  spain: { label: 'Spain', flag: '🇪🇸', tz: 'Europe/Madrid', session: 'europe' },
  italy: { label: 'Italy', flag: '🇮🇹', tz: 'Europe/Rome', session: 'europe' },
  netherlands: { label: 'Netherlands', flag: '🇳🇱', tz: 'Europe/Amsterdam', session: 'europe' },
  switzerland: { label: 'Switzerland', flag: '🇨🇭', tz: 'Europe/Zurich', session: 'europe' },
  nordics: { label: 'Nordics', flag: '🇸🇪', tz: 'Europe/Stockholm', session: 'europe' },
  canada: { label: 'Canada', flag: '🇨🇦', tz: 'America/Toronto', session: 'us' },
  global: { label: 'Global', flag: '🌐', tz: 'UTC', session: 'fx' },
  crypto: { label: 'Crypto (24/7)', flag: '₿', tz: 'UTC', session: 'always' },
})

/**
 * Cash-session windows in UTC minutes, Mon–Fri. Deliberately CONSERVATIVE and
 * deliberately approximate: these are the heuristic fallback, and
 * symbol-hours.js overrides every one of them with the broker's own schedule
 * the moment a symbol has been refreshed (isSymbolOpenCached). Being an hour
 * tight costs a few signals; being an hour loose costs broker rejections.
 *
 * DST is not modelled. Europe and the US shift together for most of the year,
 * and a 30-minute error at the edge of a window is inside the margin these
 * approximations already carry — again, the broker schedule is the real answer.
 */
export const SESSION_WINDOWS = Object.freeze({
  us: { open: 14 * 60 + 30, close: 20 * 60 + 55, label: 'New York', hours: 'Mon–Fri 14:30–20:55 UTC' },
  tokyo: { open: 0, close: 6 * 60, label: 'Tokyo', hours: 'Mon–Fri 00:00–06:00 UTC' },
  hongkong: { open: 1 * 60 + 30, close: 8 * 60, label: 'Hong Kong', hours: 'Mon–Fri 01:30–08:00 UTC' },
  sydney: { open: 23 * 60, close: 5 * 60, label: 'Sydney', hours: 'Sun–Fri 23:00–05:00 UTC' },
  europe: { open: 7 * 60, close: 15 * 60 + 30, label: 'Frankfurt/Paris', hours: 'Mon–Fri 07:00–15:30 UTC' },
  uk: { open: 8 * 60, close: 16 * 60 + 30, label: 'London', hours: 'Mon–Fri 08:00–16:30 UTC' },
})

/** Broker dot-suffix → region. The suffix IS the exchange; nothing to guess. */
export const SUFFIX_REGION = Object.freeze({
  US: 'us', NYSE: 'us', NAS: 'us',
  DE: 'germany', XETRA: 'germany',
  UK: 'uk', L: 'uk', LSE: 'uk',
  FR: 'france', PA: 'france',
  ES: 'spain', MC: 'spain',
  IT: 'italy', MI: 'italy',
  NL: 'netherlands', AS: 'netherlands',
  CH: 'switzerland', SW: 'switzerland',
  SE: 'nordics', ST: 'nordics', NO: 'nordics', OL: 'nordics',
  DK: 'nordics', CO: 'nordics', FI: 'nordics', HE: 'nordics',
  HK: 'hongkong', JP: 'japan', T: 'japan',
  AU: 'australia', AX: 'australia',
  SG: 'singapore', CA: 'canada', TO: 'canada',
})

/**
 * Index → exchange. LISTED, not derived, and that is deliberate. sessions.js
 * records three separate incidents caused by hardcoded lists (CORN, then
 * LTC/ADA/DOGE, then every FX cross outside a list of ten) and concludes that
 * enumeration cannot keep up — but the reason it could not keep up was that FX
 * pairs and equities number in the hundreds and carry structural clues.
 * `GER40` carries no clue at all: it is a broker-invented ticker, and there
 * are roughly twenty of them, fixed. Shape-matching cannot reach these; a
 * table can.
 */
export const INDEX_REGION = Object.freeze({
  US30: 'us', US500: 'us', NAS100: 'us', US2000: 'us', VIX: 'us', SDY: 'us',
  JPN225: 'japan',
  GER40: 'germany', GER30: 'germany',
  UK100: 'uk',
  FRA40: 'france', SPA35: 'spain', ITA40: 'italy', NETH25: 'netherlands',
  SWI20: 'switzerland', EUSTX50: 'germany',
  HK50: 'hongkong', CN50: 'china', CHINA50: 'china', SG30: 'singapore',
  AUS200: 'australia',
})

/** The broker suffix, uppercased, or '' — `AMD.US` → `US`. */
export function symbolSuffix(symbol) {
  const m = /\.([A-Z]{1,5})$/.exec(String(symbol || '').toUpperCase())
  return m ? m[1] : ''
}

/** The bare ticker without its exchange suffix — `AMD.US` → `AMD`. */
export const bareTicker = (symbol) =>
  String(symbol || '').toUpperCase().replace(/\.[A-Z]{1,5}$/, '')

/**
 * Which region does an instrument of class `cls` trade in?
 *
 * `cls` is passed IN rather than computed here so this module stays a leaf —
 * sessions.js calls it having just computed the class, and symbol-taxonomy.js
 * calls it the same way.
 */
export function regionFor(symbol, cls) {
  const s = String(symbol || '').toUpperCase()
  if (cls === 'crypto') return 'crypto'
  if (cls === 'index') return INDEX_REGION[s] || 'us'
  // No suffix and not a listed index → a US listing, on this broker.
  if (cls === 'stock') return SUFFIX_REGION[symbolSuffix(s)] || 'us'
  // FX, metals, energies, softs and grains are OTC or globally cleared: their
  // hours are the FX week or an exchange window, not a country's cash session.
  return 'global'
}

/** Is `mins` (UTC minutes into the day) inside a window that may wrap midnight? */
export function inWindow(win, day, mins) {
  if (!win) return false
  const { open, close } = win
  if (open < close) return day >= 1 && day <= 5 && mins >= open && mins <= close
  // Wraps midnight (Sydney): the tail belongs to the NEXT weekday, so Sunday
  // evening is in-session and Friday evening is not.
  const evening = mins >= open && day >= 0 && day <= 4
  const morning = mins <= close && day >= 1 && day <= 5
  return evening || morning
}
