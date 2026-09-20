// node --test agent/services/tick-segments.test.js — PR-I: the keeper's half
// of the sealed-segment read path, against a FAKE SIDECAR (a real http
// server speaking the two routes cpp-exec serves, including its 1 MiB clamp,
// its bearer gate and its bad_name / not_found refusals).
//
// What it proves: the listing drops a name that is not the sealed pattern
// before it can be used as a path; a multi-chunk pull reassembles BYTE-EXACT
// and verifies through the real decoder; a corrupt chunk is refused and the
// file is DELETED (never handed to research); an interrupted pull leaves no
// half file under the real name; syncSegments skips what is already cached
// at the right length and honours its bounds; the research route pulls and
// then runs; and with nothing reachable anywhere the 409 is still honest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB } from '../db.js'
import { encodeHeader, encodeRecord, FLAGS, KIND } from '../lib/tick-segment.js'
import {
  listSidecarSegments, pullSegment, syncSegments, syncFromSidecars, cachedSegments,
  tickSegmentsView, segmentCacheDir, SEGMENT_NAME_RE, MAX_CHUNK, CACHE_DIR_ENV,
  verifySegmentFile, listAllSides, recordsInBytes, syncInWorker,
} from './tick-segments.js'
import { startTickResearchJobWithSync, _resetTickResearchJobs, NO_SEGMENTS_ANYWHERE } from './tick-research-run.js'

const SECRET = 'test-exec-secret'
const NAME_A = 'seg-1757548800000-000001.tks'
const NAME_B = 'seg-1757548900000-000002.tks'

/** A valid sealed segment: header + n two-sided quote records, all checksummed. */
function makeSegment(n = 40, { startedMs = 1_757_548_800_000, symbolId = 7 } = {}) {
  const parts = [encodeHeader({ environment: 'demo', generation: 1, startedMs, feedId: 'fake-sidecar' })]
  for (let i = 0; i < n; i++) {
    const bid = 100_000 + Math.round(Math.sin(i / 5) * 40 + (i % 3))
    parts.push(encodeRecord({
      recvMs: startedMs + i * 100, seq: i + 1, symbolId, bid, ask: bid + 10,
      flags: FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED,
      kind: KIND.QUOTE, generation: 1,
    }))
  }
  return Buffer.concat(parts)
}

/**
 * The sidecar's two routes. `chunkCap` is the server-side clamp (cpp-exec
 * clamps at 1 MiB; a small cap here forces the multi-chunk path).
 * `corruptFrom` flips one byte in every chunk from that offset on.
 */
