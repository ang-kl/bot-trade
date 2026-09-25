// node --test agent/routes/tick-readiness-routes.test.js — P5's three routes
// over a real express app: the readiness read (all accounts and one), the
// signals read, the validation importer's refusal path (PR-H set the
// thresholds, so an unknown trial answers 400 trial_not_found and writes
// nothing), and PR-H's research action.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { getAccountState } from '../services/account-registry.js'
import { ENGINE_STATUS_KEY } from '../services/entry-mode.js'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from '../test-support/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureSegment, syntheticSegment } from '../services/tick-research-run.test.js'
import { _resetTickResearchJobs } from '../services/tick-research-run.js'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('46130058', 0, 1, 'active', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)').run('42993489', 1, 1, 'active', '5268549')
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({ db, close: () => s.close(), url: (p) => `http://127.0.0.1:${s.address().port}${p}` }))
  })
}

test('GET /state/tick-readiness lists every account with classed blockers; ?account narrows to one; GET /state/tick-signals answers', async () => {
  const s = await server()
  try {
    const all = await fetch(s.url('/state/tick-readiness')).then(r => r.json())
    assert.equal(all.accounts.length, 2); assert.equal(all.readyCount, 0)
    assert.ok(all.accounts.every(a => a.ready === false && a.blockedReasons.length > 0 && Array.isArray(a.readiness)))
    const one = await fetch(s.url('/state/tick-readiness?account=42993489')).then(r => r.json())
    assert.equal(one.accountId, '…3489'); assert.equal(one.environment, 'live'); assert.ok(one.blockedReasons.includes('validation_stage'))
    const sig = await fetch(s.url('/state/tick-signals')).then(r => r.json())
    assert.equal(sig.count, 0); assert.deepEqual(sig.signals, [])
  } finally { s.close() }
})

test('POST /actions/tick-validation is past thresholds_unset (PR-H set them): an unknown trial refuses 400 trial_not_found and writes nothing; a missing stage is 400', async () => {
  const s = await server()
  try {
    const bad = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058' }) })
    assert.equal(bad.status, 400)
    const r = await fetch(s.url('/actions/tick-validation'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: '46130058', stage: 'replay_passed', evidence: { trialId: 'x' } }) })
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.ok, false); assert.equal(body.reason, 'trial_not_found', 'RED if the checked-in thresholds went back to null (thresholds_unset)')
    assert.equal(getAccountState(s.db, '46130058', ENGINE_STATUS_KEY), null)
  } finally { s.close() }
})

