import { createHash } from 'node:crypto'
import { getState, setState } from '../db.js'
import { credsForRegisteredAccount, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { DEFAULT_PARAMS, profileHash } from '../lib/tick-strategy.js'
import { tfMs } from '../lib/timeframes.js'
import { nativeProfileHash } from './scanner-profiles.js'
import { SCANNER_PROFILE_LIMIT, SCANNER_REGISTRATION_BYTES } from '../lib/scanner-bounds.js'
export { SCANNER_PROFILE_LIMIT, SCANNER_REGISTRATION_BYTES }
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => allowed.includes(k))
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi
export function scannerProfileRegistry(db) {
  const raw = getState(db, 'scanner_mirror_profiles_json')
  let profiles = []; try { profiles = JSON.parse(raw || '[]') } catch { return { valid: false, revision: digest(raw), profiles: [], orderAuthority: false } }
  if (!Array.isArray(profiles) || profiles.length > SCANNER_PROFILE_LIMIT) return { valid: false, revision: digest(raw), profiles: [], orderAuthority: false }
  return { valid: true, revision: digest(profiles), profiles, orderAuthority: false }
}
function validate(db, p) {
  if (!fields(p, ['source', 'feed', 'strategy', 'configVersion', 'profileHash', 'candidateTtlMs', 'timeframe', 'options', 'profile'])) fail('profile_fields_invalid')
  const feed = marketIdentity(p.feed)
  if (!feed || Object.keys(p.feed).sort().join(',') !== 'accountId,host,provider,symbolId' || typeof p.feed.accountId !== 'string' || typeof p.feed.symbolId !== 'string') fail('feed_identity_invalid')
  const c = credsForRegisteredAccount(db, feed.accountId), map = getAccountSymbolMap(db, feed.accountId)?.map
  if (!c || c.host !== feed.host || !map || !Object.values(map).some(id => String(id) === feed.symbolId)) fail('registered_account_feed_required')
  if (typeof p.configVersion !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(p.configVersion) || !integer(p.candidateTtlMs, 1, 3600000)) fail('profile_version_or_ttl_invalid')
  if (p.source === 'cpp-scan-tick') {
    if (p.strategy !== 'tick_momentum_breakout' || p.timeframe != null || p.options != null
      || !fields(p.profile, Object.keys(DEFAULT_PARAMS)) || Object.keys(p.profile).length !== Object.keys(DEFAULT_PARAMS).length) fail('tick_profile_required')
    const ranges = { rangeEvents: [2,4096], momentumEvents: [1,4096], confirmations: [1,1024], minStopPrice: [1,1e9], priceIncrement: [1,1e9], maxSpread: [1,1e9], maxQuoteAgeMs: [1,3600000], expiryEvents: [1,1e6], rearmCooldownEvents: [0,1e6] }
    if (Object.entries(ranges).some(([k, [lo, hi]]) => !integer(p.profile[k], lo, hi))) fail('tick_profile_bounds')
    for (const [k, hi] of [['minEfficiency',1],['spreadBufferMult',100],['stopVolMult',100]]) if (typeof p.profile[k] !== 'number' || !Number.isFinite(p.profile[k]) || p.profile[k] < 0 || p.profile[k] > hi) fail('tick_profile_bounds')
    if (p.profileHash !== profileHash(p.profile)) fail('profile_hash_mismatch')
  } else if (p.source === 'cpp-scan-timeframe') {
    if (p.profile != null || typeof p.timeframe !== 'string' || !tfMs(p.timeframe)) fail('closed_timeframe_required')
    const expected = nativeProfileHash(p.strategy, p.options ?? {})
    if (!expected || p.profileHash !== expected) fail('unsupported_or_mismatched_native_profile')
  } else fail('scanner_source_invalid')
  return canonical({ ...p, feed })
}
export function registerScannerProfiles(db, input, { env = process.env, now = Date.now() } = {}) {
  if (env.SCANNER_BRIDGE_ENABLED === '1') fail('stop_observation_bridge_before_profile_change', 409)
  // Over HTTP the scoped parser (index.js, same byte limit on the raw body)
  // refuses an oversized body first; this byte check is for direct callers.
  // The profile count bound is reachable over HTTP (1025 small profiles).
  if (!fields(input, ['expectedRevision', 'profiles']) || !Array.isArray(input.profiles) || input.profiles.length > SCANNER_PROFILE_LIMIT
    || Buffer.byteLength(JSON.stringify(input)) > SCANNER_REGISTRATION_BYTES) fail('registration_bound')
  const profiles = input.profiles.map(p => validate(db, p)), unique = new Set()
  for (const p of profiles) {
    const key = JSON.stringify([p.source, marketIdentityKey(p.feed), p.strategy, p.timeframe || ''])
    if (unique.has(key)) fail('duplicate_comparison_identity')
    unique.add(key)
  }
  return db.transaction(() => {
    const previous = scannerProfileRegistry(db)
    if (input.expectedRevision !== previous.revision) fail('profile_revision_conflict', 409)
    setState(db, 'scanner_mirror_profiles_json', JSON.stringify(profiles))
    const next = scannerProfileRegistry(db)
    db.prepare('INSERT INTO action_log(method,path,body) VALUES(?,?,?)').run('AUDIT', '/actions/scanner-profiles', JSON.stringify({ at: new Date(now).toISOString(), previousRevision: previous.revision, revision: next.revision, count: profiles.length, orderAuthority: false }))
    return next
  }).immediate()
}
