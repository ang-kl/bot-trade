// ---------------------------------------------------------------------------
// agent/services/fvg-strategy.js — Fair-value-gap retrace entry.
//
// A fair value gap is a three-bar imbalance: price moved so fast that bar i's
// low never overlapped bar i-2's high (bullish), leaving a band nobody traded
// through. The trade is not the gap itself — it is the RETRACE back into it:
// price comes back to fill the imbalance, finds the participation that was
// skipped, and continues in the original direction.
//
// WHAT WAS ALREADY HERE, AND WHAT WAS NOT. The geometry has existed in this
// codebase twice over for some time — `findFvgZones` (lib/indicators.js, with
// fill marking, already driving Telegram charts and the /actions overlays) and
// `findFVGs` (fib-strategy.js, unfilled-only). What did NOT exist was a
// strategy: something that turns a zone into an entry, a stop and a target and
// registers in STRATEGY_REGISTRY. A comment in va-breakout.js asserted the
// detector itself was missing; that was stale, and is corrected in this change.
//
// This uses lib/indicators.js's `findFvgZones` — the one with fill marking,
// because "has this gap already been filled" is exactly the question the entry
// rule turns on, and re-deriving it here would be a second implementation of
// the thing the vol-gate work is specifically trying to avoid.
//
// KIND. Continuation, not mean-reversion: the thesis is that the impulse
// resumes after the fill. STRATEGY_KIND registers it as a trend/breakout kind
// so the regime gate keeps it out of dead markets, where gaps form on noise and
// fill without follow-through.
//
// The vol-gate spec (§3.5) wants each gap tagged with the volatility regime it
// was CREATED in, not the one it fills in — a gap torn open in a panic is a
// different object from one that opened in a calm drift. `originBarIdx` and
// `originAgeBars` are returned for exactly that stamping; the gate reads them.
// ---------------------------------------------------------------------------

import { atr } from './fib-strategy.js'
import { findFvgZones } from '../lib/indicators.js'
import { STRATEGY_PREFILTER_RR } from '../lib/strategy-prefilter-rr.js'

const MIN_BARS = 60
const ATR_PERIOD = 14

// A gap thinner than this is noise, not an imbalance worth trading — every
// other bar leaves a tick-sized gap on a quiet instrument.
const MIN_GAP_ATR = Number(process.env.FVG_MIN_GAP_ATR) || 0.25
// And one wider than this is usually a session break or a news dislocation,
// where "the gap fills" is a much weaker claim.
const MAX_GAP_ATR = Number(process.env.FVG_MAX_GAP_ATR) || 3

// A gap only stays interesting for so long. Past this the impulse that made it
// is old news and the level is just another price.
const MAX_AGE_BARS = Number(process.env.FVG_MAX_AGE_BARS) || 40
// It also needs to have been given a chance to work: entering on the same bar
// that completes the gap is chasing the impulse, not trading its retrace.
const MIN_AGE_BARS = 2

const SL_ATR_BUFFER = 0.5
// One definition, in strategies.js — see STRATEGY_PREFILTER_RR there for why
// a local copy of this number is a bug and not a convenience.
const MIN_RR = STRATEGY_PREFILTER_RR

const round5 = (v) => Math.round(v * 1e5) / 1e5

/**
 * How far into the zone price has come, 0-1. 0 = only just touched the near
 * edge, 1 = traded through the far edge (i.e. filled).
 */
export function fillFraction(zone, price) {
  const height = zone.top - zone.bottom
  if (!(height > 0)) return null
  const into = zone.dir === 'bull' ? (zone.top - price) : (price - zone.bottom)
  return Math.max(0, Math.min(1, into / height))
}

/**
 * The freshest tradeable gap, or null.
 *
 * "Tradeable" means: still unfilled, old enough to be a retrace rather than a
 * chase, young enough to still matter, and a sane size relative to ATR.
 */
export function selectZone(zones, bars, a, { maxAgeBars = MAX_AGE_BARS } = {}) {
  const last = bars.length - 1
  let best = null
  for (const z of zones) {
    if (z.filledIdx != null) continue          // already filled — no imbalance left
    const age = last - z.fromIdx
    if (age < MIN_AGE_BARS || age > maxAgeBars) continue
    const height = z.top - z.bottom
    if (!(height > 0)) continue
    const heightAtr = height / a
    if (heightAtr < MIN_GAP_ATR || heightAtr > MAX_GAP_ATR) continue
    // Freshest wins: the most recent imbalance is the one price is reacting to.
    if (!best || z.fromIdx > best.fromIdx) best = z
  }
  return best
}

