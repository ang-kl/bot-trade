import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DEFAULT_PARAMS, profileHash } from '../lib/tick-strategy.js'
import { ACCOUNT_SYMBOL_MAP_TTL_MS } from '../lib/ctrader-creds.js'
import { nativeProfileHash } from './scanner-profiles.js'
import { prepareScannerAlignment } from '../../scripts/prepare-scanner-alignment.mjs'
import { tempDir } from '../test-support/temp-dir.js'

const NOW = Date.parse('2026-09-28T01:00:00Z')
const stamp = new Date(NOW).toISOString()
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const digest = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const host = 'demo.ctraderapi.com'
const feed = (accountId, symbolId) => ({ provider: 'ctrader', host, accountId, symbolId })
const tick = (accountId, symbolId) => ({ source: 'cpp-scan-tick', feed: feed(accountId, symbolId),
  strategy: 'tick_momentum_breakout', configVersion: 'tick-v1', candidateTtlMs: 5000,
  profile: { ...DEFAULT_PARAMS }, profileHash: profileHash(DEFAULT_PARAMS) })
const timeframe = (accountId, symbolId) => ({ source: 'cpp-scan-timeframe', feed: feed(accountId, symbolId),
  strategy: 'donchian_breakout', timeframe: '5m', options: {}, configVersion: 'tf-v1',
  candidateTtlMs: 300000, profileHash: nativeProfileHash('donchian_breakout') })

function fixture() {
  // Target IDs deliberately differ. A copied numeric ID would identify a
  // different target instrument and must never become a plausible proposal.
  const profiles = [tick('11', '7'), tick('11', '8'), timeframe('11', '7'), timeframe('11', '8')]
  const revision = digest(profiles)
  return {
    snapshot: { readAt: stamp, revision, profiles, selected: '22',
      accounts: [{ account_id: '11', is_live: 0 }, { account_id: '22', is_live: 0 }],
      maps: { '11': { accountId: '11', builtAt: stamp, map: { EURUSD: 7, GBPUSD: 8 } },
        '22': { accountId: '22', builtAt: stamp, map: { EURUSD: 70, GBPUSD: 80, OTHER: 7 } } },
      tickFeeds: [{ accountId: '22', host, profileHash: profileHash(DEFAULT_PARAMS), observedAt: stamp }],
      universe: ['EURUSD', 'GBPUSD', 'USOIL'],
      nativeTimeframe: { observedAt: stamp, cells: { count: 690, capacity: 1024, stale: 690 }, pending: 0 } },
    plan: { expectedRevision: revision, selectedAccountId: '22',
      tickMoves: [{ fromAccountId: '11', toAccountId: '22' }],
      timeframeMove: { fromAccountId: '11', toAccountId: '22' } },
  }
}

test('proposal keeps old ticks, maps names to exact target IDs, replaces timeframe cohort and proves exact rollback', () => {
  const { snapshot, plan } = fixture(), before = structuredClone(snapshot)
  const r = prepareScannerAlignment(snapshot, plan, { now: NOW })
  assert.deepEqual(snapshot, before, 'the input and original rollback must remain immutable')
  assert.deepEqual(r.rollback.profiles, before.profiles)
  assert.equal(r.proposal.expectedRevision, snapshot.revision)
  assert.equal(r.rollback.expectedRevision, digest(r.proposal.profiles))
  const ticks = r.proposal.profiles.filter(p => p.source === 'cpp-scan-tick')
  const bars = r.proposal.profiles.filter(p => p.source === 'cpp-scan-timeframe')
  assert.deepEqual(ticks.slice(0, 2), snapshot.profiles.slice(0, 2))
  assert.deepEqual(ticks.slice(2).map(p => p.feed.symbolId), ['70', '80'])
  assert.deepEqual(bars.map(p => p.feed), [feed('22', '70'), feed('22', '80')])
  assert.deepEqual(bars.map(p => ({ ...p, feed: null })), snapshot.profiles.slice(2).map(p => ({ ...p, feed: null })))
  assert.equal(r.evidence.registryRoundTrip, true)
  assert.equal(r.evidence.registryRoundTripScope, 'in_memory_database_only')
  assert.deepEqual(r.evidence.rollbackPreflight, {
    nativeRestorationVerified: false, requiredCells: 2, requiresFreshCapacityCheck: true,
    ifInsufficient: 'wait_until_unwanted_cells_idle_and_stale_or_separately_approved_native_restart',
    automaticRestart: false,
  })
  assert.ok(r.evidence.applicationRequires.includes('Rollback requires fresh native-capacity preflight after bridge pause; registry restoration alone does not restore evicted native cells'))
  assert.equal(r.evidence.orderAuthority, false)
  assert.equal(r.evidence.accountSelectionChanged, false)
  assert.equal(r.evidence.originalTickProfilesPreserved, 2)
  assert.equal(r.evidence.timeframeProfilesReplaced, 2)
  assert.deepEqual(r.evidence.unresolvedUniverse['22'], ['USOIL'])
  assert.deepEqual(r.evidence.coverage.map(c => c.mappedUniverseWithoutProfile), [[], []])
  assert.equal(r.evidence.nativeCapacity.ready, true)
})

