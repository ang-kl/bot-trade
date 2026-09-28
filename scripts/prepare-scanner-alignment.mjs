#!/usr/bin/env node
// Version 1 - 2026-09-28. Offline review package only: no network, production
// database, account-selection action or deployment operation is implemented.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initDB, setState } from '../agent/db.js'
import { ACCOUNT_SYMBOL_MAP_TTL_MS } from '../agent/lib/ctrader-creds.js'
import { registeredCalendarAccounts } from '../agent/services/watchdog-calendar-refresh.js'
import { scannerProfileRegistry, registerScannerProfiles, SCANNER_PROFILE_LIMIT, SCANNER_REGISTRATION_BYTES } from '../agent/services/scanner-profile-registry.js'

const MAX_AGE_MS = 300000
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const digest = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const bodyDigest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex')
const fail = message => { throw new Error(message) }
const fresh = (stamp, now) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))
  && Date.parse(stamp) <= now && now - Date.parse(stamp) <= MAX_AGE_MS
const identity = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
const validId = value => identity(String(value)) && (typeof value === 'string' || Number.isSafeInteger(value))

function nativeCapacity(observation, required, now) {
  const c = observation?.cells
  if (!observation || !fresh(observation.observedAt, now)) return { ready: false, reason: 'native_watchdog_missing_or_stale', required }
  if (!c || c.capacity !== SCANNER_PROFILE_LIMIT || ![c.count, c.stale, observation.pending].every(Number.isSafeInteger)
    || c.count < 0 || c.count > c.capacity || c.stale < 0 || c.stale > c.count || observation.pending !== 0) {
    return { ready: false, reason: 'native_capacity_or_pending_invalid', required }
  }
  const available = c.capacity - c.count + c.stale
  return { ready: available >= required, reason: available >= required ? 'free_plus_idle_stale_cells_sufficient' : 'native_capacity_insufficient',
    required, available, existing: c.count, stale: c.stale, capacity: c.capacity,
    note: 'Registration does not delete native cells; only idle cells unoffered for one hour can be evicted. Recheck after bridge pause.' }
}

function memoryRegistry(snapshot, prepare) {
  const db = initDB(':memory:')
  try {
    for (const a of snapshot.accounts) db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,?)').run(a.account_id, a.is_live)
    for (const [id, map] of Object.entries(snapshot.maps)) setState(db, `symbol_id_map:${id}`, JSON.stringify(map))
    setState(db, 'ctrader_account_id', snapshot.selected)
    // Sentinel settings live only in this memory database. Their unchanged
    // readback makes the no-account/no-entry assertion a checked property.
    setState(db, 'autotrade_enabled', '1')
    const authorityState = () => digest({
      accounts: db.prepare('SELECT * FROM accounts ORDER BY account_id').all(),
      state: db.prepare("SELECT key,value FROM agent_state WHERE key != 'scanner_mirror_profiles_json' ORDER BY key").all(),
      entries: db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n,
      trades: db.prepare('SELECT COUNT(*) n FROM trades').get().n,
    })
    const authorityBefore = authorityState()
    const accounts = new Map([...registeredCalendarAccounts(db)].map(([id, account]) => [id, account.host]))
    const result = prepare(accounts), { proposal, rollback } = result
    const original = registerScannerProfiles(db, { expectedRevision: scannerProfileRegistry(db).revision, profiles: snapshot.profiles }, { env: {} })
    if (original.revision !== proposal.expectedRevision) fail('original_registry_revision_mismatch')
    const installed = registerScannerProfiles(db, proposal, { env: {} })
    if (installed.orderAuthority !== false || installed.revision !== rollback.expectedRevision) fail('proposal_registry_mismatch')
    if (authorityState() !== authorityBefore) fail('registry_changed_account_or_entry_authority')
    for (const [input, env, expected] of [
      [proposal, {}, 'profile_revision_conflict'],
      [rollback, { SCANNER_BRIDGE_ENABLED: '1' }, 'stop_observation_bridge_before_profile_change'],
    ]) {
      let refused = false
      try { registerScannerProfiles(db, input, { env }) } catch (e) { if (e.message !== expected) throw e; refused = true }
      if (!refused || scannerProfileRegistry(db).revision !== installed.revision) fail('registry_guard_failed')
    }
    const restored = registerScannerProfiles(db, rollback, { env: {} })
    if (restored.revision !== original.revision || digest(restored.profiles) !== digest(snapshot.profiles)) fail('rollback_mismatch')
    if (authorityState() !== authorityBefore) fail('rollback_changed_account_or_entry_authority')
    return result
  } finally { db.close() }
}