function fakeSidecar({ files = new Map(), chunkCap = 64, openBytes = 0, enabled = true, corruptFrom = null, extraListNames = [], chunkOverride = null } = {}) {
  const calls = { list: 0, chunk: 0 }
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.headers.authorization !== `Bearer ${SECRET}`) return json(401, { error: 'unauthorized' })
    if (url.pathname === '/tick-segments') {
      calls.list++
      if (!enabled) return json(200, { enabled: false, reason: 'TICK_SPOOL_PATH not set' })
      const segments = [...files.entries()].sort(([a], [b]) => a < b ? -1 : 1)
        .map(([name, buf], i) => ({ name, bytes: buf.length, sealedAtMs: 1_757_549_000_000 + i, index: i + 1 }))
      for (const name of extraListNames) segments.push({ name, bytes: 10, sealedAtMs: 1, index: 99 })
      return json(200, { enabled: true, spool: '/data/tick', segments, openBytes, truncated: false, maxChunkBytes: MAX_CHUNK })
    }
    if (url.pathname === '/tick-segment') {
      calls.chunk++
      const name = url.searchParams.get('name') || ''
      const offset = Number(url.searchParams.get('offset') || 0)
      const len = Number(url.searchParams.get('len') || MAX_CHUNK)
      if (!SEGMENT_NAME_RE.test(name)) return json(400, { error: 'bad_name' })
      const buf = files.get(name)
      if (!buf) return json(404, { error: 'not_found' })
      if (offset >= buf.length) return json(200, { name, totalBytes: buf.length, offset, len: 0, eof: true, b64: '' })
      const take = Math.min(len, chunkCap, buf.length - offset)
      const slice = Buffer.from(buf.subarray(offset, offset + take))
      if (corruptFrom != null && offset >= corruptFrom) slice[0] = slice[0] ^ 0xFF
      const body = { name, totalBytes: buf.length, offset, len: slice.length, eof: offset + take >= buf.length, b64: slice.toString('base64') }
      return json(200, chunkOverride ? chunkOverride(body, { name, offset, buf }) : body)
    }
    json(404, { error: 'not found' })
  })
  return new Promise(resolve => srv.listen(0, () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`, calls, files,
    close: () => srv.close(),
  })))
}

const dep = (s) => ({ base: s.base, secret: SECRET })
const tmp = (p) => mkdtempSync(join(tmpdir(), p))

test('PR-I: the listing is read over the wire, and a name that is not the sealed pattern is dropped before it can be used as a path', async () => {
  const files = new Map([[NAME_A, makeSegment(10)], [NAME_B, makeSegment(20)]])
  const s = await fakeSidecar({ files, extraListNames: ['../../etc/passwd', 'seg-1-1.tks', 'seg-1757548800000-000001.tks.open'] })
  try {
    const list = await listSidecarSegments(dep(s))
    assert.equal(list.ok, true); assert.equal(list.enabled, true); assert.equal(list.spool, '/data/tick')
    assert.deepEqual(list.segments.map(x => x.name), [NAME_A, NAME_B], 'RED if a hostile name from the sidecar survives into a path')
    assert.equal(list.segments[0].bytes, files.get(NAME_A).length)
    // an unauthenticated read gets nothing
    const noAuth = await listSidecarSegments({ base: s.base, secret: 'wrong' })
    assert.equal(noAuth.ok, false); assert.match(noAuth.error, /401/)
  } finally { s.close() }
})

test('PR-I: a sidecar with no recorder answers enabled:false — reported, not an error', async () => {
  const s = await fakeSidecar({ enabled: false })
  try {
    const list = await listSidecarSegments(dep(s))
    assert.equal(list.ok, true); assert.equal(list.enabled, false)
    assert.match(list.reason, /TICK_SPOOL_PATH/)
    const sync = await syncSegments(dep(s), tmp('tick-cache-'))
    assert.deepEqual([sync.pulled, sync.skipped, sync.enabled], [0, 0, false])
  } finally { s.close() }
})

test('PR-I: a multi-chunk pull reassembles BYTE-EXACT, verifies through the decoder, and leaves no .part behind', async () => {
  const body = makeSegment(40)               // 64 + 40*40 = 1,664 bytes
  const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 64 })
  const dest = tmp('tick-cache-')
  try {
    const r = await pullSegment(dep(s), NAME_A, dest)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.bytes, body.length)
    assert.equal(r.records, 40)
    assert.ok(s.calls.chunk >= 2, `expected a multi-chunk pull, got ${s.calls.chunk} call(s)`)
    assert.deepEqual(readFileSync(join(dest, NAME_A)), body, 'byte-exact')
    assert.deepEqual(readdirSync(dest), [NAME_A], 'no .part left behind')
  } finally { s.close() }
})

test('PR-I: nothing exists under the REAL name while the transfer is in flight, and an interrupted pull leaves no file at all', async () => {
  const body = makeSegment(40)
  const dest = tmp('tick-cache-')
  const seen = []
  // The sidecar reports, on every chunk after the first, whether the real
  // name is already on disk in the keeper's cache — that is the `.part`
  // rename being load-bearing, observed rather than assumed.
  const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 64 })
  const fetchProbe = async (url, opts) => {
    if (String(url).includes('/tick-segment?')) seen.push(existsSync(join(dest, NAME_A)))
    return globalThis.fetch(url, opts)
  }
  try {
    const r = await pullSegment({ base: s.base, secret: SECRET, fetch: fetchProbe }, NAME_A, dest)
    assert.equal(r.ok, true, r.error)
    assert.ok(seen.length >= 2, `expected a multi-chunk pull, got ${seen.length}`)
    assert.deepEqual([...new Set(seen)], [false], 'RED if the .part rename is removed: the half file is visible under the real name mid-transfer')
    assert.deepEqual(readFileSync(join(dest, NAME_A)), body)
  } finally { s.close() }

  // an interrupted transfer (the sidecar stops answering) leaves NOTHING
  const dead = tmp('tick-cache-')
  const s2 = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 64 })
  let calls = 0
  const dropAfterFirst = async (url, opts) => {
    if (String(url).includes('/tick-segment?') && ++calls > 1) throw new Error('connection reset')
    return globalThis.fetch(url, opts)
  }
  try {
    const r = await pullSegment({ base: s2.base, secret: SECRET, fetch: dropAfterFirst }, NAME_A, dead)
    assert.equal(r.ok, false)
    assert.deepEqual(readdirSync(dead), [], 'no half file under the real name and no .part left behind')
  } finally { s2.close() }
})

test('PR-I: a corrupt chunk is REFUSED and the file deleted — a bad segment never reaches research', async () => {
  const body = makeSegment(40)
  // corruption from the second chunk on: the header decodes, a record CRC does not
  const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 64, corruptFrom: 64 })
  const dest = tmp('tick-cache-')
  try {
    const r = await pullSegment(dep(s), NAME_A, dest)
    assert.equal(r.ok, false)
    assert.match(r.error, /verify_failed/)
    assert.equal(existsSync(join(dest, NAME_A)), false, 'RED if the post-pull verification is removed: a corrupt segment survives under the real name')
    assert.equal(existsSync(join(dest, `${NAME_A}.part`)), false)
    assert.deepEqual(readdirSync(dest), [])
  } finally { s.close() }
})

test('PR-I: a corrupt HEADER is refused the same way, and a name the sidecar does not have is a reported failure', async () => {
  const s = await fakeSidecar({ files: new Map([[NAME_A, Buffer.alloc(200)]]), chunkCap: 1024 })
  const dest = tmp('tick-cache-')
  try {
    const bad = await pullSegment(dep(s), NAME_A, dest)
    assert.equal(bad.ok, false); assert.match(bad.error, /verify_failed: bad header/)
    assert.equal(existsSync(join(dest, NAME_A)), false)
    const missing = await pullSegment(dep(s), NAME_B, dest)
    assert.equal(missing.ok, false); assert.match(missing.error, /404/)
    // a hostile name is refused by the keeper before any request is made
    const hostile = await pullSegment(dep(s), '../../etc/passwd', dest)
    assert.equal(hostile.ok, false); assert.equal(hostile.error, 'bad_name')
    assert.deepEqual(readdirSync(dest), [])
  } finally { s.close() }
})

test('PR-I: syncSegments skips a segment already cached at the right length, re-pulls one whose length differs, and honours its bounds', async () => {
  const a = makeSegment(10), b = makeSegment(20, { startedMs: 1_757_548_900_000 })
  const s = await fakeSidecar({ files: new Map([[NAME_A, a], [NAME_B, b]]), chunkCap: 4096, openBytes: 777 })
  const dest = tmp('tick-cache-')
  try {
    const first = await syncSegments(dep(s), dest)
    assert.deepEqual([first.pulled, first.skipped, first.bytes], [2, 0, a.length + b.length])
    assert.equal(first.openBytes, 777); assert.equal(first.spool, '/data/tick')
    const callsAfterFirst = s.calls.chunk

    const second = await syncSegments(dep(s), dest)
    assert.deepEqual([second.pulled, second.skipped], [0, 2], 'already present at the right byte length')
    assert.equal(s.calls.chunk, callsAfterFirst, 'no bytes moved on the second sync')

    // a cached file whose length disagrees is pulled again
    writeFileSync(join(dest, NAME_A), Buffer.alloc(11))
    const third = await syncSegments(dep(s), dest)
    assert.deepEqual([third.pulled, third.skipped], [1, 1])
    assert.deepEqual(readFileSync(join(dest, NAME_A)), a)

    // bounds: one segment at a time, and a byte budget below the next file
    const bounded = tmp('tick-cache-')
    const one = await syncSegments(dep(s), bounded, { maxSegments: 1 })
    assert.deepEqual([one.pulled, one.truncated], [1, true])
    const tiny = tmp('tick-cache-')
    const none = await syncSegments(dep(s), tiny, { maxBytes: 10 })
    assert.deepEqual([none.pulled, none.truncated], [0, true])
    assert.deepEqual(readdirSync(tiny), [])
  } finally { s.close() }
})

test('PR-I: cachedSegments and GET /state/tick-segments read what is there without pulling anything', async () => {
  const a = makeSegment(10)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a], [NAME_B, makeSegment(20)]]), openBytes: 42 })
  const dest = tmp('tick-cache-')
  try {
    writeFileSync(join(dest, NAME_A), a)
    writeFileSync(join(dest, 'not-a-segment.txt'), 'x')
    assert.deepEqual([...cachedSegments(dest).keys()], [NAME_A])
    const before = s.calls.chunk
    const view = await tickSegmentsView({ sides: [{ name: 'fake', base: s.base }], secret: SECRET, cacheDir: dest })
    assert.equal(view.cacheDir, dest)
    assert.deepEqual(view.cache.map(c => c.name), [NAME_A])
    assert.equal(view.cacheBytes, a.length)
    assert.equal(view.sides.length, 1)
    assert.deepEqual([view.sides[0].reachable, view.sides[0].enabled, view.sides[0].segments, view.sides[0].cached], [true, true, 2, 1])
    assert.equal(view.sides[0].openBytes, 42)
    assert.equal(view.sides[0].newest, NAME_B)
    assert.equal(s.calls.chunk, before, 'the view pulls nothing')
  } finally { s.close() }
})

test('PR-I: the cache directory default — the cache env, else the research dir, else the tmpdir', () => {
  assert.equal(segmentCacheDir({ [CACHE_DIR_ENV]: '/mnt/cache' }), '/mnt/cache')
  assert.equal(segmentCacheDir({ TICK_SEGMENTS_DIR: '/mnt/research' }), '/mnt/research')
  assert.equal(segmentCacheDir({ [CACHE_DIR_ENV]: '/mnt/cache', TICK_SEGMENTS_DIR: '/mnt/research' }), '/mnt/cache')
  assert.equal(segmentCacheDir({}), join(tmpdir(), 'tick-segments'))
  assert.equal(segmentCacheDir({ TICK_SEGMENTS_DIR: '   ' }), join(tmpdir(), 'tick-segments'))
})

test('PR-I: the research action pulls the sidecar\'s segments into the cache and THEN runs the job', async (t) => {
  _resetTickResearchJobs()
  t.after(() => _resetTickResearchJobs())
  const db = initDB(':memory:')
  const a = makeSegment(300)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 4096 })
  const empty = tmp('tick-empty-')
  const cache = tmp('tick-cache-')
  try {
    const r = await startTickResearchJobWithSync(db, { stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 } }, {
      segmentsDir: empty,
      cacheDir: cache,
      listAll: () => listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
      sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
    })
    assert.equal(r.status, 202, JSON.stringify(r.body))
    assert.equal(r.body.segmentsDir, cache)
    assert.equal(r.body.segments, 1)
    assert.equal(r.body.sync.pulled, 1)
    assert.equal(r.body.sync.bytes, a.length)
    assert.deepEqual(readFileSync(join(cache, NAME_A)), a, 'the cached segment is the sidecar\'s bytes')
    assert.equal(statSync(join(cache, NAME_A)).size, a.length)
    // a second POST while that job runs is refused BEFORE anything is pulled
    let syncCalls = 0
    const second = await startTickResearchJobWithSync(db, {}, {
      segmentsDir: tmp('tick-empty-'), cacheDir: tmp('tick-cache-'),
      listAll: async () => { syncCalls++; return { segments: 0, bytes: 0, records: 0, truncated: false, reachable: 0, sides: [] } },
      sync: async () => { syncCalls++; return { pulled: 0, skipped: 0, bytes: 0, truncated: false, sides: [] } },
    })
    assert.equal(second.status, 409); assert.equal(second.body.error, 'research_running')
    assert.equal(syncCalls, 0, 'a second POST must not move bytes it will not use')
    for (let i = 0; i < 400; i++) {
      const { tickResearchJob } = await import('./tick-research-run.js')
      const j = tickResearchJob(r.body.jobId)
      if (j && j.state !== 'running') { assert.equal(j.state, 'done', j.error || ''); break }
      await new Promise(res => setTimeout(res, 25))
    }
  } finally { s.close() }
})

test('PR-I: with nothing reachable anywhere the 409 is still honest — and it says what each side reported', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const s = await fakeSidecar({ files: new Map(), enabled: false })
  const empty = tmp('tick-empty-')
  const cache = tmp('tick-cache-')
  try {
    const r = await startTickResearchJobWithSync(db, {}, {
      segmentsDir: empty,
      cacheDir: cache,
      listAll: () => listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
      sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error, 'no_segments')
    assert.equal(r.body.where, NO_SEGMENTS_ANYWHERE)
    assert.match(r.body.localWhere, /demo sidecar volume/)
    assert.equal(r.body.sync.pulled, 0)
    assert.equal(r.body.sync.sides[0].enabled, false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 0, 'no trial written on a refusal')
    // an unreachable sidecar is the same honest refusal, with the error named
    const gone = await startTickResearchJobWithSync(db, {}, {
      segmentsDir: empty, cacheDir: cache,
      listAll: () => listAllSides({ sides: [{ name: 'gone', base: 'http://127.0.0.1:1' }], secret: SECRET }),
      sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'gone', base: 'http://127.0.0.1:1' }], secret: SECRET }),
    })
    assert.equal(gone.status, 409); assert.equal(gone.body.error, 'no_segments')
    assert.ok(gone.body.sync.sides[0].error, 'the unreachable side names its error')
  } finally { s.close() }
})

test('PR-I: a local segment directory short-circuits the pull entirely (no sidecar call)', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const dir = tmp('tick-local-')
  writeFileSync(join(dir, NAME_A), makeSegment(300))
  let syncCalls = 0
  try {
    const r = await startTickResearchJobWithSync(db, { stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 } }, {
      segmentsDir: dir,
      cacheDir: tmp('tick-cache-'),
      listAll: async () => { syncCalls++; return { segments: 0, bytes: 0, records: 0, truncated: false, reachable: 0, sides: [] } },
      sync: async () => { syncCalls++; return { pulled: 0, skipped: 0, bytes: 0, truncated: false, sides: [] } },
    })
    assert.equal(r.status, 202)
    assert.equal(r.body.segmentsDir, dir)
    assert.equal(r.body.sync, undefined)
    assert.equal(syncCalls, 0, 'nothing is pulled when the keeper can already read segments')
  } finally { _resetTickResearchJobs() }
})

// ---------------------------------------------------------------------------
// The checker round (15-09-2026). Each test below names the finding it pins.

test('checker m-5: a chunk declaring more than MAX_CHUNK is refused BEFORE it is decoded or buffered', async () => {
  const body = makeSegment(40)
  const huge = 'A'.repeat(4) // the payload never has to be built: the refusal is on the declared length
  const s = await fakeSidecar({
    files: new Map([[NAME_A, body]]), chunkCap: 4096,
    chunkOverride: (b) => ({ ...b, len: (8 << 20), b64: huge }),
  })
  const dest = tmp('tick-cache-')
  try {
    const r = await pullSegment(dep(s), NAME_A, dest)
    assert.equal(r.ok, false)
    assert.match(r.error, /above the 1048576-byte cap/, 'RED if the cap is only requested and never enforced on the answer')
    assert.deepEqual(readdirSync(dest), [], 'nothing written')
  } finally { s.close() }
})

test('checker m-4: the three pull guards are pinned — a declared length that disagrees, a short total at eof, and no progress without eof', async () => {
  const body = makeSegment(40)
  // (a) len says one thing, b64 decodes to another
  {
    const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 4096, chunkOverride: (b) => ({ ...b, len: b.len - 1 }) })
    const dest = tmp('tick-cache-')
    try {
      const r = await pullSegment(dep(s), NAME_A, dest)
      assert.equal(r.ok, false); assert.match(r.error, /chunk length \d+ != declared \d+/)
      assert.deepEqual(readdirSync(dest), [])
    } finally { s.close() }
  }
  // (b) eof arrives having served fewer bytes than totalBytes claimed
  {
    const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 4096, chunkOverride: (b) => ({ ...b, totalBytes: b.totalBytes + 5000 }) })
    const dest = tmp('tick-cache-')
    try {
      const r = await pullSegment(dep(s), NAME_A, dest)
      assert.equal(r.ok, false); assert.match(r.error, /pulled \d+ of \d+ bytes/)
      assert.deepEqual(readdirSync(dest), [], 'a short segment never lands under the real name')
    } finally { s.close() }
  }
  // (c) len:0 with eof:false — without the guard this spins for ever
  {
    const s = await fakeSidecar({ files: new Map([[NAME_A, body]]), chunkCap: 4096, chunkOverride: (b) => ({ ...b, len: 0, b64: '', eof: false }) })
    const dest = tmp('tick-cache-')
    try {
      const r = await Promise.race([
        pullSegment(dep(s), NAME_A, dest),
        new Promise((_, rej) => setTimeout(() => rej(new Error('pullSegment did not return — the no-progress guard is gone')), 5000)),
      ])
      assert.equal(r.ok, false); assert.match(r.error, /no progress at offset 0/)
      assert.deepEqual(readdirSync(dest), [])
    } finally { s.close() }
  }
})

test('checker M-2: a cached segment of the RIGHT LENGTH but the wrong bytes is re-pulled, not skipped for ever', async () => {
  const a = makeSegment(40)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 4096 })
  const dest = tmp('tick-cache-')
  try {
    // a same-length corruption: one byte flipped inside a record
    const corrupt = Buffer.from(a)
    corrupt[200] = corrupt[200] ^ 0xFF
    writeFileSync(join(dest, NAME_A), corrupt)
    assert.equal(statSync(join(dest, NAME_A)).size, a.length, 'the length matches, which is exactly why length alone was not enough')
    assert.equal(verifySegmentFile(join(dest, NAME_A)).ok, false)

    const r = await syncSegments(dep(s), dest)
    assert.equal(r.pulled, 1, 'RED if presence is judged by byte length alone: the corrupt copy is skipped for ever')
    assert.equal(r.skipped, 0)
    assert.equal(r.corrupt.length, 1)
    assert.equal(r.corrupt[0].name, NAME_A); assert.equal(r.corrupt[0].repulled, true)
    assert.deepEqual(readFileSync(join(dest, NAME_A)), a, 'the bytes on disk are now the sidecar\'s')
    assert.equal(verifySegmentFile(join(dest, NAME_A)).records, 40)

    // and a good copy is still skipped on the next pass
    const again = await syncSegments(dep(s), dest)
    assert.deepEqual([again.pulled, again.skipped, again.corrupt.length], [0, 1, 0])
  } finally { s.close() }
})

test('checker M-2: a corrupt cached segment the sidecar no longer lists is REPORTED, never silently counted as present', async () => {
  const s = await fakeSidecar({ files: new Map(), chunkCap: 4096 })
  const dest = tmp('tick-cache-')
  try {
    const corrupt = Buffer.from(makeSegment(40))
    corrupt[200] = corrupt[200] ^ 0xFF
    writeFileSync(join(dest, NAME_B), corrupt)
    const r = await syncSegments(dep(s), dest)
    assert.equal(r.corrupt.length, 1)
    assert.equal(r.corrupt[0].name, NAME_B)
    assert.equal(r.corrupt[0].repulled, false, 'the sidecar cannot repair it — say so rather than trust it')
    assert.ok(existsSync(join(dest, NAME_B)), 'an operator-populated file is reported, not deleted by this path')
  } finally { s.close() }
})

test('checker M-1: more records than the cap are refused 413 from the LISTING, with nothing pulled and an empty cache', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const a = makeSegment(400)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a], [NAME_B, makeSegment(400, { startedMs: 1_757_548_900_000 })]]), chunkCap: 4096 })
  const cache = tmp('tick-cache-')
  try {
    const listed = await listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET })
    assert.equal(listed.segments, 2); assert.equal(listed.records, 800)
    assert.equal(recordsInBytes(a.length), 400)
    const chunkCallsBefore = s.calls.chunk
    const r = await startTickResearchJobWithSync(db, {}, {
      segmentsDir: tmp('tick-empty-'), cacheDir: cache, maxRecords: 100,
      listAll: () => listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
      sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
    })
    assert.equal(r.status, 413)
    assert.equal(r.body.error, 'too_many_records')
    assert.equal(r.body.records, 800); assert.equal(r.body.maxRecords, 100)
    assert.equal(r.body.sync.pulled, 0, 'RED if the sync runs before the cap is checked')
    assert.deepEqual(readdirSync(cache), [], 'not one byte on disk')
    assert.equal(s.calls.chunk, chunkCallsBefore, 'not one chunk requested')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 0)
  } finally { s.close(); _resetTickResearchJobs() }
})

test('checker m-3: two concurrent research POSTs — exactly one pulls, the other is 409, and neither leaves a failed entry or a stray .part', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const a = makeSegment(300)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 512 })
  const cache = tmp('tick-cache-')
  const empty = tmp('tick-empty-')
  try {
    const call = () => startTickResearchJobWithSync(db, { stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 } }, {
      segmentsDir: empty, cacheDir: cache,
      listAll: () => listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
      sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
    })
    const chunksBefore = s.calls.chunk
    const [r1, r2] = await Promise.all([call(), call()])
    const statuses = [r1.status, r2.status].sort()
    assert.deepEqual(statuses, [202, 409], `got ${JSON.stringify(statuses)}`)
    const ok = r1.status === 202 ? r1 : r2
    const busy = r1.status === 202 ? r2 : r1
    assert.equal(busy.body.error, 'research_running')
    assert.equal(ok.body.sync.pulled, 1)
    for (const side of ok.body.sync.sides) assert.deepEqual(side.failed, [])
    // EXACTLY ONE pull's worth of chunks moved. Without the lock claimed
    // before the sync, both callers pull the same segment and this doubles —
    // the status pair alone cannot see that, because the loser is still 409
    // (it just loses later, after paying for the bytes).
    const perPull = Math.ceil(a.length / 512)
    assert.equal(s.calls.chunk - chunksBefore, perPull, 'RED if the job slot is claimed only after the sync: both callers pulled')
    assert.deepEqual(readdirSync(cache), [NAME_A], 'no stray .part left behind')
    assert.deepEqual(readFileSync(join(cache, NAME_A)), a)
  } finally { s.close(); _resetTickResearchJobs() }
})

test('checker B-1: the sync runs in a WORKER — syncInWorker pulls and verifies off this thread', async () => {
  const a = makeSegment(300)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 4096 })
  const dest = tmp('tick-cache-')
  try {
    const r = await syncInWorker(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET })
    assert.equal(r.pulled, 1, r.error)
    assert.equal(r.bytes, a.length)
    assert.deepEqual(readFileSync(join(dest, NAME_A)), a, 'the worker wrote the sidecar\'s exact bytes')
    // a worker file that cannot load is a reported failure, never a throw
    const bad = await syncInWorker(dest, { sides: [], workerFile: new URL('./no-such-worker.js', import.meta.url) })
    assert.equal(bad.pulled, 0); assert.ok(bad.error)
  } finally { s.close() }
})

test('checker m-3: two concurrent pulls of the SAME segment into the same directory both succeed byte-exact — neither deletes the other\'s temp file', async () => {
  // The route now claims its slot before syncing, so it cannot produce this
  // race any more — but pullSegment and syncSegments are a public API and a
  // shared `<name>.part` is a bug wherever it is called from. Before the
  // pid+uuid suffix one caller\'s `finally` rmSync deleted the other\'s temp
  // file and that caller saw a phantom ENOENT on its rename.
  const a = makeSegment(200)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 256 })
  const dest = tmp('tick-cache-')
  try {
    const [r1, r2] = await Promise.all([
      pullSegment(dep(s), NAME_A, dest),
      pullSegment(dep(s), NAME_A, dest),
    ])
    assert.equal(r1.ok, true, r1.error)
    assert.equal(r2.ok, true, r2.error)
    assert.equal(r1.bytes, a.length); assert.equal(r2.bytes, a.length)
    assert.deepEqual(readFileSync(join(dest, NAME_A)), a)
    assert.deepEqual(readdirSync(dest), [NAME_A], 'no stray .part survives either pull')
  } finally { s.close() }
})

test('checker M-1, follow-up: a SECOND request after a successful sync is not refused 413 by double-counting the cache against the listing', async () => {
  _resetTickResearchJobs()
  const db = initDB(':memory:')
  const a = makeSegment(300)
  const s = await fakeSidecar({ files: new Map([[NAME_A, a]]), chunkCap: 4096 })
  const cache = tmp('tick-cache-')
  const empty = tmp('tick-empty-')
  const opts = () => ({
    segmentsDir: empty, cacheDir: cache,
    // a cap that comfortably fits ONE copy of the segment but not two
    maxRecords: 450,
    listAll: () => listAllSides({ sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
    sync: (dest) => syncFromSidecars(dest, { sides: [{ name: 'fake', base: s.base }], secret: SECRET }),
  })
  try {
    const first = await startTickResearchJobWithSync(db, { stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 } }, opts())
    assert.equal(first.status, 202, JSON.stringify(first.body).slice(0, 300))
    assert.equal(first.body.sync.pulled, 1)
    _resetTickResearchJobs()
    // the cache now holds exactly what the sidecar lists
    assert.deepEqual(readdirSync(cache), [NAME_A])
    const second = await startTickResearchJobWithSync(db, { stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 } }, opts())
    assert.equal(second.status, 202, `RED if the pre-flight sums the listing and the cache: ${JSON.stringify(second.body).slice(0, 300)}`)
    assert.equal(second.body.sync.pulled, 0, 'already cached and verified')
    assert.equal(second.body.sync.skipped, 1)
    // …and a cached segment the sidecar does NOT list still counts towards the cap
    writeFileSync(join(cache, NAME_B), makeSegment(300, { startedMs: 1_757_548_900_000 }))
    _resetTickResearchJobs()
    const third = await startTickResearchJobWithSync(db, {}, opts())
    assert.equal(third.status, 413, 'a cache-only segment is added to the listed total, not ignored')
    assert.equal(third.body.records, 600)
  } finally { s.close(); _resetTickResearchJobs() }
})

// ---- PR-EX checker, 20-09-2026: what `maxSegments` actually bounds --------
// The bound is on WHAT THE CACHE HOLDS of the sidecar's oldest segments, not
// on how many GETs this particular run makes. Two ways it used to mean the
// wrong thing, both measured by the checker on the production shape
// (4 sealed 64 MiB segments, two sides): a warm cache made the run pull the
// segments BEYOND the bound (128 MiB moved and then sliced away by the
// replay, which reads the oldest two either way), and each side was handed
// the bound whole, so two sides pulled up to twice what was asked for.
test('PR-EX: a cache already holding the oldest N counts against maxSegments — nothing beyond the bound is pulled', async () => {
  const a = makeSegment(10), b = makeSegment(20, { startedMs: 1_757_548_900_000 })
  const NAME_C = 'seg-1757549000000-000003.tks'
  const s = await fakeSidecar({ files: new Map([[NAME_A, a], [NAME_B, b], [NAME_C, makeSegment(30, { startedMs: 1_757_549_000_000 })]]) })
  const dest = tmp('tick-cache-warm-')
  try {
    // seed the cache with the OLDEST two, exactly as a previous bounded run leaves it
    writeFileSync(join(dest, NAME_A), a)
    writeFileSync(join(dest, NAME_B), b)
    const before = s.calls.chunk
    const r = await syncSegments(dep(s), dest, { maxSegments: 2 })
    assert.equal(r.pulled, 0, 'RED if the skip-if-cached test runs before the bound: segment 3 is pulled')
    assert.equal(r.skipped, 2); assert.equal(r.taken, 2); assert.equal(r.truncated, true)
    assert.equal(s.calls.chunk, before, 'not one chunk requested')
    assert.deepEqual(readdirSync(dest).sort(), [NAME_A, NAME_B])
  } finally { s.close() }
})

test('PR-EX: the segment bound is shared ACROSS sides, like the byte budget — two sides under maxSegments 2 pull two, not four', async () => {
  const one = await fakeSidecar({ files: new Map([[NAME_A, makeSegment(10)], [NAME_B, makeSegment(20, { startedMs: 1_757_548_900_000 })]]) })
  const NAME_C = 'seg-1757549000000-000003.tks'
  const NAME_D = 'seg-1757549100000-000004.tks'
  const two = await fakeSidecar({ files: new Map([[NAME_C, makeSegment(30, { startedMs: 1_757_549_000_000 })], [NAME_D, makeSegment(40, { startedMs: 1_757_549_100_000 })]]) })
  const dest = tmp('tick-cache-sides-')
  try {
    const r = await syncFromSidecars(dest, { sides: [{ name: 'one', base: one.base }, { name: 'two', base: two.base }], secret: SECRET, maxSegments: 2 })
    assert.equal(r.pulled, 2, 'RED if each side gets the whole bound: 4 pulled')
    assert.equal(r.taken, 2)
    assert.deepEqual(readdirSync(dest).sort(), [NAME_A, NAME_B])
    assert.equal(r.sides[1].pulled, 0, 'the second side is asked, and takes nothing — the bound is spent')
    // unbounded is unchanged: every side pulls what it lists
    const all = tmp('tick-cache-sides2-')
    const u = await syncFromSidecars(all, { sides: [{ name: 'one', base: one.base }, { name: 'two', base: two.base }], secret: SECRET })
    assert.equal(u.pulled, 4); assert.deepEqual(readdirSync(all).sort(), [NAME_A, NAME_B, NAME_C, NAME_D].sort())
  } finally { one.close(); two.close() }
})