test('source revision, selected account, snapshot and feed observations must match freshly', () => {
  for (const [name, mutate, pattern] of [
    ['revision', (s, p) => { p.expectedRevision = 'stale' }, /revision/],
    ['snapshot digest', s => { s.revision = 'invented' }, /revision/],
    ['selection', s => { s.selected = '11' }, /selected_account/],
    ['old snapshot', s => { s.readAt = new Date(NOW - 300001).toISOString() }, /snapshot_stale/],
    ['future snapshot', s => { s.readAt = new Date(NOW + 1).toISOString() }, /snapshot_stale/],
    ['old feed', s => { s.tickFeeds[0].observedAt = new Date(NOW - 300001).toISOString() }, /feed_stale/],
    ['feed account', s => { s.tickFeeds[0].accountId = '11' }, /observed_tick_feed/],
    ['feed profile', s => { s.tickFeeds[0].profileHash = 'invented' }, /tick_profile/],
    ['feed host', s => { s.tickFeeds[0].host = 'live.ctraderapi.com' }, /observed_tick_feed/],
  ]) {
    const { snapshot, plan } = fixture(); mutate(snapshot, plan)
    assert.throws(() => prepareScannerAlignment(snapshot, plan, { now: NOW }), pattern, name)
  }
})

test('missing, ambiguous, colliding or cross-account symbol maps fail without producing aliases', () => {
  for (const [name, mutate, pattern] of [
    ['missing target name', s => { delete s.maps['22'].map.EURUSD }, /target_symbol_missing/],
    ['missing original ID', s => { delete s.maps['11'].map.EURUSD }, /source_symbol_ambiguous/],
    ['ambiguous original ID', s => { s.maps['11'].map.ALIAS = 7 }, /source_symbol_ambiguous/],
    ['ambiguous target ID', s => { s.maps['22'].map.ALIAS = 70 }, /target_symbol_ambiguous/],
    ['colliding target IDs', s => { s.maps['22'].map.GBPUSD = 70 }, /target_symbol_ambiguous/],
    ['wrong map owner', s => { s.maps['22'].accountId = '11' }, /map_account/],
    ['wrong account host', s => { s.accounts[1].is_live = 1 }, /observed_tick_feed/],
    ['unknown target account', s => { s.accounts.pop() }, /account_missing/],
  ]) {
    const { snapshot, plan } = fixture(); mutate(snapshot, plan)
    assert.throws(() => prepareScannerAlignment(snapshot, plan, { now: NOW }), pattern, name)
  }
})

test('actual registry rejects invalid strategy hash and duplicate target comparison identities', () => {
  const { snapshot, plan } = fixture()
  snapshot.profiles[2].profileHash = 'invented'
  snapshot.revision = plan.expectedRevision = digest(snapshot.profiles)
  assert.throws(() => prepareScannerAlignment(snapshot, plan, { now: NOW }), /mismatched_native_profile/)
  const pair = fixture()
  pair.plan.tickMoves.push({ ...pair.plan.tickMoves[0] })
  assert.throws(() => prepareScannerAlignment(pair.snapshot, pair.plan, { now: NOW }), /duplicate/)
  const cross = fixture()
  cross.snapshot.accounts[1].is_live = 1
  cross.snapshot.tickFeeds[0].host = 'live.ctraderapi.com'
  assert.throws(() => prepareScannerAlignment(cross.snapshot, cross.plan, { now: NOW }), /cross_host_move/)
})

test('native capacity is a separate fail-closed application gate, including stale or missing watchdog evidence', () => {
  for (const native of [null,
    { observedAt: stamp, cells: { count: 1024, capacity: 1024, stale: 1 }, pending: 0 },
    { observedAt: new Date(NOW - 300001).toISOString(), cells: { count: 0, capacity: 1024, stale: 0 }, pending: 0 },
    { observedAt: stamp, cells: { count: 690, capacity: 512, stale: 690 }, pending: 0 },
  ]) {
    const { snapshot, plan } = fixture(); snapshot.nativeTimeframe = native
    const r = prepareScannerAlignment(snapshot, plan, { now: NOW })
    assert.equal(r.evidence.nativeCapacity.ready, false)
    assert.ok(r.evidence.applicationBlockers.length)
  }
  const { snapshot, plan } = fixture()
  snapshot.nativeTimeframe.cells = { count: 1024, capacity: 1024, stale: 2 }
  assert.equal(prepareScannerAlignment(snapshot, plan, { now: NOW }).evidence.nativeCapacity.ready, true)
})