test('PR-H: POST /actions/tick-research answers 409 no_segments with WHERE the data is when TICK_SEGMENTS_DIR is unset, and starts a worker job (202) that imports when it names a segment directory', async () => {
  _resetTickResearchJobs()
  const s = await server()
  const saved = process.env.TICK_SEGMENTS_DIR
  const savedCache = process.env.TICK_SEGMENTS_CACHE_DIR
  try {
    delete process.env.TICK_SEGMENTS_DIR
    // PR-I: the route now asks the sidecar before refusing, so the cache it
    // would pull into is pinned to an empty directory for this test.
    process.env.TICK_SEGMENTS_CACHE_DIR = mkdtempSync(join(tmpdir(), 'tick-cache-route-'))
    const no = await fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageA: true }) })
    assert.equal(no.status, 409)
    const nb = await no.json()
    // PR-I: `where` now names that the SIDECAR was asked too and had nothing;
    // the pre-PR-I text (the local options) is kept as `localWhere`.
    assert.equal(nb.error, 'no_segments'); assert.match(nb.where, /no sidecar side with a tick recorder/); assert.match(nb.where, /GET \/state\/tick-segments/)
    assert.match(nb.localWhere, /demo sidecar volume/); assert.match(nb.localWhere, /TICK_SEGMENTS_DIR/); assert.match(nb.localWhere, /scripts\/tick-research\.mjs/)
    assert.equal(nb.sync.pulled, 0, 'nothing was pulled from an unreachable sidecar')
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 0, 'never a fake trial')
    const dir = mkdtempSync(join(tmpdir(), 'tick-seg-route-'))
    writeFileSync(join(dir, 'seg-000001.tks'), fixtureSegment({ symbolId: 3 }))
    process.env.TICK_SEGMENTS_DIR = dir
    const ok = await fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 } }) })
    assert.equal(ok.status, 202)
    const started = await ok.json()
    assert.equal(started.ok, true); assert.equal(started.state, 'running'); assert.ok(started.jobId)
    let job = null
    for (let i = 0; i < 400; i++) { job = await fetch(s.url(`/state/tick-research-job?id=${started.jobId}`)).then(r => r.json()); if (job.state !== 'running') break; await new Promise(r => setTimeout(r, 25)) }
    assert.equal(job.state, 'done', JSON.stringify(job).slice(0, 300))
    const body = job.result
    assert.equal(body.ok, true); assert.equal(body.trials.length, 1); assert.equal(body.inserted, 1); assert.equal(body.trials[0].replay.ok, false)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 1)
    const view = await fetch(s.url('/state/tick-research')).then(r => r.json())
    assert.equal(view.trials[0].trialId, body.trialIds[0])
    const unknown = await fetch(s.url('/state/tick-research-job?id=nope'))
    assert.equal(unknown.status, 404)
    const all = await fetch(s.url('/state/tick-research-job')).then(r => r.json())
    assert.equal(all.running, null); assert.equal(all.jobs[0].jobId, started.jobId)
  } finally {
    if (saved != null) process.env.TICK_SEGMENTS_DIR = saved; else delete process.env.TICK_SEGMENTS_DIR
    if (savedCache != null) process.env.TICK_SEGMENTS_CACHE_DIR = savedCache; else delete process.env.TICK_SEGMENTS_CACHE_DIR
    s.close()
  }
})

test('PR-I: GET /state/tick-segments reads the cache and each sidecar side without pulling anything', async () => {
  const s = await server()
  const savedCache = process.env.TICK_SEGMENTS_CACHE_DIR
  try {
    const cache = mkdtempSync(join(tmpdir(), 'tick-cache-view-'))
    writeFileSync(join(cache, 'seg-1757548800000-000001.tks'), fixtureSegment({ symbolId: 3 }))
    writeFileSync(join(cache, 'not-a-segment.txt'), 'x')
    process.env.TICK_SEGMENTS_CACHE_DIR = cache
    const v = await fetch(s.url('/state/tick-segments')).then(r => r.json())
    assert.equal(v.cacheDir, cache)
    assert.deepEqual(v.cache.map(c => c.name), ['seg-1757548800000-000001.tks'], 'only the sealed pattern is counted as a cached segment')
    assert.ok(v.cacheBytes > 0)
    assert.ok(Array.isArray(v.sides) && v.sides.length >= 1)
    // no sidecar is listening in the test process: reachable is false, and
    // that is REPORTED rather than thrown
    assert.equal(v.sides[0].reachable, false)
    assert.ok(v.sides[0].error)
  } finally {
    if (savedCache != null) process.env.TICK_SEGMENTS_CACHE_DIR = savedCache; else delete process.env.TICK_SEGMENTS_CACHE_DIR
    s.close()
  }
})

