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
  // 1.5 → 1.0, owner order 2026-08-22 (audit item 4). The partial pipeline
  // was wired end-to-end and NEVER FIRED on account ACCT-DEMO-2: winners were
  // closed at the broker or scratched before reaching +1.5R (NAS100 banked
  // 18% of plan, closed manually), so the trigger sat above the excursions
  // this book actually produces. "A TP1 partial at ~1R would have turned
  // several of this week's scratches into keeps." Class-level values in
  // asset-controllers.js moved with it and stay owner-overridable.
  partialTriggerR: 1.0,    // close half at +1.0R
  partialFraction: 0.5,    // close 50%
  partialTrailR: 0.5,      // trail SL 0.5R behind current price after partial
  runnerTriggerR: 2.5,     // begin runner trail at +2.5R
  runnerTrailR: 1.0,       // trail 1R behind current price
  // BANK the whole position at this R. The runner trail alone never exits a
  // winner until it pulls back a full trail-R, so on a margin-tight account
  // big winners (LLY sat at +17R) held ALL the margin hostage and armed
  // strategies couldn't get a fill (owner chose: cap + bank). 0/null disables.
  bankTriggerR: 4,
  // PR-J (exit asymmetry, 11-09-2026). What FRACTION of the position the bank
  // target takes. 1 = the whole position, which is exactly what this rule did
  // before PR-J and is still the default HERE — the halving is switched on per
  // account by managed-exit.js, and only for the families `takeAtRFamilies`
  // scopes the take to, so a non-managed account and an out-of-scope family
  // behave precisely as they did. < 1 turns the bank into a PARTIAL_EXIT that
  // banks that fraction, moves the stop to at least breakeven and trails the
  // remainder `bankTrailAtrMult` behind the peak.
  bankFraction: 1,
  bankTrailAtrMult: 1.5,
  // PR-J: the time cap stops closing winners.
  //
  // MEASURED (five broker statements, 95 bot deals, 09–11 Sep): winners' median
  // move +0.39%, losers' −0.76%, avg win ÷ avg loss 0.72 at a 51% win rate —
  // expectancy negative BY CONSTRUCTION, because the winners were capped (at
  // +1R by the take, or cut mid-move by this clock) while the losers ran to
  // full 1–3% stops. Ten positions were closed in one batch at 21:31 SGT by
  // this rule after 17–21h held, several of them in profit.
  //
  // So: a position at or above `timeCapHoldMinR` when its cap expires is NOT
  // closed. Its stop is tightened to a trail and it leaves by that stop, by its
  // target, or by invalidation. A position BELOW the threshold — and a position
  // whose price cannot be read at all — still dies at the clock, with the same
  // reason string it always had. `timeCapHoldWinners: false` restores the old
  // behaviour exactly, and `timeCapMaxExtraHours` bounds the hold so "hold the
  // winner" can never mean "hold forever".
  timeCapHoldWinners: true,
  timeCapHoldMinR: 0,
  timeCapTrailAtrMult: 1.5,
  timeCapMaxExtraHours: 72,
  // Managed-exit trail (owner "c1", 25-08-2026): trail the stop this many R
  // behind the PEAK favorable excursion, active from entry, tighten-only —
  // the trail_1R rule the gated-entry counterfactual measured at PF 1.82
  // (+0.38R) against the actual exits' 0.44 (-0.53R). null = off; the caller
  // (monitorOnePosition) sets it per-account through managed-exit.js so it
  // reaches DEMO accounts only until the forward sample confirms.
  alwaysTrailR: null,
  // NOTE (2026-08-14): there is deliberately no `defaultTimeCapMinutes` here.
  // One was defined for months and never read by anything — evaluatePosition
  // only ever consults `pos.time_cap_at`, which is written at fill time from
  // the signal's own `time_cap_minutes`. A setup that declares no cap has no
  // cap, and exits on its stop, its target, or invalidation. Re-introducing a
  // blanket default would put a clock on technical setups that were sized to
  // a structure, not to a deadline.
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

/** true for long/BUY, false for short/SELL. */
function isLong(side) {
  return !(side === 'short' || side === 'SELL')
}