/** A current, explicitly scoped proposal. Unknown identities fail closed;
 * missing native capacity blocks application while leaving a reviewable draft.
 * Never pass a database connection: only an explicit non-secret JSON snapshot.
 */
export function prepareScannerAlignment(snapshot, plan, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || !fresh(snapshot?.readAt, now)) fail('snapshot_stale_or_invalid')
  if (!Array.isArray(snapshot.profiles) || snapshot.profiles.length > SCANNER_PROFILE_LIMIT) fail('registration_bound')
  if (digest(snapshot.profiles) !== snapshot.revision || snapshot.revision !== plan?.expectedRevision) fail('source_revision_mismatch')
  if (!identity(plan.selectedAccountId) || snapshot.selected !== plan.selectedAccountId) fail('selected_account_mismatch')
  if (!Array.isArray(snapshot.accounts) || !snapshot.maps || !Array.isArray(snapshot.tickFeeds)
    || !Array.isArray(snapshot.universe) || snapshot.universe.some(s => typeof s !== 'string' || !s)) fail('snapshot_fields_invalid')
  if (!Array.isArray(plan.tickMoves) || !plan.tickMoves.length || !plan.timeframeMove
    || Object.keys(plan).some(k => !['expectedRevision', 'selectedAccountId', 'tickMoves', 'timeframeMove'].includes(k))) fail('plan_fields_invalid')
  const accountIds = new Set()
  for (const a of snapshot.accounts) {
    if (!identity(a.account_id) || ![0, 1].includes(a.is_live) || accountIds.has(a.account_id)) fail('account_registry_invalid')
    accountIds.add(a.account_id)
  }
  return memoryRegistry(snapshot, accounts => prepareProfiles(snapshot, plan, now, accounts))
}

