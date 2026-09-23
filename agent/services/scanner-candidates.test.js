import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { scannerCandidateId, validateScannerCandidate, recordScannerMirrorPage, scannerMirrorStatus, scannerMirrorAdmission, pollScannerMirrors } from './scanner-candidates.js'
const NOW = 1800000000000
function setup(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,?)').run('11', 0)
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,?)').run('22', 1)
  setState(db, 'symbol_id_map:11', JSON.stringify({ map: { EURUSD: 7 } }))
  setState(db, 'symbol_id_map:22', JSON.stringify({ map: { EURUSD: 8 } }))
  const c = { schemaVersion: 1, purpose: 'mirror', orderAuthority: false, feed: { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' },
    feedEpoch: 'epoch1', configVersion: 'v1', profileHash: 'abcdef0123456789', strategy: 'tick_momentum_breakout', sourceSequence: 18,
    sourceTimestampMs: null, receivedAtMs: NOW - 100, evaluatedAtMs: NOW - 50, expiresAtMs: NOW + 900, signal: { side: 'BUY', bid: 100, ask: 102, stopDistance: 3 } }
  c.candidateId = scannerCandidateId(c)
  const policy = { source: 'cpp-scan-tick', feed: c.feed, strategy: c.strategy, configVersion: c.configVersion, profileHash: c.profileHash, candidateTtlMs: 1000 }
  const opts = { policies: [policy], now: NOW }
  const page = (rows = [{ ...c, cursor: 1 }], instanceId = 'a'.repeat(64)) => ({ instanceId, candidates: rows, latestCursor: rows.at(-1)?.cursor || 0, oldestCursor: 1, gap: false, orderAuthority: false })
  return { db, c, policy, opts, page }
}
test('same candidate replay and scanner restart cannot duplicate observations or create an order intent', t => {
  const { db, c, opts, page } = setup(t)
  assert.equal(recordScannerMirrorPage(db, 'cpp-scan-tick', page(), opts).recorded, 1)
  assert.equal(recordScannerMirrorPage(db, 'cpp-scan-tick', page(), opts).duplicates, 1)
  const restart = recordScannerMirrorPage(db, 'cpp-scan-tick', page([{ ...c, cursor: 1 }], 'b'.repeat(64)), opts)
  assert.equal(restart.duplicates, 1); assert.equal(restart.gap, true)
  assert.equal(db.prepare('SELECT count(*) n FROM scanner_mirror_candidates').get().n, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
  assert.equal(scannerMirrorAdmission().ok, false)
  const conflict = { ...c, signal: { ...c.signal, stopDistance: 30 }, cursor: 2 }
  assert.equal(recordScannerMirrorPage(db, 'cpp-scan-tick', page([conflict], 'b'.repeat(64)), opts).rejected, 1)
  assert.equal(scannerMirrorStatus(db).sources[0].last_error, 'candidate_identity_conflict')
})
test('registered account identity, own symbol map, versions, source time and explicit expiry are enforced', t => {
  const { db, c, opts } = setup(t)
  assert.equal(validateScannerCandidate(db, 'cpp-scan-tick', c, opts).ok, true)
  for (const [change, reason] of [
    [{ feed: { ...c.feed, accountId: '99' } }, 'account_unregistered'],
    [{ feed: { ...c.feed, accountId: '22' } }, 'account_feed_mismatch'],
    [{ feed: { ...c.feed, symbolId: '8' } }, 'account_symbol_unmapped'],
    [{ profileHash: 'different' }, 'comparison_profile_unregistered'],
    [{ sourceTimestampMs: NOW + 1 }, 'candidate_time_or_expiry_invalid'],
    [{ expiresAtMs: NOW + 1e6 }, 'candidate_time_or_expiry_invalid'],
    [{ orderAuthority: true }, 'mirror_contract_required']])
    assert.equal(validateScannerCandidate(db, 'cpp-scan-tick', { ...c, ...change }, opts).reason, reason)
  assert.equal(validateScannerCandidate(db, 'cpp-scan-tick', c, { ...opts, now: NOW + 1000 }).state, 'expired')
  assert.equal(scannerMirrorStatus(db).status, 'unavailable')
})
test('cursor gaps and restarts remain explicit; malformed pages roll back the whole batch', t => {
  const { db, c, opts, page } = setup(t)
  assert.equal(recordScannerMirrorPage(db, 'cpp-scan-tick', page([{ ...c, cursor: 5 }]), opts).gap, true)
  const reset = page([{ ...c, cursor: 6 }], 'b'.repeat(64))
  assert.equal(recordScannerMirrorPage(db, 'cpp-scan-tick', reset, opts).resetRequired, true)
  const before = scannerMirrorStatus(db).sources[0].cursor
  assert.throws(() => recordScannerMirrorPage(db, 'cpp-scan-tick', page([{ ...c, cursor: 7 }, { ...c, cursor: 6 }]), opts), /scanner_cursor_order/)
  assert.equal(scannerMirrorStatus(db).sources[0].cursor, before)
})
test('collector refetches from zero on instance change even when the new cursor is larger', async t => {
  const { db, c, policy, opts, page } = setup(t)
  recordScannerMirrorPage(db, 'cpp-scan-tick', page(), opts)
  setState(db, 'scanner_mirror_profiles_json', JSON.stringify([policy]))
  const seen = []
  const result = await pollScannerMirrors(db, { now: NOW, env: { SCANNER_TICK_URL: 'https://scanner.invalid', SCANNER_TICK_SECRET: 'test-only' },
    fetchImpl: async (url, options) => {
      seen.push(url.searchParams.get('after')); assert.equal(options.redirect, 'error')
      return new Response(JSON.stringify(page([{ ...c, cursor: seen.length === 1 ? 2 : 1 }], 'b'.repeat(64))))
    } })
  assert.deepEqual(seen, ['1', '0']); assert.equal(result.outcomes[0].duplicates, 1)
})