/**
 * The PRICE distance a PR-J trail sits behind the peak.
 *
 * `mult` multiplies the position's ATR when one was supplied by the caller,
 * and the position's own initial risk (1R, a price distance too) when one was
 * not. Both denominators are stated on purpose rather than hidden: the ATR is
 * read from the profit keeper's in-memory cache, which is populated only when
 * the keeper runs in adaptive mode and has seen this symbol, so a rule that
 * could ONLY use ATR would silently not fire on everything else — a trigger
 * out of reach of what it guards. The R fallback is always reachable.
 *
 * @param {{initial_risk:number|null}} pos
 * @param {number} mult
 * @param {number|null|undefined} atr
 * @returns {{dist:number, basis:string}|null}
 */
function trailDistance(pos, mult, atr) {
  const m = Number(mult)
  if (!Number.isFinite(m) || m <= 0) return null
  const a = Number(atr)
  if (Number.isFinite(a) && a > 0) return { dist: m * a, basis: `${m}×ATR` }
  const risk = Math.abs(Number(pos.initial_risk))
  if (Number.isFinite(risk) && risk > 0) return { dist: m * risk, basis: `${m}R (no ATR)` }
  return null
}

/** Peak-favourable price this position has traded to, in price terms. */
function peakPriceOf(pos, peakR) {
  return priceAtR(pos, peakR)
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate what the bot should do with an open position right now.
 *
 * Rule precedence (first match wins):
 *   1. Time cap expired              -> FULL_EXIT below timeCapHoldMinR (or
 *                                       past the backstop); at or above it,
 *                                       MOVE_SL to the cap trail, once (PR-J)
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
 *   time_cap_trail_at:string|null, bank_partial_at:string|null,
 *   created_at:string
 * }} pos
 * @param {{ currentPrice:number|null, now?:Date, rules?:object,
 *           atr?:number|null }} ctx  `atr` is optional: PR-J's two trails use
 *   it when the caller has one and fall back to the position's own 1R distance
 *   when it does not.
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

  const createdAtEarly = pos.created_at ? new Date(pos.created_at) : null
  const minutesEarly = createdAtEarly ? (now - createdAtEarly) / 60_000 : null

  // --- 0. Time cap, BEFORE the price gate --------------------------------
  //
  // A time cap is a comparison of two clocks. It needs no price, and it used
  // to sit below the `r == null` bail-out at step 1, which meant a position
  // whose price OR entry price could not be read never had its cap evaluated
  // at all — it just returned HOLD, every pass, forever.
  //
  // Production, 2026-08-03: seven burn-in positions on account ACCT-DEMO-1, each
  // carrying the thesis "closes in ≤12m", still open 5h18m to 8h31m after
  // their caps expired, holding −$52.91. Every one had `entry_price: null`
  // and logged "Price data unavailable" — so `currentR` returned null and the
  // only exit those positions had besides the stop was unreachable.
  //
  // That is the same shape as the loss cap that could not fire earlier today:
  // a protective check placed downstream of a data dependency it does not
  // actually have. The cap is now evaluated first, and a missing price makes
  // it MORE urgent to honour, not less — a position nobody can price is
  // exactly the one that should not be left running past its deadline.
  //
  // PR-J (11-09-2026): what the cap does to a WINNER changed. A position at or
  // above `timeCapHoldMinR` is trailed instead of closed — see DEFAULT_RULES
  // for the measurement that ordered it. Everything above still holds: the cap
  // is evaluated before the price gate, and a position nobody can price still
  // dies at the clock, because `r` is null and null is not ≥ the threshold.
  if (pos.time_cap_at) {
    const capEarly = new Date(pos.time_cap_at)
    if (Number.isFinite(capEarly.getTime()) && now >= capEarly) {
      const capMetrics = { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade: minutesEarly }
      const holdWinners = rules.timeCapHoldWinners === true
      const minR = Number.isFinite(Number(rules.timeCapHoldMinR)) ? Number(rules.timeCapHoldMinR) : 0
      const wouldHold = holdWinners && r != null && r >= minR
      // The backstop: holding a winner may extend the trade, never unbound it.
      const extraH = Number(rules.timeCapMaxExtraHours)
      const backstopAt = Number.isFinite(extraH) && extraH > 0
        ? capEarly.getTime() + extraH * 3_600_000
        : null
      const backstopped = backstopAt != null && now.getTime() >= backstopAt

      if (!wouldHold || backstopped) {
        return {
          action: 'FULL_EXIT',
          // Unchanged for every case that used to reach here — a loser at the
          // clock closes with exactly the string the ledger already carries.
          reason: wouldHold
            ? `time_cap_expired_backstop (${pos.time_cap_at} + ${extraH}h)`
            : `time_cap_expired (${pos.time_cap_at})`,
          newSL: null,
          exitFraction: 1,
          updates,
          metrics: capMetrics,
        }
      }

      // Winner at the cap. Stamp ONCE — the stamp is what stops this branch
      // being re-decided every cycle; from the next pass the ordinary ladder
      // (managed trail, breakeven, invalidation) governs the position and the
      // backstop above is the only cap rule still watching it.
      //
      // THE HOLD IS NOT FREE, AND IT IS NOT UNCONDITIONAL (checker B1,
      // 11-09-2026). The first version of this branch trailed at
      // `peak − 1.5 × 1R` with no floor, so with the entry stop at −1R the
      // move only tightened at peak ≥ 1.5R — while the measurement that
      // ordered the PR describes winners of +0.39 % MEDIAN against 1–3 %
      // stops, i.e. roughly +0.13R to +0.39R. Every position it was written
      // about landed in 0 ≤ R < 1.5, was stamped, and was held at FULL
      // ORIGINAL RISK for up to 72 hours: a realised +0.13R…+0.39R turned
      // back into −1R of open risk, ten times over in the 21:31 batch.
      //
      // So the trail is FLOORED AT BREAKEVEN — the same floor the bank branch
      // below already applies — and the hold is REFUSED when even that is not
      // tighter than the stop the position already has: then the cap closes
      // the position exactly as it did before this PR. A hold that cannot
      // improve the stop is not a hold, it is an unpriced extension of risk.
      if (!pos.time_cap_trail_at) {
        const peakR = Math.max(newMfe ?? 0, r)
        const td = trailDistance(pos, rules.timeCapTrailAtrMult, ctx.atr)
        const long = isLong(pos.side)
        // At LEAST breakeven. `r >= minR >= 0` on this path, so entry is a
        // level the trade has actually reached.
        let trailSL = pos.entry_price
        if (td && Number.isFinite(Number(pos.entry_price))) {
          const peak = peakPriceOf(pos, peakR)
          const t = long ? peak - td.dist : peak + td.dist
          trailSL = long ? Math.max(trailSL, t) : Math.min(trailSL, t)
        }
        // TIGHTEN-ONLY, the invariant every other tightener in this repo
        // obeys: a cap that LOOSENED a stop would hand back more than the
        // close it replaced. Note isTighter() answers true for a NULL stop,
        // which is safe here only because of the breakeven floor above — a
        // stop-less row gets a stop at entry, never at peak − 1.5R.
        if (Number.isFinite(Number(trailSL)) && isTighter(pos.side, pos.current_sl, trailSL)) {
          updates.time_cap_trail_at = now.toISOString()
          return {
            action: 'MOVE_SL',
            reason: `time_cap_trailing (${pos.time_cap_at}, R=${r.toFixed(2)} ≥ ${minR}, stop → ${trailSL === pos.entry_price ? 'breakeven' : `${td ? td.basis : 'breakeven'} behind peak ${peakR.toFixed(2)}R`})`,
            newSL: trailSL,
            exitFraction: null,
            updates,
            metrics: capMetrics,
          }
        }
        return {
          action: 'FULL_EXIT',
          reason: `time_cap_expired (${pos.time_cap_at})`,
          newSL: null,
          exitFraction: 1,
          updates,
          metrics: capMetrics,
        }
      }
    }
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

  // --- 1. Time cap expired — handled at step 0, above the price gate. ----

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
  //
  // PR-J (11-09-2026): with `bankFraction` < 1 the bank becomes a PARTIAL —
  // half the position taken at the trigger, the stop moved to at least
  // breakeven, the remainder trailed. The measurement is in DEFAULT_RULES: the
  // whole-position take is what capped the winners at +1R while the losers ran
  // to full stops. bankFraction 1 is still the default and still closes the
  // whole position with the same reason string.
  if (rules.bankTriggerR > 0 && r >= rules.bankTriggerR) {
    const frac = Number(rules.bankFraction)
    const fraction = Number.isFinite(frac) && frac > 0 && frac < 1 ? frac : 1
    if (fraction >= 1) {
      return {
        action: 'FULL_EXIT',
        reason: `bank_target_${rules.bankTriggerR}R (current R=${r.toFixed(2)})`,
        newSL: null,
        exitFraction: 1,
        updates,
        metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
      }
    }
    // ONE partial per position at this trigger, ever. Without the stamp the
    // remainder sits above the trigger on the very next pass and is banked
    // again, and again — a loop of ever smaller partials, each paying spread.
    if (!pos.bank_partial_at) {
      const peakR = Math.max(newMfe ?? 0, r)
      const td = trailDistance(pos, rules.bankTrailAtrMult, ctx.atr)
      const long = isLong(pos.side)
      // At LEAST breakeven: banking part of a winner without moving the stop
      // reduces the win and leaves the risk untouched.
      let target = pos.entry_price
      if (td) {
        const peak = peakPriceOf(pos, peakR)
        const t = long ? peak - td.dist : peak + td.dist
        target = long ? Math.max(target, t) : Math.min(target, t)
      }
      const shouldTrail = isTighter(pos.side, pos.current_sl, target)
      return {
        action: 'PARTIAL_EXIT',
        reason: `bank_partial_${rules.bankTriggerR}R ${Math.round(fraction * 100)}% (current R=${r.toFixed(2)}, remainder trails ${td ? td.basis : 'breakeven'})`,
        newSL: shouldTrail ? target : pos.current_sl,
        exitFraction: fraction,
        // A partial the broker cannot size (below the minimum lot, or a step
        // that floors it to zero) must NOT silently leave the position
        // un-banked: before PR-J this trigger closed the whole position, and
        // that is what the executor falls back to (checker M4).
        fallbackFullExitIfUnfillable: true,
        updates: { ...updates, scaled_out: 1, be_moved: 1, bank_partial_at: now.toISOString() },
        metrics: { currentR: r, mfeR: newMfe, maeR: newMae, minutesInTrade },
      }
    }
    // Already banked: the remainder is the trail's to manage — fall through.
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

  // --- 4.5 Managed trail (from entry, behind the PEAK) --------------------
  // Peak-based on purpose: trailing behind current price would loosen on a
  // pullback; behind MFE, the stop only ever ratchets — identical to the
  // trail_1R replay the evidence came from. At entry, peak−trailR equals the
  // original stop, so the rule is a no-op until the trade shows profit.
  // ACTIVATION GATE, same as the replay (`peakR > rule.trailR`): the trail
  // arms only once the trade has moved a full trail-distance in profit.
  // Invisible while trailR was 1.0 — peak−1R below +1R sits behind a 1R
  // initial stop anyway — but at 0.5R the ungated version tightens the
  // stop on the FIRST favourable tick (peak 0.1R → stop −0.4R), which is
  // not the rule the 44-trade evidence was scored on.
  const managedPeakR = Math.max(newMfe ?? 0, r)
  if (rules.alwaysTrailR > 0 && managedPeakR > rules.alwaysTrailR) {
    const peakR = managedPeakR
    const trailSL = priceAtR(pos, peakR - rules.alwaysTrailR)
    if (isTighter(pos.side, pos.current_sl, trailSL)) {
      return {
        action: 'MOVE_SL',
        reason: `managed_trail @ ${(peakR - rules.alwaysTrailR).toFixed(2)}R (peak ${peakR.toFixed(2)}R − ${rules.alwaysTrailR}R)`,
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
