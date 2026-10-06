import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  startStartupProfile, startPhaseProfile, stopPhaseProfile, _resetForTests,
} from './cpu-profile.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const previousPhases = process.env.CPU_PROFILE_PHASES
afterEach(() => {
  _resetForTests()
  if (previousPhases === undefined) delete process.env.CPU_PROFILE_PHASES
  else process.env.CPU_PROFILE_PHASES = previousPhases
})

function independentStartupCallback() {
  const until = performance.now() + 250
  let value = 0
  while (performance.now() < until) value += Math.sqrt(value + 1)
  return value
}

test('continuous startup trace names a concurrent callback across phase handoffs', async () => {
  delete process.env.CPU_PROFILE_PHASES
  let summary
  const stop = startStartupProfile(value => { summary = value })
  assert.equal(startPhaseProfile('scan'), false)
  assert.equal(stopPhaseProfile(() => assert.fail('phase sink stole startup trace')), false)
  // The main cycle is awaiting; an independent ticker holds its same thread.
  await new Promise(resolve => setTimeout(() => {
    independentStartupCallback()
    resolve()
  }, 10))
  assert.equal(startPhaseProfile('analyze'), false)
  stop()
  assert.equal(summary.phase, 'startup-first-cycle')
  // Time can land in the native clock primitive as well as its JS caller.
  // Both must retain the actual callback's ownership, without double counting.
  const ownedMs = summary.top.reduce((sum, row) => sum +
    (/independentStartupCallback/.test(row.frame) ? row.selfMs :
      (row.callers || []).filter(caller => /independentStartupCallback/.test(caller.frame))
        .reduce((total, caller) => total + caller.selfMs, 0)), 0)
  assert.ok(ownedMs >= 100, JSON.stringify(summary))
  assert.ok(summary.samples > 0)
  assert.equal('nodes' in summary, false, 'raw inspector data must stay out of logs')
})

test('deadline releases the inspector and cannot stop a later operator profile', async () => {
  process.env.CPU_PROFILE_PHASES = 'monitor'
  let calls = 0
  const staleStop = startStartupProfile(() => { calls++ }, { maxMs: 20 })
  await sleep(60)
  assert.equal(calls, 1)
  assert.equal(startPhaseProfile('monitor'), true)
  staleStop()
  await sleep(25)
  let phase
  assert.equal(stopPhaseProfile(summary => { phase = summary.phase }), true)
  assert.equal(phase, 'monitor')
  assert.equal(calls, 1)
})

test('completion/error cleanup is once-only and a second cycle cannot re-arm', async () => {
  delete process.env.CPU_PROFILE_PHASES
  let calls = 0
  const error = new Error('original cycle failure')
  const stop = startStartupProfile(() => { calls++ }, { maxMs: 20 })
  assert.throws(() => {
    try { throw error } finally { stop() }
  }, value => value === error)
  stop()
  startStartupProfile(() => assert.fail('second cycle re-armed'))()
  await sleep(40)
  assert.equal(calls, 1)
  assert.equal(stopPhaseProfile(() => assert.fail('trace retained')), false)
})

test('startup does not steal an already-running operator trace', () => {
  process.env.CPU_PROFILE_PHASES = 'scan'
  assert.equal(startPhaseProfile('scan'), true)
  startStartupProfile(() => assert.fail('startup replaced existing trace'))()
  let phase
  stopPhaseProfile(summary => { phase = summary.phase })
  assert.equal(phase, 'scan')
})

test('a failing diagnostic sink does not change application results', () => {
  const result = { keep: 'original result' }
  const stop = startStartupProfile(() => { throw new Error('sink failure') })
  const observed = (() => {
    try { return result } finally { stop() }
  })()
  assert.equal(observed, result)
})
