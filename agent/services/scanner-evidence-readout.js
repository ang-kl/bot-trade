// Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
// One opt-in projection of the real read routes. No registration, selection,
// broker refresh or candidate promotion; missing observation stays unknown.
import { createHash } from 'node:crypto'
import { buildScannerAlignmentSnapshot } from './scanner-alignment-snapshot.js'
import { scannerMirrorStatus } from './scanner-candidates.js'
import { NATIVE_DEFAULT_STRATEGIES } from './scanner-profiles.js'
import { registeredCalendarAccounts } from './watchdog-calendar-refresh.js'
import { SCANNER_PROFILE_LIMIT, SCANNER_REGISTRATION_BYTES } from '../lib/scanner-bounds.js'

const SOURCES = new Set(['cpp-scan-timeframe', 'cpp-scan-tick'])
const HOSTS = new Set(['demo.ctraderapi.com', 'live.ctraderapi.com'])
const STRATEGIES = new Set(['fib_618_fade', 'tick_momentum_breakout', ...NATIVE_DEFAULT_STRATEGIES])
const LIMITS = Object.freeze({ accounts: 64, profiles: SCANNER_PROFILE_LIMIT, cells: 256, groups: 64, feeds: 64, records: 640, bytes: 98304 })
const id = v => typeof v === 'string' && /^[1-9]\d{0,18}$/.test(v) ? v : null
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null
const bool = v => typeof v === 'boolean' ? v : null
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null
// Codex · №12,751 · 2026-10-10; codex-footprint: scanner-hash-contract.
// Tick registry/feed identities use profileHash()'s 16-hex prefix. Native
// timeframe profiles and registry/configuration digests retain full SHA256.
const tickHash = v => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v) ? v : null
const profileHashFor = (s, v) => s === 'cpp-scan-tick' ? tickHash(v) : s === 'cpp-scan-timeframe' ? hash(v) : null
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null
const host = v => HOSTS.has(v) ? v : null
const source = v => SOURCES.has(v) ? v : null
const strategy = v => STRATEGIES.has(v) ? v : null
const state = v => ['matched', 'account_profile_mismatch', 'no_timeframe_profiles', 'unavailable', 'observed', 'mirror'].includes(v) ? v : null
const fixedMissing = new Set(['registry_invalid', 'no_tick_feed_observed_in_five_minutes', 'timeframe_scanner_not_configured', 'timeframe_watchdog_incomplete'])
function missingReason(v) {
  if (fixedMissing.has(v)) return v
  if (typeof v !== 'string') return 'unclassified_missing_input'
  if (/^map_(missing|account_unnamed):\d{1,4}$/.test(v)) return v
  return v.startsWith('timeframe_watchdog_unreadable:') ? 'timeframe_watchdog_unreadable' : 'unclassified_missing_input'
}
function cellOf(p) {
  const cell = { source: source(p?.source), accountId: id(p?.feed?.accountId), host: host(p?.feed?.host), symbolId: id(p?.feed?.symbolId),
    timeframe: p?.timeframe == null ? null : typeof p.timeframe === 'string' && /^\d{1,4}(?:m|h|d|w|mo)$/.test(p.timeframe) ? p.timeframe : null,
    strategy: strategy(p?.strategy), profileHash: profileHashFor(p?.source, p?.profileHash),
    configVersionHash: typeof p?.configVersion === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(p.configVersion)
      ? createHash('sha256').update(p.configVersion).digest('hex') : null }
  return cell.source && cell.accountId && cell.host && cell.symbolId && cell.strategy && cell.profileHash && cell.configVersionHash
    && (cell.source === 'cpp-scan-tick' ? p.timeframe == null : cell.timeframe) ? cell : null
}
function coverageOf(c) {
  if (!c || typeof c !== 'object') return null
  return { status: state(c.status), accountId: id(c.accountId), host: host(c.host), registeredProfiles: integer(c.registeredProfiles),
    matchingProfiles: integer(c.matchingProfiles), observedAtMs: integer(c.observedAtMs) }
}

