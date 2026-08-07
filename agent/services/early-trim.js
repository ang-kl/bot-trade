// ---------------------------------------------------------------------------
// agent/services/early-trim.js — "shrink the lot once the trade is in profit",
// SHADOW MODE.
//
// Owner, 2026-08-07: "trade more and shrink lot size earlier if symbol is
// profit to take gains earlier if necessary" — then, after reading the spec:
// "ship T2 log-only now".
//
// WHY LOG-ONLY, AND WHY THAT IS NOT HEDGING. Trimming a winner early is the
// exact mechanism the Calculated-Risk / Defensive-Drift audit suspects is
// ALREADY truncating this system's winners: 60% of postmortems classify
// time_cap, spike tightening pulls the trail from 2.5 ATR to 1.0 ATR mid-move,
// and burn-in sets the target at 1.6x the stop. Phase 7's replay (#680) exists
// to measure precisely that and cannot run until roughly 13-08, when ~7 days of
// clean-origin rows exist.
//
// So this module computes the trim it WOULD make and records it. Nothing is
// closed, no stop is moved, no volume changes. A week from now there are two
// independent readings — the offline replay over stored bars, and this live
// shadow record over trades that actually happened — and the decision to switch
// it on can be made against both instead of against an intuition.
//
// THE RULE (spec §T2; every number is the owner's to change):
//
//   when   unrealised >= trimAtR, measured in R against the ORIGINAL stop
//    and   this position has not been trimmed before
//    and   the remainder after the trim still clears the broker's minimum lot
//   then   close trimFrac of it and move the stop to breakeven
//
// FOUR THINGS THIS GETS RIGHT, none of them incidental:
//
//   1. R IS MEASURED AGAINST THE ORIGINAL STOP (trades.sl_price), never the
//      current one. The keeper ratchets the live stop, so "R" computed from
//      monitored_positions.current_sl would shrink as the trail tightens and
//      the trade would appear to reach 1R without moving. That is the
//      difference between a threshold and a self-fulfilling one.
//   2. THE BREAKEVEN MOVE IS PART OF THE RULE, not a nicety. Trimming without
//      it reduces the win and leaves the risk untouched — strictly the worst
//      of both, and the easiest version to ship by accident.
//   3. THE MINIMUM-LOT GUARD. A trim that leaves a remnant below the broker's
//      minimum leaves a position that cannot later be closed normally. Refused,
//      with the reason recorded, rather than rounded and hoped for.
//   4. ONE TRIM PER POSITION, EVER — not one per leg. When add-on-trend (T3)
//      eventually lands, a per-leg flag would re-arm the trim on every add and
//      produce exactly the trim/add/trim churn the spec warns about, paying
//      spread each round.
// ---------------------------------------------------------------------------

/** Shadow mode only. 'act' is deliberately NOT implemented in this module. */
export const EARLY_TRIM_MODE_LOG = 'log'

export const DEFAULT_EARLY_TRIM = Object.freeze({
  // OFF until the owner turns it on, and 'log' is the only mode that exists.
  enabled: false,
  mode: EARLY_TRIM_MODE_LOG,
  atR: 1.0,      // trim once unrealised reaches this many R
  frac: 0.5,     // fraction of the CURRENT volume to close
  moveSlToBreakeven: true,
})

/**
 * Read the shadow-trim config, falling back to the defaults for anything
 * missing or malformed. A config that cannot be parsed must leave the feature
 * OFF — the fail-safe direction for a feature that would otherwise start
 * writing shadow rows nobody asked for.
 *
 * @param {object|null} raw
 * @returns {typeof DEFAULT_EARLY_TRIM}
 */
export function earlyTrimConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    enabled: c.enabled === true,
    // Any value other than 'log' is treated as 'log'. There is no act path in
    // this module, and silently accepting mode:'act' would imply one exists.
    mode: EARLY_TRIM_MODE_LOG,
    atR: num(c.atR, DEFAULT_EARLY_TRIM.atR),
    frac: Math.min(0.9, num(c.frac, DEFAULT_EARLY_TRIM.frac)),
    moveSlToBreakeven: c.moveSlToBreakeven !== false,
  }
}

