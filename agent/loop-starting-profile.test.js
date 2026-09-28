// Execute the loop's actual phase-accounting block with the real V8 profiler.
// A planted startup burner must be captured before the first phase change;
// testing the profiler module alone cannot detect a missing loop call site.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { startPhaseProfile, stopPhaseProfile, _resetForTests } from './services/cpu-profile.js'

const source = readFileSync(new URL('./loop.js', import.meta.url), 'utf8')
const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
const loop = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'runLoop')
const statements = loop.body.body
const expressionCall = (node, name) => node.type === 'ExpressionStatement'
  && node.expression.type === 'CallExpression' && node.expression.callee.name === name
const begin = statements.find(node => expressionCall(node, 'startLagMonitor'))
const guard = statements.find(node => node.type === 'TryStatement'
  && expressionCall(node.block.body[0], 'markLagPhase')
  && node.block.body[0].expression.arguments[0]?.value === 'starting')
const startup = guard ? guard.block.body : statements
const end = startup.find(node => expressionCall(node, 'setState')
  && node.expression.arguments[1]?.value === 'loop_started_at')
assert.ok(begin && end && end.end > begin.start, 'the real cycle accounting block must remain identifiable')
const definitions = source.slice(begin.start, guard ? guard.start : end.end)
const prefix = guard ? source.slice(guard.block.start + 1, end.end) : ''
const dependencyBindings = `const { db, start, startLagMonitor, sampleLag, markLagPhase, setState,
    startPhaseProfile, stopPhaseProfile, log } = deps;`
const phaseBlock = new Function('deps', `
  ${dependencyBindings}
  ${definitions}
  ${prefix}
  return { phase, closePhases };
`)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const guardedBlock = guard ? new AsyncFunction('deps', 'work', `
  ${dependencyBindings}
  ${definitions}
  ${source.slice(guard.start, end.end)}
    return await work({ phase, closePhases });
  ${source.slice(guard.block.end - 1, guard.end)}
`) : null

function deliberateStartingBurner() {
  const until = Date.now() + 200
  let value = 0
  while (Date.now() < until) value += Math.sqrt(value + 1)
  return value
}

function deliberateScanBurner() {
  const until = Date.now() + 200
  let value = 0
  while (Date.now() < until) value += Math.sqrt(value + 1)
  return value
}

// Separate call target for the boundary test: once a burner is warmed, V8
// may inline it into the test callback and legitimately omit its own frame.
function deliberateTransitionStartingBurner() {
  const until = Date.now() + 200
  let value = 0
  while (Date.now() < until) value += Math.sqrt(value + 1)
  return value
}

function setup(t, phases) {
  const before = process.env.CPU_PROFILE_PHASES
  if (phases == null) delete process.env.CPU_PROFILE_PHASES
  else process.env.CPU_PROFILE_PHASES = phases
  _resetForTests()
  t.after(() => {
    _resetForTests()
    if (before === undefined) delete process.env.CPU_PROFILE_PHASES
    else process.env.CPU_PROFILE_PHASES = before
  })
  const state = new Map()
  const marked = []
  let failing = false
  let failureKey = null
  const deps = {
    db: {}, start: Date.now(),
    startLagMonitor: () => {}, sampleLag: () => ({ maxMs: 0 }),
    markLagPhase: key => marked.push(key),
    setState: (_db, key, value) => {
      if (failing || key === failureKey) throw new Error('injected diagnostic write failure')
      state.set(key, value)
    },
    startPhaseProfile, stopPhaseProfile, log: () => {},
  }
  return {
    ...phaseBlock(deps), state, marked,
    nextCycle: () => phaseBlock({ ...deps, start: Date.now() }),
    guardedCycle: work => guardedBlock({ ...deps, start: Date.now() }, work),
    failWrites: () => { failing = true },
    failOnKey: key => { failureKey = key },
  }
}

async function profile(state, key) {
  // Profiler.stop delivers its summary through a callback. Let queued
  // callbacks complete without replacing that lifecycle with a fake sink.
  await new Promise(resolve => setImmediate(resolve))
  const summaries = JSON.parse(state.get('loop_cpu_profile_json') || '{}')
  assert.ok(summaries[key], `no ${key} profile was captured by the loop`)
  return summaries[key]
}

