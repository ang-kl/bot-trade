// ---------------------------------------------------------------------------
// shared/formulas.js — the ONE home for the formulas that both the Node agent
// and the React app must agree on (owner, 2026-07-28: "have a standard
// codebase section for formulas, don't recode everywhere and get messy").
//
// Before this file existed the repo carried FIVE symbol→asset-class
// classifiers and SIX trading-day anchors, and they disagreed: the server
// ledger bucketed `.US` equities into Indices (no `stock` class at all) and
// rolled its day at a fixed 22:00 UTC, while the page's gradient card used
// its own classifier WITH a stock class and a DST-aware 17:00-NY day roll —
// so the same losing trade showed as "Stocks −$953" in one card and
// "Indices −404" in another, and "Yesterday" quietly contained today.
//
// Plain ESM with no imports so it loads identically under Node (agent/) and
// Vite (src/). Anything time- or symbol-classification-shaped that two
// surfaces both need belongs here, not re-derived locally.
// ---------------------------------------------------------------------------

// --- market categorization -------------------------------------------------
// Eight classes: the seven display columns plus 'other'. 'other' EXISTS as a
// column so every classified set is exhaustive — cells must provably sum to
// their Net; a silent leftover bucket is how the Strategy×market table got a
// Net no visible cell explained.
export const MARKET_COLS = [
  { key: 'crypto', label: 'Crypto' },
  { key: 'fx', label: 'Forex' },
  { key: 'index', label: 'Indices' },
  { key: 'stock', label: 'Stocks' },
  { key: 'metal', label: 'Metals' },
  { key: 'energy', label: 'Energy' },
  { key: 'grain', label: 'Grains' },
  { key: 'other', label: 'Other' },
]
export const MARKETS = MARKET_COLS.map(c => c.key)

const CRYPTO = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB|DOT|LINK|AVAX|TRX)[A-Z]{3,4}$/
const METAL = /^X(AU|AG|PT|PD)[A-Z]{3}$|^COPPER/
const ENERGY = /^(NATGAS|SPOTCRUDE|BRENT|UKOIL|USOIL|OIL|WTI)/
const GRAIN = /^(WHEAT|CORN|SOYBEAN|SUGAR|COFFEE|COCOA|COTTON|OATS|RICE)/
const INDEX = /^(US30|US500|NAS100|USTEC|US2000|GER40|UK100|FRA40|JPN225|AUS200|EUSTX|VIX|DOW|HK50|CHINA50|SPAIN35|ITALY40|SWISS20|NETH25)/
// Exchange-suffixed cash equities. Indices are matched FIRST (above), so
// AUS200 never lands here; a plain `0016.HK` or `GOOGL.US` does.
const STOCK_SUFFIX = /\.(US|UK|DE|AU|CA|JP|HK|SG)$/

/** Symbol → one of MARKETS. The single classifier — do not fork this. */
export function categorize(symbol) {
  const s = String(symbol || '').toUpperCase()
  if (CRYPTO.test(s)) return 'crypto'
  if (METAL.test(s)) return 'metal'
  if (ENERGY.test(s)) return 'energy'
  if (GRAIN.test(s)) return 'grain'
  if (INDEX.test(s)) return 'index'
  if (STOCK_SUFFIX.test(s)) return 'stock'
  if (/^[A-Z]{6}$/.test(s)) return 'fx'
  return 'other'
}

// --- trading-day / week anchors --------------------------------------------
// The FX trading day opens at 17:00 America/New_York (owner sign-off
// 2026-07-24), DST-aware via the tz database — NOT a fixed UTC hour. In
// July that is 21:00 UTC; in January 22:00 UTC. Every window labelled
// "Yesterday"/"WTD"/"Today" must use THIS anchor or its label lies for the
// hour after the real day roll.
const D = 24 * 3600_000
const FX_DAY_OPEN_NY_MIN = 17 * 60

function nyWallClock(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(nowMs))
  const get = (t) => parts.find(p => p.type === t)?.value
  return { wd: get('weekday'), min: (Number(get('hour')) % 24) * 60 + Number(get('minute')) }
}

/** Most recent 17:00-NY instant at or before `now`, to the millisecond. */
export function dayAnchorMs(nowMs) {
  const { min } = nyWallClock(nowMs)
  const sinceAnchorMin = min >= FX_DAY_OPEN_NY_MIN ? min - FX_DAY_OPEN_NY_MIN : min + (24 * 60 - FX_DAY_OPEN_NY_MIN)
  const secondsPastMin = (Math.floor(nowMs / 1000) % 60) + (nowMs % 1000) / 1000
  return nowMs - sinceAnchorMin * 60_000 - secondsPastMin * 1000
}

/** Most recent Sunday-17:00-NY instant — the FX week open. */
export function weekAnchorMs(nowMs) {
  let a = dayAnchorMs(nowMs)
  // The anchor instant is 17:00 NY of some day; the week opens on Sunday's.
  for (let i = 0; i < 8 && nyWallClock(a).wd !== 'Sun'; i++) a -= D
  return a
}

/** Friday 17:00 NY → Sunday 17:00 NY: FX closed (crypto still trades). */
export function isFxWeekend(nowMs) {
  const { wd, min } = nyWallClock(nowMs)
  if (wd === 'Sat') return true
  if (wd === 'Fri') return min >= FX_DAY_OPEN_NY_MIN
  if (wd === 'Sun') return min < FX_DAY_OPEN_NY_MIN
  return false
}

// --- timestamps ------------------------------------------------------------
/**
 * closed_at → epoch ms. Prefers the exact closed_at_ms column when present;
 * tolerates both the space- and 'T'-separated text formats (the same split
 * the risk gate normalizes with REPLACE).
 */
export function closedAtMs(row) {
  if (row.closed_at_ms != null && Number.isFinite(Number(row.closed_at_ms))) return Number(row.closed_at_ms)
  const raw = String(row.closed_at || '').replace(' ', 'T')
  if (!raw) return null
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z')
  return Number.isFinite(t) ? t : null
}
