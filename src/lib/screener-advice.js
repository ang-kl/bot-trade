// screener-advice.js — a deterministic, technical-only read for the
// watchlist screener (owner: "advice whether aggressive buying or buying
// or volatility"). This is NOT a fundamentals/analyst recommendation —
// there is no such data source in this app (see Tune.jsx's Defense-stocks
// preset comment). It's a plain-words label derived from three numbers the
// bot already computes for real once a symbol is scanned:
//   bias        — long/short/skip, from the strategy scan
//   confidence  — 0-10 conviction score, from the same scan
//   atrPct      — ATR as % of price, from the regime detector
// Blank (null) until the symbol has actually been scanned — never invented.

export const HIGH_VOL_ATR_PCT = 3 // ATR >= 3% of price reads as "volatile" regardless of bias

/**
 * @param {{bias: string|null, confidence: number|null, atrPct: number|null}} input
 * @returns {{label: string, tone: 'up'|'down'|'warning'|'neutral'} | null}
 *   null = not scanned yet / no real signal to report.
 */
export function screenerAdvice({ bias, confidence, atrPct }) {
  if (!bias || bias === 'skip') return null
  const long = bias === 'long'
  if (atrPct != null && atrPct >= HIGH_VOL_ATR_PCT) {
    return { label: 'Caution — high volatility', tone: 'warning' }
  }
  if (confidence != null && confidence >= 7) {
    return { label: long ? 'Aggressive Buy' : 'Aggressive Sell', tone: long ? 'up' : 'down' }
  }
  return { label: long ? 'Buy' : 'Sell', tone: long ? 'up' : 'down' }
}
