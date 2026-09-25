// V3 WEB-4: what the readings table says about the SERVER's own broker read
// (GET /state/account-overview → serverReadings; agent/services/
// broker-readings.js). The server reads every account once a minute; the page
// only reads the cache. Returns null when there is nothing to warn about, or
// when an older agent sends no field at all (each row still shows its own
// receipt time and status, so nothing is claimed either way).
const words = s => String(s).replaceAll('_', ' ')

export function serverReadingsNotice(r, { timeText = ms => new Date(ms).toLocaleTimeString() } = {}) {
  if (!r || typeof r !== 'object') return null
  const atMs = typeof r.at === 'string' ? Date.parse(r.at) : NaN
  const last = Number.isFinite(atMs) ? `last completed round ${timeText(atMs)}` : 'no completed round recorded'
  const reason = typeof r.reason === 'string' && r.reason ? words(r.reason) : null
  if (r.status === 'no_record') return 'The server has not recorded an account reading yet. Each row shows its own receipt time.'
  if (!r.fresh) return `Server account readings are out of date (${last}${reason ? `; latest attempt: ${reason}` : ''}). Rows past their limit show as stale.`
  if (r.status === 'failed') return `The latest server reading failed (${reason ?? 'no reason recorded'}); ${last}.`
  if (r.status === 'partial') {
    const failed = Array.isArray(r.failed) ? r.failed.map(f => `${f.accountId}${f.reason ? ` (${words(f.reason)})` : ''}`) : []
    const missing = Array.isArray(r.missing) ? r.missing.map(id => `${id} (not on the broker token)`) : []
    const names = [...failed, ...missing]
    return `The latest server reading did not read ${names.length} account${names.length === 1 ? '' : 's'}: ${names.join(', ')}; ${last}.`
  }
  if (r.status === 'success') return null
  return `Server reading status unrecognised; ${last}.`
}