/**
 * Standard strategy signal, or null.
 *
 * Entry: price has retraced INTO an unfilled gap but not through it, and the
 * current bar closed back in the gap's own direction — the reaction, not the
 * arrival. Stop sits beyond the far edge (where "the gap holds" is wrong).
 * Target is the impulse extreme that created the imbalance.
 */
export function computeFvgSignal(bars, timeframe, opts = {}) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS) return null

  const a = atr(bars, ATR_PERIOD)
  if (!(a > 0)) return null

  const zones = findFvgZones(bars)
  const z = selectZone(zones, bars, a, opts)
  if (!z) return null

  const bar = bars[bars.length - 1]
  const price = bar.c
  const height = z.top - z.bottom

  // Price must be INSIDE the zone right now. Above a bull gap it has not
  // retraced yet; below it the gap is filled and selectZone would have
  // dropped it — but a bar can straddle, so check the close explicitly.
  if (price > z.top || price < z.bottom) return null

  const bias = z.dir === 'bull' ? 'long' : 'short'

  // The reaction bar: closed in the gap's direction. A bar that fell through
  // a bull gap and closed at its low is not a bounce, it is the fill in
  // progress, and entering there is catching the knife that is still falling.
  const closedWithDirection = z.dir === 'bull' ? bar.c > bar.o : bar.c < bar.o
  if (!closedWithDirection) return null

  const entry = price
  const sl = z.dir === 'bull'
    ? z.bottom - SL_ATR_BUFFER * a
    : z.top + SL_ATR_BUFFER * a
  const slDist = Math.abs(entry - sl)
  if (!(slDist > 0)) return null

  // The impulse extreme — the far side of the move that tore the gap open.
  // That is where the thesis says price is going back to.
  const impulse = bars.slice(Math.max(0, z.fromIdx - 2), z.fromIdx + 1)
  const target = z.dir === 'bull'
    ? Math.max(...impulse.map(b => b.h))
    : Math.min(...impulse.map(b => b.l))
  const tp1 = z.dir === 'bull'
    ? Math.max(target, entry + slDist * MIN_RR)
    : Math.min(target, entry - slDist * MIN_RR)

  const rr = Math.abs(tp1 - entry) / slDist
  if (!(rr >= MIN_RR)) return null

  const filled = fillFraction(z, price)

  // Conviction: a deeper retrace into the gap is a better entry (more of the
  // imbalance repaired, stop no further away), and a fresher gap is stronger.
  const age = (bars.length - 1) - z.fromIdx
  let conviction = 4
  if (filled != null && filled >= 0.5) conviction += 2
  if (age <= 10) conviction += 1
  if (height / a >= 0.75) conviction += 1
  conviction = Math.max(0, Math.min(10, conviction))

  return {
    bias,
    entry: round5(entry),
    sl: round5(sl),
    tp1: round5(tp1),
    tp2: round5(z.dir === 'bull' ? tp1 + slDist : tp1 - slDist),
    conviction,
    rr: Math.round(rr * 100) / 100,
    timeframe,
    time_cap_minutes: null,
    strategy: 'fvg_retrace',
    fvg: {
      top: round5(z.top),
      bottom: round5(z.bottom),
      heightAtr: Math.round((height / a) * 100) / 100,
      fillFraction: filled != null ? Math.round(filled * 100) / 100 : null,
      // For vol-gate §3.5: the gate stamps the regime the gap was CREATED in,
      // not the one it is filling in. It needs the creating bar, not just the
      // zone's prices.
      originBarIdx: z.fromIdx,
      originBarTime: bars[z.fromIdx]?.t ?? null,
      originAgeBars: age,
    },
    reason: `${bias} FVG retrace — ${Math.round((filled ?? 0) * 100)}% into a ${Math.round((height / a) * 100) / 100}xATR gap ${age} bars old`,
  }
}

computeFvgSignal.minBars = MIN_BARS

export const _internal = { MIN_BARS, MIN_GAP_ATR, MAX_GAP_ATR, MAX_AGE_BARS, MIN_RR, SL_ATR_BUFFER }
