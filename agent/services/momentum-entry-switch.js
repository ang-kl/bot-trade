// ---------------------------------------------------------------------------
// agent/services/momentum-entry-switch.js — V3 T4: the one switch that decides
// whether a momentum entry carries the partial-TP1 plan.
//
// OFF BY DEFAULT, and off until the owner answers OD-1. The file
// config/momentum-entries.json is the declaration; only `"market": true`
// turns it on. A missing, unreadable or malformed file is OFF, never on: a
// switch that fails open would resume live entries on a bad deploy.
//
// While it is off, autoTrade does exactly what it did before T4 for every
// producer: a momentum proposal carries no target and the shared execution
// boundary refuses it. Nothing in this module touches a risk limit, a cap, a
// threshold or TP1's mandatory status.
//
// A leaf module (fs only) so the status route can read it without importing
// the producer, which imports the contract the route already imports.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'

export const MOMENTUM_ENTRIES_FILE = new URL('../config/momentum-entries.json', import.meta.url)

// The producers whose entries the T4 plan applies to (the row-cursor book and
// the daily momentum account). Every other producer is untouched by T4.
export const MOMENTUM_ENTRY_PRODUCERS = Object.freeze(['cross_sectional_book', 'daily_momentum_account'])

/** { market, source, error }. market is true only for the literal true. */
export function loadMomentumEntrySwitch(file = MOMENTUM_ENTRIES_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { market: raw?.market === true, source: 'config/momentum-entries.json', error: null }
  } catch (error) {
    return { market: false, source: 'config/momentum-entries.json', error: `unreadable (off): ${error.message}` }
  }
}

/** Does the T4 plan path apply to this producer's entry? False for every
 * producer while the switch is off. The producer id is checked first, so a
 * scan dispatch never reads the file. */
export function momentumPlanApplies(producerId, { load = loadMomentumEntrySwitch } = {}) {
  if (!MOMENTUM_ENTRY_PRODUCERS.includes(producerId)) return false
  return load().market === true
}
