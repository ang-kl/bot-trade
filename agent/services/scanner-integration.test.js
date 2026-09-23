import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { initDB, setState } from '../db.js'
import { computeFibSignal, pickAllSignals } from './fib-strategy.js'
import { boundedScannerObserver, publishTimeframeEvaluation, scannerObserver, scannerRequest } from './scanner-feed.js'
import { FIB_PROFILE, comparisonStatus, TickComparisonReader, recordReference, compareTimeframeResult, matchingProfile } from './scanner-comparison.js'
import { pollScannerMirrors } from './scanner-candidates.js'
import { recordScannerWork } from './scanner-work.js'
import { nodeWatchdogContract } from './watchdog-contract.js'
import { recordMarketCalendar } from './market-calendar.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { nativeProfileHash } from './scanner-profiles.js'

const feed = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '7' }
const fixture = name => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url)))
function database(t, policies = []) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (11,0)').run()
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (22,0)').run()
  setState(db, 'symbol_id_map:11', '{"EURUSD":7}'); setState(db, 'symbol_id_map:22', '{"EURUSD":8}')
  setState(db, 'scanner_mirror_profiles_json', JSON.stringify(policies)); return db
}
function fibJob() {
  const f = fixture('cpp-scan-timeframe/src/tests/fixtures/fib-parity.json').find(f => f.expected)?.request
  const receivedAtMs = Date.now() - 100, shift = receivedAtMs - f.receivedAtMs
  const bars = f.bars.map(b => ({ ...b, t: b.t + shift }))
  return { ...f, feed, configVersion: 'v1', feedEpoch: 'epoch1', profileHash: FIB_PROFILE,
    receivedAtMs, bars, nativeCompatible: true, reference: computeFibSignal(bars, f.timeframe, {}) }
}
const policy = job => ({ source: 'cpp-scan-timeframe', feed, strategy: 'fib_618_fade', configVersion: 'v1', profileHash: FIB_PROFILE, timeframe: job.timeframe, candidateTtlMs: 60000 })

test('comparison uses identical rules on both broker hosts and rejects cross-account feed relabelling', t => {
  const job = fibJob(), other = { ...job, feed: { ...feed, accountId: '22', host: 'live.ctraderapi.com', symbolId: '8' } }
  const db = database(t, [policy(job), { ...policy(job), feed: other.feed }])
  db.prepare('UPDATE accounts SET is_live=1 WHERE account_id=22').run()
  assert.ok(matchingProfile(db, 'cpp-scan-timeframe', job))
  assert.ok(matchingProfile(db, 'cpp-scan-timeframe', other))
  assert.equal(matchingProfile(db, 'cpp-scan-timeframe', { ...other, feed: { ...other.feed, host: feed.host } }), null)
  assert.equal(matchingProfile(db, 'cpp-scan-timeframe', { ...other, feed: { ...other.feed, symbolId: '7' } }), null)
})

test('observer sees the exact evaluated window and cannot alter the strategy result when transport fails', t => {
  const db = database(t), seen = [], bars = [{ c: 1 }, { c: 2 }], signal = { strategy: 'test', conviction: 5 }
  const fn = input => { assert.equal(input.length, 1); return signal }
  assert.deepEqual(pickAllSignals([fn], bars, '1h', {}, () => bars.slice(-1), (owner, input, result) => {
    seen.push({ owner, input, result }); throw new Error('transport failed')
  }), [signal])
  assert.equal(seen[0].input[0], bars[1]); assert.equal(seen[0].result, signal)
  assert.equal(scannerObserver(db, {}, {}), null)
  const queue = boundedScannerObserver(() => {}, { capacity: 2 })
  assert.equal(queue.offer({ bars }), true); assert.equal(queue.offer({ bars }), true); assert.equal(queue.offer({ bars }), false)
  queue.acknowledge(); assert.equal(queue.offer({ bars }), true); queue.fail(); assert.equal(queue.offer({ bars }), false)
  assert.equal(queue.status().dropped, 2)
})

