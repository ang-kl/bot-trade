// ---------------------------------------------------------------------------
// agent/services/daily-loss-pacing.js — a daily loss budget that is SPENT
// OVER THE DAY rather than available all at once.
//
// Owner, 03-08-2026, on account 5203012's daily cap: "Raise the overlay to
// 8.8% and dynamic-intelligent adjusted down from 18.8% to ensure how many
// can be trade by timeframe for longevity to trade."
//
// The problem a flat cap has. A single percentage is a cliff: the account may
// lose that much, and once it does, it is finished for the day no matter how
// early. On 03-08 account 46130058 spent its entire 5% (2,419) across 67
// trades and hit the wall at 10:37 UTC — thirteen hours before the FX day
// rolled, with London and New York still to come. Raising the number to 8.8%
// buys a bigger cliff, not a better one; at the same trade rate it would have
// been reached by lunch.
//
// What this does instead. The ceiling (`dailyLossPctMax`) is the MOST the day
// may ever cost. The base (`dailyLossPct`) is what may be spent by the time
// the day OPENS. Between them the allowance ramps with elapsed FX-day time:
//
//   allowed(t) = balance × (base + (ceiling − base) × elapsedFraction)
//
// So at 8.8% base and an 18.8% ceiling, the first hour can cost 8.8%, and only
// a full day of trading can reach 18.8%. A bad opening hour stops early with
// the day's capacity intact; a long grinding day earns its rope. That is the
// "longevity" the owner asked for: the budget is rationed across the sessions
// rather than handed over at 21:00 UTC and gone by lunch.
//
// TWO DELIBERATE PROPERTIES:
//
//   1. OFF BY DEFAULT, AND NEVER LOOSER BY ACCIDENT. `dailyLossPctMax` is null
//      in DEFAULT_RISK_CONFIG. Absent, or ≤ base, or malformed → the flat cap
//      behaves exactly as it does today, byte for byte. A config that cannot
//      be read must not widen a risk limit.
//   2. THE CEILING IS ABSOLUTE. allowed(t) never exceeds balance × ceiling,
//      whatever the clock does — a wrong `nowMs`, a DST seam, a paused box
//      resuming days later. Clamped at both ends.
//
// It also answers the second half of the ask — "how many can be trade" — by
// reporting the budget left and how many more trades that supports at the
// account's own per-trade risk, so the number is on the veto line and the
// Risk page instead of being something the operator has to derive.
// ---------------------------------------------------------------------------

/** One FX trading day. The anchor is risk.js fxDayOpenMs (17:00 New York). */
export const FX_DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// THE TIERED FLOOR — OWNER DECISION, 2026-08-07, verbatim:
//
//   "Change immediately dailyLossPct for 43097342 to $200 min. or 3% for
//    accounts < $10000. 4% for account > $10000."
//
// WHAT WAS WRONG. On 43097342 the cap had collapsed to USD 16.16 — 3% of a
// balance that had shrunk — and `daily_loss_limit_hit pnl=-912.72 limit=16.16`
// logged 4,717 vetoes in seven days. A percentage of a small balance is not a
// risk limit, it is a shutdown: any single ordinary loss ends the day, so the
// account can never trade its way back and never accumulates the sample the
// go-live gate needs.
//
// THE RULE, exactly as specified:
//
//   cap = max( floorUsd , balance × (balance < tierAt ? smallPct : largePct) )
//        = max( 200 , balance × (balance < 10,000 ? 3% : 4%) )
//
// so 1,983 → max(200, 59.50)  = 200      (was 59.50, and 16.16 when smaller)
//    46,073 → max(200, 1,842.92) = 1,842.92
//
// THIS RAISES A RISK LIMIT. It is recorded here rather than buried in config
// because that is what it is: on a small account the day's allowance goes from
// tens of dollars to two hundred. The owner asked for it in those words, with
// those numbers, after seeing the veto counts. It is not a correctness fix and
// must not be described as one.
//
// FLOOR, NOT CEILING — and this is the part that inverts existing behaviour.
// `dailyLossLimit` combines by MIN (see below): two caps are reconciled by
// obeying the tighter. A FLOOR is the opposite instruction — "never less than
// this" — so it is applied AFTER the min, deliberately, and only when set.
// Leaving it inside the min would make it a no-op on exactly the small
// accounts it exists for.
//
// OFF BY DEFAULT AT THE MODULE LEVEL. `floorUsd` null and both tier pcts null
// reproduce the previous arithmetic byte for byte; the defaults live in
// risk.js's DEFAULT_RISK_CONFIG where every other risk number lives, so this
// module stays a pure function of what it is handed.
// ---------------------------------------------------------------------------

