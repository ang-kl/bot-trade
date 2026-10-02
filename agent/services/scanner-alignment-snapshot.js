// ---------------------------------------------------------------------------
// agent/services/scanner-alignment-snapshot.js — the fresh, non-secret input
// scripts/prepare-scanner-alignment.mjs needs (02-10-2026, C·2).
//
// WHY A ROUTE. The builder is offline and refuses a snapshot older than five
// minutes. Its inputs live in Node's database (profile registry, per-account
// symbol maps, mirrored tick observations) and on the private network (the two
// native scanners' own readings). No existing read route returns them, so a
// one-off export would be stale before it could be applied. This reads them
// again on demand.
//
// READ ONLY. It writes nothing, selects nothing, registers nothing. The only
// outbound call is a plain GET /watchdog to the timeframe scanner, bounded by
// scannerRequest's 2 s timeout and 256 KiB limit. No secret is returned.
//
// NOTHING IS GUESSED. A part that cannot be read is null and named in
// `missing`, so the builder refuses it instead of building on a default.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { getState } from '../db.js'
import { scannerProfileRegistry } from './scanner-profile-registry.js'
import { scannerRequest } from './scanner-feed.js'

const UNIVERSE_FILE = new URL('../config/momentum-universe.json', import.meta.url)
const FEED_MAX_AGE_MS = 300_000
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

export function declaredUniverse(file = UNIVERSE_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return Object.entries(raw).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v)).flatMap(([, v]) => v.map(String))
}

/** Latest mirrored tick observation per (feed account, host), with its profile hash. */
export function observedTickFeeds(db, now) {
  let rows = []
  try {
    rows = db.prepare(`SELECT detail, observed_ms FROM scanner_comparisons
      WHERE source = 'cpp-scan-tick' AND observed_ms >= ? ORDER BY observed_ms DESC LIMIT 2000`).all(now - FEED_MAX_AGE_MS)
  } catch { return [] }
  const feeds = new Map()
  for (const r of rows) {
    let d; try { d = JSON.parse(r.detail) } catch { continue }
    const feed = d?.feed, hash = d?.profileHash
    if (!feed?.accountId || !feed?.host || typeof hash !== 'string') continue
    const key = `${feed.host}|${feed.accountId}`
    if (!feeds.has(key)) feeds.set(key, { accountId: String(feed.accountId), host: String(feed.host), profileHash: hash, observedAt: iso(r.observed_ms) })
  }
  return [...feeds.values()]
}

export async function nativeTimeframeObservation(env, fetchImpl) {
  if (!env.SCANNER_TIMEFRAME_URL || !env.SCANNER_TIMEFRAME_SECRET) return { value: null, reason: 'timeframe_scanner_not_configured' }
  try {
    const w = await scannerRequest(env.SCANNER_TIMEFRAME_URL, env.SCANNER_TIMEFRAME_SECRET, '/watchdog', null, fetchImpl)
    const body = w?.body ?? w
    const cells = body?.cells
    if (!cells || !Number.isInteger(body?.observedAtMs) || !Array.isArray(body?.work) || body?.workComplete !== true) {
      return { value: null, reason: 'timeframe_watchdog_incomplete' }
    }
    const pending = body.work.reduce((s, x) => s + (Number.isFinite(x?.pending) ? x.pending : 0), 0)
    return { value: { observedAt: iso(body.observedAtMs), cells: { count: cells.count, capacity: cells.capacity, stale: cells.stale }, pending }, reason: null }
  } catch (e) {
    return { value: null, reason: `timeframe_watchdog_unreadable:${String(e.message).slice(0, 80)}` }
  }
}

export async function buildScannerAlignmentSnapshot(db, { now = Date.now(), env = process.env, fetchImpl = fetch, universeFile } = {}) {
  const missing = []
  const registry = scannerProfileRegistry(db)
  if (!registry.valid) missing.push('registry_invalid')
  const accounts = db.prepare('SELECT account_id, is_live FROM accounts ORDER BY account_id').all()
    .map(a => ({ account_id: String(a.account_id), is_live: a.is_live ? 1 : 0 }))
  const maps = {}
  for (const a of accounts) {
    let raw = null; try { raw = JSON.parse(getState(db, `symbol_id_map:${a.account_id}`) || 'null') } catch { raw = null }
    if (!raw || typeof raw.map !== 'object' || raw.map == null) { missing.push(`map_missing:${a.account_id.slice(-4)}`); continue }
    maps[a.account_id] = { accountId: raw.accountId == null ? null : String(raw.accountId), builtAt: raw.builtAt ?? null, map: raw.map,
      ...(raw.complete !== undefined ? { complete: raw.complete } : {}), ...(raw.sourceCount !== undefined ? { sourceCount: raw.sourceCount } : {}) }
    if (maps[a.account_id].accountId == null) missing.push(`map_account_unnamed:${a.account_id.slice(-4)}`)
  }
  const tickFeeds = observedTickFeeds(db, now)
  if (!tickFeeds.length) missing.push('no_tick_feed_observed_in_five_minutes')
  const native = await nativeTimeframeObservation(env, fetchImpl)
  if (!native.value) missing.push(native.reason)
  return {
    readAt: iso(now),
    revision: registry.revision,
    selected: getState(db, 'ctrader_account_id') ?? null,
    profiles: registry.profiles,
    accounts,
    maps,
    tickFeeds,
    universe: declaredUniverse(universeFile),
    nativeTimeframe: native.value,
    missing,
    orderAuthority: false,
    note: 'Read-only. Feed and native observations older than five minutes are refused by the builder. Nothing here is a registry-write payload.',
  }
}
