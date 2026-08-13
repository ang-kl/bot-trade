// ---------------------------------------------------------------------------
// agent/services/risk-matrix.js — every risk setting, global and per account,
// side by side.
//
// WHY (owner, 2026-08-04): "ACCOUNT card, change to a Summary table of the
// global + individual account's Risk setups and each table settings with
// collapsible triangle."
//
// The Risk page could show ONE account's effective settings at a time — the
// selected one — and the Account card showed balance, leverage and an id. So
// the question an operator actually has, "does 5203012 run tighter than
// 46130058, and where?", could only be answered by switching accounts and
// remembering. Overlays make that worse rather than better: a per-account
// overlay is a PARTIAL config merged over the global one, so the same field
// can be an override on one account and a default on the next, and nothing
// said which.
//
// This assembles the whole grid in one read: the global config, every enabled
// account's effective config, and — the part that matters — WHICH of those
// values are that account's own overlay rather than the global value it
// inherited. A number that looks identical on two accounts for two different
// reasons is exactly the kind of thing this page should not hide.
//
// It also carries the per-key change stamps from risk-config-history.js, so
// the same "last changed" fact the proposal rows show is available per cell.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig } from './risk.js'
import { loadRiskConfigChanges } from './risk-config-history.js'

/**
 * Setting groups, in the order the Risk page shows them.
 *
 * Named here rather than derived, because a group is an editorial decision
 * about what an operator reads together — "the day's brakes" is a different
 * thought from "how big is one bet". A key missing from every group would
 * vanish from the table, so `groupOf` falls back to 'Other' and a test asserts
 * that bucket stays empty.
 */
export const RISK_GROUPS = Object.freeze([
  { id: 'day', label: 'Day limits', keys: [
    'dailyLossPct', 'dailyLossPctMax', 'dailyLossLimit', 'equityStopPct',
    'campaign', 'dailyLossFloorUsd', 'dailyLossTierAtUsd', 'dailyLossTierSmallPct', 'dailyLossTierLargePct',
    'maxMarginUsagePct', 'marginLevelFloorPct',
  ] },
  { id: 'size', label: 'Position size', keys: [
    'perTradeRiskPct', 'perTradeRiskUsd', 'maxRiskCapPct', 'maxRiskUsd', 'minLotSize',
    // Grouped with the risk ceilings because an operator reads it as one, but
    // it is the only one here denominated in EXPOSURE rather than risk — which
    // is what lets it catch a wrong contract spec that the others compute
    // through and authorise. See the note on the default in risk.js.
    'maxNotionalXBalance',
  ] },
  { id: 'quality', label: 'Entry quality', keys: [
    'minRR', 'minExpectancyR', 'minSLDistancePct', 'maxSpreadFracOfSL', 'stopTriggerMethod',
  ] },
  { id: 'exposure', label: 'Exposure', keys: [
    'maxOpenPositions', 'maxPositionsPerSymbol', 'maxClusterExposure',
    'maxCurrencyExposure', 'blockedSymbols',
  ] },
  { id: 'streak', label: 'Losing streaks', keys: [
    'maxConsecutiveLosses', 'cooldownMinutes', 'symbolCooldownMinutes',
    'deriskOnDrawdown', 'deriskWindowHours', 'deriskTriggerPct', 'deriskMult',
  ] },
  { id: 'pnl', label: 'P&L trust', keys: [
    'blockOnUnknownPnl', 'unknownPnlGraceMin', 'unknownPnlMaxAgeMin', 'unknownPnlMinAttempts',
    'minTradesForKelly', 'allowNegativeExpectancyOverride', 'nullExitMinR',
  ] },
  { id: 'cost', label: 'Cost gates', keys: [
    'newsGateEnabled', 'newsGateMinBefore', 'newsGateMinAfter', 'newsGateImpacts',
    'carryGateEnabled', 'carryMaxNegativeSwapPoints',
    'commissionGateEnabled', 'commissionMaxFracOfWin', 'commissionGateMinTrades',
    'slippageGateEnabled', 'slippageMaxAdversePct', 'slippageGateMinTrades',
  ] },
  { id: 'account', label: 'Account', keys: ['leverage'] },
])

