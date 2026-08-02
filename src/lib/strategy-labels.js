// Shared strategy short-labels — one source of truth so the Desk Edge-health
// table and the Std trade table never drift (they did: rsi2_reversion was
// missing from one). Terse codes on purpose (dense mobile tables).
export const STRAT_SHORT = {
  fib_618_fade: 'FIB',
  cup_handle: 'C&H',
  inv_cup_handle: 'ICUP',
  ema_pullback: 'EMA',
  donchian_breakout: 'BRK',
  rsi_meanrev: 'RSI',
  rsi2_reversion: 'RSI2',
  vwap_trend: 'VWAP',
  vp_value: 'VP',
  fib_confluence: 'FIBC',
  // Added 2026-07-29: both were in STRATEGY_REGISTRY and missing here, so
  // their trades and vetoes rendered a raw snake_case key. Found by the
  // registry-coverage test in strategy-labels.test.js, which now fails the
  // build rather than letting the next one slip through the same way.
  va_breakout: 'VAB',
  fvg_retrace: 'FVG',
}

// key → short code, falling back to the raw key (never blank for a real
// strategy). null/empty → null so callers can render a dash.
export const stratShort = (key) => (key ? (STRAT_SHORT[key] || key) : null)

// ---------------------------------------------------------------------------
// FULL names, for the places that have room for prose rather than a 4-letter
// code. Owner (2026-07-30, screenshot of the Accounts page): "Check the Text
// for the first column of 'Strategy forecast vs. actual' in Accounts page. the
// abbreviatons and acryomns not proper capitalised."
//
// They were right, and CSS was doing it. Three tables rendered the raw
// snake_case KEY under `text-transform: capitalize`, which capitalises the
// first letter of each word and nothing else — so `rsi2_reversion` came out
// "Rsi2_reversion", `vwap_trend` as "Vwap_trend", `fvg_retrace` as
// "Fvg_retrace". CSS cannot know that RSI, VWAP and FVG are acronyms; only a
// map can. These strings mirror STRATEGY_REGISTRY's `name` field
// (agent/services/strategies.js), which already spells them correctly, and the
// coverage test fails the build if a new strategy is added without one.
// ---------------------------------------------------------------------------
// Owner 2026-08-01 set the display titles for five keys explicitly
// ("vwap_trend = VWAP Trend, fib_confluence = Fibonacci Confluence, ...");
// those five no longer mirror STRATEGY_REGISTRY's `name` field — the UI map
// is the owner's wording, the registry keeps its own strings for agent-side
// text (Telegram). The registry-coverage test still guards KEY coverage.
// Owner 2026-08-02: "I am very particular about words/terms/acronyms" —
// every strategy display name is Title Case ("Fibonacci 61.8% Fade", never
// "fib_618_fade" or "Fibonacci 61.8% fade").
export const STRAT_NAME = {
  fib_618_fade: 'Fibonacci 61.8% Fade',
  cup_handle: 'Cup & Handle',
  inv_cup_handle: 'Inverted Cup & Handle',
  ema_pullback: 'EMA Trend-Pullback',
  donchian_breakout: 'Range Breakout',
  rsi_meanrev: 'RSI Mean-Reversion',
  rsi2_reversion: 'RSI 2 Reversion',
  vwap_trend: 'VWAP Trend',
  vp_value: 'Vol. Profile Value',
  fib_confluence: 'Fibonacci Confluence',
  va_breakout: 'Value-Area Breakout',
  fvg_retrace: 'FVG Retrace',
}

// Buckets the API emits that are NOT strategies, kept out of STRAT_NAME so the
// registry-coverage tests stay honest about what a strategy is.
// 'manual / external' is strategy-insights.js's COALESCE fallback for a trade
// with no strategy label at all (agent/services/strategy-insights.js:21).
export const NON_STRATEGY_NAME = {
  'manual / external': 'Manual / External',
  manual: 'Manual',
  external: 'External',
  unlabelled: 'Unlabelled',
}

// Acronyms and initialisms that must stay upper-case when a key has no entry in
// STRAT_NAME. Only terms this project actually uses — a generic
// "three letters means an acronym" rule would shout at words like "day".
const ACRONYMS = new Set([
  'rsi', 'vwap', 'fvg', 'ema', 'sma', 'atr', 'macd', 'vp', 'va', 'rr', 'tp', 'sl',
  'fx', 'llm', 'ai', 'adx', 'obv', 'cci', 'mfi', 'ohlc', 'ohlcv', 'pnl', 'dd', 'cvar',
])

/**
 * A human label for a strategy key.
 *
 * Known keys get their registry name. Anything else — a strategy added by the
 * agent and not yet mapped, or the aggregate bucket 'manual / external' the
 * insights query emits — is humanised: separators become spaces, the acronyms
 * above go upper-case, other words get a leading capital. The raw key is never
 * shown as-is and never blanked; an unmapped strategy must stay identifiable.
 *
 * Callers should DROP their `capitalize` class when using this: CSS capitalize
 * would re-lowercase nothing but would fight future edits, and it is what
 * produced "Rsi2_reversion" in the first place.
 *
 * @param {string|null|undefined} key
 * @returns {string|null} null for null/empty, so callers can render a dash.
 */
export function strategyLabel(key) {
  if (!key) return null
  if (Object.prototype.hasOwnProperty.call(STRAT_NAME, key)) return STRAT_NAME[key]
  if (Object.prototype.hasOwnProperty.call(NON_STRATEGY_NAME, key)) return NON_STRATEGY_NAME[key]
  const words = String(key).split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return String(key)
  return words
    .map(w => {
      const lower = w.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      // A leading acronym fused to digits — rsi2, ema200 — is split so the
      // acronym still shouts: "RSI2", not "Rsi2".
      const m = /^([a-z]+)(\d+)$/.exec(lower)
      if (m && ACRONYMS.has(m[1])) return m[1].toUpperCase() + m[2]
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')
}
