// ---------------------------------------------------------------------------
// agent/services/tick-segments.js — PR-I: the keeper's half of the
// sealed-segment READ path (docs/plan-execution-audit-2026-09-11.md §12.3
// "segment locality"; docs/owner-principles-plan-2026-09-11.md §8 item 4).
//
// THE BLOCKAGE THIS CLOSES (measured 15-09-2026): the demo sidecar had
// recorded 4.59 M tick events into /data/tick with 2 sealed segments
// (0.13 GB) and the Node keeper could not read a byte of it — the spool is a
// volume on the sidecar — so POST /actions/tick-research could only answer
// 409 no_segments and REPLAY_PASSED was unreachable. The sidecar now serves
// GET /tick-segments (the sealed listing) and GET /tick-segment (a bounded
// range, base64 in JSON); this module pulls them into a keeper-local cache
// directory that the research path points TICK_SEGMENTS_DIR-style at.
//
// READ PATH ONLY. Nothing here places an order, moves a stage, changes a
// threshold or touches a trading code path.
//
// WHAT IS TRUSTED AND WHAT IS NOT. The sidecar's listing is DATA, not
// instruction: every name is re-checked against the same pattern the sidecar
// enforces before it is used as a filename here, so a compromised or buggy
// sidecar cannot name a file outside the cache directory. And a pulled
// segment is VERIFIED before research may read it — the decoder
// (lib/tick-segment.js) checks the header magic, version and CRC and every
// record's CRC, and a segment that fails is deleted and reported. A chunk
// that arrives corrupt must not become a trial.
// ---------------------------------------------------------------------------
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, readdirSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { readSegment, HEADER_BYTES, RECORD_BYTES } from '../lib/tick-segment.js'
import { execBaseFor, EXEC_HOST_LIVE, EXEC_HOST_DEMO } from '../lib/exec-engine.js'

/** The sidecar's own per-call cap (cpp-exec/src/tick_recorder.hpp kMaxChunkBytes). */
export const MAX_CHUNK = 1 << 20
/** The sidecar's own sealed naming — re-checked here, never assumed. */
export const SEGMENT_NAME_RE = /^seg-[0-9]{13}-[0-9]{6}\.tks$/
/**
 * Bounds on ONE sync, and they are the keeper's own. 2 GiB was the sidecar's
 * spool cap when this was written; that cap is now TICK_SPOOL_CAP_BYTES on the
 * sidecar (GW-CAP), and a larger spool is pulled across successive syncs —
 * cached segments are skipped without charging this byte budget, and
 * `truncated` says there is more. 500 is the sidecar's list cap
 * (kMaxListEntries, oldest first).
 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const DEFAULT_MAX_SEGMENTS = 500
export const CACHE_DIR_ENV = 'TICK_SEGMENTS_CACHE_DIR'

/**
 * Where pulled segments land. `TICK_SEGMENTS_CACHE_DIR` if set, else
 * `TICK_SEGMENTS_DIR` (the directory research already reads — so a pull
 * fills exactly the place the operator pointed at), else
 * `<os.tmpdir()>/tick-segments`. The tmpdir default is deliberate: a cache
 * is reconstructible from the sidecar at any time, so nothing is lost if the
 * container replaces it, and it cannot fill a data volume nobody sized for
 * it. An operator who wants it kept sets one of the two variables.
 */
export function segmentCacheDir(env = process.env) {
  const explicit = String(env[CACHE_DIR_ENV] || '').trim()
  if (explicit) return explicit
  const research = String(env.TICK_SEGMENTS_DIR || '').trim()
  if (research) return research
  return join(tmpdir(), 'tick-segments')
}

/**
 * V3 R1: whether this keeper's segment cache outlives a Node redeploy, so a
 * reader of GET /state/tick-segments never takes `cached` for a second kept
 * copy. The default (<os.tmpdir()>/tick-segments) goes with the container:
 * the gateway spool is then the only kept copy of a sealed segment, and what
 * the spool retires or loses at a restart is gone. A directory an operator
 * set may sit on a volume; Node cannot see its mounts, so it says unknown.
 */