/**
 * Keys that were once enforced, are still WRITTEN in somebody's overlay, and
 * are read by nothing today.
 *
 * `kellyFraction` is the case that named this list: it sits in the production
 * global overlay, and the only mention of it left in the engine is the comment
 * at risk.js:588 explaining why the `kelly * kellyFraction * 4` haircut was
 * removed. Giving it a control on the Risk page would have been the wrong fix —
 * an editable field for a number nothing reads is a worse lie than a missing
 * one. Giving it a group row would have been the same lie with a triangle.
 *
 * So it is declared dead here and the grid says so out loud, once, above the
 * table. The value stays in the overlay: deleting an operator's stored setting
 * to tidy a UI is not this module's call.
 */
export const RETIRED_KEYS = Object.freeze({
  kellyFraction: 'no longer read — full Kelly ships the risk-budgeted size (risk.js kellyVolume)',
})

/** Which group a key belongs to. 'Other' is a bug, not a category. */
export function groupOf(key) {
  return RISK_GROUPS.find(g => g.keys.includes(key))?.id ?? 'other'
}

/** Keys that belong to no declared group — should always be empty. */
export function ungroupedKeys() {
  return Object.keys(DEFAULT_RISK_CONFIG).filter(k => groupOf(k) === 'other')
}

/** One account's raw overlay — the PARTIAL config merged over the global one. */
function overlayFor(db, accountId) {
  try {
    const raw = JSON.parse(getState(db, `acct:${String(accountId)}:risk_config_json`) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

/**
 * The whole grid.
 *
 * @returns {{
 *   groups: Array<{id,label,keys:string[]}>,
 *   global: { values: object, overridden: string[], changed: object },
 *   accounts: Array<{accountId, isLive, enabled, values: object,
 *                    overridden: string[], changed: object}>,
 *   defaults: object,
 * }}
 */
export function buildRiskMatrix(db) {
  const defaults = { ...DEFAULT_RISK_CONFIG }
  let globalRaw = {}
  try { globalRaw = JSON.parse(getState(db, 'risk_config_json') || '{}') || {} } catch { globalRaw = {} }

  const global = {
    values: loadRiskConfig(db),
    // OVERRIDDEN MEANS "written here", not "differs from the default". A value
    // deliberately set to the default IS an override — it stops following
    // future default changes — and showing it as inherited would misrepresent
    // what happens when the default moves.
    overridden: Object.keys(globalRaw),
    changed: loadRiskConfigChanges(db),
  }

  let rows = []
  try {
    rows = db.prepare('SELECT account_id, is_live, enabled FROM accounts ORDER BY is_live DESC, account_id').all()
  } catch { rows = [] }

  const accounts = rows.map(r => {
    const id = String(r.account_id)
    const overlay = overlayFor(db, id)
    return {
      accountId: id,
      isLive: r.is_live === 1,
      enabled: r.enabled === 1,
      values: loadRiskConfig(db, id),
      overridden: Object.keys(overlay),
      changed: loadRiskConfigChanges(db, id),
    }
  })

  // Retired keys somebody is still storing. Reported per writer, because
  // "kellyFraction is set globally" and "kellyFraction is set on 5203012" are
  // different things to go and clean up.
  const retired = []
  for (const [key, why] of Object.entries(RETIRED_KEYS)) {
    if (global.overridden.includes(key)) retired.push({ key, where: 'global', value: globalRaw[key], why })
    for (const a of accounts) {
      if (a.overridden.includes(key)) {
        retired.push({ key, where: a.accountId, value: overlayFor(db, a.accountId)[key], why })
      }
    }
  }

  return { groups: RISK_GROUPS.map(g => ({ ...g })), global, accounts, defaults, retired }
}

/**
 * Where does one account's value come from?
 *
 *   'account' — this account's own overlay
 *   'global'  — inherited from the global config, which itself overrides a default
 *   'default' — nobody has ever set it
 *
 * The distinction is the point of the table. Two accounts showing 1.00% for
 * different reasons behave differently the moment a default or the global
 * value moves, and a grid that renders both the same way hides that.
 */
export function originOf(key, { accountOverridden = [], globalOverridden = [] } = {}) {
  if (accountOverridden.includes(key)) return 'account'
  if (globalOverridden.includes(key)) return 'global'
  return 'default'
}