/**
 * The percentage that applies to a balance under the owner's two-tier rule.
 * Returns null when the tier rule is off or the balance is unknown, so the
 * caller falls back to the flat `basePct` exactly as before.
 *
 * @param {number|null} balance
 * @param {{smallPct?:number|null, largePct?:number|null, tierAt?:number|null}} tier
 * @returns {number|null}
 */
export function tieredDailyPct(balance, { smallPct = null, largePct = null, tierAt = null } = {}) {
  const bal = Number(balance)
  const small = Number(smallPct)
  const large = Number(largePct)
  const at = Number(tierAt)
  if (!Number.isFinite(bal) || bal <= 0) return null
  if (!Number.isFinite(small) || small <= 0) return null
  if (!Number.isFinite(large) || large <= 0) return null
  // A missing or nonsensical boundary would silently pick one tier for every
  // account; treated as "rule off" rather than guessed.
  if (!Number.isFinite(at) || at <= 0) return null
  return bal < at ? small : large
}

/**
 * Pure. The daily-loss allowance for one account at one instant.
 *
 * TWO INDEPENDENT CHECKS, EITHER OF WHICH MAY BE TURNED OFF (owner,
 * 04-08-2026): *"all Daily cap fallback be (null) mean not used to check. if %
 * is (null) means not used to check. then warn that daily cap fallback isn't
 * use it will be uncapped."*
 *
 *   `dailyLossPct`   — % of balance. Off when null/0, and inapplicable when
 *                      the balance is unknown (a percentage of an unknown
 *                      number is not a limit).
 *   `dailyLossLimit` — flat USD. Off when null/0. It used to apply ONLY in the
 *                      balance-unknown branch, which meant it was dead on every
 *                      account that had a balance — i.e. all of them. It is now
 *                      a real bound in its own right.
 *
 * Whichever checks are ON both apply, so the cap is the TIGHTER of them. That
 * direction is not arbitrary: two limits that disagree can only be reconciled
 * by obeying both, and taking the looser one would let either field silently
 * cancel the other.
 *
 * WHEN NEITHER IS SET THE DAY IS UNCAPPED, and this says so with `capUsd:
 * null` rather than a `0` that a caller could read as "cap of zero" (block
 * everything) or a large number it could read as "plenty left". Null forces
 * every consumer to handle the case; the UI turns it into the warning the
 * owner asked for.
 *
 * @param {object} a
 * @param {number|null} a.balance        account balance USD, null when unset
 * @param {number|null} a.basePct        dailyLossPct — spendable at day open; null = check off
 * @param {number|null} a.maxPct         dailyLossPctMax — the day's ceiling
 * @param {number|null} a.absoluteFallback  dailyLossLimit USD; null = check off
 * @param {number} a.nowMs
 * @param {number} a.dayOpenMs           fxDayOpenMs(nowMs)
 * @param {number} [a.spentUsd]          today's realised loss as a POSITIVE number
 * @param {number} [a.perTradeRiskUsd]   $ at risk on a typical trade, for tradesLeft
 * @returns {{capUsd:number|null, uncapped:boolean, binding:'pct'|'usd'|'both'|null,
 *            pctCapUsd:number|null, usdCapUsd:number|null,
 *            pct:number|null, paced:boolean, elapsed:number,
 *            ceilingUsd:number|null, remainingUsd:number|null, tradesLeft:number|null}}
 */
