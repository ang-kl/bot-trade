// Shared time-formatting helpers.
//
// SQLite's default `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` (space
// separator, no timezone). Chrome and Firefox parse this leniently as local
// time; Safari rejects it with the exact error "The string did not match the
// expected pattern". `parseSqliteTs` normalises both SQLite and ISO shapes to
// a valid `Date`, returning `null` on anything unparseable so callers can
// render `"—"` instead of throwing.

const SQLITE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export function parseSqliteTs(ts) {
  if (ts == null || ts === '') return null
  if (typeof ts === 'number') {
    const d = new Date(ts)
    return Number.isFinite(d.getTime()) ? d : null
  }
  const s = typeof ts === 'string'
    ? (SQLITE_RE.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts)
    : ts
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d : null
}

const DEFAULT_FMT = {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  second: '2-digit', hour12: false,
}

export function fmtTime(ts, opts = DEFAULT_FMT) {
  const d = parseSqliteTs(ts)
  if (!d) return '—'
  try {
    return d.toLocaleString('en-GB', opts)
  } catch {
    return '—'
  }
}

export function fmtAgo(ts) {
  const d = parseSqliteTs(ts)
  if (!d) return ''
  const ago = Date.now() - d.getTime()
  if (ago < 0) return 'just now'
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
  if (ago < 86_400_000) {
    const h = Math.floor(ago / 3_600_000)
    const m = Math.floor((ago % 3_600_000) / 60_000)
    return `${h}h ${m}m ago`
  }
  return `${Math.floor(ago / 86_400_000)}d ago`
}
