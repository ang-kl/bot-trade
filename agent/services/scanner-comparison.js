import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { TickMomentumOracle, profileHash, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { SCANNER_PROFILE_LIMIT } from '../lib/scanner-bounds.js'

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
export { FIB_PROFILE } from './scanner-profiles.js'
const RETAIN = 7 * 86400_000, CAP = 100_000
const exists = db => db.prepare("SELECT 1 FROM sqlite_master WHERE name='scanner_comparisons'").get()
function trimOne(db, table) {
  if (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n > CAP)
    db.prepare(`DELETE FROM ${table} WHERE rowid=(SELECT rowid FROM ${table} ORDER BY observed_ms,rowid LIMIT 1)`).run()
}
// The schema is created once per connection, not re-parsed for every row. A
// creation inside a transaction is not remembered: a rollback would undo it.
const schemaReady = new WeakSet()
function schema(db) {
  if (schemaReady.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_references (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, observed_ms INTEGER NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS scanner_comparisons (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL,
    detail TEXT NOT NULL, observed_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scanner_reference_age ON scanner_references(observed_ms);
    CREATE INDEX IF NOT EXISTS scanner_comparison_age ON scanner_comparisons(observed_ms);
    CREATE INDEX IF NOT EXISTS scanner_comparison_source_state ON scanner_comparisons(source, state, observed_ms);
    CREATE INDEX IF NOT EXISTS scanner_comparison_source_age ON scanner_comparisons(source, observed_ms);`)
  if (!db.inTransaction) schemaReady.add(db)
}
const basis = v => hash([v.feed, v.feedEpoch, v.configVersion, v.profileHash, v.timeframe, v.barCloseAtMs ?? v.sourceSequence])
export function comparisonRecord(db, id, source, state, detail, now = Date.now()) {
  schema(db)
  // Evidence is append-only by identity; replay cannot inflate a population.
  const payload = JSON.stringify(detail)
  if (Buffer.byteLength(payload) > 16000) throw new Error('comparison_detail_bound')
  // No per-row trim: a COUNT per insert held the page transaction's write
  // lock while the main thread busy-waited on it. retainComparisons bounds
  // the table instead, per source, on the collector's 60 s cadence (so the
  // overshoot is at most one minute of rows).
  db.prepare('INSERT OR IGNORE INTO scanner_comparisons VALUES (?,?,?,?,?)').run(id, source, state, payload, now)
}
// Each source keeps its own newest `cap` rows. With one shared cap the tick
// stream (about 100 rows/s) evicted every timeframe comparison in about 17
// minutes, so timeframe parity could never be read back.
// The write lock is held only for deletions: the edge (the cap-th newest row
// of a source) is found by a read, which in WAL mode does not block the main
// thread's writes, and the rows older than it are deleted in bounded chunks.
// Every statement walks an index; none sorts the table.
export function retainComparisons(db, now = Date.now(), { cap = CAP, chunk = 2000 } = {}) {
  schema(db)
  // The 7-day age deletes are chunked too: after the bridge has been off for
  // more than 7 days a single statement held the write lock 558 ms at 100,000
  // stale rows and 1,074 ms at 200,000 (the #1088 checker's measurement).
  const aged = table => db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE observed_ms<? LIMIT ?)`)
  const agedReferences = aged('scanner_references'), agedComparisons = aged('scanner_comparisons')
  while (agedReferences.run(now - RETAIN, chunk).changes === chunk) { /* next bounded chunk */ }
  db.prepare('DELETE FROM scanner_references WHERE rowid IN (SELECT rowid FROM scanner_references ORDER BY observed_ms DESC,rowid DESC LIMIT -1 OFFSET ?)').run(cap)
  while (agedComparisons.run(now - RETAIN, chunk).changes === chunk) { /* next bounded chunk */ }
  const first = db.prepare('SELECT MIN(source) source FROM scanner_comparisons')
  const next = db.prepare('SELECT MIN(source) source FROM scanner_comparisons WHERE source > ?')
  const edge = db.prepare('SELECT observed_ms at, rowid id FROM scanner_comparisons WHERE source=? ORDER BY observed_ms DESC,rowid DESC LIMIT 1 OFFSET ?')
  const drop = db.prepare(`DELETE FROM scanner_comparisons WHERE rowid IN (SELECT rowid FROM scanner_comparisons
    WHERE source=? AND (observed_ms<? OR (observed_ms=? AND rowid<?)) ORDER BY observed_ms,rowid LIMIT ?)`)
  for (let source = first.get().source; source != null; source = next.get(source).source) {
    const kept = edge.get(source, cap - 1)
    if (kept) while (drop.run(source, kept.at, kept.at, kept.id, chunk).changes === chunk) { /* next bounded chunk */ }
  }
}
export function recordReference(db, body, reference, now = Date.now()) {
  schema(db)
  const id = basis(body), payload = JSON.stringify({ ...body, bars: undefined, reference })
  const old = db.prepare('SELECT payload FROM scanner_references WHERE id=?').get(id)
  if (old) {
    const prior = JSON.parse(old.payload)
    if (hash([prior.inputHash, prior.reference]) !== hash([body.inputHash, reference])) throw new Error('reference_identity_conflict')
  }
  db.prepare('INSERT OR IGNORE INTO scanner_references (id,payload,observed_ms) VALUES (?,?,?)').run(id, payload, now)
  trimOne(db, 'scanner_references')
  return { id, duplicate: !!old, original: old ? JSON.parse(old.payload) : null }
}
export function claimReferenceDelivery(db, id) {
  return db.prepare("UPDATE scanner_references SET attempts=attempts+1 WHERE id=? AND delivery_state!='delivered' AND attempts<3").run(id).changes > 0
}
export function markReferenceDelivery(db, id, state) {
  db.prepare('UPDATE scanner_references SET delivery_state=? WHERE id=?').run(state, id)
}
const TF_FIELDS = ['bias', 'entry', 'sl', 'tp1', 'tp2', 'conviction', 'rr', 'time_cap_minutes', 'timeframe']
const TICK_FIELDS = ['side', 'bid', 'ask', 'trigger2', 'stopDistance', 'spread', 'V', 'E', 'D', 'H', 'L', 'B', 'confirmations']
function sameField(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && sameField(a[k], b[k]))
  }
  return a === b
}
export function compareSignals(reference, native, fields = TF_FIELDS) {
  if (reference == null || native == null) return reference == null && native == null ? [] : ['signal_presence']
  return fields.filter(k => !sameField(reference[k], native[k]))
}
export function compareTimeframeResult(db, row, now = Date.now()) {
  const input = row.candidate || row, id = basis(input)
  schema(db)
  const saved = db.prepare('SELECT payload FROM scanner_references WHERE id=?').get(id)
  const reference = saved ? JSON.parse(saved.payload).reference : null
  const fields = input.strategy === 'fib_618_fade' ? TF_FIELDS : [...TF_FIELDS, 'strategy', 'direction_reason', 'confluenceCount',
    'sl_atr_mult', 'sl_widened_to_floor', 'stack_confirmed', 'cup', 'fvg']
  const differences = saved ? compareSignals(reference, row.candidate?.signal, fields) : []
  const validOutcome = ['candidate', 'no_signal', 'expired'].includes(row.outcome) && (row.outcome === 'candidate') === !!row.candidate
  const state = !validOutcome ? 'contract_rejected' : !saved ? 'reference_missing' : row.outcome === 'expired' ? 'native_expired' : differences.length ? 'mismatch' : 'matched'
  comparisonRecord(db, id, 'cpp-scan-timeframe', state, { feed: input.feed, timeframe: input.timeframe,
    sourceSequence: input.sourceSequence ?? input.barCloseAtMs, differences, orderAuthority: false }, now)
  return state
}
export const REFUSAL_WINDOW_MS = 3_600_000
export function comparisonStatus(db, { now = Date.now() } = {}) {
  if (!exists(db)) return { status: 'unavailable', reason: 'no_comparison_observation', orderAuthority: false }
  // This runs on the main thread for every /state/scanner-mirrors and
  // heartbeat read. The populations read is index-only on the covering
  // (source, state, observed_ms) index. The refusal breakdown has to open each
  // row it counts (json_extract on detail), so it reads only the last hour:
  // a range on the same index. Unbounded it opened every retained refusal
  // (270 ms at 100,000, measured by the #1088 checker); the hour holds about
  // 2,100 when all 690 timeframe cells refuse every bar (1.7 ms, measured).
  return { status: 'observed', orderAuthority: false, retentionDays: 7, capacity: CAP, capacityPer: 'source',
    populations: db.prepare('SELECT source,state,count(*) records,MAX(observed_ms) lastObservedAtMs FROM scanner_comparisons GROUP BY source,state').all(),
    inputRefusedWindowMs: REFUSAL_WINDOW_MS,
    inputRefusedLastHour: db.prepare(`SELECT json_extract(detail,'$.error') error,json_extract(detail,'$.reason') reason,count(*) records
      FROM scanner_comparisons WHERE source='cpp-scan-timeframe' AND state='input_refused' AND observed_ms>=? GROUP BY 1,2`).all(now - REFUSAL_WINDOW_MS),
    note: 'Retained comparisons are observations, not independent research samples. Gaps, missing references and unsupported profiles prevent a complete parity claim.' }
}
export function comparisonProfiles(db) {
  try { const p = JSON.parse(getState(db, 'scanner_mirror_profiles_json') || 'null'); return Array.isArray(p) && p.length <= SCANNER_PROFILE_LIMIT ? p : [] } catch { return [] }
}
// One memo serves one comparison page. Without it every row re-parsed the
// registry and the account's symbol map and hashed every profile: 1.806 ms a
// row, so a 128-row page held the write lock 146-248 ms (measured) while the
// main thread busy-waited on it (db.js busy_timeout 5000).
export const comparisonMemo = () => ({ accounts: new Map(), profiles: null })
const feedKey = (source, feed) => JSON.stringify([source, canonical(feed)])
// Routing only: the broker host a registered account's feed must carry, or
// null for an unregistered account. One lookup for both paths below.
function registeredHost(db, accountId) {
  const account = db.prepare('SELECT is_live FROM accounts WHERE account_id=?').get(accountId)
  return account ? (account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com') : null
}
function memoAccount(db, memo, accountId) {
  if (!memo.accounts.has(accountId)) {
    const host = registeredHost(db, accountId), map = host ? getAccountSymbolMap(db, accountId)?.map : null
    memo.accounts.set(accountId, { host, symbols: map ? new Set(Object.values(map).map(String)) : null })
  }
  return memo.accounts.get(accountId)
}
function memoProfiles(db, memo) {
  if (!memo.profiles) {
    memo.profiles = new Map()
    for (const p of comparisonProfiles(db)) {
      if (!p || typeof p !== 'object' || !p.feed || typeof p.feed !== 'object') continue
      const key = feedKey(p.source, p.feed)
      if (memo.profiles.has(key)) memo.profiles.get(key).push(p); else memo.profiles.set(key, [p])
    }
  }
  return memo.profiles
}
export function matchingProfile(db, source, value, memo = null) {
  const f = value.feed
  if (!f || f.provider !== 'ctrader' || !/^[1-9]\d*$/.test(f.accountId) || !/^[1-9]\d*$/.test(f.symbolId)) return null
  if (memo) {
    // Same rules as below: the registered host, the symbol in the account's own
    // map, the canonical feed identity, then the exact profile fields in order.
    const account = memoAccount(db, memo, f.accountId)
    if (!account.host || f.host !== account.host || !account.symbols?.has(f.symbolId)) return null
    return (memoProfiles(db, memo).get(feedKey(source, f)) || []).find(p => p.strategy === value.strategy
      && p.configVersion === value.configVersion && p.profileHash === value.profileHash
      && (p.timeframe || '') === (value.timeframe || '')) || null
  }
  const host = registeredHost(db, f.accountId)
  if (!host || f.host !== host) return null
  const map = getAccountSymbolMap(db, f.accountId)?.map
  if (!map || !Object.values(map).some(id => String(id) === f.symbolId)) return null
  return comparisonProfiles(db).find(p => p.source === source && hash(p.feed) === hash(f)
    && p.strategy === value.strategy && p.configVersion === value.configVersion && p.profileHash === value.profileHash
    && (p.timeframe || '') === (value.timeframe || '')) || null
}

// The oracle runs in the isolated bridge worker, on exactly the quotes the
// native worker completed (including its actual queue-gap reset). HTTP polling
// is never counted as a scan. Bounded cursors make missing input explicit.
export class TickComparisonReader {
  constructor() { this.instance = null; this.after = 0; this.streams = new Map() }
  consume(db, page, now = Date.now()) {
    schema(db)
    const after = this.after, instance = this.instance
    try { return db.transaction(() => this.consumePage(db, page, now)).immediate() }
    catch (error) { this.after = after; this.instance = instance; this.streams.clear(); throw error }
  }
  consumePage(db, page, now) {
    if (!/^[a-f0-9]{64}$/.test(page?.instanceId) || page.orderAuthority !== false
      || !Number.isSafeInteger(page.latestCursor) || page.latestCursor < 0 || !Number.isSafeInteger(page.oldestCursor)
      || page.oldestCursor < 1 || page.oldestCursor > page.latestCursor + 1
      || typeof page.gap !== 'boolean'
      || !Array.isArray(page.candidates) || page.candidates.length > 128) throw new Error('comparison_page_invalid')
    const memo = comparisonMemo()
    if (this.instance !== page.instanceId) { this.after = 0; this.streams.clear(); this.instance = page.instanceId }
    if (page.gap || this.after < page.oldestCursor - 1) {
      this.streams.clear()
      comparisonRecord(db, hash([page.instanceId, 'gap', page.oldestCursor]), 'cpp-scan-tick', 'input_gap', { after: this.after, oldest: page.oldestCursor }, now)
    }
    let previous = 0
    for (const row of page.candidates) {
      if (!Number.isSafeInteger(row.cursor) || row.cursor <= previous || row.cursor < page.oldestCursor || row.cursor > page.latestCursor) throw new Error('comparison_cursor_invalid')
      previous = row.cursor
      if (row.cursor <= this.after) continue
      if (row.cursor !== Math.max(this.after + 1, page.oldestCursor)) {
        this.streams.clear()
        comparisonRecord(db, hash([page.instanceId, 'cursor_gap', row.cursor]), 'cpp-scan-tick', 'input_gap', { after: this.after, next: row.cursor }, now)
      }
      const id = hash([page.instanceId, row.cursor]), q = row.quote
      let state = 'contract_rejected', differences = []
      const policy = matchingProfile(db, 'cpp-scan-tick', row, memo)
      if (policy && Number.isSafeInteger(policy.candidateTtlMs) && policy.candidateTtlMs >= 1 && policy.candidateTtlMs <= 3600000 && row.profile && Object.keys(DEFAULT_PARAMS).every(k => Object.hasOwn(row.profile, k))
        && profileHash(row.profile) === row.profileHash
        && ['candidate', 'no_signal', 'expired'].includes(row.outcome) && (row.outcome === 'candidate') === !!row.signal
        && row.orderAuthority === false && Number.isSafeInteger(row.completedAtMs) && row.completedAtMs <= now
        && q && Number.isSafeInteger(q.seq) && q.seq > 0 && Number.isSafeInteger(q.recvMs) && q.recvMs <= row.completedAtMs
        && ['bid', 'ask'].every(k => q[k] === null || (Number.isSafeInteger(q[k]) && q[k] > 0))
        && ['snapshot', 'crossed', 'changed'].every(k => typeof q[k] === 'boolean')) {
        // Streams are keyed without the feed epoch: each gateway feed restart
        // used to add 53 streams until the 512 bound turned every row into
        // 'reference_capacity'. A new epoch replaces its stream with a fresh
        // oracle, which rewarms from the next snapshot.
        const key = hash([row.feed, row.configVersion, row.profileHash])
        if (this.streams.has(key) && this.streams.get(key).epoch !== row.feedEpoch) this.streams.delete(key)
        if (!this.streams.has(key) && this.streams.size < 512) this.streams.set(key, { oracle: new TickMomentumOracle(row.profile), known: q.snapshot, last: 0, epoch: row.feedEpoch })
        const stream = this.streams.get(key)
        if (stream && q.seq > stream.last) {
          // A native reset recovers the economic state, while the gap record
          // remains in the retained population. Local setup counters are not
          // treated as cross-process economic identity.
          if (q.snapshot) stream.known = true
          const reference = stream.oracle.feed(q); stream.last = q.seq
          // The checked-in JavaScript oracle serializes V and E to six
          // decimals (tick-strategy.js). Canonicalize only those diagnostic
          // fields to its public precision; prices/targets remain unchanged.
          const native = row.signal ? { ...row.signal,
            V: typeof row.signal.V === 'number' ? +row.signal.V.toFixed(6) : row.signal.V,
            E: typeof row.signal.E === 'number' ? +row.signal.E.toFixed(6) : row.signal.E } : null
          // Expiry suppresses dispatch, not oracle state advancement. Verify
          // it independently against the registered TTL; an 'expired' label
          // must not hide either a premature suppression or a late signal.
          const expired = q.recvMs + policy.candidateTtlMs <= row.completedAtMs
          differences = compareSignals(expired ? null : reference, native, TICK_FIELDS)
          if ((row.outcome === 'expired') !== expired) differences.push('expiry')
          state = !stream.known ? 'reference_warmup_unknown' : differences.length ? 'mismatch' : expired ? 'native_expired' : 'matched'
        } else state = stream ? 'source_sequence_invalid' : 'reference_capacity'
      }
      comparisonRecord(db, id, 'cpp-scan-tick', state, { feed: row.feed, sourceSequence: q?.seq, differences, orderAuthority: false }, now)
      this.after = row.cursor
    }
    return { after: this.after, instanceId: this.instance, orderAuthority: false }
  }
}