/**
 * Pure. Would the early trim fire on this position right now?
 *
 * Returns `{ trim, rNow, ... }` in every case — a decision NOT to trim is as
 * much of a shadow observation as a decision to trim, and the reason is what
 * makes a week of these rows readable.
 *
 * @param {object} a
 * @param {string} a.side            LONG/BUY or SHORT/SELL
 * @param {number} a.entry           entry price
 * @param {number} a.originalSl      trades.sl_price — NOT the ratcheted stop
 * @param {number} a.price           current price
 * @param {number} a.volume          current volume, broker units
 * @param {number} [a.minVolume]     broker minimum; 0/absent = no guard
 * @param {boolean} [a.alreadyTrimmed]
 * @param {object} a.cfg             from earlyTrimConfig()
 * @returns {{trim:boolean, rNow:number|null, frac:number|null,
 *            trimVolume:number|null, remainVolume:number|null,
 *            slToBreakeven:number|null, reason:string}}
 */
export function earlyTrimDecision({
  side, entry, originalSl, price, volume, minVolume = 0, alreadyTrimmed = false, cfg,
}) {
  const no = (reason, rNow = null) => ({
    trim: false, rNow, frac: null, trimVolume: null, remainVolume: null,
    slToBreakeven: null, reason,
  })
  const c = cfg || DEFAULT_EARLY_TRIM
  if (!c.enabled) return no('disabled')
  if (alreadyTrimmed) return no('already_trimmed')

  const e = Number(entry)
  const sl = Number(originalSl)
  const p = Number(price)
  const vol = Number(volume)
  if (!(e > 0) || !(p > 0) || !(vol > 0)) return no('missing_prices_or_volume')
  // No original stop means no R. Inventing one from the current stop is the
  // shrinking-denominator bug this module's header warns about, so the honest
  // answer is that the rule cannot be evaluated at all.
  if (!(sl > 0)) return no('no_original_stop')

  const s = String(side || '').toUpperCase()
  const dir = s === 'LONG' || s === 'BUY' ? 1 : -1
  const riskDistance = Math.abs(e - sl)
  // A stop at the entry has no risk distance, so every price is infinite R.
  if (!(riskDistance > 0)) return no('stop_at_entry')

  const rNow = ((p - e) * dir) / riskDistance
  if (!(rNow >= c.atR)) return no('below_threshold', round3(rNow))

  const trimVolume = Math.floor(vol * c.frac)
  const remainVolume = vol - trimVolume
  if (!(trimVolume > 0)) return no('trim_rounds_to_zero', round3(rNow))
  // The remainder has to be a position the broker will still accept a close
  // on. Refusing here is the point — see header §3.
  if (minVolume > 0 && remainVolume < minVolume) {
    return no(`remainder_below_min_lot remain=${remainVolume} min=${minVolume}`, round3(rNow))
  }

  return {
    trim: true,
    rNow: round3(rNow),
    frac: c.frac,
    trimVolume,
    remainVolume,
    slToBreakeven: c.moveSlToBreakeven ? e : null,
    reason: `early_trim rNow=${round3(rNow)} >= ${c.atR}R`,
  }
}

function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null
}

/**
 * The shadow record for one would-be trim. Deliberately a plain object built
 * here rather than inline at the call site, so every row a week from now has
 * the same shape and the comparison against Phase 7's replay is mechanical
 * instead of a parsing exercise.
 */
export function earlyTrimShadowRow(decision, { symbol, positionId, tradeId, accountId, price }) {
  return {
    kind: 'early_trim_shadow',
    mode: EARLY_TRIM_MODE_LOG,
    symbol, positionId, tradeId, accountId,
    price,
    rNow: decision.rNow,
    wouldTrimVolume: decision.trimVolume,
    wouldRemainVolume: decision.remainVolume,
    wouldMoveSlTo: decision.slToBreakeven,
    reason: decision.reason,
    // Stated on every row so nobody reading the table later mistakes it for
    // something that happened.
    applied: false,
  }
}
