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