test('PR-H checker M-1: while a research job over a large segment runs, GET /health on the same app answers within 100 ms and a second POST is 409 research_running', async () => {
  _resetTickResearchJobs()
  const s = await server()
  const saved = process.env.TICK_SEGMENTS_DIR
  try {
    const dir = mkdtempSync(join(tmpdir(), 'tick-seg-route-big-'))
    writeFileSync(join(dir, 'seg-000001.tks'), syntheticSegment(300_000))
    process.env.TICK_SEGMENTS_DIR = dir
    const post = (b) => fetch(s.url('/actions/tick-research'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const first = await post({ stageA: false, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 }, sim: { latencyMs: 60, minTargetToCost: 1 } })
    assert.equal(first.status, 202)
    const { jobId } = await first.json()
    const second = await post({ stageA: false })
    assert.equal(second.status, 409); assert.equal((await second.json()).error, 'research_running')
    const t0 = performance.now()
    const h = await fetch(s.url('/health'))
    const ms = performance.now() - t0
    assert.equal(h.status, 200)
    assert.ok(ms < 100, `GET /health took ${ms.toFixed(0)} ms while the job ran (RED when the replay runs on the event loop: 48.8 s measured)`)
    const running = await fetch(s.url(`/state/tick-research-job?id=${jobId}`)).then(r => r.json())
    assert.equal(running.state, 'running', 'the job was still running when /health answered — the latency was measured against real work')
    let job = null
    for (let i = 0; i < 2400; i++) { job = await fetch(s.url(`/state/tick-research-job?id=${jobId}`)).then(r => r.json()); if (job.state !== 'running') break; await new Promise(r => setTimeout(r, 25)) }
    assert.equal(job.state, 'done', JSON.stringify(job).slice(0, 300)); assert.equal(job.result.manifest.events, 300_000)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM tick_trials').get().n, 1)
  } finally { if (saved != null) process.env.TICK_SEGMENTS_DIR = saved; else delete process.env.TICK_SEGMENTS_DIR; s.close() }
})

// ---------------------------------------------------------------------------
// PR-I checker B-1. The M-1 test above proves the event loop stays free while
// the JOB runs. It starts sampling AFTER the job has started, so it never
// covered the SYNC that now runs first — and the sync's per-segment
// verification (readFileSync + a full CRC scan, ~1 s per 64 MiB) was on the
// keeper's event loop: /health measured 0.0009 s → 1.017 s → 0.0006 s across
// one 64 MiB pull. This samples /health from the moment the POST is issued.
test('PR-I checker B-1: GET /health stays under 100 ms WHILE a multi-megabyte segment sync runs (the pull AND its verification are off the event loop)', async () => {
  _resetTickResearchJobs()
  const { encodeHeader, encodeRecord, FLAGS, KIND } = await import('../lib/tick-segment.js')
  // ~16 MiB of valid, checksummed records: big enough that verifying it on
  // the loop blocks for hundreds of milliseconds.
  const RECORDS = 419_000
  const header = encodeHeader({ environment: 'demo', generation: 1, startedMs: 1_757_548_800_000, feedId: 'b1' })
  const rec = encodeRecord({ recvMs: 1_757_548_800_000, seq: 1, symbolId: 7, bid: 100_000, ask: 100_010, flags: FLAGS.BID_PRESENT | FLAGS.BID_CHANGED | FLAGS.ASK_PRESENT | FLAGS.ASK_CHANGED, kind: KIND.QUOTE, generation: 1 })
  const segment = Buffer.alloc(header.length + RECORDS * rec.length)
  header.copy(segment, 0)
  for (let i = 0; i < RECORDS; i++) rec.copy(segment, header.length + i * rec.length)
  const NAME = 'seg-1757548800000-000001.tks'
  const SECRET = 'b1-secret'
  const CHUNK = 1 << 20

  // The fake sidecar PRE-BUILDS every response body, so serving costs this
  // process almost nothing — what the sampler measures is the keeper's own
  // work, not the fake sidecar's.
  const bodies = new Map()
  for (let off = 0; off < segment.length; off += CHUNK) {
    const slice = segment.subarray(off, Math.min(off + CHUNK, segment.length))
    bodies.set(off, JSON.stringify({ name: NAME, totalBytes: segment.length, offset: off, len: slice.length, eof: off + slice.length >= segment.length, b64: slice.toString('base64') }))
  }
  const listBody = JSON.stringify({ enabled: true, spool: '/data/tick', segments: [{ name: NAME, bytes: segment.length, sealedAtMs: 1_757_549_000_000, index: 1 }], openBytes: 0, truncated: false, maxChunkBytes: CHUNK })
  const { createServer } = await import('node:http')
  const sidecar = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}') }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/tick-segments') return res.end(listBody)
    const off = Number(url.searchParams.get('offset') || 0)
    return res.end(bodies.get(off) ?? JSON.stringify({ name: NAME, totalBytes: segment.length, offset: off, len: 0, eof: true, b64: '' }))
  })
  await new Promise(r => sidecar.listen(0, r))
  const sidecarBase = `http://127.0.0.1:${sidecar.address().port}`

  const s = await server()
  const savedUrl = process.env.EXEC_URL, savedSecret = process.env.EXEC_SECRET
  const savedDir = process.env.TICK_SEGMENTS_DIR, savedCache = process.env.TICK_SEGMENTS_CACHE_DIR
  try {
    // the real default path: no injected sync, no injected listing
    process.env.EXEC_URL = sidecarBase
    process.env.EXEC_SECRET = SECRET
    delete process.env.TICK_SEGMENTS_DIR
    process.env.TICK_SEGMENTS_CACHE_DIR = mkdtempSync(join(tmpdir(), 'tick-cache-b1-'))

    // TWO samplers, and no sleep between requests. The first draft slept 5 ms
    // between /health calls and took its start stamp AFTER the sleep, so a
    // 200 ms block that landed inside the gap was invisible: the mutation
    // putting the sync back on the event loop left the test GREEN. A request
    // is now always in flight, and a 5 ms interval timer independently
    // records how late it fires — event-loop lag cannot hide from that.
    let sampling = true
    let worst = 0, samples = 0
    const sampler = (async () => {
      while (sampling) {
        const t0 = performance.now()
        try { await fetch(s.url('/health')).then(r => r.json()) } catch { /* server closing */ }
        worst = Math.max(worst, performance.now() - t0)
        samples++
      }
    })()
    let worstLag = 0, lagSamples = 0
    let lastTick = performance.now()
    const lagTimer = setInterval(() => {
      const now = performance.now()
      worstLag = Math.max(worstLag, now - lastTick - 5)
      lastTick = now
      lagSamples++
    }, 5)

    const posted = await fetch(s.url('/actions/tick-research'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageA: false, dryRun: true, params: { rangeEvents: 64, momentumEvents: 16, maxSpread: 200 } }),
    })
    const body = await posted.json()
    sampling = false
    clearInterval(lagTimer)
    await sampler

    assert.equal(posted.status, 202, JSON.stringify(body).slice(0, 400))
    assert.equal(body.sync.pulled, 1, 'the segment really was pulled through the worker')
    assert.equal(body.sync.bytes, segment.length)
    assert.ok(samples > 5, `only ${samples} health samples taken`)
    assert.ok(lagSamples > 5, `only ${lagSamples} loop-lag samples taken`)
    assert.ok(worst < 100, `GET /health took ${worst.toFixed(0)} ms during the sync — the pull or its verification is back on the event loop (measured 1,017 ms before the fix)`)
    assert.ok(worstLag < 100, `the event loop stalled for ${worstLag.toFixed(0)} ms during the sync — the pull or its verification is back on it`)
  } finally {
    _resetTickResearchJobs()
    sidecar.close()
    s.close()
    if (savedUrl != null) process.env.EXEC_URL = savedUrl; else delete process.env.EXEC_URL
    if (savedSecret != null) process.env.EXEC_SECRET = savedSecret; else delete process.env.EXEC_SECRET
    if (savedDir != null) process.env.TICK_SEGMENTS_DIR = savedDir; else delete process.env.TICK_SEGMENTS_DIR
    if (savedCache != null) process.env.TICK_SEGMENTS_CACHE_DIR = savedCache; else delete process.env.TICK_SEGMENTS_CACHE_DIR
  }
})
