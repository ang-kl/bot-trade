// ---------------------------------------------------------------------------
// agent/services/trade-horizon.js — the HORIZON a position is held for,
// decided once at entry from its strategy family and stored on the trade row
// (§4-D, owner-approved 03-10-2026, № 10,777·B·4), and the one place every
// exit rule asks which regime a row belongs to (§5).
//
// WHY A STORED COLUMN AND NOT A LOOKUP. §4-P (PR #981) protected weeks-horizon
// positions from the intraday management rules by keying every exemption on
// MEMBERSHIP OF THE MOMENTUM BOOK plus `monitored_positions.paused`; nothing
// read a horizon, so the managed-exit take and the time cap — which do not
// consult the book — could still reach a momentum runner through the
// strategy family alone (`takeAtRFamilies`), and a family list edited to
// include 'momentum' would have capped every weeks position at +1R. The
// horizon is now a fact about the ROW, written when the trade is created and
// read by the evaluators, so a later edit to a family list or a strategy's
// registry entry cannot re-classify a position that is already open.
//
// THE RULE IS ONE LINE: the momentum family (the horizon-judged families of
// strategies.js) is held for weeks; every other family, and a row with no
// strategy on record (manual, external, adopted without a label), is
// intraday — exactly the regime those rows live under today.
// ---------------------------------------------------------------------------

import { familyOf, HORIZON_JUDGED_FAMILIES, horizonJudgedKeys } from './strategies.js'

/** The two horizons a trade row may carry. */
export const HORIZONS = Object.freeze(['intraday', 'weeks'])

/** The families held for weeks: the same set the watchdog and breaker leave alone. */
export const WEEKS_HORIZON_FAMILIES = HORIZON_JUDGED_FAMILIES

/** 'weeks' for the momentum family; 'intraday' for everything else, including no strategy. */
export function horizonForStrategy(strategyKey) {
  const fam = strategyKey ? familyOf(strategyKey) : null
  return fam && WEEKS_HORIZON_FAMILIES.includes(fam) ? 'weeks' : 'intraday'
}

/** A stored value is honoured only when it is one of HORIZONS; anything else reads as "not recorded". */
export function normaliseHorizon(raw) {
  return HORIZONS.includes(raw) ? raw : null
}

export const isWeeksHorizon = (h) => h === 'weeks'

/** The horizon stored on a trade row, or null when the row has none (or does not exist). */
export function storedHorizon(db, tradeId) {
  if (tradeId == null) return null
  try {
    const row = db.prepare('SELECT horizon FROM trades WHERE id = ?').get(Number(tradeId))
    return normaliseHorizon(row?.horizon)
  } catch { return null }
}

/**
 * The horizon an evaluator applies to a position: an explicit valid value
 * first (a caller that already read the row), else the trade row's stored
 * value, else — a row written before the column existed, or a fixture with
 * no trade — the strategy-family rule, which is what every such row lived
 * under before this. The stored value WINS over the strategy on purpose: the
 * horizon is set at entry and does not move with later edits to the registry.
 */
export function horizonOfPosition(db, { tradeId = null, strategy = null, horizon = null } = {}) {
  return normaliseHorizon(horizon) ?? storedHorizon(db, tradeId) ?? horizonForStrategy(strategy)
}

/**
 * One-time backfill for rows that exist before the column did: every open
 * (or in-flight) trade with no horizon gets one from the same rule as a new
 * entry, read from its strategy or — an adopted row with no strategy of its
 * own — the strategy its broker label decodes to. Closed rows are left NULL:
 * nothing evaluates them, and a value nobody decided at the time is not
 * fabricated after the fact. Idempotent: a row with a horizon is never
 * rewritten. Returns the counts so the boot line can state what it did.
 */
export function backfillTradeHorizons(db) {
  const weeksKeys = horizonJudgedKeys()
  const inFlight = `('open', 'submitting', 'unconfirmed')`
  const placeholders = weeksKeys.map(() => '?').join(', ')
  const weeks = weeksKeys.length
    ? db.prepare(
      `UPDATE trades SET horizon = 'weeks'
        WHERE horizon IS NULL AND status IN ${inFlight}
          AND COALESCE(strategy, label_strategy) IN (${placeholders})`,
    ).run(...weeksKeys).changes
    : 0
  const intraday = db.prepare(
    `UPDATE trades SET horizon = 'intraday' WHERE horizon IS NULL AND status IN ${inFlight}`,
  ).run().changes
  return { weeks, intraday, total: weeks + intraday }
}
