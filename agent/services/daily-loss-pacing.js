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
}) {
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
  const both = [pctCapUsd, usdCapUsd].filter(v => v != null)
  const capUsd = both.length ? Math.min(...both) : null
  const binding = capUsd == null ? null
    : pctCapUsd != null && usdCapUsd != null
      ? (pctCapUsd === usdCapUsd ? 'both' : (pctCapUsd < usdCapUsd ? 'pct' : 'usd'))
      : (pctCapUsd != null ? 'pct' : 'usd')

  const remainingUsd = capUsd == null ? null : Math.max(0, capUsd - spentUsd)

  return {
    capUsd,
    uncapped: capUsd == null,
    binding,
    pctCapUsd,
    usdCapUsd,
    pct,
    // Pacing describes the percentage check, so it is only true when that
    // check is the one actually holding the line. A ramp the flat USD cap sits
    // below is not pacing anything, and saying so would explain the day's
    // allowance with the wrong mechanism.
    paced: hasCeiling && binding !== 'usd',
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
    return p.usdCapUsd != null
      ? `% cap binds (${usd(p.pctCapUsd)}, tighter than the ${usd(p.usdCapUsd)} flat cap)`
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
