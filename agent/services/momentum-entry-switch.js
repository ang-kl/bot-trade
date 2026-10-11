// ---------------------------------------------------------------------------
// agent/services/momentum-entry-switch.js — V3 T4: the one switch that decides
// whether a momentum entry carries the partial-TP1 plan.
//
// Shipped OFF; ON since the owner's OD-1 (27-09-2026, market entries: yes).
// The file config/momentum-entries.json is the declaration; only `"market": true`
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

// The account list (B1, T4 fix round): the switch applies ONLY to the
// accounts the file names. Declared data, not a hardcoded id: widening is a
// one-line change to config/momentum-entries.json with the owner's yes
// (principle 9). The arm state is NOT the scope: on a fresh or restored
// database global-strategies.json arms tsmom_long on every account with no
// explicit cell, and momentum-account.json's `_all` sends every enabled
// account through the daily pass. A missing, malformed or empty list names
// no account: fail closed, every account takes the pre-T4 path.
const ACCOUNT_ID = /^[1-9]\d*$/

// W8 — Claude · № 13,382 12-Oct (owner "go W8" after № 13,381;
// docs/instruction-2026-10-12-decisions.md W8; claude-builder). `"_all"` in
// `accounts` names every ENABLED registry account — the token
// config/momentum-account.json already uses (principle 9: no hardcoded
// account list). This leaf module has no database, so a caller that has one
// passes `isEnabled` (registryEnabled below). The two momentum producers reach
// the check only from the book's per-account pass, whose roster is the
// registry's enabled accounts that may enter (registryAutopilotAccounts via
// getAutopilotAccounts), so their call (loop.js autoTrade) needs none.
export const ALL_ENABLED_ACCOUNTS = '_all'

/** An `isEnabled` reader over the account registry: enabled = 1. */
export function registryEnabled(db) {
  return (accountId) => {
    try { return !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ? AND enabled = 1').get(String(accountId)) } catch { return false }
  }
}

/** { market, accounts, source, error }. market is true only for the literal
 * true; accounts holds only well-formed account ids (strings) and the `_all`
 * token. */
export function loadMomentumEntrySwitch(file = MOMENTUM_ENTRIES_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts.filter(a => typeof a === 'string' && (a === ALL_ENABLED_ACCOUNTS || ACCOUNT_ID.test(a))) : []
    return { market: raw?.market === true, accounts, source: 'config/momentum-entries.json', error: null }
  } catch (error) {
    return { market: false, accounts: [], source: 'config/momentum-entries.json', error: `unreadable (off): ${error.message}` }
  }
}

/** Is this account named in the switch's declared account list — by id, or
 * by `_all` when it is a well-formed id the registry has enabled (`isEnabled`
 * given) or the caller's roster already is (no `isEnabled`; see above)? */
export function momentumAccountListed(sw, accountId, { isEnabled = null } = {}) {
  if (!Array.isArray(sw?.accounts) || accountId == null) return false
  const id = String(accountId)
  if (sw.accounts.includes(id)) return true
  if (!sw.accounts.includes(ALL_ENABLED_ACCOUNTS) || !ACCOUNT_ID.test(id)) return false
  return typeof isEnabled === 'function' ? isEnabled(id) === true : true
}

/** Does the T4 plan path apply to this producer's entry on this account?
 * False for every producer while the switch is off, and for every account the
 * file does not name. The producer id is checked first, so a scan dispatch
 * never reads the file. */
export function momentumPlanApplies(producerId, { accountId = null, load = loadMomentumEntrySwitch, isEnabled = null } = {}) {
  if (!MOMENTUM_ENTRY_PRODUCERS.includes(producerId)) return false
  const sw = load()
  return sw.market === true && momentumAccountListed(sw, accountId, { isEnabled })
}