test('timeframe feed refuses partial bars and unsupported semantics; retries are bounded and preserve source age', async t => {
  const job = fibJob(), db = database(t, [policy(job)]), sent = []
  const fetchImpl = async (_url, options) => { sent.push(JSON.parse(options.body)); throw new Error('offline') }
  const options = { env: { SCANNER_TIMEFRAME_URL: 'http://scanner.test', SCANNER_TIMEFRAME_SECRET: 'fixture' }, fetchImpl }
  assert.equal((await publishTimeframeEvaluation(db, { ...job, nativeCompatible: false }, options)).state, 'unsupported')
  await assert.rejects(() => publishTimeframeEvaluation(db, { ...job, bars: [{ ...job.bars[0], t: Date.now() }] }, options), /bar_input_invalid/)
  for (let i = 0; i < 3; i++) await assert.rejects(() => publishTimeframeEvaluation(db, { ...job, receivedAtMs: job.receivedAtMs + i }, options), /offline/)
  assert.equal((await publishTimeframeEvaluation(db, job, options)).state, 'already_delivered_or_retry_budget_exhausted')
  assert.equal(sent.length, 3); assert.ok(sent.every(b => b.receivedAtMs === job.receivedAtMs))
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

test('timeframe comparison detects missing references, changed economics and duplicate observations', t => {
  const job = fibJob(), db = database(t), body = { ...job, barCloseAtMs: job.bars.at(-1).t + job.barDurationMs, inputHash: 'exact-bars' }
  recordReference(db, body, job.reference)
  const row = { ...body, outcome: 'candidate', candidate: { ...body, sourceSequence: body.barCloseAtMs, signal: { ...job.reference, tp1: job.reference.tp1 + 1 } } }
  assert.equal(compareTimeframeResult(db, row), 'mismatch'); compareTimeframeResult(db, row)
  assert.equal(comparisonStatus(db).populations[0].records, 1)
  assert.equal(compareTimeframeResult(db, { ...row, candidate: { ...row.candidate, feed: { ...feed, accountId: '22' } } }), 'reference_missing')
})

test('comparison pages roll back malformed batches and retain cursor-gap evidence', t => {
  const db = database(t), reader = new TickComparisonReader()
  const page = { instanceId: 'a'.repeat(64), orderAuthority: false, oldestCursor: 1, latestCursor: 2, gap: false,
    candidates: [{ cursor: 1 }, { cursor: 3 }] }
  assert.throws(() => reader.consume(db, page), /comparison_cursor_invalid/)
  assert.equal(reader.after, 0)
  assert.equal(db.prepare('SELECT count(*) n FROM scanner_comparisons').get().n, 0)
  reader.consume(db, { ...page, latestCursor: 3 })
  assert.equal(reader.after, 3)
  assert.ok(comparisonStatus(db).populations.some(p => p.state === 'input_gap' && p.records === 1))
  assert.throws(() => reader.consume(db, { ...page, latestCursor: 3, candidates: [{ cursor: 3 }, { cursor: 2 }] }), /comparison_cursor_invalid/)
  assert.equal(reader.after, 3)
})

async function nativeService(t, service) {
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await new Promise(r => portServer.once('listening', r))
  const port = portServer.address().port; await new Promise(r => portServer.close(r))
  const binary = new URL(`../../${service}/bin/${service}`, import.meta.url)
  const child = spawn(binary.pathname, [], { env: { ...process.env, PORT: String(port), SCANNER_SECRET: 'fixture' }, stdio: 'ignore' })
  let failed = null; child.on('error', e => { failed = e })
  t.after(async () => { if (child.exitCode == null && !failed) { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) } })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (failed) throw failed
    try { if ((await fetch(`${url}/health`)).ok) return url } catch { /* startup */ }
    await delay(10)
  }
  throw new Error('native fixture did not start')
}
const has = service => existsSync(new URL(`../../${service}/bin/${service}`, import.meta.url))

test('real timeframe HTTP feed, candidate collector and actual JavaScript reference agree without creating an intent', { skip: !has('cpp-scan-timeframe') }, async t => {
  const url = await nativeService(t, 'cpp-scan-timeframe'), job = fibJob(), db = database(t, [policy(job)])
  const env = { SCANNER_TIMEFRAME_URL: url, SCANNER_TIMEFRAME_SECRET: 'fixture' }
  assert.equal((await publishTimeframeEvaluation(db, job, { env })).state, 'delivered')
  for (let i = 0; i < 50 && !comparisonStatus(db).populations?.length; i++) { await pollScannerMirrors(db, { env }); await delay(10) }
  assert.deepEqual(comparisonStatus(db).populations.map(p => [p.state, p.records]), [['matched', 1]])
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
  assert.equal((await fetch(`${url}/watchdog`)).status, 401)
})

