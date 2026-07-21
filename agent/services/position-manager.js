// ---------------------------------------------------------------------------
// agent/services/position-manager.js
//
// Deterministic position-management engine. Runs BEFORE the LLM Monitor on
// every active position. Cheap, fast, never hallucinates. Implements the
// SL-staircase + invalidation + time-cap rules.
//
// The LLM Monitor is only called when this engine returns HOLD or
// DEFER_TO_LLM — saving tokens and reserving the model for ambiguous cases.
//
// Pure: no DB writes, no network calls. Caller supplies inputs, caller
// persists the returned patch.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tunable thresholds. Overridable per-strategy via agent_state (caller merges).
// ---------------------------------------------------------------------------

export const DEFAULT_RULES = Object.freeze({
  beTriggerR: 0.7,         // move SL to breakeven at +0.7R MFE
  partialTriggerR: 1.5,    // close half at +1.5R
  partialFraction: 0.5,    // close 50%
  partialTrailR: 0.5,      // trail SL 0.5R behind current price after partial
  runnerTriggerR: 2.5,     // begin runner trail at +2.5R
  runnerTrailR: 1.0,       // trail 1R behind current price
  // BANK the whole position at this R. The runner trail alone never exits a
  // winner until it pulls back a full trail-R, so on a margin-tight account
  // big winners (LLY sat at +17R) held ALL the margin hostage and armed
  // strategies couldn't get a fill (owner chose: cap + bank). 0/null disables.
  bankTriggerR: 4,
  defaultTimeCapMinutes: 180, // 3 hours if Analyst didn't set one
})

// ---------------------------------------------------------------------------
// R-unit math — direction-aware
// ---------------------------------------------------------------------------

/**
 * Compute R (risk multiple) for a position given current price.
 * Returns signed R: positive = in profit, negative = in drawdown.
 *
 * @param {{ side:string, entry_price:number, initial_risk:number }} pos
 * @param {number} currentPrice
 * @returns {number|null}
 */
export function currentR(pos, currentPrice) {
  if (!pos.initial_risk || !pos.entry_price || currentPrice == null) return null
  const dir = pos.side === 'short' || pos.side === 'SELL' ? -1 : 1
  return ((currentPrice - pos.entry_price) * dir) / pos.initial_risk
}

/**
 * Convert an R value back to a price, given a position's entry and risk.
 * Used to compute "SL = entry + 0.5R" style targets.
 *
 * @param {{ side:string, entry_price:number, initial_risk:number }} pos
 * @param {number} r
 * @returns {number}
 */
export function priceAtR(pos, r) {
  const dir = pos.side === 'short' || pos.side === 'SELL' ? -1 : 1
  return pos.entry_price + dir * r * pos.initial_risk
}

/**
 * Would moving SL from `oldSL` to `newSL` tighten (move toward price)?
 * Direction-aware: longs tighten by raising SL; shorts by lowering.
 *
 * @param {string} side
 * @param {number|null} oldSL
 * @param {number} newSL
 */