export async function readScannerEvidence(db, { now = Date.now(), env = process.env, fetchImpl = fetch, expiresAtMs = Infinity, clock = Date.now } = {}) {
  // Guard the existing route's in-memory projections before opening a large
  // state value. These indexed state reads never acquire a write transaction.
  const accounts = db.prepare('SELECT account_id FROM accounts ORDER BY account_id LIMIT ?').all(LIMITS.accounts + 1)
  const stateSize = db.prepare('SELECT length(value) n FROM agent_state WHERE key=?')
  const registryBytes = stateSize.get('scanner_mirror_profiles_json')?.n || 0
  const mapSizes = accounts.slice(0, LIMITS.accounts).map(a => stateSize.get(`symbol_id_map:${a.account_id}`)?.n || 0)
  if (accounts.length > LIMITS.accounts || registryBytes > SCANNER_REGISTRATION_BYTES
    || mapSizes.some(n => n > 2097152) || mapSizes.reduce((a, b) => a + b, 0) + registryBytes > 8388608)
    return { summary: { readAtMs: now, status: 'unavailable', reason: 'scanner_input_bound', orderAuthority: false, limits: LIMITS }, records: [] }
  const snapshot = await buildScannerAlignmentSnapshot(db, { now, env, fetchImpl: (url, options) => {
    if (clock() >= expiresAtMs) throw Error('scanner_evidence_expired')
    return fetchImpl(url, options)
  } })
  let mirrors = null
  try { mirrors = scannerMirrorStatus(db, { now }) } catch { /* named below, no raw error output */ }
  const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : []
  const groups = new Map(), cells = [], mappings = new Map(), records = []
  let invalidProfiles = 0, outputBytes = 0, omittedRecords = 0
  const add = (kind, value) => {
    const record = { kind, value }, bytes = Buffer.byteLength(JSON.stringify(record))
    if (records.length >= LIMITS.records || bytes > 12000 || outputBytes + bytes > LIMITS.bytes) { omittedRecords++; return }
    outputBytes += bytes; records.push(record)
  }
  for (const p of profiles.slice(0, LIMITS.profiles)) {
    const c = cellOf(p)
    if (!c) { invalidProfiles++; continue }
    const key = JSON.stringify([c.source, c.accountId, c.host])
    if (!groups.has(key)) groups.set(key, { source: c.source, accountId: c.accountId, host: c.host, profiles: 0 })
    groups.get(key).profiles++
    if (cells.length < LIMITS.cells) cells.push(c)
  }
  for (const g of [...groups.values()].slice(0, LIMITS.groups)) add('scanner-profile-group', g)
  const registered = registeredCalendarAccounts(db)
  for (const a of snapshot.accounts.slice(0, LIMITS.accounts)) {
    const accountId = id(a.account_id), map = snapshot.maps[accountId]
    const shape = !!map?.map && typeof map.map === 'object' && !Array.isArray(map.map)
    const own = accountId && map?.accountId === accountId && shape
    const status = !map ? 'map_missing' : !shape ? 'map_invalid' : !own ? 'map_account_conflict' : 'stored_account_map'
    add('scanner-account-map', { accountId, host: host(registered.get(accountId)?.host),
      status, mapAccountId: id(map?.accountId), builtAt: iso(map?.builtAt), complete: bool(map?.complete), sourceCount: integer(map?.sourceCount) })
    if (own) {
      const wanted = new Set(cells.filter(c => c.accountId === accountId).map(c => c.symbolId)), symbols = new Map()
      for (const [symbol, symbolId] of Object.entries(map.map)) {
        const sid = id(String(symbolId))
        if (!wanted.has(sid) || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(symbol)) continue
        if (!symbols.has(sid)) symbols.set(sid, { names: [], total: 0 })
        const row = symbols.get(sid); row.total++
        if (row.names.length < 4) row.names.push(symbol)
      }
      mappings.set(accountId, symbols)
    }
  }
  for (const f of snapshot.tickFeeds.slice(0, LIMITS.feeds)) add('scanner-tick-feed', { accountId: id(f.accountId), host: host(f.host),
    profileHash: tickHash(f.profileHash), observedAt: iso(f.observedAt) })
  for (const s of (mirrors?.sources || []).slice(0, 8)) add('scanner-source', { source: source(s.source),
    observedAtMs: integer(s.observed_at_ms), cursor: integer(s.cursor), gaps: integer(s.gaps), rejected: integer(s.rejected), lastErrorPresent: !!s.last_error })
  for (const c of (mirrors?.candidates || []).slice(0, LIMITS.groups)) add('scanner-candidates', { source: source(c.source), accountId: id(c.account_id),
    host: host(c.host), strategy: strategy(c.strategy), count: integer(c.count) })
  for (const c of cells) {
    const map = mappings.get(c.accountId), names = map?.get(c.symbolId)
    add('scanner-profile-cell', { ...c, symbolNames: names?.names || [], symbolNamesTruncated: (names?.total || 0) > 4,
      mappingStatus: !map ? 'map_unavailable_or_foreign' : !names ? 'symbol_unmapped' : 'stored_account_map' })
  }
  const missing = [...new Set(snapshot.missing.map(missingReason))]
  if (!mirrors) missing.push('mirror_read_failed')
  if (!mirrors?.bridge?.timeframeCoverage) missing.push('timeframe_coverage_not_recorded')
  if (!profiles.length) missing.push('no_registered_profiles')
  if (invalidProfiles) missing.push('invalid_profile_identity')
  const native = snapshot.nativeTimeframe
  const summary = { readAtMs: now, alignmentReadAt: iso(snapshot.readAt), status: missing.length ? 'incomplete' : 'observed', orderAuthority: false,
    revision: hash(snapshot.revision), selectedAccountId: id(snapshot.selected), registeredProfiles: profiles.length, invalidProfiles,
    groups: groups.size, cellsSelected: cells.length, cellsIncluded: records.filter(r => r.kind === 'scanner-profile-cell').length,
    profilesTruncated: profiles.length - invalidProfiles > records.filter(r => r.kind === 'scanner-profile-cell').length,
    groupsTruncated: groups.size > LIMITS.groups, feedsTruncated: snapshot.tickFeeds.length > LIMITS.feeds,
    candidateGroupsTruncated: (mirrors?.candidates?.length || 0) > LIMITS.groups,
    missing, limits: LIMITS, outputBytes, omittedRecords,
    nativeTimeframe: native ? { observedAt: iso(native.observedAt), cells: { count: integer(native.cells?.count), capacity: integer(native.cells?.capacity),
      stale: integer(native.cells?.stale) }, pending: integer(native.pending) } : null,
    mirrors: mirrors ? { observedAtMs: integer(mirrors.observedAtMs), status: state(mirrors.status), orderAuthority: mirrors.orderAuthority === false ? false : null,
      bridge: { enabled: bool(mirrors.bridge?.enabled), failed: bool(mirrors.bridge?.failed), pending: integer(mirrors.bridge?.pending),
        dropped: integer(mirrors.bridge?.dropped), timeframeCoverage: coverageOf(mirrors.bridge?.timeframeCoverage) },
      collector: { readAtMs: integer(mirrors.collector?.readAtMs), durationMs: integer(mirrors.collector?.durationMs),
        tickBacklog: bool(mirrors.collector?.tickBacklog), errorPresent: !!mirrors.collector?.error },
      comparisonStatus: state(mirrors.comparison?.status), comparisonRefusalsTruncated: bool(mirrors.comparison?.inputRefusedTruncated) } : null }
  return { summary, records }
}