export function pacedDailyCap({
  balance, basePct, maxPct, absoluteFallback,
  nowMs, dayOpenMs, spentUsd = 0, perTradeRiskUsd = 0,
  floorUsd = null, tierSmallPct = null, tierLargePct = null, tierAtUsd = null,
}) {
  // The tier rule REPLACES basePct when it applies — it is a statement about
  // which percentage is correct for this balance, not an extra bound. When it
  // is off (any knob null/absent) basePct is used unchanged.
  const tierPct = tieredDailyPct(balance, {
    smallPct: tierSmallPct, largePct: tierLargePct, tierAt: tierAtUsd,
  })
  if (tierPct != null) basePct = tierPct
  // ---- the flat USD check -------------------------------------------------
  // A limit of zero is not a limit of zero dollars — nobody configures "lose
  // nothing, ever" — it is how an empty field arrives after a Number() cast.
  // Treated as OFF, same as null.
  const usdRaw = Number(absoluteFallback)
  const usdCapUsd = Number.isFinite(usdRaw) && Math.abs(usdRaw) > 0 ? Math.abs(usdRaw) : null

  // ---- the percentage check ----------------------------------------------
  const base = Number(basePct)
  const pctOn = Number.isFinite(base) && base > 0 && balance > 0
  const ceil = Number(maxPct)
  const hasCeiling = pctOn && Number.isFinite(ceil) && ceil > base

  // Elapsed fraction of the FX day, clamped. A clock that reads before the
  // day open (skew) or beyond its end (a box resuming late) must land on a
  // defined end of the ramp, not off it.
  const raw = (nowMs - dayOpenMs) / FX_DAY_MS
  const elapsed = hasCeiling ? Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0)) : 0

  const pct = !pctOn ? null : hasCeiling ? base + (ceil - base) * elapsed : base
  const pctCapUsd = !pctOn
    ? null
    : hasCeiling
      ? Math.min(balance * ceil, balance * pct)   // ceiling is absolute
      : balance * base

  // ---- combine ------------------------------------------------------------
  // WHEN THE TIER RULE IS ON IT DEFINES THE DAY, and the flat `dailyLossLimit`
  // stops clamping. This is a real consequence and is stated rather than
  // discovered: with the flat 300 still in the min, a 46,073 account would cap
  // at 300 instead of the 4% (1,842.92) the owner specified — the tier rule
  // would be dead on exactly the large accounts its 4% tier exists for.
  //
  // The owner's instruction describes the WHOLE rule ("$200 min. or 3% … 4%")
  // and names no flat ceiling, so honouring both would be obeying an
  // instruction they did not give. `dailyLossLimit` remains fully in force
  // whenever the tier rule is off.
  // The flat cap is out of force entirely when the tier rule is on. Keep that
  // fact in ONE place — `binding` below used to re-derive it from the raw
  // `usdCapUsd` and got a different answer (see the comment on `binding`).
  const usdInForce = tierPct != null ? null : usdCapUsd
  const both = [pctCapUsd, ...(usdInForce != null ? [usdInForce] : [])].filter(v => v != null)
  const minCapUsd = both.length ? Math.min(...both) : null
  // THE FLOOR IS APPLIED LAST, and only to a cap that already exists. Lifting
  // a null (both checks off) to the floor would INVENT a limit where the owner
  // turned every one of them off — the opposite of what a floor is for.
  const floor = Number(floorUsd)
  const floorOn = Number.isFinite(floor) && floor > 0
  const capUsd = minCapUsd == null ? null : (floorOn ? Math.max(minCapUsd, floor) : minCapUsd)
  const floorBinding = capUsd != null && floorOn && capUsd > minCapUsd
  // When the floor lifted the cap, the floor IS what is binding — reporting
  // 'pct' there would name a number the operator can see is not the one in
  // force, which is the class of quiet lie this file already refuses.
  //
  // MEASURED IN PRODUCTION, 22-08-2026. This compared against `usdCapUsd`
  // rather than `usdInForce`, so on a tiered account it named a cap the line
  // above had deliberately excluded. Account 46130058, balance $33,952:
  //
  //   pctCapUsd 1358.09 (4% large tier) · usdCapUsd 150 · tier rule ON
  //   → capUsd 1358.09 (correct)  but  binding 'usd'  (wrong)
  //   → "daily_loss_limit_hit pnl=-2281.09 limit=1358.09
  //      — flat $ cap binds ($150.00, tighter than $1358.09 from %)"
  //
  // The line reports one number and then blames a different one. 5,173 vetoes
  // a day carried it, and reading it cost a real recommendation: the $150 was
  // read as a shutdown-tight cap on a small balance and put up for raising,
  // when it was not in force at all and the cap actually holding was $1,358.
  // `capUsd` was right the whole time; only the explanation lied.
  //
  // It also suppressed pacing: `paced` is gated on `binding !== 'usd'`, so a
  // tiered account with a ramp reported no ramp.
  const binding = capUsd == null ? null
    : floorBinding ? 'floor'
      : pctCapUsd != null && usdInForce != null
        ? (pctCapUsd === usdInForce ? 'both' : (pctCapUsd < usdInForce ? 'pct' : 'usd'))
        : (pctCapUsd != null ? 'pct' : 'usd')

  const remainingUsd = capUsd == null ? null : Math.max(0, capUsd - spentUsd)

  return {
    capUsd,
    uncapped: capUsd == null,
    binding,
    pctCapUsd,
    usdCapUsd,
    // The flat cap AS APPLIED: null whenever the tier rule has taken it out of
    // force. `usdCapUsd` stays as configured so the Risk page can still show
    // what is set; readers deciding what BINDS must use this one.
    usdInForce,
    pct,
    // Pacing describes the percentage check, so it is only true when that
    // check is the one actually holding the line. A ramp the flat USD cap sits
    // below is not pacing anything, and saying so would explain the day's
    // allowance with the wrong mechanism.
    paced: hasCeiling && binding !== 'usd' && binding !== 'floor',
    // The owner's two-tier floor, reported so the Risk page can say WHICH
    // rule produced the number rather than leaving it to be re-derived.
    floorUsd: floorOn ? floor : null,
    floorBinding,
    tierPct,
    elapsed,
    ceilingUsd: hasCeiling ? balance * ceil : null,
    remainingUsd,
    tradesLeft: tradesLeft(remainingUsd, perTradeRiskUsd),
  }
}