function prepareProfiles(snapshot, plan, now, accounts) {
  const ownMap = id => {
    if (!identity(id) || !accounts.has(id)) fail('account_missing')
    const entry = snapshot.maps[id]
    if (!entry || String(entry.accountId) !== id || !entry.map || Array.isArray(entry.map)
      || typeof entry.map !== 'object' || !Object.values(entry.map).every(validId)) fail('map_account_or_values_invalid')
    const built = typeof entry.builtAt === 'string' ? Date.parse(entry.builtAt) : NaN
    if (!Number.isFinite(built) || built > now || now - built >= ACCOUNT_SYMBOL_MAP_TTL_MS) fail('map_stale_or_invalid')
    return entry.map
  }
  const moves = [], tickAdditions = [], seenMoves = new Set()
  const remap = (p, move) => {
    const from = ownMap(move.fromAccountId), to = ownMap(move.toAccountId)
    if (accounts.get(move.fromAccountId) !== accounts.get(move.toAccountId)) fail('cross_host_move_refused')
    if (p.feed.accountId !== move.fromAccountId || p.feed.host !== accounts.get(move.fromAccountId)) fail('source_feed_mismatch')
    const names = Object.keys(from).filter(n => String(from[n]) === p.feed.symbolId)
    if (names.length !== 1) fail('source_symbol_ambiguous_or_missing')
    const name = names[0]
    if (!Object.hasOwn(to, name)) fail(`target_symbol_missing:${name}`)
    const targetId = String(to[name])
    if (Object.keys(to).filter(n => String(to[n]) === targetId).length !== 1) fail(`target_symbol_ambiguous:${name}`)
    const next = { ...structuredClone(p), feed: { provider: 'ctrader', host: accounts.get(move.toAccountId), accountId: move.toAccountId, symbolId: targetId } }
    moves.push({ source: p.source, name, from: p.feed, to: next.feed, strategy: p.strategy, timeframe: p.timeframe ?? null })
    return next
  }
  const checkMove = move => {
    if (!move || Object.keys(move).sort().join(',') !== 'fromAccountId,toAccountId'
      || move.fromAccountId === move.toAccountId) fail('move_fields_invalid')
    ownMap(move.fromAccountId); ownMap(move.toAccountId)
  }
  for (const move of plan.tickMoves) {
    checkMove(move)
    if (seenMoves.has(move.toAccountId)) fail('duplicate_tick_move')
    seenMoves.add(move.toAccountId)
    const feeds = snapshot.tickFeeds.filter(f => f.accountId === move.toAccountId && f.host === accounts.get(move.toAccountId))
    if (feeds.length !== 1) fail('observed_tick_feed_required')
    if (!fresh(feeds[0].observedAt, now)) fail('feed_stale_or_invalid')
    const templates = snapshot.profiles.filter(p => p.source === 'cpp-scan-tick' && p.feed?.accountId === move.fromAccountId)
    if (!templates.length) fail('tick_population_missing')
    for (const p of templates) {
      if (p.profileHash !== feeds[0].profileHash) fail('observed_tick_profile_mismatch')
      tickAdditions.push(remap(p, move))
    }
  }
  checkMove(plan.timeframeMove)
  if (plan.timeframeMove.toAccountId !== plan.selectedAccountId) fail('timeframe_selected_account_mismatch')
  const timeframes = snapshot.profiles.filter(p => p.source === 'cpp-scan-timeframe')
  if (!timeframes.length || timeframes.some(p => p.feed?.accountId !== plan.timeframeMove.fromAccountId)) fail('timeframe_population_not_exact')
  const replacements = timeframes.map(p => remap(p, plan.timeframeMove))
  let at = 0
  const profiles = snapshot.profiles.map(p => p.source === 'cpp-scan-timeframe' ? replacements[at++] : structuredClone(p)).concat(tickAdditions)
  const proposal = { expectedRevision: snapshot.revision, profiles }
  const rollback = { expectedRevision: digest(profiles), profiles: structuredClone(snapshot.profiles) }
  if (profiles.length > SCANNER_PROFILE_LIMIT || [proposal, rollback].some(x => Buffer.byteLength(JSON.stringify(x)) > SCANNER_REGISTRATION_BYTES)) fail('registration_bound')
  const capacity = nativeCapacity(snapshot.nativeTimeframe, replacements.length, now)
  const targetAccounts = [...new Set([...plan.tickMoves.map(m => m.toAccountId), plan.timeframeMove.toAccountId])]
  const population = (source, accountId) => {
    const map = ownMap(accountId)
    const cells = profiles.filter(p => p.source === source && p.feed.accountId === accountId)
    const ids = new Set(cells.map(p => p.feed.symbolId))
    return { source, accountId, profiles: cells.length, symbols: ids.size,
      mappedUniverseWithoutProfile: [...new Set(snapshot.universe)].filter(name => Object.hasOwn(map, name) && !ids.has(String(map[name]))) }
  }
  const coverage = [...plan.tickMoves.map(m => population('cpp-scan-tick', m.toAccountId)), population('cpp-scan-timeframe', plan.timeframeMove.toAccountId)]
  return { version: 1, preparedAt: new Date(now).toISOString(), sourceReadAt: snapshot.readAt, proposal, rollback,
    evidence: { applied: false, registryRoundTrip: true, registryRoundTripScope: 'in_memory_database_only',
      orderAuthority: false, accountSelectionChanged: false,
      originalCount: snapshot.profiles.length, proposedCount: profiles.length,
      originalTickProfilesPreserved: snapshot.profiles.filter(p => p.source === 'cpp-scan-tick').length,
      tickProfilesAdded: tickAdditions.length, timeframeProfilesReplaced: replacements.length,
      previousRevision: snapshot.revision, proposedRevision: rollback.expectedRevision,
      proposalSha256: bodyDigest(proposal), rollbackSha256: bodyDigest(rollback),
      proposalBytes: Buffer.byteLength(JSON.stringify(proposal)), rollbackBytes: Buffer.byteLength(JSON.stringify(rollback)),
      limitBytes: SCANNER_REGISTRATION_BYTES, limitCount: SCANNER_PROFILE_LIMIT,
      mapEvidence: Object.fromEntries([...new Set(moves.flatMap(m => [m.from.accountId, m.to.accountId]))].map(id => [id,
        { builtAt: snapshot.maps[id].builtAt, digest: digest(snapshot.maps[id]), symbols: Object.keys(snapshot.maps[id].map).length,
          complete: snapshot.maps[id].complete ?? null, sourceCount: snapshot.maps[id].sourceCount ?? null }])),
      unresolvedUniverse: Object.fromEntries(targetAccounts.map(id => [id, [...new Set(snapshot.universe)].filter(name => !Object.hasOwn(ownMap(id), name))])),
      coverage,
      identityChanges: moves, nativeCapacity: capacity, applicationBlockers: capacity.ready ? [] : [capacity.reason],
      rollbackPreflight: { nativeRestorationVerified: false, requiredCells: timeframes.length, requiresFreshCapacityCheck: true,
        ifInsufficient: 'wait_until_unwanted_cells_idle_and_stale_or_separately_approved_native_restart', automaticRestart: false },
      applicationRequires: ['Explicit approval of this replacement and bridge pause/restore', 'Fresh registry, selected-account, feed, map and native-capacity readback',
        'Bridge OFF before compare-and-set and rollback',
        'Rollback requires fresh native-capacity preflight after bridge pause; registry restoration alone does not restore evicted native cells',
        'If rollback capacity is insufficient, wait until unwanted cells are idle and stale or obtain separately approved native restart; never restart automatically',
        'No account-selection or trading changes'] } }
}