test('explicit starting opt-in captures work before any phase transition, then closes cleanly', async t => {
  const run = setup(t, 'starting')
  deliberateStartingBurner()
  const elapsed = run.closePhases()
  const summary = await profile(run.state, 'starting')
  assert.equal(summary.phase, 'starting')
  assert.ok(summary.samples > 0)
  assert.ok(summary.top.some(row => /deliberateStartingBurner/.test(row.frame) && row.selfMs > 0),
    `startup work was not attributed: ${JSON.stringify(summary.top)}`)
  assert.ok(elapsed.starting >= 200)
  assert.deepEqual(run.marked, ['starting', 'idle'])
  assert.equal(stopPhaseProfile(() => assert.fail('a closed cycle must not retain a profile')), false)
})

test('all-phase opt-in preserves starting-to-scan boundaries and allows the next cycle', async t => {
  const run = setup(t, '*')
  deliberateTransitionStartingBurner()
  run.phase('scanning fixture symbols', 'scan')
  deliberateScanBurner()
  run.closePhases()
  const starting = await profile(run.state, 'starting')
  const scan = await profile(run.state, 'scan')
  assert.ok(starting.top.some(row => /deliberateTransitionStartingBurner/.test(row.frame)), JSON.stringify(starting))
  assert.ok(scan.top.some(row => /deliberateScanBurner/.test(row.frame)), JSON.stringify(scan))
  assert.ok(!starting.top.some(row => /deliberateScanBurner/.test(row.frame)), 'scan work must not leak into startup')
  assert.ok(!scan.top.some(row => /deliberateTransitionStartingBurner/.test(row.frame)), 'startup work must not leak into scan')
  assert.equal(stopPhaseProfile(() => assert.fail('the transitioned cycle leaked a profile')), false)
  run.state.delete('loop_cpu_profile_json')
  const next = run.nextCycle()
  deliberateStartingBurner()
  next.closePhases()
  assert.ok((await profile(run.state, 'starting')).samples > 0, 'a second cycle must acquire its own profile')
})

test('default-off and scan-only configurations do not acquire a starting profile', async t => {
  for (const phases of [null, 'scan']) {
    const run = setup(t, phases)
    run.closePhases()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(run.state.has('loop_cpu_profile_json'), false)
    assert.equal(stopPhaseProfile(() => assert.fail('unarmed starting work was profiled')), false)
  }
})

test('closing a failed starting phase stops sampling before a diagnostic persistence failure', t => {
  const run = setup(t, 'starting')
  deliberateStartingBurner()
  run.failWrites()
  assert.throws(() => run.closePhases(), /injected diagnostic write failure/)
  assert.equal(stopPhaseProfile(() => assert.fail('a failed close left the profiler active')), false)
  assert.equal(startPhaseProfile('starting'), true, 'diagnostic write failure must not block the next profile')
  stopPhaseProfile(() => {})
})

test('the real lifecycle guard stops startup sampling on a pre-main-try database failure', async t => {
  assert.ok(guardedBlock, 'the starting profile requires cleanup around pre-main-try failures')
  const run = setup(t, 'starting')
  run.closePhases()
  run.failOnKey('loop_started_at')
  await assert.rejects(run.guardedCycle(() => assert.fail('the failed stamp must stop this cycle')),
    /injected diagnostic write failure/)
  assert.equal(stopPhaseProfile(() => assert.fail('startup sampling leaked after a database failure')), false)
})

test('the real lifecycle guard remains harmless after normal close and stops a thrown or early-returning cycle', async t => {
  assert.ok(guardedBlock, 'the cycle must have a profiler cleanup guard')
  const run = setup(t, 'starting')
  run.closePhases()
  for (const outcome of ['normal', 'early', 'throw']) {
    const work = run.guardedCycle(({ closePhases }) => {
      if (outcome === 'throw') throw new Error('injected cycle failure')
      if (outcome === 'early') return 'early'
      closePhases()
      return 'normal'
    })
    if (outcome === 'throw') await assert.rejects(work, /injected cycle failure/)
    else assert.equal(await work, outcome)
    assert.equal(stopPhaseProfile(() => assert.fail(`sampling leaked after ${outcome}`)), false)
  }
})
