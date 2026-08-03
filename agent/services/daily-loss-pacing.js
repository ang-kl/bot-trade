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
 * @param {object} a
 * @param {number|null} a.balance        account balance USD, null when unset
 * @param {number} a.basePct             dailyLossPct — spendable at day open
 * @param {number|null} a.maxPct         dailyLossPctMax — the day's ceiling
 * @param {number} a.absoluteFallback    dailyLossLimit USD, used when balance is null
 * @param {number} a.nowMs
 * @param {number} a.dayOpenMs           fxDayOpenMs(nowMs)
 * @param {number} [a.spentUsd]          today's realised loss as a POSITIVE number
 * @param {number} [a.perTradeRiskUsd]   $ at risk on a typical trade, for tradesLeft
 * @returns {{capUsd:number, pct:number|null, paced:boolean, elapsed:number,
 *            ceilingUsd:number|null, remainingUsd:number|null, tradesLeft:number|null}}
 */
export function pacedDailyCap({
  balance, basePct, maxPct, absoluteFallback,
  nowMs, dayOpenMs, spentUsd = 0, perTradeRiskUsd = 0,
}) {
  // No balance → the absolute USD fallback, unpaced. Pacing is a fraction of
  // an equity figure; without one there is nothing to take a fraction of, and
  // inventing a percentage of an unknown balance would be worse than the flat
  // number the operator explicitly configured.
  if (!(balance > 0)) {
    const capUsd = Math.abs(Number(absoluteFallback) || 0)
    return {
      capUsd, pct: null, paced: false, elapsed: 0, ceilingUsd: null,
      remainingUsd: capUsd > 0 ? Math.max(0, capUsd - spentUsd) : null,
      tradesLeft: null,
    }
  }

  const base = Number(basePct)
  const ceil = Number(maxPct)
  const hasCeiling = Number.isFinite(ceil) && Number.isFinite(base) && ceil > base
  const flatUsd = balance * (Number.isFinite(base) ? base : 0)

  if (!hasCeiling) {
    return {
      capUsd: flatUsd, pct: Number.isFinite(base) ? base : null, paced: false,
      elapsed: 0, ceilingUsd: null,
      remainingUsd: Math.max(0, flatUsd - spentUsd),
      tradesLeft: tradesLeft(flatUsd - spentUsd, perTradeRiskUsd),
    }
  }

  // Elapsed fraction of the FX day, clamped. A clock that reads before the
  // day open (skew) or beyond its end (a box resuming late) must land on a
  // defined end of the ramp, not off it.
  const raw = (nowMs - dayOpenMs) / FX_DAY_MS
  const elapsed = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0))

  const pct = base + (ceil - base) * elapsed
  const capUsd = Math.min(balance * ceil, balance * pct)   // ceiling is absolute
  const remainingUsd = Math.max(0, capUsd - spentUsd)

  return {
    capUsd, pct, paced: true, elapsed,
    ceilingUsd: balance * ceil,
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

/** Human-readable tail for the veto line and the Risk page. */
export function describePacing(p) {
  if (!p?.paced) return null
  const pct = (p.pct * 100).toFixed(2).replace(/\.?0+$/, '')
  const ceil = p.ceilingUsd != null ? ` of ${(p.ceilingUsd).toFixed(0)} max` : ''
  const left = p.remainingUsd != null ? `, ${p.remainingUsd.toFixed(2)} left` : ''
  const trades = p.tradesLeft != null ? ` (~${p.tradesLeft} more trade${p.tradesLeft === 1 ? '' : 's'})` : ''
  return `paced ${pct}% at ${(p.elapsed * 100).toFixed(0)}% through the FX day${ceil}${left}${trades}`
}
