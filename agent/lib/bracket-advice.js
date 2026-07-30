// Owner, 2026-07-31: "a manual trade with no TP, or an analysis execution with
// no SL — should be flagged as stated. the symbol should be advised and input
// the missing TP or SL."
//
// PR #520 made the exec chokepoint refuse those orders, which is correct but
// unhelpful on its own: the caller got `guard_no_target: market order has no
// take profit attached`, which names neither the symbol nor what to do next.
// This turns that refusal into something a trader can act on — WHICH symbol,
// WHICH side, WHICH field is missing, and for a take profit, the price that
// would satisfy the configured R:R floor.
//
// The suggestion is advice, never an automatic fill. Nothing here places an
// order or mutates a payload; a missing bracket stays the trader's decision,
// because a stop or target the system invented is exactly the kind of number
// that looks deliberate in the ledger six months later and was not.
import { minRrFor } from '../services/strategies.js'

/** Which bracket leg a guard_* reason is complaining about, or null. */
export function bracketGapField(reason) {
  if (typeof reason !== 'string') return null
  if (reason.startsWith('guard_naked_order')) return 'sl'
  if (reason.startsWith('guard_no_target')) return 'tp'
  return null
}

function decimalsOf(n) {
  const s = String(n)
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : Math.min(s.length - dot - 1, 8)
}

/**
 * Round the suggestion to the symbol's price precision. A suggested TP of
 * 1.2734499999 next to an entry of 1.27301 reads as noise and invites a
 * copy-paste the broker then rejects for precision (INVALID_REQUEST).
 *
 * `digits` is the broker's own figure when the caller has it (both routes read
 * volMeta.digits before building the payload). Without it, fall back to the
 * widest precision the entry and stop actually show — entry alone is not
 * enough, because a round entry like 1.2 would collapse a 1.215 suggestion to
 * 1.2 and hand back a target at the entry price.
 */
function roundPrice(value, { digits, entry, sl }) {
  if (!Number.isFinite(value)) return null
  const d = Number.isInteger(digits) && digits >= 0
    ? Math.min(digits, 8)
    : Math.max(decimalsOf(entry), Number.isFinite(sl) ? decimalsOf(sl) : 0)
  return Number(value.toFixed(d))
}

/**
 * Describe a bracket refusal in terms the trader can answer.
 *
 * @param {string} reason        the guard_* reason thrown by the chokepoint
 * @param {object} ctx           {symbol, side, entry, sl, tp, strategy, minRR}
 * @returns {object|null}        null when `reason` is not a bracket refusal
 */
export function describeBracketGap(reason, ctx = {}) {
  const field = bracketGapField(reason)
  if (!field) return null

  const symbol = ctx.symbol || 'this symbol'
  const side = (ctx.side || '').toUpperCase() || null
  const entry = Number(ctx.entry)
  const sl = Number(ctx.sl)
  const isLong = side === 'BUY'

  let suggestion = null
  let suggestionBasis = null

  if (field === 'tp' && Number.isFinite(entry) && Number.isFinite(sl) && entry !== sl) {
    // The R:R floor the risk gate would apply to THIS strategy — a suggestion
    // below it would be refused a second time, which is worse than no
    // suggestion at all.
    const rrFloor = minRrFor(ctx.strategy, Number.isFinite(Number(ctx.minRR)) ? Number(ctx.minRR) : 1.5)
    const slDistance = Math.abs(entry - sl)
    // Direction from the stop, not from `side` alone: on an analysis execution
    // the side is derived from bias and the stop is the thing actually placed,
    // so the stop is the more reliable statement of which way this trade faces.
    const long = Number.isFinite(sl) ? sl < entry : isLong
    suggestion = roundPrice(long ? entry + rrFloor * slDistance : entry - rrFloor * slDistance,
      { digits: ctx.digits, entry, sl })
    suggestionBasis = `${rrFloor}R from entry ${entry} against the ${slDistance} stop distance — the minimum this strategy's R:R floor accepts`
  }

  const label = field === 'tp' ? 'take profit' : 'stop loss'
  const message = `${symbol}${side ? ` ${side}` : ''} has no ${label}. ` +
    (suggestion != null
      ? `Enter one to place this order — ${suggestion} would satisfy the R:R floor.`
      : `Enter one to place this order.`)

  return {
    field,
    symbol,
    side,
    entry: Number.isFinite(entry) ? entry : null,
    sl: Number.isFinite(sl) ? sl : null,
    tp: Number.isFinite(Number(ctx.tp)) ? Number(ctx.tp) : null,
    suggestion,
    suggestionBasis,
    message,
  }
}