test('native defaults and EMA options traverse the actual HTTP comparison path without order authority', { skip: !has('cpp-scan-timeframe') }, async t => {
  const url = await nativeService(t, 'cpp-scan-timeframe'), fixtures = [...fixture('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json'),
    ...fixture('cpp-scan-timeframe/src/tests/fixtures/ema-options-parity.json')]
  const start = Date.now() - fixtures.length * 1000 - 100
  const jobs = fixtures.map(({ request, referenceOptions }, i) => {
    const receivedAtMs = start + i * 1000, shift = receivedAtMs - request.receivedAtMs
    const bars = request.bars.map(b => ({ ...b, t: b.t + shift }))
    const compute = STRATEGY_REGISTRY.find(s => s.key === request.strategy).compute
    return { ...request, feed, receivedAtMs, bars, nativeCompatible: true,
      nativeOptions: request.options, profileHash: nativeProfileHash(request.strategy, request.options), reference: compute(bars, request.timeframe, referenceOptions) }
  })
  const policies = [...new Map(jobs.map(j => [`${j.strategy}:${j.timeframe}:${j.profileHash}`, { source: 'cpp-scan-timeframe', feed,
    strategy: j.strategy, timeframe: j.timeframe, configVersion: j.configVersion, profileHash: j.profileHash, candidateTtlMs: 3600000 }])).values()]
  const db = database(t, policies), env = { SCANNER_TIMEFRAME_URL: url, SCANNER_TIMEFRAME_SECRET: 'fixture' }
  for (const job of jobs) {
    assert.equal((await publishTimeframeEvaluation(db, job, { env })).state, 'delivered')
    await pollScannerMirrors(db, { env })
  }
  for (let i = 0; i < 50; i++) {
    await pollScannerMirrors(db, { env })
    if (comparisonStatus(db).populations.reduce((sum, p) => sum + p.records, 0) === jobs.length) break
    await delay(10)
  }
  assert.deepEqual(comparisonStatus(db).populations.map(p => [p.state, p.records]), [['matched', jobs.length]],
    JSON.stringify(db.prepare("SELECT detail FROM scanner_comparisons WHERE state != 'matched'").all()))
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

test('comparison includes added strategy direction and confluence metadata', t => {
  const f = fixture('cpp-scan-timeframe/src/tests/fixtures/reference-parity.json').find(f => f.request.strategy === 'fib_confluence' && f.expected)
  const db = database(t), body = { ...f.request, barCloseAtMs: f.request.receivedAtMs, inputHash: 'frozen' }
  recordReference(db, body, f.expected)
  const row = { ...body, outcome: 'candidate', candidate: { ...body, sourceSequence: body.barCloseAtMs,
    signal: { ...f.expected, confluenceCount: f.expected.confluenceCount + 1 } } }
  assert.equal(compareTimeframeResult(db, row), 'mismatch')
  row.candidate.signal = { ...f.expected, direction_reason: 'wrong' }
  assert.equal(compareTimeframeResult(db, row), 'mismatch')
  row.candidate.signal = f.expected
  assert.equal(compareTimeframeResult(db, row), 'matched')
})

test('real native tick evaluations match the JavaScript oracle; gaps remain visible and replay is not extra evidence', { skip: !has('cpp-scan-tick') }, async t => {
  const url = await nativeService(t, 'cpp-scan-tick')
  const f = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_fixture.json'), expected = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_expected.json')
  const job = { schemaVersion: 1, purpose: 'mirror', feed, feedEpoch: 'epoch1', configVersion: 'v1', profileHash: expected.profileHash,
    strategy: 'tick_momentum_breakout', profile: f.params, candidateTtlMs: 3600000 }
  const db = database(t, [{ ...job, source: 'cpp-scan-tick' }]), shift = Date.now() - 1000 - f.events.at(-1).recvMs
  const records = f.events.map(q => ({ sequence: q.seq, sourceSequence: q.seq, receivedAtMs: q.recvMs + shift,
    sourceTimestampMs: null, bid: q.bid, ask: q.ask,
    flags: (q.bid != null ? 1 : 0) | (q.ask != null ? 2 : 0) | (q.snapshot ? 16 : 0) | (q.crossed ? 32 : 0) | (q.changed ? 0 : 64) }))
  await scannerRequest(url, 'fixture', '/feed', { ...job, records })
  const reader = new TickComparisonReader()
  for (let i = 0; i < 50 && reader.after < records.length; i++) {
    const page = await scannerRequest(url, 'fixture', `/comparisons?after=${reader.after}`)
    reader.consume(db, page); await delay(10)
  }
  assert.equal(reader.after, records.length)
  const populations = comparisonStatus(db).populations
  assert.deepEqual(populations.map(p => p.state), ['matched'], JSON.stringify(db.prepare("SELECT detail FROM scanner_comparisons WHERE state='mismatch' LIMIT 4").all()))
  assert.equal(populations[0].records, records.length)
  const page = await scannerRequest(url, 'fixture', '/comparisons?after=0')
  reader.consume(db, page); assert.equal(comparisonStatus(db).populations[0].records, records.length)
  reader.consume(db, { ...page, gap: true, oldestCursor: 2, candidates: page.candidates.slice(1) })
  assert.ok(comparisonStatus(db).populations.some(p => p.state === 'input_gap'))
  assert.equal(db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

test('actual scan receipt and complete account records supply no-order context; partial coverage and resting orders do not become zero', t => {
  const db = database(t), now = Date.parse('2026-09-22T06:00:00Z')
  recordMarketCalendar(db, feed, { symbolId: 7, scheduleTimeZone: 'UTC', schedule: [{ startSecond: 21 * 3600, endSecond: 5 * 86400 + 21 * 3600 }] }, { nowMs: now - 1000 })
  const input = { creds: { ...feed, ready: true }, scopeAccounts: ['11'], symbolMap: { EURUSD: 7 }, completedAt: now - 500, nextDue: now + 300000,
    result: { scans: [{ symbol: 'EURUSD' }], errors: [], coverage: { scanned: 1, total: 7 } } }
  recordScannerWork(db, input)
  db.prepare("INSERT INTO decision_log(account_id,stage,decision,reason,created_at) VALUES ('11','margin_pool','skip','free margin exhausted',?)").run(new Date(now - 1000).toISOString())
  let reading = nodeWatchdogContract(db, { now }), activity = reading.work.find(w => w.role === 'entry_activity')
  assert.equal(activity.ordersSinceOpen, 0); assert.equal(activity.firstRecordedBlocker.reason, 'free margin exhausted')
  assert.equal(reading.calendars[0].calendar.observedAtMs, now - 1000)
  assert.equal(nodeWatchdogContract(db, { now: now + 500 }).work.find(w => w.role === 'scanner').lastCompletedAtMs, now - 500)
  db.prepare(`INSERT INTO entry_intents(id,account_id,environment,side,producer_id,basis,mode_epoch,permit_id,permit_expires_at,state,updated_at,created_at)
    VALUES ('resting','11','demo','BUY','fixture','fixture',1,'fixture','2099-01-01','ACCEPTED',?,?)`).run(new Date(now).toISOString(), new Date(now).toISOString())
  activity = nodeWatchdogContract(db, { now }).work.find(w => w.role === 'entry_activity')
  assert.equal(activity.ordersSinceOpen, null); assert.equal(activity.orderEvidence.intents, 1)
  recordScannerWork(db, { ...input, result: { ...input.result, deadlineHit: true } })
  assert.equal(nodeWatchdogContract(db, { now }).work.find(w => w.role === 'entry_activity').activityComplete, false)
})

test('rotating scan batches retain unvisited work and its original deadline', t => {
  const db = database(t), start = Date.now() - 600000
  const input = { creds: { ...feed, ready: true }, scopeAccounts: ['11'], symbolMap: { EURUSD: 7, GBPUSD: 8 },
    completedAt: start, nextDue: start + 300000, cadenceMs: 300000,
    result: { scans: [{ symbol: 'EURUSD' }], expectedSymbols: ['EURUSD', 'GBPUSD'], errors: [], rotationRuns: 2, coverage: { scanned: 1, total: 2 } } }
  const first = recordScannerWork(db, input)
  assert.equal(first.instruments[1].lastCompletedAt, null)
  const second = recordScannerWork(db, { ...input, completedAt: start + 300000, nextDue: start + 600000 })
  assert.equal(second.instruments[1].nextDue, first.instruments[1].nextDue)
  assert.equal(second.instruments[0].lastCompletedAt, start + 300000)
  const changed = recordScannerWork(db, { ...input, symbolMap: { EURUSD: 7, GBPUSD: 9 }, completedAt: start + 600000 })
  assert.equal(changed.instruments[1].registeredAt, start + 600000)
})

test('tick expiry is checked against registered TTL and cannot hide an incorrect suppression', t => {
  const f = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_fixture.json'), expected = fixture('cpp-scan-tick/src/tests/fixtures/tick_momentum_expected.json')
  const now = Date.now(), policy = { source: 'cpp-scan-tick', feed, strategy: 'tick_momentum_breakout', configVersion: 'v1', profileHash: expected.profileHash, candidateTtlMs: 60000 }
  const db = database(t, [policy]), reader = new TickComparisonReader()
  const row = (cursor, age, outcome) => ({ ...policy, cursor, feedEpoch: 'expiry-test', profile: f.params, completedAtMs: now, receivedAtMs: now-age, outcome, orderAuthority: false,
    quote: { seq: cursor, recvMs: now-age, bid: 100, ask: 101, snapshot: true, crossed: false, changed: true } })
  reader.consume(db, { instanceId: 'e'.repeat(64), orderAuthority: false, oldestCursor: 1, latestCursor: 3, gap: false,
    candidates: [row(1, 0, 'expired'), row(2, 60001, 'expired'), row(3, 60001, 'no_signal')] }, now)
  assert.deepEqual(db.prepare('SELECT state,detail FROM scanner_comparisons ORDER BY rowid').all().map(r => [r.state, JSON.parse(r.detail).differences]), [
    ['mismatch', ['expiry']], ['native_expired', []], ['mismatch', ['expiry']],
  ])
})
