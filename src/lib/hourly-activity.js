import { openingEvidence } from './hourly-openings.js'
import { validActivitySplit } from './currency-money.js'
const count = n => Number.isSafeInteger(n) && n >= 0
export function activityEvidence(report, options) {
  const r = openingEvidence(report, options)
  if (!r || r.activityVersion !== 1 || ![r.closedN, r.pricedN, r.wins, r.unknownCloseTimeN].every(count)
    || r.pricedN > r.closedN || r.wins > r.pricedN || !Array.isArray(r.moneyByAccount)) return null
  if (r.rows.some(h => ![h.closedN, h.pricedN, h.wins].every(count) || h.pricedN > h.closedN
    || h.wins > h.pricedN || (h.net != null && !Number.isFinite(h.net)))) return null
  if (['closedN', 'pricedN', 'wins'].some(k => r.rows.reduce((n, h) => n + h[k], 0) !== r[k])) return null
  if (r.net != null && !Number.isFinite(r.net)) return null
  if (r.moneyByAccount.some(a => ![a.closedN, a.pricedN].every(count) || a.pricedN > a.closedN
    || (a.recordedNet != null && !Number.isFinite(a.recordedNet)))) return null
  // Per-currency money (V3 WEB-5): absent on an older server; when present it
  // must reconcile to the closes it splits, or the evidence is not shown.
  if (!validActivitySplit(r, r.closedN) || r.rows.some(h => !validActivitySplit(h, h.closedN))) return null
  return r
}

/** One displayed hour of the rolling 24-hour table from validated activity
 * evidence (null when unavailable). V3 WEB-3 adds the server's observed broker
 * balances at the hour's edges and the hour's last floating reading; a value
 * the server did not observe stays null, never zero. */
export function hourRowEvidence(openings, slot) {
  const row = openings?.rows.find(r => r.from === slot.from && r.to === slot.to)
  const finiteOrNull = v => typeof v === 'number' && Number.isFinite(v) ? v : null
  return { net: row?.net ?? null, closedN: row?.closedN ?? null,
    openBal: finiteOrNull(row?.openBal), closeBal: finiteOrNull(row?.closeBal), balance: row?.balance ?? null,
    openedN: row?.openedN ?? null, unknownOpeningTimeN: openings?.unknownTimeN ?? 0,
    unknownCloseTimeN: openings?.unknownCloseTimeN ?? 0,
    incompleteOpeningWindow: Boolean(row && row.to > openings.observedThrough) }
}
