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
}

// key → short code, falling back to the raw key (never blank for a real
// strategy). null/empty → null so callers can render a dash.
export const stratShort = (key) => (key ? (STRAT_SHORT[key] || key) : null)
