// daily-stop-display.js — the account card's "daily stop" and "loss-cap used",
// rendered from the server's reading, never computed here.
//
// WEB-2 (8,989-A row 4). The card used to print balance × dailyLossPct, a
// formula the risk engine does not enforce (the engine applies the USD 200
// floor and the 3%/4% balance tiers, and takes the flat cap out of force while
// the tier rule is on): −900 on an account the engine caps at 1,191.42, −0 on
// accounts it caps at 200. `loss-cap used` was hard-coded null. Both now come
// from GET /state/account-overview `accounts[].dailyStop`, which is the
// engine's own dailyLossVerdict (agent/services/daily-stop-reading.js).
//
// This module only turns that reading into words. It computes no cap and no
// percentage, and it never borrows a figure from another account.

const STATES = new Set(['in_force', 'uncapped', 'not_read'])
const USED_STATES = new Set(['measured', 'not_read', 'not_comparable', 'uncapped'])

/**
 * Normalise one account's `dailyStop` reading into the fields the cards use.
 * A missing or malformed reading is `not_read` — never a zero, never a dash
 * that could pass for "no stop".
 *
 * @param {object|null|undefined} ds  accounts[].dailyStop from /state/account-overview
 * @returns {{capState:string, cap:number|null, capCcy:string|null,
 *            used:number|null, usedState:string, capLoss:number|null,
 *            unitsNote:string|null, title:string}}
 */
export function dailyStopView(ds) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const capState = STATES.has(ds?.status) ? ds.status : 'not_read'
  const cap = capState === 'in_force' ? num(ds.capUsd) : null
  const capCcy = typeof ds?.currency === 'string' && ds.currency ? ds.currency : null
  const lc = ds?.lossCapUsed
  const usedState = capState === 'in_force' && cap != null
    ? (USED_STATES.has(lc?.status) ? lc.status : 'not_read')
    : capState === 'uncapped' ? 'uncapped' : 'not_read'
  const used = usedState === 'measured' ? num(lc?.pct) : null
  const capLoss = usedState === 'measured' ? num(lc?.consumed) : null
  const effectiveCapState = capState === 'in_force' && cap == null ? 'not_read' : capState
  const title = [
    effectiveCapState === 'in_force' ? `Daily stop the risk engine enforces: ${[capCcy, cap.toFixed(2)].filter(Boolean).join(' ')} per FX day (from 17:00 New York).` : null,
    effectiveCapState === 'uncapped' ? 'The risk engine enforces no daily stop on this account: both daily checks are off.' : null,
    effectiveCapState === 'not_read' ? `Daily stop not read${ds?.reason ? `: ${ds.reason}` : ''}.` : null,
    ds?.explain ? `Why: ${ds.explain}.` : null,
    num(ds?.balanceUsed) != null ? `Balance the % check used: ${num(ds.balanceUsed).toFixed(2)} (${ds.balanceKey}).` : null,
    lc && lc.realisedLoss != null ? `Realised loss today: ${lc.realisedLoss.toFixed(2)}${num(ds?.estimatedStopoutUsd) ? ` (incl. ${num(ds.estimatedStopoutUsd).toFixed(2)} estimated for stop-outs not yet priced)` : ''}.` : null,
    lc && lc.floatingLoss != null ? `Floating loss now: ${lc.floatingLoss.toFixed(2)}.` : null,
    usedState !== 'measured' && lc?.reason ? `Loss-cap used not shown: ${lc.reason}.` : null,
    ds?.unitsNote || null,
    ds?.engineBlock?.reason ? `Engine verdict now: ${ds.engineBlock.reason}` : null,
  ].filter(Boolean).join(' ')
  return { capState: effectiveCapState, cap, capCcy, used, usedState, capLoss, unitsNote: ds?.unitsNote || null, title }
}

/**
 * The two phrases a card prints. `money(n, 0)` is the page's formatter.
 * @returns {{stop:string, used:string}}
 */
export function dailyStopWords(view, money) {
  const v = view || {}
  // A card built without the state fields (older callers, fixtures) is read
  // from its numbers: a cap is in force, a missing one is not read.
  const capState = v.capState ?? (v.cap != null ? 'in_force' : 'not_read')
  const usedState = v.usedState ?? (v.used != null ? 'measured' : 'not_read')
  const stop = capState === 'in_force' && v.cap != null
    ? `−${money(v.cap, 0)}${v.capCcy ? ` ${v.capCcy}` : ''}`
    : capState === 'uncapped' ? 'off (both checks off)' : 'not read'
  const used = usedState === 'measured' && v.used != null ? `${v.used}%`
    : usedState === 'not_comparable' ? 'not comparable'
      : usedState === 'uncapped' ? '—' : 'not read'
  // The engine's day is the FX day (17:00 New York), not the page's calendar
  // day — said beside a cap, and only beside one.
  const day = capState === 'in_force' && v.cap != null ? ' (FX day)' : ''
  return { stop, used, day }
}

/** The card's colour for loss-cap used — the page's existing thresholds. */
export function usedColour(used, { P_MU, P_DN, P_WRN, P_ACC }) {
  return used == null ? P_MU : used > 66 ? P_DN : used > 33 ? P_WRN : P_ACC
}

/**
 * The stop fields one Performance account card carries, from THAT account's
 * own /state/account-overview row. The row's `balance` and `dailyLossPct`
 * are deliberately not consulted: their product is the formula the engine
 * does not enforce, and a missing reading is "not read", not a fallback.
 *
 * @param {object|null|undefined} row  accounts[i] of /state/account-overview
 * @param {{P_MU:string, P_DN:string, P_WRN:string, P_ACC:string}} palette
 */
export function cardStopFields(row, palette) {
  const v = dailyStopView(row?.dailyStop)
  return {
    cap: v.cap, used: v.used, capState: v.capState, capCcy: v.capCcy, usedState: v.usedState,
    capLoss: v.capLoss, stopTitle: v.title, usedCol: usedColour(v.used, palette),
  }
}
