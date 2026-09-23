import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { TickMomentumOracle, profileHash, DEFAULT_PARAMS } from '../lib/tick-strategy.js'

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
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_references (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, observed_ms INTEGER NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS scanner_comparisons (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, state TEXT NOT NULL,
    detail TEXT NOT NULL, observed_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scanner_reference_age ON scanner_references(observed_ms);
    CREATE INDEX IF NOT EXISTS scanner_comparison_age ON scanner_comparisons(observed_ms);`)
}
const basis = v => hash([v.feed, v.feedEpoch, v.configVersion, v.profileHash, v.timeframe, v.barCloseAtMs ?? v.sourceSequence])
export function comparisonRecord(db, id, source, state, detail, now = Date.now()) {
  schema(db)
  // Evidence is append-only by identity; replay cannot inflate a population.
  const payload = JSON.stringify(detail)
  if (Buffer.byteLength(payload) > 16000) throw new Error('comparison_detail_bound')
  db.prepare('INSERT OR IGNORE INTO scanner_comparisons VALUES (?,?,?,?,?)').run(id, source, state, payload, now)
  trimOne(db, 'scanner_comparisons')
}
export function retainComparisons(db, now = Date.now()) {
  schema(db)
  for (const table of ['scanner_references', 'scanner_comparisons']) {
    db.prepare(`DELETE FROM ${table} WHERE observed_ms < ?`).run(now - RETAIN)
    db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY observed_ms DESC,rowid DESC LIMIT -1 OFFSET ?)`).run(CAP)
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
export function compareSignals(reference, native, fields = TF_FIELDS) {
  if (reference == null || native == null) return reference == null && native == null ? [] : ['signal_presence']
  return fields.filter(k => typeof reference[k] === 'number' && typeof native[k] === 'number'
    ? !Number.isFinite(reference[k]) || !Number.isFinite(native[k]) || Math.abs(reference[k] - native[k]) > 1e-9
    : reference[k] !== native[k])
}
export function compareTimeframeResult(db, row, now = Date.now()) {
  const input = row.candidate || row, id = basis(input)
  schema(db)
  const saved = db.prepare('SELECT payload FROM scanner_references WHERE id=?').get(id)
  const reference = saved ? JSON.parse(saved.payload).reference : null
  const fields = input.strategy === 'fib_618_fade' ? TF_FIELDS : [...TF_FIELDS, 'strategy', 'direction_reason', 'confluenceCount']
  const differences = saved ? compareSignals(reference, row.candidate?.signal, fields) : []
  const validOutcome = ['candidate', 'no_signal', 'expired'].includes(row.outcome) && (row.outcome === 'candidate') === !!row.candidate
  const state = !validOutcome ? 'contract_rejected' : !saved ? 'reference_missing' : row.outcome === 'expired' ? 'native_expired' : differences.length ? 'mismatch' : 'matched'
  comparisonRecord(db, id, 'cpp-scan-timeframe', state, { feed: input.feed, timeframe: input.timeframe,
    sourceSequence: input.sourceSequence ?? input.barCloseAtMs, differences, orderAuthority: false }, now)
  return state
}
export function comparisonStatus(db) {
  if (!exists(db)) return { status: 'unavailable', reason: 'no_comparison_observation', orderAuthority: false }
  return { status: 'observed', orderAuthority: false, retentionDays: 7, capacity: CAP,
    populations: db.prepare('SELECT source,state,count(*) records,MAX(observed_ms) lastObservedAtMs FROM scanner_comparisons GROUP BY source,state').all(),
    note: 'Retained comparisons are observations, not independent research samples. Gaps, missing references and unsupported profiles prevent a complete parity claim.' }
}
export function comparisonProfiles(db) {
  try { const p = JSON.parse(getState(db, 'scanner_mirror_profiles_json') || 'null'); return Array.isArray(p) && p.length <= 512 ? p : [] } catch { return [] }
}
export function matchingProfile(db, source, value) {
  const f = value.feed
  if (!f || f.provider !== 'ctrader' || !/^[1-9]\d*$/.test(f.accountId) || !/^[1-9]\d*$/.test(f.symbolId)) return null
  const account = db.prepare('SELECT is_live FROM accounts WHERE account_id=?').get(f.accountId)
  if (!account || f.host !== (account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com')) return null
  let map; try { map = JSON.parse(getState(db, `symbol_id_map:${f.accountId}`)) } catch { return null }
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
      if (matchingProfile(db, 'cpp-scan-tick', row) && row.profile && Object.keys(DEFAULT_PARAMS).every(k => Object.hasOwn(row.profile, k))
        && profileHash(row.profile) === row.profileHash
        && ['candidate', 'no_signal', 'expired'].includes(row.outcome) && (row.outcome === 'candidate') === !!row.signal
        && row.orderAuthority === false && Number.isSafeInteger(row.completedAtMs) && row.completedAtMs <= now
        && q && Number.isSafeInteger(q.seq) && q.seq > 0 && Number.isSafeInteger(q.recvMs) && q.recvMs <= row.completedAtMs
        && ['bid', 'ask'].every(k => q[k] === null || (Number.isSafeInteger(q[k]) && q[k] > 0))
        && ['snapshot', 'crossed', 'changed'].every(k => typeof q[k] === 'boolean')) {
        const key = hash([row.feed, row.feedEpoch, row.configVersion, row.profileHash])
        if (!this.streams.has(key) && this.streams.size < 512) this.streams.set(key, { oracle: new TickMomentumOracle(row.profile), known: q.snapshot, last: 0 })
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
          differences = compareSignals(reference, native, TICK_FIELDS)
          state = !stream.known ? 'reference_warmup_unknown' : row.outcome === 'expired' ? 'native_expired' : differences.length ? 'mismatch' : 'matched'
        } else state = stream ? 'source_sequence_invalid' : 'reference_capacity'
      }
      comparisonRecord(db, id, 'cpp-scan-tick', state, { feed: row.feed, sourceSequence: q?.seq, differences, orderAuthority: false }, now)
      this.after = row.cursor
    }
    return { after: this.after, instanceId: this.instance, orderAuthority: false }
  }
}
