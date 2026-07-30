// side.js — ONE answer to "is this position long or short?".
//
// THE BUG THIS EXISTS TO KILL (owner, 2026-07-30, with a screenshot of ten open
// positions): "wrong estimate Dollar calculation for Stop-Loss for 'short'
// trade, it is positive dollar while 'Take-Profit' is negative dollar."
//
// The dollars were right. The SIDE was wrong. Two vocabularies flow through this
// app and they were compared with `=== 'BUY'`:
//
//   · the broker/proto path says  BUY / SELL   (agent/routes/actions.js SIDE_NAME)
//   · the database path says      long / short (monitored_positions.side,
//                                               risk_events.side, trades.side)
//
// `String('long').toUpperCase() === 'BUY'` is false, so EVERY LONG held in the
// DB rendered as "Short" (StdTradeTable) and levelMoney flipped its direction,
// inverting the estimated SL/TP money. Rows carrying broker-truth impacts were
// unaffected, which is why only some rows in the screenshot looked wrong — the
// tell that made the vocabulary mismatch findable.
//
// Nine call sites had already worked around this individually — three with the
// correct `side === 'BUY' || side === 'long'` form (pfd-math, chrono-math,
// TradeGaugeWall), the rest with the broken strict form. That split is the real
// defect: a per-call-site convention cannot hold. This module is the convention.
//
// UNKNOWN IS A THIRD ANSWER. `isLong` returns null rather than falling through
// to "short", because on this screen a guess is a lie about direction, and
// direction decides whether a number is a profit or a loss.

const LONG = new Set(['buy', 'long', 'b', 'bid', '1'])
const SHORT = new Set(['sell', 'short', 's', 'ask', '2'])

/**
 * @param {string|number|null|undefined} side any of BUY/SELL, long/short, 1/2
 * @returns {boolean|null} true long, false short, null when it cannot be known
 */
export function isLong(side) {
  const s = String(side ?? '').trim().toLowerCase()
  if (LONG.has(s)) return true
  if (SHORT.has(s)) return false
  return null
}

/** +1 long, -1 short, null unknown — for price-difference maths. */
export function sideDir(side) {
  const l = isLong(side)
  return l === null ? null : (l ? 1 : -1)
}

/** 'Long' / 'Short' / null. Callers print '—' for null rather than guessing. */
export function sideLabel(side) {
  const l = isLong(side)
  return l === null ? null : (l ? 'Long' : 'Short')
}

/** 'LONG' / 'SHORT' / null — for the tables that shout their side column. */
export function sideLabelUpper(side) {
  const s = sideLabel(side)
  return s === null ? null : s.toUpperCase()
}
