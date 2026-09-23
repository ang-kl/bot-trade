import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { compareTimeframeResult, comparisonStatus } from './scanner-comparison.js'
import { scannerBridgeStatus } from './scanner-feed.js'

const SOURCES = new Set(['cpp-scan-tick', 'cpp-scan-timeframe'])
const ID = /^[1-9][0-9]{0,18}$/
const VERSION = /^[A-Za-z0-9_.-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const RETAIN_MS = 7 * 86400_000
const MAX_ROWS = 100_000
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const integer = (v, low = 0, high = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= low && v <= high
const object = v => v != null && typeof v === 'object' && !Array.isArray(v)
const read = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_mirror_cursors (
    source TEXT PRIMARY KEY, instance_id TEXT NOT NULL, cursor INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL, gaps INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0, last_error TEXT);
    CREATE TABLE IF NOT EXISTS scanner_mirror_candidates (
    candidate_id TEXT PRIMARY KEY, source TEXT NOT NULL, account_id TEXT NOT NULL,
    host TEXT NOT NULL, symbol_id TEXT NOT NULL, strategy TEXT NOT NULL,
    profile_hash TEXT NOT NULL, config_version TEXT NOT NULL, received_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL, observed_at_ms INTEGER NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS scanner_mirror_age ON scanner_mirror_candidates(observed_at_ms);
    CREATE TABLE IF NOT EXISTS scanner_mirror_outcomes (
    source TEXT NOT NULL, instance_id TEXT NOT NULL, cursor INTEGER NOT NULL,
    outcome TEXT NOT NULL, reason TEXT, observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY(source,instance_id,cursor));
    CREATE INDEX IF NOT EXISTS scanner_mirror_outcome_age ON scanner_mirror_outcomes(observed_at_ms);`)
}

export function scannerCandidateId(c) {
  return digest([c.feed, c.feedEpoch, c.configVersion, c.profileHash, c.strategy, c.sourceSequence, c.timeframe || ''])
}
function identityReason(db, source, value, policies) {
  if (!object(value) || !object(value.feed)) return 'identity_unavailable'
  const { feed: f } = value
  if (f.provider !== 'ctrader' || typeof f.accountId !== 'string' || typeof f.symbolId !== 'string' || !ID.test(f.accountId) || !ID.test(f.symbolId)
      || !['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(f.host)
      || Object.keys(f).sort().join(',') !== 'accountId,host,provider,symbolId') return 'identity_invalid'
  const account = db.prepare('SELECT account_id,is_live FROM accounts WHERE account_id=?').get(f.accountId)
  if (!account) return 'account_unregistered'
  const host = account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  if (host !== f.host) return 'account_feed_mismatch'
  const map = read(db, `symbol_id_map:${f.accountId}`)
  if (!object(map) || !Object.values(map).some(id => String(id) === f.symbolId)) return 'account_symbol_unmapped'
  if (![value.feedEpoch, value.configVersion, value.profileHash].every(v => typeof v === 'string' && VERSION.test(v))) return 'version_unavailable'
  if (source === 'cpp-scan-tick' ? value.strategy !== 'tick_momentum_breakout' : value.strategy === 'tick_momentum_breakout') return 'strategy_source_mismatch'
  const policy = (Array.isArray(policies) ? policies : []).find(p => p?.source === source && p.strategy === value.strategy && p.configVersion === value.configVersion
    && p.profileHash === value.profileHash && p.feed?.host === f.host && p.feed?.accountId === f.accountId && p.feed?.symbolId === f.symbolId
    && (p.timeframe || '') === (value.timeframe || ''))
  if (!policy) return 'comparison_profile_unregistered'
  return policy
}
/** Validates observations only. This function cannot issue an entry permit. */
export function validateScannerCandidate(db, source, c, { policies = [], now = Date.now() } = {}) {
  if (!SOURCES.has(source) || !object(c) || c.schemaVersion !== 1 || c.purpose !== 'mirror' || c.orderAuthority !== false) return { ok: false, reason: 'mirror_contract_required' }
  const identity = identityReason(db, source, c, policies)
  if (typeof identity === 'string') return { ok: false, reason: identity }
  if (!integer(c.sourceSequence, 1) || !integer(c.receivedAtMs, 1, now) || !integer(c.evaluatedAtMs, c.receivedAtMs, now)
    || !integer(c.expiresAtMs, c.receivedAtMs + 1) || !integer(identity.candidateTtlMs, 1, 3600000)
    || c.expiresAtMs - c.receivedAtMs !== identity.candidateTtlMs
    || (c.sourceTimestampMs !== null && !integer(c.sourceTimestampMs, 1, c.receivedAtMs))) return { ok: false, reason: 'candidate_time_or_expiry_invalid' }
  if (!HASH.test(c.candidateId) || scannerCandidateId(c) !== c.candidateId) return { ok: false, reason: 'candidate_identity_mismatch' }
  if (!object(c.signal) || Buffer.byteLength(JSON.stringify(c)) > 16384) return { ok: false, reason: 'signal_shape_invalid' }
  const finitePositive = n => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (source === 'cpp-scan-tick') {
    if (!['BUY', 'SELL'].includes(c.signal.side) || ![c.signal.bid, c.signal.ask, c.signal.stopDistance].every(finitePositive)
        || c.signal.ask < c.signal.bid) return { ok: false, reason: 'tick_signal_invalid' }
  } else {
    const { bias, entry, sl, tp1, tp2 } = c.signal
    if (!['long', 'short'].includes(bias) || ![entry, sl, tp1].every(finitePositive)
        || (tp2 != null && !finitePositive(tp2)) || c.signal.timeframe !== c.timeframe
        || (bias === 'long' ? !(sl < entry && tp1 > entry) : !(sl > entry && tp1 < entry)))
      return { ok: false, reason: 'target_geometry_invalid' }
  }
  return { ok: true, state: now >= c.expiresAtMs ? 'expired' : 'mirror', admission: 'not_evaluated', orderAuthority: false }
}
export function scannerMirrorAdmission() { return { ok: false, reason: 'mirror_candidate_has_no_order_authority' } }

export function recordScannerMirrorPage(db, source, page, { policies = [], now = Date.now() } = {}) {
  if (!SOURCES.has(source) || !object(page) || !HASH.test(page.instanceId) || page.orderAuthority !== false
    || !Array.isArray(page.candidates) || page.candidates.length > 256
    || !integer(page.latestCursor) || !integer(page.oldestCursor, 1, page.latestCursor + 1)) throw new Error('invalid_scanner_page')
  schema(db)
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM scanner_mirror_cursors WHERE source=?').get(source)
    const restarted = !!old && old.instance_id !== page.instanceId
    const after = restarted ? 0 : old?.cursor || 0
    // A new process can have advanced beyond the old cursor. Its instance ID,
    // not merely a smaller number, detects this otherwise invisible restart.
    if (restarted && page.latestCursor > 0 && (!page.candidates.length || page.candidates[0].cursor > page.oldestCursor)) return { resetRequired: true, after: 0, instanceId: page.instanceId }
    db.prepare('DELETE FROM scanner_mirror_candidates WHERE observed_at_ms<?').run(now - RETAIN_MS)
    db.prepare('DELETE FROM scanner_mirror_outcomes WHERE observed_at_ms<?').run(now - RETAIN_MS)
    let cursor = after, count = db.prepare('SELECT count(*) n FROM scanner_mirror_candidates').get().n
    let recorded = 0, duplicates = 0, rejected = 0, noSignal = 0, expired = 0, lastError = null, previous = 0
    let gap = restarted || page.gap === true || after < page.oldestCursor - 1 || after > page.latestCursor
    const ins = db.prepare('INSERT INTO scanner_mirror_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const row of page.candidates) {
      if (!object(row) || !integer(row.cursor, page.oldestCursor, page.latestCursor) || row.cursor <= previous) throw new Error('scanner_cursor_order')
      previous = row.cursor
      if (row.cursor <= after) { duplicates++; continue }
      if (row.cursor !== cursor + 1) gap = true
      cursor = row.cursor
      const c = row.candidate || (row.candidateId ? row : null)
      let outcome = 'rejected', reason = null
      if (c) {
        const check = validateScannerCandidate(db, source, c, { policies, now })
        if (!check.ok) reason = check.reason
        else {
          const fingerprint = digest([c.feed, c.feedEpoch, c.configVersion, c.profileHash, c.strategy, c.sourceSequence,
            c.timeframe || '', c.receivedAtMs, c.sourceTimestampMs, c.expiresAtMs, c.signal])
          const prior = db.prepare('SELECT fingerprint FROM scanner_mirror_candidates WHERE candidate_id=?').get(c.candidateId)
          if (prior && prior.fingerprint !== fingerprint) reason = 'candidate_identity_conflict'
          else if (prior) { duplicates++; outcome = 'duplicate' }
          else if (count >= MAX_ROWS) reason = 'candidate_retention_capacity'
          else {
            ins.run(c.candidateId, source, c.feed.accountId, c.feed.host, c.feed.symbolId, c.strategy,
              c.profileHash, c.configVersion, c.receivedAtMs, c.expiresAtMs, now, fingerprint, JSON.stringify(c))
            count++; recorded++; outcome = check.state
          }
        }
      } else if (source === 'cpp-scan-timeframe' && ['no_signal', 'expired'].includes(row.outcome)
          && row.orderAuthority === false && typeof identityReason(db, source, row, policies) !== 'string'
          && integer(row.receivedAtMs, 1, now) && integer(row.completedAtMs, row.receivedAtMs, now)) {
        outcome = row.outcome; if (outcome === 'no_signal') noSignal++; else expired++
      } else reason = 'completed_evaluation_unverified'
      if (reason) { rejected++; lastError = reason }
      if (!reason && source === 'cpp-scan-timeframe') compareTimeframeResult(db, row, now)
      db.prepare('INSERT OR IGNORE INTO scanner_mirror_outcomes VALUES(?,?,?,?,?,?)').run(source, page.instanceId, row.cursor, outcome, reason, now)
    }
    if (!page.candidates.length && restarted) cursor = 0
    db.prepare(`INSERT INTO scanner_mirror_cursors VALUES(?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
      instance_id=excluded.instance_id,cursor=excluded.cursor,observed_at_ms=excluded.observed_at_ms,
      gaps=scanner_mirror_cursors.gaps+excluded.gaps,rejected=scanner_mirror_cursors.rejected+excluded.rejected,last_error=excluded.last_error`)
      .run(source, page.instanceId, cursor, now, gap ? 1 : 0, rejected, lastError)
    // Telemetry is bounded independently of candidate count.
    db.prepare('DELETE FROM scanner_mirror_outcomes WHERE rowid IN (SELECT rowid FROM scanner_mirror_outcomes ORDER BY observed_at_ms DESC,rowid DESC LIMIT -1 OFFSET ?)').run(MAX_ROWS)
    return { recorded, duplicates, rejected, noSignal, expired, gap, cursor, instanceId: page.instanceId, orderAuthority: false }
  }).immediate()
}

export function scannerMirrorStatus(db, { now = Date.now() } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scanner_mirror_cursors'").get())
    return { observedAtMs: now, status: 'unavailable', sources: [], orderAuthority: false, reason: 'no_scanner_observation', comparison: comparisonStatus(db), bridge: scannerBridgeStatus(db) }
  return { observedAtMs: now, orderAuthority: false, mode: 'mirror', retentionDays: 7, capacity: MAX_ROWS,
    sources: db.prepare('SELECT * FROM scanner_mirror_cursors ORDER BY source').all(),
    outcomes: db.prepare('SELECT source,outcome,reason,count(*) AS count FROM scanner_mirror_outcomes GROUP BY source,outcome,reason').all(),
    candidates: db.prepare('SELECT source,account_id,host,strategy,count(*) AS count FROM scanner_mirror_candidates GROUP BY source,account_id,host,strategy').all(),
    comparison: comparisonStatus(db), bridge: scannerBridgeStatus(db) }
}

async function scannerPage(url, secret, after, fetchImpl) {
  const endpoint = new URL(url)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('scanner_endpoint_invalid')
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/candidates`
  endpoint.searchParams.set('after', after)
  const response = await fetchImpl(endpoint, { headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error('scanner_read_unavailable')
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 256 * 1024) { await response.body.cancel?.().catch(() => {}); throw new Error('scanner_response_bound') }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
/** Call from the isolated collector process; never a protection callback. */
export async function pollScannerMirrors(db, { env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const policies = read(db, 'scanner_mirror_profiles_json')
  if (!Array.isArray(policies) || !policies.length || policies.length > 512) return { configured: false, reason: 'comparison_profiles_unconfigured', orderAuthority: false }
  schema(db)
  const outcomes = []
  for (const [source, prefix] of [['cpp-scan-tick', 'SCANNER_TICK'], ['cpp-scan-timeframe', 'SCANNER_TIMEFRAME']]) {
    const url = env[`${prefix}_URL`], secret = env[`${prefix}_SECRET`]
    if (!url || !secret) { outcomes.push({ source, status: 'unconfigured' }); continue }
    const old = db.prepare('SELECT * FROM scanner_mirror_cursors WHERE source=?').get(source)
    try {
      let page = await scannerPage(url, secret, old?.cursor || 0, fetchImpl)
      if (old && page.instanceId !== old.instance_id) page = await scannerPage(url, secret, 0, fetchImpl)
      const result = recordScannerMirrorPage(db, source, page, { policies, now: typeof now === 'function' ? now() : now })
      outcomes.push({ source, ...result, latestCursor: page.latestCursor, backlog: result.cursor < page.latestCursor })
    } catch { outcomes.push({ source, status: 'unavailable', reason: 'scanner_read_or_contract_failed' }) }
  }
  return { configured: true, outcomes, orderAuthority: false }
}