function isTighter(side, oldSL, newSL) {
  if (oldSL == null) return true
  return (side === 'short' || side === 'SELL') ? newSL < oldSL : newSL > oldSL
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate what the bot should do with an open position right now.
 *
 * Rule precedence (first match wins):
 *   1. Time cap expired              -> FULL_EXIT
 *   2. Invalidation trigger breached -> FULL_EXIT   (price-based triggers only;
 *                                                    text triggers defer to LLM)
 *   3. Partial-exit window           -> PARTIAL_EXIT + trail SL to +0.5R
 *   4. Runner trail                  -> MOVE_SL to (price - 1R)
 *   5. Breakeven move                -> MOVE_SL to entry
 *   6. None of the above             -> HOLD
 *
 * Always returns an `updates` patch with refreshed MFE/MAE so the caller can
 * persist. If currentPrice is unknown, returns a HOLD with null metrics.
 *
 * @param {{
 *   id:number, symbol:string, side:string,
 *   entry_price:number, current_sl:number|null, current_tp:number|null,
 *   initial_risk:number|null, mfe_r:number|null, mae_r:number|null,
 *   be_moved:number|null, scaled_out:number|null,
 *   invalidation_trigger:string|null, time_cap_at:string|null,
 *   created_at:string
 * }} pos
 * @param {{ currentPrice:number|null, now?:Date, rules?:object }} ctx
 */
export function evaluatePosition(pos, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date()
  const rules = { ...DEFAULT_RULES, ...(ctx.rules || {}) }
  const price = ctx.currentPrice

  // --- Metrics ------------------------------------------------------------
  const r = currentR(pos, price)
  const prevMfe = pos.mfe_r ?? 0
  const prevMae = pos.mae_r ?? 0
  const newMfe = r != null ? Math.max(prevMfe, r) : prevMfe
  const newMae = r != null ? Math.min(prevMae, r) : prevMae

  const updates = {
    mfe_r: newMfe,
    mae_r: newMae,
  }

  // If we can't price-check, record what we know and bail.
  if (r == null) {
    return {
      action: 'HOLD',
      reason: 'no_current_price',
      newSL: null,
      exitFraction: null,
      updates,
      metrics: { currentR: null, mfeR: newMfe, maeR: newMae, minutesInTrade: null },
    }
  }

  const createdAt = pos.created_at ? new Date(pos.created_at) : null
  const minutesInTrade = createdAt ? (now - createdAt) / 60_000 : null

  // --- 1. Time cap expired -----------------------------------------------
  if (pos.time_cap_at) {
    const cap = new Date(pos.time_cap_at)
    if (Number.isFinite(cap.getTime()) && now >= cap) {
      return {
        action: 'FULL_EXIT',
        reason: `time_cap_expired (${pos.time_cap_at})`,
        newSL: null,
        exitFraction: 1,
        updates,
        metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
      }
    }
  }

  // --- 2. Price-based invalidation trigger -------------------------------
  // We only enforce triggers expressed as `price<X` or `price>X` here; free-
  // text triggers ("close below 3428 on 15m with >1.5x volume") require
  // candle/volume data → delegated to LLM Monitor.
  const priceTrigger = parsePriceTrigger(pos.invalidation_trigger)
  if (priceTrigger && priceTrigger.fired(price)) {
    return {
      action: 'FULL_EXIT',
      reason: `invalidation_trigger: ${priceTrigger.label}`,
      newSL: null,
      exitFraction: 1,
      updates,
      metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
    }
  }

  // --- 2.5 Bank target — take the WHOLE win at bankTriggerR ---------------
  // Recycles margin into new setups instead of trailing a giant winner
  // forever. Checked before the partial so a gap straight through both
  // levels banks everything rather than scaling out of a done trade.
  if (rules.bankTriggerR > 0 && r >= rules.bankTriggerR) {
    return {
      action: 'FULL_EXIT',
      reason: `bank_target_${rules.bankTriggerR}R (current R=${r.toFixed(2)})`,
      newSL: null,
      exitFraction: 1,
      updates,
      metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
    }
  }

  // --- 3. Partial-exit window --------------------------------------------
  if (!pos.scaled_out && r >= rules.partialTriggerR) {
    const trailSL = priceAtR(pos, rules.partialTrailR) // e.g. +0.5R
    // Only recommend if trailSL actually tightens vs current SL
    const shouldTrail = isTighter(pos.side, pos.current_sl, trailSL)
    return {
      action: 'PARTIAL_EXIT',
      reason: `partial_at_${rules.partialTriggerR}R (current R=${r.toFixed(2)})`,
      newSL: shouldTrail ? trailSL : pos.current_sl,
      exitFraction: rules.partialFraction,
      updates: { ...updates, scaled_out: 1, be_moved: 1 },
      metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
    }
  }

  // --- 4. Runner trail (post-partial only) -------------------------------
  if (pos.scaled_out && r >= rules.runnerTriggerR) {
    const trailR = r - rules.runnerTrailR
    const trailSL = priceAtR(pos, trailR)
    if (isTighter(pos.side, pos.current_sl, trailSL)) {
      return {
        action: 'MOVE_SL',
        reason: `runner_trail @ ${trailR.toFixed(2)}R behind current`,
        newSL: trailSL,
        exitFraction: null,
        updates,
        metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
      }
    }
  }

  // --- 5. Breakeven move -------------------------------------------------
  if (!pos.be_moved && r >= rules.beTriggerR) {
    const beSL = pos.entry_price
    if (isTighter(pos.side, pos.current_sl, beSL)) {
      return {
        action: 'MOVE_SL',
        reason: `breakeven_lock @ ${rules.beTriggerR}R (current R=${r.toFixed(2)})`,
        newSL: beSL,
        exitFraction: null,
        updates: { ...updates, be_moved: 1 },
        metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
      }
    }
  }

  // --- 6. Default: HOLD (LLM Monitor may still override) -----------------
  return {
    action: 'HOLD',
    reason: `hold (R=${r.toFixed(2)}, mfe=${newMfe.toFixed(2)}, mae=${newMae.toFixed(2)})`,
    newSL: null,
    exitFraction: null,
    updates,
    metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
  }
}

// ---------------------------------------------------------------------------
// Invalidation-trigger parser
//
// Recognises simple price predicates the Analyst can emit, e.g.:
//   "price<3428"         → long invalidated if price drops below 3428
//   "price>3555"         → short invalidated if price rises above 3555
//   "close<3428"         → alias (treated same at 5-min granularity)
// Anything else returns null and the free-text trigger is left for the LLM.
// ---------------------------------------------------------------------------

function parsePriceTrigger(raw) {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.trim().match(/^(?:price|close)\s*([<>])\s*([\d.]+)\s*$/i)
  if (!m) return null
  const op = m[1]
  const threshold = Number(m[2])
  if (!Number.isFinite(threshold)) return null
  return {
    label: `${m[0]}`,
    fired: (price) => op === '<' ? price < threshold : price > threshold,
  }
}

// Exposed for unit tests.
export const _internal = { parsePriceTrigger, isTighter }