function main(args) {
  const options = new Map()
  if (args.length !== 6) fail('Usage: node scripts/prepare-scanner-alignment.mjs --snapshot FILE --plan FILE --out-dir EXISTING_PRIVATE_DIR')
  for (let i = 0; i < args.length; i += 2) {
    if (!['--snapshot', '--plan', '--out-dir'].includes(args[i]) || options.has(args[i])) fail('invalid_arguments')
    options.set(args[i], args[i + 1])
  }
  const read = path => {
    const bytes = readFileSync(path)
    if (bytes.length > 4 * 1024 * 1024) fail('input_file_bound')
    return JSON.parse(bytes.toString('utf8'))
  }
  const result = prepareScannerAlignment(read(options.get('--snapshot')), read(options.get('--plan')))
  const output = [['scanner-proposal.json', result.proposal], ['scanner-rollback.json', result.rollback],
    ['scanner-evidence.json', { version: result.version, preparedAt: result.preparedAt, sourceReadAt: result.sourceReadAt, ...result.evidence }]]
  for (const [name] of output) if (existsSync(join(options.get('--out-dir'), name))) fail('output_exists')
  for (const [name, value] of output) writeFileSync(join(options.get('--out-dir'), name),
    JSON.stringify(value) + (name === 'scanner-evidence.json' ? '\n' : ''), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ applied: false, proposedCount: result.proposal.profiles.length, proposedRevision: result.rollback.expectedRevision,
    applicationBlockers: result.evidence.applicationBlockers }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
