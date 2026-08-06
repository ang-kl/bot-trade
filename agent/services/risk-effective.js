// ---------------------------------------------------------------------------
// agent/services/risk-effective.js — which number does this account actually
// trade under, where did it come from, and who put it there?
//
// THE AUDIT FINDING (Part 2, 2026-08-06). The Risk page showed `minRR 1.5`.
// The accounts were gated at 4.5–6.16. Both readings came from the same route.
// The reason is that `/state/risk-full` took `?account=<id>` and NOTHING ELSE
// was validated: a caller who wrote `?accountId=…`, `?acct=…`, or misspelled
// the value got the GLOBAL config back, presented exactly as if it were the
// account's. A silently-ignored parameter is worse than a rejected one — it
// answers a question nobody asked, in the shape of the question they did.
//
// Three states were also collapsed into one:
//   1. no account named          → the global config, correctly
//   2. a KNOWN account           → global + that account's overlay
//   3. an UNKNOWN account id     → global config, indistinguishable from (2)
//
// (3) is the dangerous one. An operator reading a typo'd account id sees
// plausible numbers and no warning, and the numbers belong to nobody.
//
// WHAT THIS MODULE DOES NOT DO. It does not change a single threshold.
// `minRR`, `perTradeRiskPct`, the daily caps and the equity stops are owner
// policy; this file only makes them legible — global value, overlay value,
// effective value, and the provenance of the overlay — so a decision about
// them can be made from what is true rather than from what the page implied.
//
// PROVENANCE IS READ, NOT INVENTED. risk-config-history.js already records
// `{at, from, to, by}` per key when a write actually changes something. That
// is the only honest source available, so where it is silent this module says
// `source: 'unknown'` and `writtenAt: null` rather than guessing. `reason` is
// null everywhere today because nothing records one — a field that is
// structurally absent is stated as absent, not filled with a plausible string.
// ---------------------------------------------------------------------------

import { DEFAULT_RISK_CONFIG, loadRiskConfig, accountRiskOverlay } from './risk.js'
import { loadRiskConfigChanges } from './risk-config-history.js'

/**
 * `by` as recorded by the write sites → the enumerated source the audit asks
 * for. Anything unrecognised stays 'unknown': a source label is a claim about
 * who moved a risk limit, and a wrong one is worse than none.
 */
const SOURCE_BY = { manual: 'manual', reassess: 'controller', migration: 'migration' }

/**
 * Is this account id one the registry knows about?
 *
 * Distinguishes "the overlay is empty" from "this account does not exist",
 * which the route previously could not say.
 *
 * @returns {boolean|null} null when the registry cannot be read at all — an
 *   unreadable table must not be reported as "no such account".
 */
export function accountKnown(db, accountId) {
  if (accountId == null) return null
  try {
    const row = db.prepare('SELECT 1 AS x FROM accounts WHERE account_id = ?').get(String(accountId))
    return !!row
  } catch { return null }
}

/**
 * Per-key truth for one scope.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} accountId
 * @param {{keys?: string[]}} [opts] defaults to every key in DEFAULT_RISK_CONFIG
 * @returns {Array<{key, globalValue, overlayValue, effectiveValue, scope,
 *   accountId, source, writtenAt, writtenBy, reason}>}
 */
export function effectiveRiskEntries(db, accountId = null, { keys } = {}) {
  const acct = accountId == null ? null : String(accountId)
  const globalCfg = loadRiskConfig(db, null)
  const overlay = acct ? (accountRiskOverlay(db, acct) || {}) : {}
  const effective = loadRiskConfig(db, acct)
  // History for the scope the value actually came FROM: an overlaid key was
  // last written on the account, a non-overlaid one on the global config.
  const acctHistory = acct ? loadRiskConfigChanges(db, acct) : {}
  const globalHistory = loadRiskConfigChanges(db, null)

  const wanted = keys && keys.length ? keys : Object.keys(DEFAULT_RISK_CONFIG)
  return wanted.map((key) => {
    const overlaid = acct != null && key in overlay
    const h = (overlaid ? acctHistory : globalHistory)[key] || null
    return {
      key,
      globalValue: globalCfg[key] ?? null,
      overlayValue: overlaid ? overlay[key] : null,
      effectiveValue: effective[key] ?? null,
      scope: overlaid ? 'account' : 'global',
      accountId: overlaid ? acct : null,
      source: h?.by != null ? (SOURCE_BY[h.by] || 'unknown') : 'unknown',
      writtenAt: h?.at ?? null,
      // Nothing records an actor distinct from the source today. Saying so is
      // the point of the field; inventing 'owner' would be a fabrication.
      writtenBy: h?.by ?? null,
      reason: null,
    }
  })
}

/**
 * Which query parameters did a caller send that the route does not understand?
 *
 * The route's own rule is the audit's: an unsupported parameter must FAIL,
 * because the alternative is answering about the global config while the
 * caller believes they asked about an account.
 *
 * @returns {string[]} unknown parameter names, in the order sent
 */
export function unknownQueryParams(query, allowed) {
  const ok = new Set(allowed || [])
  return Object.keys(query || {}).filter((k) => !ok.has(k))
}
