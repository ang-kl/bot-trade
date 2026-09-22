import { openingEvidence } from './hourly-openings.js'
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
  return r
}
