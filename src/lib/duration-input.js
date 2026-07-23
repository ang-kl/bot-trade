// Free-text duration parsing for risk-config fields like "Streak cooldown"
// (owner: "can I type 5m = 5 minutes, 5s = 5 seconds, 5h = 5 hours"). The
// underlying config field is always stored/consumed as MINUTES (possibly
// fractional — risk.js just does `cooldownMinutes * 60_000`), so a bare
// number keeps meaning minutes for back-compat; a unit suffix overrides it.

/** Parse "5m" / "30s" / "2h" / "5" (bare = minutes) / "off" -> minutes, or
 *  null when the input can't be parsed at all. */
export function parseDurationToMinutes(input) {
  const s = String(input ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'off') return 0
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n < 0) return null
  const unit = m[2] || 'm'
  if (unit === 's') return n / 60
  if (unit === 'h') return n * 60
  return n
}

/** Reverse of the above, for an input's initial/reset display — picks
 *  seconds/hours when that renders as a whole number, else plain minutes. */
export function formatMinutesShort(mins) {
  const n = Number(mins)
  if (mins == null || !Number.isFinite(n)) return ''
  if (n === 0) return 'off'
  if (n < 1) return `${Math.round(n * 60)}s`
  if (n >= 60 && n % 60 === 0) return `${n / 60}h`
  return `${n}m`
}
