import { getState } from '../db.js'

// A cached response belongs to exactly one account. Callers choose the age and
// currency requirements for their use; this reader neither refreshes the cache
// nor changes a risk policy. Broker money fields are already decoded by the
// snapshot producer and remain in the account's deposit currency.
export const RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

export function readAccountSnapshot(db, accountId, {
  nowMs = Date.now(),
  maxAgeMs = RISK_DISPLAY_SNAPSHOT_MAX_AGE_MS,
  expectedCurrency = null,
} = {}) {
  const id = accountId == null ? null : String(accountId)
  const result = {
    accountId: id, status: 'unavailable', reason: null,
    fetchedAt: null, ageMs: null, maxAgeMs, currency: null,
    snapshot: null,
  }
  const unavailable = (reason) => ({ ...result, reason })
  if (!id || !/^[1-9]\d*$/.test(id)) return unavailable('account_required')
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return unavailable('invalid_freshness_policy')
  }
  let raw
  try { raw = getState(db, `acct:${id}:broker_snapshot_cache_json`) }
  catch { return unavailable('snapshot_read_failed') }
  if (!raw) return unavailable('snapshot_missing')
  let snapshot
  try { snapshot = JSON.parse(raw) }
  catch { return unavailable('snapshot_malformed') }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || !snapshot.account || typeof snapshot.account !== 'object' || Array.isArray(snapshot.account)) {
    return unavailable('snapshot_malformed')
  }
  const account = snapshot.account
  if (String(account.accountId) !== id) return unavailable('account_mismatch')
  const currency = typeof account.currency === 'string' ? account.currency.trim().toUpperCase() : ''
  result.currency = /^[A-Z]{3}$/.test(currency) ? currency : null
  result.fetchedAt = typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : null
  // Reject zone-less/future dates instead of ageing them in the host's local
  // timezone or treating negative age as an especially fresh observation.
  const at = result.fetchedAt && /(?:Z|[+-]\d{2}:\d{2})$/i.test(result.fetchedAt)
    ? Date.parse(result.fetchedAt) : NaN
  if (!Number.isFinite(at)) return unavailable('snapshot_time_invalid')
  result.ageMs = nowMs - at
  if (result.ageMs < 0) return unavailable('snapshot_time_future')
  if (snapshot.error || account.error) return unavailable('snapshot_error')
  if (result.ageMs >= maxAgeMs) {
    return { ...result, status: 'stale', reason: 'snapshot_stale' }
  }
  if (expectedCurrency != null && result.currency !== expectedCurrency) {
    return unavailable(result.currency ? 'currency_mismatch' : 'currency_unknown')
  }
  return { ...result, status: 'fresh', snapshot }
}
