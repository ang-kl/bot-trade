// Local synthetic HTTP capacity evidence. Never connects to a broker or production.
// This is not evidence of production peak-feed or protection-latency acceptance.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'

const root = new URL('../', import.meta.url)
const fixture = path => JSON.parse(readFileSync(new URL(path, root)))
const tick = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_fixture.json')
const tickHash = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_expected.json').profileHash
const timeframe = fixture('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json')
  .find(f => f.request.strategy === 'ema_pullback' && f.expected).request
const streams = 500, concurrency = 8
const distribution = values => {
  const s = [...values].sort((a, b) => a - b)
  const at = p => s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] * 100) / 100 : null
  return { samples: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }
}
function rss(pid) {
  const value = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)
  return value ? Number(value[1]) / 1024 : null
}
async function trial(service) {
  const socket = createServer().listen(0, '127.0.0.1')
  await new Promise(r => socket.once('listening', r))
  const port = socket.address().port
  await new Promise(r => socket.close(r))
  // Deliberately pass no inherited environment/broker credentials to the worker.
  const child = spawn(new URL(`${service}/bin/${service}`, root).pathname, [], {
    env: { PORT: String(port), SCANNER_SECRET: 'local-capacity-fixture' }, stdio: 'ignore',
  })
  let processError, monitoring = false, monitor
  child.on('error', e => { processError = e })
  const url = `http://127.0.0.1:${port}`
  async function request(path, body) {
    const response = await fetch(`${url}${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer local-capacity-fixture', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  const isTick = service === 'cpp-scan-tick'
  const path = isTick ? '/feed' : '/evaluate'
  function job(index) {
    const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: String(index + 1) }
    if (!isTick) {
      const shift = Date.now() - 1000 - timeframe.receivedAtMs
      return { ...timeframe, feed, receivedAtMs: timeframe.receivedAtMs + shift,
        sourceTimestampMs: timeframe.sourceTimestampMs + shift,
        bars: timeframe.bars.map(b => ({ ...b, t: b.t + shift })) }
    }
    const shift = Date.now() - 1000 - tick.events.at(-1).recvMs
    return { schemaVersion: 1, purpose: 'mirror', feed, feedEpoch: 'capacity1', configVersion: 'v1',
      profileHash: tickHash, strategy: 'tick_momentum_breakout', profile: tick.params, candidateTtlMs: 60000,
      records: tick.events.map(q => ({ sequence: q.seq, sourceSequence: q.seq, receivedAtMs: q.recvMs + shift,
        sourceTimestampMs: null, bid: q.bid, ask: q.ask,
        flags: (q.bid != null ? 1 : 0) | (q.ask != null ? 2 : 0) | (q.snapshot ? 16 : 0) | (q.crossed ? 32 : 0) | (q.changed ? 0 : 64) })) }
  }
  try {
    let ready = false
    for (let i = 0; i < 100 && !ready; i++) {
      if (processError) throw processError
      try { ready = (await request('/health')).status === 200 } catch { await delay(10) }
    }
    assert.ok(ready, 'native service starts')
    const latency = [], healthLatency = []
    let peakRssMiB = rss(child.pid), next = 0, backpressure = 0, acceptedRecords = 0, droppedRecords = 0
    monitoring = true
    monitor = (async () => {
      while (monitoring) {
        const at = performance.now(), health = await request('/health')
        assert.equal(health.status, 200); assert.equal(health.body.orderAuthority, false)
        healthLatency.push(performance.now() - at)
        peakRssMiB = Math.max(peakRssMiB, rss(child.pid))
        await delay(10)
      }
    })()
    const started = performance.now()
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < streams) {
        const input = job(next++), at = performance.now()
        let accepted = false
        for (let attempt = 0; attempt < 100; attempt++) {
          const r = await request(path, input)
          if (r.status === 429) { backpressure++; await delay(5); continue }
          assert.equal(r.status, 202, JSON.stringify(r.body)); assert.equal(r.body.orderAuthority, false)
          acceptedRecords += r.body.accepted || 0; droppedRecords += r.body.dropped || 0
          accepted = true; break
        }
        assert.ok(accepted, 'bounded retry budget'); latency.push(performance.now() - at)
      }
    }))
    // V3 CV-1: the tick scanner lists one work row per stream; the timeframe
    // scanner lists only cells with a job queued or running (an idle cell has
    // no deadline) and counts every cell in `cells`.
    const retained = s => isTick ? s.work.length : s.cells.count
    const capacity = isTick ? 512 : 1024
    let state
    for (let i = 0; i < 500; i++) {
      state = (await request('/watchdog')).body
      if (retained(state) === streams && state.work.every(w => w.state !== 'queued')) break
      await delay(10)
    }
    const elapsedMs = performance.now() - started
    assert.equal(retained(state), streams)
    if (isTick) assert.ok(state.work.every(w => w.state !== 'queued' && w.lastCompletedAtMs > 0))
    else assert.ok(state.work.length === 0 && state.cells.lastCompletedAtMs > 0 && state.cells.capacity === capacity)
    assert.equal(state.orderAuthority, false)
    if (isTick) {
      assert.equal(acceptedRecords + droppedRecords, streams * tick.events.length, 'every input is accounted for')
      assert.equal(state.processed, acceptedRecords); assert.equal(state.dropped, droppedRecords)
    }
    // Fill the documented bound (512 streams / 1024 cells); with nothing stale
    // the next new identity must fail closed.
    for (let index = streams; index < capacity; index++) {
      let status
      for (let attempt = 0; attempt < 100; attempt++) { status = (await request(path, job(index))).status; if (status !== 429) break; await delay(5) }
      assert.equal(status, 202)
    }
    const overflow = await request(path, job(capacity))
    assert.equal(overflow.status, 429)
    const output = (await request(isTick ? '/comparisons?after=0' : '/candidates?after=0')).body
    const finalState = (await request('/watchdog')).body
    assert.equal(retained(finalState), capacity)
    if (isTick) assert.equal(output.gap, true, 'undrained bounded comparison ring reports its overwrite gap')
    const unauthenticated = await fetch(`${url}/watchdog`, { signal: AbortSignal.timeout(5000) })
    assert.equal(unauthenticated.status, 401)
    monitoring = false; await monitor
    return { service, scope: 'local synthetic HTTP load only', streams, concurrency,
      inputPerStream: isTick ? tick.events.length : timeframe.bars.length,
      inputKind: isTick ? 'classified quote records' : 'closed EMA bars',
      elapsedMs: Math.round(elapsedMs), acknowledgmentLatencyMs: distribution(latency),
      concurrentHealthLatencyMs: distribution(healthLatency), peakRssMiB: Math.round(peakRssMiB * 100) / 100,
      backpressureResponses: backpressure, acceptedRecords: isTick ? acceptedRecords : null,
      droppedInputRecords: isTick ? droppedRecords : null, losslessInput: !isTick || droppedRecords === 0,
      completedStreams: retained(state), capacity,
      overflowStatus: overflow.status, retainedStreams: retained(finalState),
      undrainedOutputGap: output.gap, latestOutputCursor: output.latestCursor,
      orderAuthority: false, unauthenticatedStatus: unauthenticated.status }
  } finally {
    monitoring = false
    if (monitor) await monitor.catch(() => {})
    if (child.exitCode == null && !processError) {
      child.kill('SIGTERM'); await new Promise(r => child.once('exit', r))
    }
  }
}
const results = []
for (const service of ['cpp-scan-tick', 'cpp-scan-timeframe']) results.push(await trial(service))
console.log(JSON.stringify({ observedAt: new Date().toISOString(), results }, null, 2))
if (results.some(r => !r.losslessInput)) process.exitCode = 1