/**
 * How many more trades the remaining budget supports at a typical per-trade
 * risk. Null when the risk per trade is unknown — a made-up count on the veto
 * line would be read as a fact.
 */
function tradesLeft(remainingUsd, perTradeRiskUsd) {
  if (!(perTradeRiskUsd > 0) || !Number.isFinite(remainingUsd)) return null
  return Math.max(0, Math.floor(remainingUsd / perTradeRiskUsd))
}

/**
 * Which check is holding the line, in words. Null when nothing is.
 *
 * This exists because the two caps are now both live, so "limit=300" on a veto
 * line no longer says WHICH field produced it — and the answer decides where
 * the operator goes to change it.
 */
export function describeBinding(p) {
  if (!p || p.capUsd == null) return null
  const usd = (v) => `$${Number(v).toFixed(2)}`
  if (p.binding === 'usd') {
    return p.pctCapUsd != null
      ? `flat $ cap binds (${usd(p.usdCapUsd)}, tighter than ${usd(p.pctCapUsd)} from %)`
      : `flat $ cap ${usd(p.usdCapUsd)} — % check off`
  }
  if (p.binding === 'pct') {
    // `usdInForce`, not `usdCapUsd`: on a tiered account the flat cap is set
    // but not applied, and "tighter than the $150 flat cap" would invite the
    // operator to go and change a field that is doing nothing.
    return p.usdInForce != null
      ? `% cap binds (${usd(p.pctCapUsd)}, tighter than the ${usd(p.usdInForce)} flat cap)`
      : p.usdCapUsd != null
        ? `% cap ${usd(p.pctCapUsd)} — the ${usd(p.usdCapUsd)} flat cap is out of force while the balance tier rule is on`
        : `% cap ${usd(p.pctCapUsd)} — flat $ check off`
  }
  return `both caps agree at ${usd(p.capUsd)}`
}

/** Human-readable tail for the veto line and the Risk page. */
export function describePacing(p) {
  if (!p?.paced) return null
  const pct = (p.pct * 100).toFixed(2).replace(/\.?0+$/, '')
  const ceil = p.ceilingUsd != null ? ` of ${(p.ceilingUsd).toFixed(0)} max` : ''
  const left = p.remainingUsd != null ? `, ${p.remainingUsd.toFixed(2)} left` : ''
  const trades = p.tradesLeft != null ? ` (~${p.tradesLeft} more trade${p.tradesLeft === 1 ? '' : 's'})` : ''
  return `paced ${pct}% at ${(p.elapsed * 100).toFixed(0)}% through the FX day${ceil}${left}${trades}`
}
