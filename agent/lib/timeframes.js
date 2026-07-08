// ---------------------------------------------------------------------------
// agent/lib/timeframes.js — free-text timeframe parsing + bar aggregation
//
// The broker only serves the native trendbar periods (1m … 1mo). Any other
// timeframe the trader types (90m, 1.5h, 0.25d, 2mo) is synthesised by
// fetching the largest native period that divides it and aggregating.
//
// Twin file: src/lib/timeframes.js (frontend mirror — keep parse rules
// identical so what the UI accepts is exactly what the agent can serve).
// ---------------------------------------------------------------------------

// Native trendbar durations. Mirrors TRENDBAR_PERIODS in ctrader-ws.js
// (durations only — protocol codes stay there; this module must not import
// ctrader-ws, which drags in the ws dependency and a circular import).
export const NATIVE_TF_MS = Object.freeze({
  '1m': 60_000, '2m': 120_000, '3m': 180_000, '4m': 240_000, '5m': 300_000,
  '10m': 600_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000,
  '1d': 86_400_000, '1w': 604_800_000, '1mo': 2_592_000_000,
})

const UNIT_MS = {
  m: 60_000,            // minute — integers only
  h: 3_600_000,         // decimals allowed from here up
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000,    // month = 30 days, matching the native '1mo'
}

// Unit spellings → canonical unit. 'M' (capital) is month; 'm' is minute.
const UNIT_ALIASES = {
  min: 'm', mins: 'm', m: 'm',
  h: 'h', hr: 'h', hrs: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', week: 'w', weeks: 'w',
  M: 'mo', mo: 'mo', month: 'mo', months: 'mo',
}

const MAX_MS = 12 * UNIT_MS.mo // sanity ceiling: one year

/**
 * Parse a trader-typed timeframe: "15min", "2h", "1.5h", "0.25d", "3d",
 * "1w", "1M". Decimals allowed for hours and up; minutes must be integers;
 * everything must land on whole minutes.
 *
 * @param {string} input
 * @returns {{label: string, ms: number} | null} canonical label + duration,
 *   or null when unreadable. Native inputs return the native label.
 */
export function parseTimeframe(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (NATIVE_TF_MS[text]) return { label: text, ms: NATIVE_TF_MS[text] }

  // 'M' must survive as month while every other unit is case-insensitive.
  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*(M|[A-Za-z]+)$/)
  if (!m) return null
  const value = Number(m[1].replace(',', '.'))
  const unit = UNIT_ALIASES[m[2] === 'M' ? 'M' : m[2].toLowerCase()]
  if (!unit || !Number.isFinite(value) || value <= 0) return null
  if (unit === 'm' && !Number.isInteger(value)) return null // no 1.5m

  const ms = value * UNIT_MS[unit]
  if (ms % 60_000 !== 0) return null // must be whole minutes (0.001h etc.)
  if (ms > MAX_MS) return null

  // Trim trailing zeros so '1.50h' and '1.5h' are the same label.
  const label = `${Number(value)}${unit}`
  const native = Object.entries(NATIVE_TF_MS).find(([, nms]) => nms === ms)
  return { label: native ? native[0] : label, ms }
}

/**
 * Duration of a timeframe label in ms — native or parseable custom. 0 when
 * unreadable, so sorts push junk to the end instead of throwing.
 */
export function tfMs(label) {
  return NATIVE_TF_MS[label] ?? parseTimeframe(label)?.ms ?? 0
}

/**
 * Pick the fetch source for a custom duration: the LARGEST native period
 * that divides it evenly. 1.5h → 3 × 30m; 6h → 6 × 1h; 2mo → 2 × 1mo.
 * Whole-minute durations always divide by '1m', so this never fails for
 * anything parseTimeframe accepted.
 *
 * @returns {{base: string, factor: number} | null}
 */
export function fetchPlan(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const natives = Object.entries(NATIVE_TF_MS).sort((a, b) => b[1] - a[1])
  for (const [base, baseMs] of natives) {
    if (baseMs < ms && ms % baseMs === 0) return { base, factor: ms / baseMs }
  }
  return null
}

/**
 * Aggregate base bars into groups of `factor`, anchored at the END of the
 * series so the newest aggregate is always built from the newest base bars.
 * (End-anchoring beats clock-aligned buckets here: weekend gaps and calendar
 * months make fixed buckets ragged, and the strategy only cares that bars
 * are internally consistent within one fetch.)
 *
 * Bars: {t,o,h,l,c,v} ascending by t. Leading remainder bars are dropped.
 */
export function aggregateBars(bars, factor) {
  if (!Array.isArray(bars) || factor <= 1) return bars || []
  const start = bars.length % factor
  const out = []
  for (let i = start; i + factor <= bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor)
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map(b => b.h)),
      l: Math.min(...chunk.map(b => b.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((s, b) => s + (b.v || 0), 0),
    })
  }
  return out
}
