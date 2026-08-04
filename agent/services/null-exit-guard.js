// ---------------------------------------------------------------------------
// agent/services/null-exit-guard.js — who may close a position, and whether
// closing it there accomplishes anything.
//
// WHY (owner, 2026-08-04, on demo 5306502 / ctid 47790949): "this account has
// penny profit, took profits too early."
//
// Measured over the prior 14 days on that account, 46 exits with an
// attributable cause:
//
//   explicit close   n=31   net -$3,348   totalR -3.77   |R|<0.1 on 26 of 31
//   managed stop     n=15   net +$1,510   totalR +10.69  |R|<0.1 on  1 of 15
//
// The diagnosis is one step past the owner's. It is not early profit-taking:
// 26 of 31 explicit closes landed within a tenth of an R of the entry price
// and then paid the spread to get there. `position_manager` is the cleanest
// case — 9 exits, every one inside |R| < 0.1, its BEST exit in fourteen days
// was +0.074R. Those are not trades, they are round-trips.
//
// The other half of the same picture: the four largest losses (NAS100 -$826,
// GOOG -$746, NZDUSD -$676, USDZAR -$592) were all explicit closes with
// stopMoves = 0 — nothing had ever trailed them. The four largest wins came
// from the ratchet doing its job (SpotCrude +$506 over 149 stop moves,
// NZDUSD +$560 over 143). The money is made by managed stops and given back
// by discretionary closes.
//
// So two rules, both owner-approved:
//
//   1. A writer must HOLD close authority. `llm_monitor` no longer does: 12
//      exits, 2 of them positive, -$2,230, and it has never once moved a
//      stop. It keeps its voice — the request is journalled and alerted —
//      but it no longer moves money.
//   2. A close at |R| below the floor is a NULL EXIT and is refused, unless
//      something names a real reason for it.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never blocks a protection writer.
// The equity stop, the loss cap, the loss guardian, the weekend bank and the
// profit ratchet exist to get out, and a floor that could stand between them
// and an exit would be a far worse bug than the one it fixes. §41's authority
// order is the arbiter, not this module's opinion about R.
//
// AND IT REFUSES TO GUESS. A null exit is a claim about where price is
// relative to entry, so an unknown or non-finite R is NOT treated as zero —
// it is treated as unknown and the close proceeds. Blocking an exit on a
// number we could not compute is how a guard becomes the incident.
// ---------------------------------------------------------------------------

/**
 * Default floor, in R. A position sitting within a tenth of an R of its entry
 * is at breakeven by any reasonable reading: closing it there banks nothing,
 * cuts nothing, and pays the spread both ways.
 *
 * Overridable per account via riskConfig.nullExitMinR. Zero or negative
 * disables the floor entirely — an operator turning it off should be able to,
 * and should get exactly what they asked for.
 */
export const DEFAULT_NULL_EXIT_MIN_R = 0.1

/**
 * Writers permitted to close a position at all.
 *
 * This is an ALLOW-list on purpose. A new writer that starts closing
 * positions has to be added here deliberately, which is the review step that
 * `llm_monitor` never got — it acquired close authority as a bug fix (see the
 * comment at loop.js:1698 about a bare DB status flip) and nobody ever asked
 * whether it should be closing positions in the first place.
 */
export const CLOSE_AUTHORITY = Object.freeze([
  'equity_stop',
  'loss_cap',
  'loss_guardian',
  'profit_ratchet',
  'profit_keeper',
  'weekend_bank',
  'position_manager',
  'fast_monitor',
  'trade_guard',
  'owner',
  'owner_ui',
  'telegram',
  'reconciliation',
])

/**
 * Writers the R floor never applies to. Protection and human intent: their
 * whole job is to get out, and whether the exit is "worth it" in R is not
 * their question to be second-guessed on.
 */
export const FLOOR_EXEMPT_WRITERS = Object.freeze([
  'equity_stop',
  'loss_cap',
  'loss_guardian',
  'profit_ratchet',
  'weekend_bank',
  'owner',
  'owner_ui',
  'telegram',
  'reconciliation',
])

/**
 * Reasons that name a real purpose for closing at breakeven. A thesis that
 * broke, a clock that ran out, or a portfolio-level event are all legitimate
 * grounds to take nothing off the table and walk away.
 *
 * Matched case-insensitively against the free-text reason the writer supplies.
 */
export const FLOOR_EXEMPT_REASON = /invalidat|time.?cap|expir|equity.?stop|daily.?cap|daily.?loss|kill|halt|margin|weekend|stop.?out|owner|manual|reconcil|broker.?closed|already.?closed/i

/** May this writer close a position at all? */
export function mayClose(writer) {
  return CLOSE_AUTHORITY.includes(String(writer || ''))
}

/**
 * Should this close be refused as a null exit?
 *
 * @param {object} o
 * @param {string} o.writer         which module is asking
 * @param {string} [o.reason]       the writer's own free-text reason
 * @param {number|null} [o.currentR] signed R at the moment of the request
 * @param {number} [o.minR]         floor override (riskConfig.nullExitMinR)
 * @returns {{ block: boolean, why: string }}
 */
export function nullExitVerdict({ writer, reason = '', currentR = null, minR } = {}) {
  const w = String(writer || '')

  if (!mayClose(w)) {
    return { block: true, why: `no_close_authority:${w || 'unknown'}` }
  }
  if (FLOOR_EXEMPT_WRITERS.includes(w)) {
    return { block: false, why: `floor_exempt_writer:${w}` }
  }

  const floor = Number.isFinite(Number(minR)) ? Number(minR) : DEFAULT_NULL_EXIT_MIN_R
  if (!(floor > 0)) return { block: false, why: 'floor_disabled' }

  if (FLOOR_EXEMPT_REASON.test(String(reason))) {
    return { block: false, why: 'reason_names_a_purpose' }
  }

  // Unknown R is unknown, NOT zero. See the header note: a guard that blocks
  // an exit on a number it could not compute is worse than the churn it was
  // built to stop. Note the null/'' check ahead of Number(): both coerce to a
  // perfectly finite 0, which is the exact value that trips the floor — the
  // "no price data" case would otherwise read as "sitting at breakeven" and
  // refuse every close on a symbol whose quote went stale.
  if (currentR == null || currentR === '') return { block: false, why: 'r_unknown' }
  const r = Number(currentR)
  if (!Number.isFinite(r)) return { block: false, why: 'r_unknown' }

  if (Math.abs(r) < floor) {
    return {
      block: true,
      why: `null_exit r=${r.toFixed(3)} within ±${floor} of entry — closing here banks nothing and pays the spread`,
    }
  }
  return { block: false, why: `r=${r.toFixed(3)} outside the floor` }
}
