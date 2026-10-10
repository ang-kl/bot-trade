// risk-format.js — how a risk setting's stored value is SHOWN.
//
// Claude · № 12,812 10-Oct (ordered № 12,810, owner "go ahead"; claude-builder).
// Moved out of RiskMatrix.jsx so the Risk page's override list and the
// summary table print one setting the same way. Display only: nothing here
// changes what is stored or what the gate reads.
//
// Two units live under the "…Pct" names, and the old one-regex formatter
// multiplied both by 100:
//   · fractions  — dailyLossPct 0.02 is 2%  (the Field edits them with `pct`)
//   · whole %    — marginLevelFloorPct 200 is 200%, minSLDistancePct 0.15 is
//                  0.15% of price (the Field shows them with unit="%")
// So the table printed "20000%" for a 200% margin-level floor and "15%" for a
// 0.15% minimum stop. maxPositionHeadroomShare is a fraction with no "Pct" in
// its name and printed raw (0.3333333333333333).

const WHOLE_PERCENT_KEYS = new Set(['marginLevelFloorPct', 'minSLDistancePct'])
const FRACTION_KEYS = /Pct$|FracOf|Share$|^marginRates\.|^commissionGate\.maxFracOfWin$/

/** A percentage with at most 2 decimals and no trailing zeros: 33.33%, 2%, 0.15%. */
function percent(n) {
  return `${Number(n.toFixed(2))}%`
}

/**
 * One stored value as text. `key` may be dotted (`derisk.triggerPct`) for a
 * field of an object-valued setting.
 */
export function showRiskValue(key, v) {
  if (v == null || v === '') return '—'
  if (Array.isArray(v)) return v.length ? `${v.length} listed` : 'none'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'object') return Object.entries(v).map(([f, x]) => `${f} ${showRiskValue(`${key}.${f}`, x)}`).join(' · ')
  if (typeof v === 'number') {
    const leaf = String(key).split('.').pop()
    if (WHOLE_PERCENT_KEYS.has(leaf) && !String(key).includes('.')) return percent(v)
    if (FRACTION_KEYS.test(key) || FRACTION_KEYS.test(leaf)) return percent(v * 100)
  }
  return String(v)
}

/** Deep equality for stored config values (numbers, strings, arrays, plain objects). */
export function sameRiskValue(a, b) {
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b))
}
function normal(v) {
  if (Array.isArray(v)) return v.map(normal)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, normal(v[k])]))
  return v === undefined ? null : v
}

/**
 * Split an account overlay into the keys that differ from the global value
 * and the keys pinned at the same value. Both are overrides — a pinned key
 * does not follow a later change to the global config — so neither list is
 * dropped; the page just says which is which.
 */
export function overlaySplit(overlayKeys, effective, global) {
  const differ = []
  const same = []
  for (const k of overlayKeys || []) {
    if (sameRiskValue(effective?.[k], global?.[k])) same.push(k)
    else differ.push(k)
  }
  return { differ, same }
}
