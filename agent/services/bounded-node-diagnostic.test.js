// Codex · №12,411 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { startBoundedNodeDiagnostic, diagnosticHttpMiddleware } from './bounded-node-diagnostic.js'
import { startPhaseProfile, stopPhaseProfile, summarizeProfile, _resetForTests } from './cpu-profile.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const envFor = id => ({ NODE_DIAGNOSTIC_RUN_ID: id, NODE_DIAGNOSTIC_EXPIRES_AT: new Date(Date.now() + 60000).toISOString() })
const fixture = () => { const db = new Database(':memory:'); db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)'); return db }
function diagnosticKnownSqlBurner() { const end = Date.now() + 220; while (Date.now() < end) { /* controlled local fixture only */ } return 42 }

test('disabled/expired/malformed configuration does not read or write a database', () => {
  const db = { prepare() { throw Error('must not access') } }
  for (const env of [{}, { ...envFor('valid-run'), NODE_DIAGNOSTIC_EXPIRES_AT: '2000-01-01Z' }, envFor('../invalid')]) {
    assert.equal(startBoundedNodeDiagnostic(db, { env }), null)
  }
})

test('real SQLite/function/HTTP capture restores itself once, and durable run ID refuses a replay', async () => {
  const db = fixture(), lines = [], log = x => lines.push(JSON.parse(x))
  const method = Object.getPrototypeOf(db).prepare
  db.function('burn', diagnosticKnownSqlBurner)
  const cached = db.prepare('SELECT burn() n'), old = process.env.CPU_PROFILE_PHASES
  process.env.CPU_PROFILE_PHASES = '*'
  try {
    const env = envFor('regression-real-window')
    const stop = startBoundedNodeDiagnostic(db, { env, durationMs: 500, log })
    assert.equal(typeof stop, 'function')
    assert.equal(startPhaseProfile('monitor'), false)
    assert.equal(stopPhaseProfile(() => assert.fail('phase must not end diagnostic')), false)
    const res = new EventEmitter(); res.statusCode = 200; res.writableFinished = true
    let passed = 0
    diagnosticHttpMiddleware({ path: '/health', headers: { authorization: 'never-log-secret', 'x-railway-request-id': 'owned-request-1' } }, res, () => passed++)
    const unfinished = new EventEmitter()
    diagnosticHttpMiddleware({ path: '/events', headers: {} }, unfinished, () => {})
    await sleep(20)
    assert.equal(cached.get().n, 42); res.emit('finish'); res.emit('close')
    await sleep(400)
    stop(); stop()
    assert.equal(passed, 1)
    assert.equal(Object.getPrototypeOf(db).prepare, method)
    assert.equal(lines.filter(x => x.kind === 'exit').length, 1)
    assert.ok(lines.find(x => x.kind === 'sql' && x.value.op === 'get' && x.value.ms >= 100))
    assert.ok(lines.find(x => x.kind === 'lag' && x.value.lateness >= 100))
    assert.ok(JSON.stringify(lines.filter(x => x.kind === 'cpu-window')).includes('diagnosticKnownSqlBurner'))
    assert.equal(lines.filter(x => x.kind === 'http').length, 1)
    assert.equal(unfinished.listenerCount('finish'), 0); assert.equal(unfinished.listenerCount('close'), 0)
    assert.equal(lines.find(x => x.kind === 'exit').value.httpUnfinished, 1)
    assert.equal(lines.find(x => x.kind === 'http-incomplete').value.reason, 'window_ended_before_response')
    assert.equal(lines.find(x => x.kind === 'http').value.requestId, 'owned-request-1')
    assert.ok(!JSON.stringify(lines).includes('never-log-secret'))
    assert.equal(startBoundedNodeDiagnostic(db, { env, log }), null)
    assert.equal(lines.at(-1).value.reason, 'run_already_claimed')
    assert.equal(db.prepare('SELECT count(*) n FROM agent_state').get().n, 1)
  } finally { if (old === undefined) delete process.env.CPU_PROFILE_PHASES; else process.env.CPU_PROFILE_PHASES = old; _resetForTests(); db.close() }
})

test('native SQL caller attribution skips both temporary instrumentation frames', () => {
  const node = (id, name, url, children) => ({ id, callFrame: { functionName: name, url, lineNumber: 4 }, children })
  const profile = { nodes: [node(1, 'actualBusinessOwner', 'file:///app/agent/services/owner.js', [2]),
    node(2, 'timed', 'file:///app/agent/services/diagnostic-sql.js', [3]),
    node(3, 'measure', 'file:///app/agent/services/diagnostic-sql.js', [4]), node(4, 'get', '', [])],
  samples: [4, 4], timeDeltas: [10000, 10000] }
  const summary = summarizeProfile(profile)
  assert.equal(summary.top[0].frame, 'get')
  assert.match(summary.top[0].callers[0].frame, /^actualBusinessOwner @/)
})

test('instrumentation or logger failure does not change SQL or leave an active profiler', () => {
  const db = fixture()
  let released = false
  const result = startBoundedNodeDiagnostic(db, { env: envFor('failed-instrument'), log() { throw Error('sink') },
    profileStart: callback => () => { released = true; callback(null) }, sqlStart() { throw Error('instrument') } })
  assert.equal(result, null); assert.equal(released, true)
  assert.equal(db.prepare('SELECT 42 n').get().n, 42)
  db.close()
})

test('wiring starts capture before hybrid/loop and HTTP middleware before parsers; entry/SL paths are uninvolved', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.ok(source.indexOf('startBoundedNodeDiagnostic(db)') < source.indexOf('startHybridTickController(db)'))
  assert.ok(source.indexOf('app.use(diagnosticHttpMiddleware)') < source.indexOf('app.use(jsonExceptScannerRegistration())'))
})
