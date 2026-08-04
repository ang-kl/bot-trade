// ---------------------------------------------------------------------------
// agent/services/risk-config-history.js — when did each risk setting last
// change, and to what?
//
// THE DEFECT THIS EXISTS FOR (owner, 2026-08-04, with a screenshot). The Risk
// page's reassessment summary shows rows like:
//
//     Daily loss limit ($)   $300 -> $150  APPLIED
//     13 applied Jul 31, 2026, 06:37 PM — the settings below hold these values now
//
// That last clause is a CLAIM, not a readout. Every value in that table comes
// from the stored assessment record, frozen at the moment it was applied. The
// component never reads the live config back. So if anything changed a setting
// afterwards — the owner editing the field below, a per-account overlay, a
// reset — the row still asserts its own number is current, and the field below
// disagrees. The owner found it by searching for the daily loss limit and
// getting a different value.
//
// It is the same class of defect as everything else in this workstream: a
// component asserting a state it never verified. §70.8's silent drops were an
// aggregate nobody could check; §70.9's lineage was a link nobody recorded.
// This is a summary nobody read back.
//
// TWO THINGS ARE NEEDED TO FIX IT HONESTLY:
//   1. the LIVE value, so the row can compare rather than claim — that is the
//      route's job, not this module's,
//   2. WHEN each key last changed and what it changed from, so a row that no
//      longer holds can say when it stopped. That is this module.
//
// WHAT THIS IS NOT. It is not an audit log — action_log already records the
// HTTP calls. This is the narrow "what does this one field say about itself"
// record the UI needs, bounded to one entry per key so it cannot grow without
// limit.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

/** agent_state key holding the change map, global or per account. */
export function changeKey(accountId = null) {
  return accountId == null
    ? 'risk_config_changed_json'
    : `acct:${String(accountId)}:risk_config_changed_json`
}

/** key → { at, from, to, by }. Never throws; an unreadable map reads as empty. */
export function loadRiskConfigChanges(db, accountId = null) {
  try {
    const raw = JSON.parse(getState(db, changeKey(accountId)) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

/**
 * Record which keys actually changed between two configs.
 *
 * ONLY REAL CHANGES. A write that sets a field to the value it already had is
 * not a change, and stamping it would make "last changed" mean "last
 * submitted" — which is the weaker fact, and the one that would let a form
 * re-save move every timestamp on the page at once.
 *
 * @param {object} before  config before the write
 * @param {object} after   config after it
 * @param {{accountId?: string|null, at?: string, by?: string}} opts
 * @returns {string[]} the keys that changed
 */
export function noteRiskConfigChanges(db, before, after, {
  accountId = null, at = new Date().toISOString(), by = 'manual',
} = {}) {
  try {
    const map = loadRiskConfigChanges(db, accountId)
    const changed = []
    for (const k of Object.keys(after || {})) {
      const from = before?.[k]
      const to = after?.[k]
      // Compared by VALUE, not identity: these are numbers and booleans out of
      // JSON, and 0 / false / null are all legitimate settings. A truthiness
      // test here would silently ignore turning a limit off.
      if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue
      map[k] = { at, from: from ?? null, to: to ?? null, by }
      changed.push(k)
    }
    if (changed.length) setState(db, changeKey(accountId), JSON.stringify(map))
    return changed
  } catch { return [] }
}

/**
 * Forget the history for keys that no longer exist in the config — a reset, or
 * a setting removed from the schema. Bounded map, no orphan rows.
 */
export function pruneRiskConfigChanges(db, validKeys, { accountId = null } = {}) {
  try {
    const valid = new Set(validKeys || [])
    const map = loadRiskConfigChanges(db, accountId)
    let dropped = 0
    for (const k of Object.keys(map)) {
      if (!valid.has(k)) { delete map[k]; dropped++ }
    }
    if (dropped) setState(db, changeKey(accountId), JSON.stringify(map))
    return dropped
  } catch { return 0 }
}

/**
 * Does the live config still hold the value a proposal claimed to apply?
 *
 * Three answers, and the middle one is the whole point — it is the state the
 * page could not express and therefore misreported as "applied".
 *
 *   'holds'      — applied, and the setting still carries that value
 *   'superseded' — applied, but something has changed it since
 *   'not_applied'— never applied
 *
 * @param {{applied: boolean, proposed: any, live: any}} o
 */
export function proposalStatus({ applied, proposed, live }) {
  if (!applied) return 'not_applied'
  return JSON.stringify(live ?? null) === JSON.stringify(proposed ?? null) ? 'holds' : 'superseded'
}
