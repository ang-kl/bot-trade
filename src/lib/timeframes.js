// ---------------------------------------------------------------------------
// src/lib/timeframes.js — free-text timeframe parsing (frontend mirror)
//
// Twin file: agent/lib/timeframes.js — keep the parse rules IDENTICAL so
// what the UI accepts is exactly what the agent can serve. The agent twin
// additionally owns fetchPlan/aggregateBars (server-side bar synthesis).
// ---------------------------------------------------------------------------

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
 * @returns {{label: string, ms: number} | null}
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

  const label = `${Number(value)}${unit}`
  const native = Object.entries(NATIVE_TF_MS).find(([, nms]) => nms === ms)
  return { label: native ? native[0] : label, ms }
}

/** Duration of a timeframe label in ms — native or parseable custom, else 0. */
export function tfMs(label) {
  return NATIVE_TF_MS[label] ?? parseTimeframe(label)?.ms ?? 0
}
