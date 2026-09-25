// ---------------------------------------------------------------------------
// agent/services/tick-shadow-counterfactual.js — plan P2 (25-09-2026): the
// shadow book's recent trades RE-SCORED with the two live filters the shadow
// does not apply, to answer "can filtering lift both PF and win rate, and
// what does each veto cost?" (owner principle 7) before anything goes live.
//
// REPORT ONLY. Nothing here is read by an entry path; no threshold, cap or
// config is written.
//
// The two filters, copied from what live does:
//   stop floor    — tick_firer.cpp:148-150: refuse when
//                   stopDistance < llround(minStopFraction × entry), both in
//                   wire units, and only when minStopFraction > 0. The
//                   shadow row stores stop_distance and entry in the same
//                   wire units. minStopFraction is read from
//                   agent/config/tick-entry.json (loadTickEntryConfig).
//   counter-trend — the permit feeder withholds the against-trend side:
//                   permittedSides(trendReadingFor(db, symbol))
//                   (tick-permits.js, direction-policy.js). Re-scored on the
//                   reading AS OF entry_ms (trendReadingAt → latestRegime's
//                   asOfMs), never a later row. The feeder reads it when it
//                   reserves the permit, not at the fill; entry_ms is within
//                   the permit TTL of that moment.
//
// A row either filter would remove is `removed`; every other row is `kept`,
// so kept + removed = the population, row for row. A row with no regime
// reading (none within maxRegimeAgeMin, the symbol unmapped, or the gate
// off) is KEPT — live grants both sides with no reading — and counted.
//
// NOT RE-SCORED, because the shadow row does not carry what they need: the
// price bound and pending-signal expiry (no signal price or signal time
// stored), and the feeder's per-account refusals (max positions, a position
// already open, lot size and sizing — the shadow row has no account).
//
// Known limits, stated in the reply: the CURRENT config and gate are used,
// not the historical ones; trades are removed one at a time, so freed slots,
// cooldowns and a different next signal are not modelled; regimes are kept
// ~29–30 days (loop.js prune, a date-format mismatch deletes the whole cutoff
// day), so the first day of a 30-day window may read no regime.
// ---------------------------------------------------------------------------

import { SIDES, sharedShadowTrades, portfolioStats, sideAccounts } from './tick-shadow.js'
import { symbolNameResolver } from './tick-shadow-accounts.js'
import { loadTickEntryConfig } from './tick-permits.js'
import { permittedSides, trendReadingAt } from './direction-policy.js'
import { loadRegimeGateConfig } from './regime-gate.js'

export const COUNTERFACTUAL_ROW_LIMIT = 50_000

/** The firer's floor, in wire units: llround(frac × entry), 0 when frac is not > 0. */
export function stopFloorWire(minStopFraction, entryWire) {
  const f = Number(minStopFraction)
  return f > 0 ? Math.round(f * Number(entryWire)) : 0
}

/**
 * One side's counterfactual over the last `days`.
 */
export function shadowCounterfactual(db, { side, profilePrefix = null, days = 30, now = Date.now(), minStopFraction = loadTickEntryConfig().minStopFraction, limit = COUNTERFACTUAL_ROW_LIMIT } = {}) {
  const sinceMs = now - days * 86_400_000
  const rows = sharedShadowTrades(db, { side, profilePrefix, sinceMs, limit })
  const nameOf = symbolNameResolver(db, sideAccounts(db, side)[0])
  const gate = loadRegimeGateConfig(db)
  const kept = [], removed = []
  const removedBy = { stopFloor: 0, counterTrend: 0, both: 0 }
  let noRegimeReading = 0, stopUnjudgeable = 0
  const unmapped = new Set()
  for (const t of rows) {
    const sd = Number(t.stop_distance), entry = Number(t.entry)
    let stopRemoved = false
    if (t.stop_distance == null || t.entry == null || !Number.isFinite(sd) || !Number.isFinite(entry) || !(entry > 0)) stopUnjudgeable++
    else stopRemoved = sd < stopFloorWire(minStopFraction, entry)
    let trendRemoved = false
    const rawName = nameOf(t.symbol_id)
    const name = rawName ? rawName.toUpperCase() : null
    if (!name) { unmapped.add(t.symbol_id); noRegimeReading++ } else {
      const reading = trendReadingAt(db, name, Number(t.entry_ms))
      if (reading == null) noRegimeReading++
      else trendRemoved = !permittedSides(reading).includes(String(t.trade_side || '').toUpperCase())
    }
    if (stopRemoved && trendRemoved) removedBy.both++
    else if (stopRemoved) removedBy.stopFloor++
    else if (trendRemoved) removedBy.counterTrend++
    ;(stopRemoved || trendRemoved ? removed : kept).push(t)
  }
  const strip = (s) => { const { bootIds: _b, ...rest } = s; return rest }
  const population = strip(portfolioStats(rows)), keptSt = strip(portfolioStats(kept)), removedSt = strip(portfolioStats(removed))
  return {
    side, profile: profilePrefix, days, since: new Date(sinceMs).toISOString(),
    rows: rows.length, truncated: rows.length >= limit, limit,
    population, kept: keptSt, removed: removedSt,
    sumsToPopulation: keptSt.trades + removedSt.trades === population.trades && kept.length + removed.length === rows.length,
    removedBy, noRegimeReading, stopUnjudgeable, unmappedSymbols: [...unmapped].filter(x => x != null).sort((a, b) => a - b),
    minStopFraction, regimeGate: { on: gate.on, maxRegimeAgeMin: gate.maxRegimeAgeMin },
    notRescored: ['price_bound (signal price not stored)', 'pending_expiry (signal time not stored)', 'max_positions', 'position_open', 'lot_size', 'sizing (the shadow row has no account)'],
    note: 'Report only. Current minStopFraction and regime gate, not the historical ones. Removed trades are taken out one at a time — freed slots, cooldowns and different next signals are not modelled, so this is the removed trades\' PF and win rate, not the portfolio that would have resulted. The regime reading is as of entry_ms (the feeder reads it at the permit, within the permit TTL). Regimes are kept ~29–30 days, so the first day of a 30-day window may read none; such trades are kept, as live grants both sides.',
  }
}

/** GET /state/tick-shadow-counterfactual: every side, or one. */
export function shadowCounterfactualView(db, { side = null, days = 30, now = Date.now() } = {}) {
  const sides = side ? [side] : SIDES
  return { at: new Date(now).toISOString(), days, sides: sides.map(s => shadowCounterfactual(db, { side: s, days, now })) }
}