export function cacheDurability(cacheDir, tmp = tmpdir()) {
  const dir = resolve(String(cacheDir || '.'))
  const t = resolve(tmp)
  if (dir === t || dir.startsWith(t + sep)) {
    return { kept: false, reason: `under os.tmpdir() (${t}): not kept across a Node redeploy, so the gateway spool is the only kept copy of a sealed segment` }
  }
  return { kept: null, reason: `set by ${CACHE_DIR_ENV} or TICK_SEGMENTS_DIR; whether that directory is on a volume is not reported to Node` }
}

/** The sidecar sides to ask, deduped — one entry when both hosts resolve to one base. */
export function segmentSides() {
  const live = execBaseFor(EXEC_HOST_LIVE)
  const demo = execBaseFor(EXEC_HOST_DEMO)
  if (live === demo) return [{ name: 'cpp_exec', base: live }]
  return [{ name: 'cpp_exec', base: live }, { name: 'cpp_exec_demo', base: demo }]
}

function deps(d = {}) {
  return {
    base: d.base ?? execBaseFor(),
    secret: d.secret ?? process.env.EXEC_SECRET ?? '',
    fetch: d.fetch ?? globalThis.fetch,
    timeoutMs: d.timeoutMs ?? 20_000,
  }
}

async function getJson(d, path) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), d.timeoutMs)
  try {
    const res = await d.fetch(d.base + path, { signal: ctrl.signal, headers: { authorization: `Bearer ${d.secret}` } })
    const body = await res.json().catch(() => null)
    return { status: res.status, ok: res.ok, body }
  } catch (err) {
    return { status: 0, ok: false, body: null, error: err?.message || String(err) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * The sidecar's sealed segments. Never throws:
 * `{ ok, enabled, spool, segments, openBytes, truncated, error }`. `enabled`
 * false is the sidecar SAYING it has no recorder (no TICK_SPOOL_PATH) —
 * different from `ok:false`, which is "it did not answer".
 */
export async function listSidecarSegments(d = {}) {
  const dd = deps(d)
  const r = await getJson(dd, '/tick-segments')
  if (!r.ok || !r.body || typeof r.body !== 'object') {
    return { ok: false, enabled: null, segments: [], openBytes: 0, truncated: false, error: r.error || `sidecar ${r.status} on /tick-segments` }
  }
  if (r.body.enabled === false) {
    return { ok: true, enabled: false, segments: [], openBytes: 0, truncated: false, reason: String(r.body.reason || 'recorder disabled') }
  }
  const segments = (Array.isArray(r.body.segments) ? r.body.segments : [])
    // The listing is data: a name that is not the sealed pattern is dropped
    // here, before it can ever be used as a path.
    .filter(s => s && SEGMENT_NAME_RE.test(String(s.name || '')))
    .map(s => ({ name: String(s.name), bytes: Number(s.bytes) || 0, sealedAtMs: Number(s.sealedAtMs) || 0, index: Number(s.index) || 0 }))
  return {
    ok: true,
    enabled: true,
    spool: typeof r.body.spool === 'string' ? r.body.spool : null,
    segments,
    openBytes: Number(r.body.openBytes) || 0,
    truncated: r.body.truncated === true,
    maxChunkBytes: Number(r.body.maxChunkBytes) || MAX_CHUNK,
  }
}

/**
 * One sealed segment, chunked at MAX_CHUNK, into `<destDir>/<name>`.
 *
 * ATOMIC AND PRIVATE: the bytes go to `<name>.<pid>.<uuid>.part` and are
 * only RENAMED onto the real name once the transfer reports eof — an
 * interrupted pull leaves a `.part`, never a half file under the name
 * research globs for. The pid+uuid suffix is checker m-3: two concurrent
 * pulls of the same segment shared one `<name>.part`, and each one's
 * `rmSync` in its `finally` deleted whatever was there, so one caller saw a
 * phantom ENOENT on its rename. Each pull now owns its temp file.
 *
 * VERIFIED: after the rename the file is decoded with lib/tick-segment.js
 * (header magic/version/CRC, then every record's CRC). A segment that fails
 * is DELETED and reported — a corrupt chunk must never become a trial.
 */
export async function pullSegment(d, name, destDir) {
  const dd = deps(d)
  if (!SEGMENT_NAME_RE.test(String(name || ''))) return { ok: false, name: String(name), error: 'bad_name' }
  mkdirSync(destDir, { recursive: true })
  const finalPath = join(destDir, name)
  const partPath = `${finalPath}.${process.pid}.${randomUUID().slice(0, 8)}.part`
  let fd = null
  try {
    fd = openSync(partPath, 'w')
    let offset = 0
    let total = null
    for (;;) {
      const r = await getJson(dd, `/tick-segment?name=${encodeURIComponent(name)}&offset=${offset}&len=${MAX_CHUNK}`)
      if (!r.ok || !r.body || typeof r.body !== 'object') {
        return { ok: false, name, error: r.error || `sidecar ${r.status} on /tick-segment` }
      }
      total = Number(r.body.totalBytes) || 0
      const declared = Number(r.body.len) || 0
      // The cap is ENFORCED on the answer, not only requested (checker m-5):
      // before this, a sidecar answering with 8 MiB was fully decoded and
      // buffered and only the CRC rejected it — the cap has to bound what we
      // are willing to hold, which means refusing before the decode.
      if (!Number.isFinite(declared) || declared < 0 || declared > MAX_CHUNK) {
        return { ok: false, name, error: `chunk declares ${declared} bytes, above the ${MAX_CHUNK}-byte cap` }
      }
      const chunk = Buffer.from(String(r.body.b64 || ''), 'base64')
      if (chunk.length !== declared) return { ok: false, name, error: `chunk length ${chunk.length} != declared ${declared}` }
      if (chunk.length > 0) writeSync(fd, chunk)
      offset += chunk.length
      if (r.body.eof === true) break
      // No progress and no eof would spin for ever.
      if (chunk.length === 0) return { ok: false, name, error: `no progress at offset ${offset}` }
      if (offset > DEFAULT_MAX_BYTES) return { ok: false, name, error: 'segment exceeds the transfer cap' }
    }
    closeSync(fd)
    fd = null
    if (total != null && offset !== total) return { ok: false, name, error: `pulled ${offset} of ${total} bytes` }
    renameSync(partPath, finalPath)
  } catch (err) {
    return { ok: false, name, error: err?.message || String(err) }
  } finally {
    if (fd != null) { try { closeSync(fd) } catch { /* best effort */ } }
    try { rmSync(partPath, { force: true }) } catch { /* best effort */ }
  }
  // Verification, after the rename: a file that does not decode is deleted,
  // never handed to research.
  try {
    const seg = readSegment(readFileSync(finalPath))
    if (!seg.header || seg.truncated) {
      rmSync(finalPath, { force: true })
      return { ok: false, name, error: seg.header ? 'verify_failed: torn or corrupt record' : 'verify_failed: bad header' }
    }
    return { ok: true, name, bytes: statSync(finalPath).size, records: seg.records.length, path: finalPath }
  } catch (err) {
    try { rmSync(finalPath, { force: true }) } catch { /* best effort */ }
    return { ok: false, name, error: `verify_failed: ${err?.message || String(err)}` }
  }
}

/**
 * Decode one segment file with the real decoder — header magic, version and
 * CRC, then EVERY record's CRC. `{ ok, records, bytes, error }`. CPU-bound:
 * ~1 s per 64 MiB, which is why every caller on the research path runs it in
 * the sync worker thread, never on the keeper's event loop (checker B-1).
 */
export function verifySegmentFile(path) {
  try {
    const buf = readFileSync(path)
    const seg = readSegment(buf)
    if (!seg.header) return { ok: false, bytes: buf.length, error: 'bad header' }
    if (seg.truncated) return { ok: false, bytes: buf.length, records: seg.records.length, error: 'torn or corrupt record' }
    return { ok: true, bytes: buf.length, records: seg.records.length }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * The sealed segments already in the cache, by name → bytes.
 *
 * `verify: true` counts a file as present only when it DECODES (checker
 * M-2): the byte length alone was the presence test, so a cached file of the
 * right length but the wrong bytes was skipped for ever and research replayed
 * a truncated stream — permanently, and reachable in the normal deployment
 * because the cache defaults to `TICK_SEGMENTS_DIR`, an operator-populated
 * directory whose files this code never wrote and never checked. A file that
 * fails is NOT deleted here (it may be the operator's own, and deleting it
 * is not this function's call) — it is left out of the map, so the sync
 * re-pulls and overwrites it, and it is reported in `corrupt`.
 */
export function cachedSegments(destDir, { verify = false } = {}) {
  const out = new Map()
  const corrupt = []
  try {
    for (const f of readdirSync(destDir)) {
      if (!SEGMENT_NAME_RE.test(f)) continue
      const path = join(destDir, f)
      try {
        const bytes = statSync(path).size
        if (verify) {
          const v = verifySegmentFile(path)
          if (!v.ok) { corrupt.push({ name: f, bytes, error: v.error }); continue }
        }
        out.set(f, bytes)
      } catch { /* vanished */ }
    }
  } catch { /* no cache dir yet */ }
  out.corrupt = corrupt
  return out
}

/**
 * Pull every sealed segment the sidecar has that the cache does not already
 * hold at the right byte length, bounded by `maxBytes` and `maxSegments`.
 * `{ pulled, skipped, bytes, truncated, failed, segments, enabled, error }`.
 * `truncated` is true when the sidecar's own list was capped OR a bound cut
 * this run short — so a caller can say "there is more" honestly.
 */
export async function syncSegments(d, destDir, { maxBytes = DEFAULT_MAX_BYTES, maxSegments = DEFAULT_MAX_SEGMENTS, verifyCache = true } = {}) {
  const list = await listSidecarSegments(d)
  if (!list.ok) return { pulled: 0, skipped: 0, bytes: 0, truncated: false, failed: [], corrupt: [], enabled: null, error: list.error }
  if (list.enabled === false) return { pulled: 0, skipped: 0, bytes: 0, truncated: false, failed: [], corrupt: [], enabled: false, reason: list.reason }
  // Presence is DECODES-and-has-the-right-length, not length alone (M-2).
  const have = cachedSegments(destDir, { verify: verifyCache })
  const corrupt = have.corrupt || []
  let pulled = 0, skipped = 0, bytes = 0, truncated = list.truncated
  const failed = []
  // `taken` is what the CACHE HOLDS of the sidecar's oldest segments, pulled
  // or already there — which is what `maxSegments` bounds. Checker, 20-09-2026:
  // the skip-if-cached test used to run BEFORE the bound, so a cache already
  // holding the oldest two under `maxSegments: 2` went on to pull segments 3
  // and 4 — 128 MiB moved on the production shape and then sliced away by the
  // replay, which reads the oldest two either way. Counting the skips against
  // the bound is what makes "pull the oldest two" mean the same thing on a
  // cold cache and a warm one.
  let taken = 0
  for (const s of list.segments) {
    if (taken >= maxSegments) { truncated = true; break }
    if (have.get(s.name) === s.bytes) { skipped++; taken++; continue }
    if (bytes + s.bytes > maxBytes) { truncated = true; break }
    const r = await pullSegment(d, s.name, destDir)
    if (r.ok) { pulled++; taken++; bytes += r.bytes }
    else failed.push({ name: s.name, error: r.error })
  }
  // A cached file that failed verification and the sidecar no longer lists
  // cannot be repaired from here — reported, never silently trusted.
  const listedNames = new Set(list.segments.map(x => x.name))
  return {
    pulled, skipped, bytes, truncated, failed, enabled: true, taken,
    corrupt: corrupt.map(c => ({ ...c, repulled: listedNames.has(c.name) })),
    segments: list.segments.length, openBytes: list.openBytes, spool: list.spool ?? null,
  }
}

/**
 * Sync from every sidecar side into one cache directory. Sides are asked in
 * order and their results reported separately; a side that is unreachable or
 * has no recorder is a REPORTED fact, never an exception.
 */
export async function syncFromSidecars(destDir, { sides = segmentSides(), fetch: fetchImpl, secret, timeoutMs, maxBytes, maxSegments, verifyCache = true } = {}) {
  const out = { destDir, pulled: 0, skipped: 0, bytes: 0, truncated: false, corrupt: 0, taken: 0, sides: [] }
  let budget = maxBytes ?? DEFAULT_MAX_BYTES
  // The SEGMENT bound is shared across the sides the same way the byte budget
  // is. Checker, 20-09-2026: it used to be handed to each side whole, so a
  // two-side deployment under `maxSegments: 2` pulled up to four segments and
  // the replay then used two of them. `undefined` keeps each side on its own
  // default, which is the unbounded path this function had before.
  let segmentBudget = maxSegments
  for (const side of sides) {
    const r = await syncSegments({ base: side.base, fetch: fetchImpl, secret, timeoutMs }, destDir, { maxBytes: budget, ...(segmentBudget === undefined ? {} : { maxSegments: Math.max(0, segmentBudget) }), verifyCache })
    if (segmentBudget !== undefined) segmentBudget = Math.max(0, segmentBudget - (r.taken ?? 0))
    out.taken += r.taken ?? 0
    out.pulled += r.pulled
    out.skipped += r.skipped
    out.bytes += r.bytes
    out.corrupt += (r.corrupt || []).length
    budget = Math.max(0, budget - r.bytes)
    if (r.truncated) out.truncated = true
    out.sides.push({ side: side.name, enabled: r.enabled, segments: r.segments ?? 0, pulled: r.pulled, skipped: r.skipped, bytes: r.bytes, failed: r.failed ?? [], corrupt: r.corrupt ?? [], ...(r.error ? { error: r.error } : {}), ...(r.reason ? { reason: r.reason } : {}) })
  }
  return out
}

/** Records a segment file of `bytes` holds, from its size alone (no decode). */
export function recordsInBytes(bytes) {
  return Math.max(0, Math.floor((Number(bytes) - HEADER_BYTES) / RECORD_BYTES))
}

/**
 * What every side LISTS, before a byte is moved — the pre-flight behind the
 * research route's 413 (checker M-1). Pulling first and refusing afterwards
 * moved up to 2 GiB to disk for a request the record cap was always going to
 * refuse; the listing is one small GET per side and answers the same
 * question.
 */
export async function listAllSides({ sides = segmentSides(), fetch: fetchImpl, secret, timeoutMs } = {}) {
  const out = { segments: 0, bytes: 0, records: 0, truncated: false, reachable: 0, names: [], recordsPerSegment: [], sides: [] }
  for (const side of sides) {
    const r = await listSidecarSegments({ base: side.base, fetch: fetchImpl, secret, timeoutMs })
    const bytes = r.segments.reduce((a, s) => a + s.bytes, 0)
    const records = r.segments.reduce((a, s) => a + recordsInBytes(s.bytes), 0)
    if (r.ok) out.reachable++
    out.segments += r.segments.length
    out.bytes += bytes
    out.records += records
    if (r.truncated) out.truncated = true
    // The NAMES matter, not just the count: the cache may already hold some
    // of these, and summing "what the sides list" with "what the cache holds"
    // double-counts exactly the segments a previous sync pulled.
    // PR-EX: the PER-SEGMENT record counts travel with the names, in the
    // same order. The research route's 413 has to tell the operator how many
    // segments fit under the cap, and an aggregate cannot answer that when
    // the segments differ in size (the last one sealed is routinely short).
    for (const seg of r.segments) if (!out.names.includes(seg.name)) { out.names.push(seg.name); out.recordsPerSegment.push(recordsInBytes(seg.bytes)) }
    out.sides.push({ side: side.name, reachable: r.ok, enabled: r.enabled, segments: r.segments.length, bytes, records, truncated: r.truncated, ...(r.error ? { error: r.error } : {}), ...(r.reason ? { reason: r.reason } : {}) })
  }
  return out
}

export const SYNC_WORKER_FILE = new URL('./tick-segments-worker.js', import.meta.url)

/**
 * `syncFromSidecars` in a WORKER THREAD (checker B-1).
 *
 * The pull's per-segment VERIFICATION is `readFileSync` + a full CRC scan —
 * measured at ~1 s per 64 MiB, and the first version ran it on the keeper's
 * event loop: `/health` went 0.0009 s → 1.017 s → 0.0006 s across a single
 * 64 MiB pull, on the process that also runs the heartbeat, the guard sync
 * and the protection sweep. Awaiting only network I/O was true of the code
 * and false of the effect. The whole sync — list, pull, decode, verify —
 * now happens off the loop; the main thread awaits a message.
 */
export function syncInWorker(destDir, { sides = segmentSides(), secret = process.env.EXEC_SECRET ?? '', timeoutMs, maxBytes, maxSegments, workerFile = SYNC_WORKER_FILE } = {}) {
  return new Promise((resolve) => {
    let worker
    try {
      worker = new Worker(workerFile, { workerData: { destDir, sides, secret, timeoutMs, maxBytes, maxSegments } })
    } catch (err) {
      resolve({ destDir, pulled: 0, skipped: 0, bytes: 0, truncated: false, corrupt: 0, sides: [], error: `sync worker did not start: ${err?.message || String(err)}` })
      return
    }
    let settled = false
    const done = (v) => { if (settled) return; settled = true; try { worker.terminate() } catch { /* best effort */ } resolve(v) }
    worker.on('message', (msg) => {
      if (msg && msg.ok && msg.result) done(msg.result)
      else done({ destDir, pulled: 0, skipped: 0, bytes: 0, truncated: false, corrupt: 0, sides: [], error: msg?.error || 'sync worker returned no result' })
    })
    worker.on('error', (err) => done({ destDir, pulled: 0, skipped: 0, bytes: 0, truncated: false, corrupt: 0, sides: [], error: err?.message || String(err) }))
    worker.on('exit', (code) => done({ destDir, pulled: 0, skipped: 0, bytes: 0, truncated: false, corrupt: 0, sides: [], error: `sync worker exited with code ${code} before reporting` }))
  })
}

/**
 * The read-only view behind GET /state/tick-segments. V3 R1: each side also
 * carries `list` — every sealed segment the sidecar lists right now, by name
 * and bytes, so a before/after pair of GET bodies grades the recovery drill
 * (T1) segment by segment — and, given `db`, `manifest`: what the heartbeat's
 * segment manifest has recorded for that side (services/tick-segment-manifest.js),
 * including the segments that are gone and why, and the persistence and
 * retention verdicts.
 */
export async function tickSegmentsView({ sides = segmentSides(), fetch: fetchImpl, secret, timeoutMs, cacheDir = segmentCacheDir(), db = null, nowMs = Date.now() } = {}) {
  let manifest = null
  if (db) {
    try {
      const { segmentManifestView } = await import('./tick-segment-manifest.js')
      manifest = segmentManifestView(db, { sides: [...new Set(['cpp_exec', 'cpp_exec_demo', ...sides.map(s => s.name)])], nowMs })
    } catch (err) { manifest = { error: err?.message || String(err) } }
  }
  const cache = cachedSegments(cacheDir)
  const out = {
    at: new Date().toISOString(),
    cacheDir,
    cacheExists: existsSync(cacheDir),
    cacheDurability: cacheDurability(cacheDir),
    cache: [...cache.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => ({ name, bytes })),
    cacheBytes: [...cache.values()].reduce((a, b) => a + b, 0),
    sides: [],
    // The view does NOT decode: verification is a full CRC scan (~1 s per
    // 64 MiB) and this route runs on the keeper's event loop (checker B-1).
    // `cached` here is a byte-length match, which is a hint, not the
    // presence test — the sync re-checks by decoding, in its worker.
    note: 'read-only: what each sidecar has sealed and what this keeper has cached. Cached counts match by byte length only (no decode on this route); POST /actions/tick-research verifies by decoding, in a worker, and re-pulls anything that fails.',
  }
  for (const side of sides) {
    const r = await listSidecarSegments({ base: side.base, fetch: fetchImpl, secret, timeoutMs })
    out.sides.push({
      side: side.name,
      reachable: r.ok,
      enabled: r.enabled,
      spool: r.spool ?? null,
      segments: r.segments.length,
      bytes: r.segments.reduce((a, s) => a + s.bytes, 0),
      openBytes: r.openBytes,
      truncated: r.truncated,
      newest: r.segments.length ? r.segments[r.segments.length - 1].name : null,
      cached: r.segments.filter(s => cache.get(s.name) === s.bytes).length,
      list: r.segments.map(s => ({ name: s.name, bytes: s.bytes, sealedAtMs: s.sealedAtMs || null })), // 0 = the sidecar sent no mtime
      ...(manifest?.sides?.[side.name] ? { manifest: manifest.sides[side.name] } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    })
  }
  if (manifest) {
    out.manifestNote = manifest.note ?? null
    if (manifest.error) out.manifestError = manifest.error
    if (manifest.policyErrors?.length) out.durabilityPolicyErrors = manifest.policyErrors
    // A side the manifest has recorded that this deployment no longer asks
    // (one sidecar serving both hosts) is still shown, never dropped.
    const asked = new Set(out.sides.map(s => s.side))
    for (const [name, m] of Object.entries(manifest.sides || {})) {
      if (!asked.has(name) && (m.listed > 0 || m.goneTotal > 0 || m.lastListing)) out.sides.push({ side: name, reachable: null, note: 'recorded by the manifest; not asked on this view', manifest: m })
    }
  }
  return out
}
