// The Hour column's two lines.
//
// Owner spec, 2026-07-31: SGT on top in 12-hour form (`5:45 AM`), UTC directly
// beneath in 24-hour form (`21:45 UTC`) two pixels smaller, and the local date
// in brackets — `(30 Jul)` — on the first row that belongs to an earlier local
// day, plus always on the oldest row so the window boundary is unambiguous.
//
// EVERYTHING GOES THROUGH Intl WITH AN EXPLICIT timeZone. Not
// `toLocaleTimeString([])`, which is what the FX-day version used: that follows
// whatever machine the browser is on, so the same table read differently in
// Singapore and in New York. And not a fixed +8 offset either — a hand-rolled
// offset is exactly what breaks on month ends, year ends, leap days and any
// future decision to make the primary zone one that observes DST. Asia/
// Singapore has no DST today; the code does not depend on that staying true.
const TZ = 'Asia/Singapore'

const cache = new Map()
function fmt(tz, opts) {
  const key = tz + JSON.stringify(opts)
  let f = cache.get(key)
  // Intl.DateTimeFormat construction is the expensive part and this runs for
  // 24 rows on every ten-minute tick.
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }); cache.set(key, f) }
  return f
}

/** '2026-07-30' in `tz` — the day-change key, not a display string. */
export function localDayKey(ms, tz = TZ) {
  const p = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))
  const get = t => p.find(x => x.type === t)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The two lines for one row.
 *
 * @returns {{local:string, utc:string, date:string, dayKey:string}}
 *   local '5:45 AM' · utc '21:45 UTC' · date '30 Jul' (caller decides whether
 *   to show it) · dayKey for comparing adjacent rows.
 */
export function hourLabel(ms, tz = TZ) {
  const d = new Date(ms)
  // en-US for h:mm AM/PM: en-GB gives 'am'/'pm' lowercase and would need
  // post-processing, which is how a stray locale bug gets in.
  const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    // Some ICU builds put U+202F (narrow no-break space) before AM/PM.
    // Normalise to a plain space so a test, a copy-paste and a screen reader
    // all see the same string. Escaped, not literal: a raw U+202F in source is
    // invisible in review and eslint rejects it outright.
    .replace(/[\u202f\u00a0]/g, ' ')
  const utc = fmt('UTC', { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  const date = fmt(tz, { day: 'numeric', month: 'short' }).format(d)
  return { local, utc: `${utc} UTC`, date, dayKey: localDayKey(ms, tz) }
}

/**
 * Which rows carry the bracketed date.
 *
 * Rule, in the owner's order: the FIRST row belonging to an earlier local day
 * (reading down from the newest), and ALWAYS the oldest row. Never row 1, and
 * never repeated on intermediate rows of the same day.
 *
 * @param {Array<{at:number}>} displayRows newest first
 * @returns {boolean[]} parallel to displayRows
 */
export function dateFlags(displayRows, tz = TZ) {
  if (!Array.isArray(displayRows) || !displayRows.length) return []
  const keys = displayRows.map(r => localDayKey(r.at, tz))
  return keys.map((k, i) => {
    if (i === keys.length - 1) return true       // the oldest row, always
    if (i === 0) return false                    // the NOW row never carries it
    return k !== keys[i - 1]                     // first row of an earlier day
  })
}