test('timeframe replacement refuses an unaccounted second cohort and registration profile overflow', () => {
  const { snapshot, plan } = fixture()
  snapshot.profiles.push(timeframe('22', '70'))
  snapshot.revision = plan.expectedRevision = digest(snapshot.profiles)
  assert.throws(() => prepareScannerAlignment(snapshot, plan, { now: NOW }), /timeframe_population/)
  const large = fixture()
  large.snapshot.profiles = Array.from({ length: 1025 }, () => tick('11', '7'))
  large.snapshot.revision = large.plan.expectedRevision = digest(large.snapshot.profiles)
  assert.throws(() => prepareScannerAlignment(large.snapshot, large.plan, { now: NOW }), /registration_bound/)
  const expanded = fixture()
  expanded.snapshot.profiles = Array.from({ length: 600 }, (_, i) => tick('11', String(i + 1))).concat(timeframe('11', '1'))
  expanded.snapshot.maps['11'].map = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`S${i}`, i + 1]))
  expanded.snapshot.maps['22'].map = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`S${i}`, i + 1001]))
  expanded.snapshot.revision = expanded.plan.expectedRevision = digest(expanded.snapshot.profiles)
  assert.throws(() => prepareScannerAlignment(expanded.snapshot, expanded.plan, { now: NOW }), /registration_bound/)
})

test('newly mapped names outside the original policy population are reported and never silently registered', () => {
  const { snapshot, plan } = fixture()
  snapshot.universe.push('OTHER')
  const r = prepareScannerAlignment(snapshot, plan, { now: NOW })
  assert.deepEqual(r.evidence.coverage.map(c => c.mappedUniverseWithoutProfile), [['OTHER'], ['OTHER']])
  assert.equal(r.proposal.profiles.length, 6)
})

test('fresh snapshot cannot refresh stale, invalid, missing or future-dated account map contents', () => {
  for (const account of ['11', '22']) {
    for (const builtAt of [null, '', 'invalid', new Date(NOW + 1).toISOString(),
      new Date(NOW - ACCOUNT_SYMBOL_MAP_TTL_MS).toISOString(),
      new Date(NOW - ACCOUNT_SYMBOL_MAP_TTL_MS - 1).toISOString()]) {
      const { snapshot, plan } = fixture()
      snapshot.maps[account].builtAt = builtAt
      assert.throws(() => prepareScannerAlignment(snapshot, plan, { now: NOW }), /map_stale_or_invalid/,
        `map ${account} with builtAt ${builtAt} must be refused even when snapshot readAt is current`)
    }
  }
  const { snapshot, plan } = fixture()
  for (const map of Object.values(snapshot.maps)) {
    map.builtAt = new Date(NOW - ACCOUNT_SYMBOL_MAP_TTL_MS + 1).toISOString()
    map.complete = false
    map.sourceCount = 1941
  }
  const r = prepareScannerAlignment(snapshot, plan, { now: NOW })
  assert.equal(r.evidence.registryRoundTrip, true)
  assert.equal(r.evidence.mapEvidence['22'].complete, false)
  assert.equal(r.evidence.mapEvidence['22'].sourceCount, 1941)
})

test('CLI payload files have exactly the byte counts and SHA256 digests recorded in evidence', () => {
  const { snapshot, plan } = fixture(), readAt = new Date().toISOString()
  snapshot.readAt = readAt
  snapshot.nativeTimeframe.observedAt = readAt
  for (const f of snapshot.tickFeeds) f.observedAt = readAt
  for (const map of Object.values(snapshot.maps)) map.builtAt = readAt
  const dir = tempDir('scanner-proposal-cli-')
  const input = join(dir, 'snapshot.json'), policy = join(dir, 'plan.json')
  writeFileSync(input, JSON.stringify(snapshot)); writeFileSync(policy, JSON.stringify(plan))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/prepare-scanner-alignment.mjs', import.meta.url)),
    '--snapshot', input, '--plan', policy, '--out-dir', dir], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(readFileSync(join(dir, 'scanner-evidence.json'), 'utf8'))
  for (const kind of ['proposal', 'rollback']) {
    const bytes = readFileSync(join(dir, `scanner-${kind}.json`))
    assert.equal(bytes.length, evidence[`${kind}Bytes`], `${kind} file length must match the review record`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), evidence[`${kind}Sha256`])
  }
})

test('canonical account routing applies identical flag and host checks on both broker hosts', () => {
  for (const [flag, route, foreign] of [[0, host, 'live.ctraderapi.com'], [1, 'live.ctraderapi.com', host]]) {
    const { snapshot, plan } = fixture()
    for (const a of snapshot.accounts) a.is_live = flag
    for (const p of snapshot.profiles) p.feed.host = route
    snapshot.tickFeeds[0].host = route
    snapshot.revision = plan.expectedRevision = digest(snapshot.profiles)
    const r = prepareScannerAlignment(snapshot, plan, { now: NOW })
    assert.ok(r.proposal.profiles.every(p => p.feed.host === route))
    assert.equal(r.evidence.accountSelectionChanged, false)
    for (const account of [0, 1]) for (const invalid of [null, undefined, '0', '1', 2]) {
      const bad = structuredClone(snapshot)
      bad.accounts[account].is_live = invalid
      assert.throws(() => prepareScannerAlignment(bad, plan, { now: NOW }), /account_registry_invalid/)
    }
    const bad = structuredClone(snapshot)
    bad.profiles[0].feed.host = foreign
    bad.revision = digest(bad.profiles)
    assert.throws(() => prepareScannerAlignment(bad, { ...plan, expectedRevision: bad.revision }, { now: NOW }), /source_feed_mismatch/)
  }
})
