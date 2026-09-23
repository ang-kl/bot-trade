// cpu-profile — the instrument that is supposed to NAME the burner in the
// monitor phase. The last two answers on that bug came from reading code and
// were both wrong, so this one has to be verified against a burner whose
// identity is known in advance: if the profiler cannot finger a function we
// deliberately planted, nothing it says about production is worth acting on.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  profileEnabledFor, startPhaseProfile, stopPhaseProfile, summarizeProfile, _resetForTests,
} from './cpu-profile.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A named function so it has something to show up AS in the profile.
function theDeliberateBurner(ms) {
  const until = Date.now() + ms
  let x = 0
  while (Date.now() < until) x += Math.sqrt(x + 1)
  return x
}

const withPhases = async (value, fn) => {
  const prev = process.env.CPU_PROFILE_PHASES
  process.env.CPU_PROFILE_PHASES = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.CPU_PROFILE_PHASES
    else process.env.CPU_PROFILE_PHASES = prev
    _resetForTests()
  }
}

test('unarmed by default — no phase profiles unless the operator asks', () => {
  const prev = process.env.CPU_PROFILE_PHASES
  delete process.env.CPU_PROFILE_PHASES
  try {
    assert.equal(profileEnabledFor('monitor'), false)
    assert.equal(startPhaseProfile('monitor'), false, 'an unarmed phase must not start an inspector session')
  } finally {
    if (prev !== undefined) process.env.CPU_PROFILE_PHASES = prev
    _resetForTests()
  }
})

test('only the named phases are armed, and * arms all of them', async () => {
  await withPhases('monitor,autopilot', () => {
    assert.equal(profileEnabledFor('monitor'), true)
    assert.equal(profileEnabledFor('autopilot'), true)
    assert.equal(profileEnabledFor('scan'), false)
  })
  await withPhases('*', () => {
    assert.equal(profileEnabledFor('scan'), true)
  })
})

test('THE POINT: a planted burner is named in the profile', async () => {
  await withPhases('monitor', async () => {
    assert.equal(startPhaseProfile('monitor'), true, 'expected the armed phase to start profiling')
    theDeliberateBurner(400)

    const summary = await new Promise((resolve) => {
      const stopped = stopPhaseProfile(resolve)
      assert.equal(stopped, true, 'stop should report that a profile was running')
    })

    assert.equal(summary.phase, 'monitor')
    assert.ok(summary.samples > 0, 'the profiler collected no samples at all')
    // The whole value of this module: the top self-time frame is the function
    // that actually held the thread, by name and file.
    assert.match(summary.top[0].frame, /theDeliberateBurner/,
      `expected the planted burner on top, got: ${summary.top.map(t => t.frame).join(' | ')}`)
    assert.ok(summary.top[0].selfMs >= 100,
      `expected the burner to own most of the window, got ${summary.top[0].selfMs}ms`)
  })
})

test('waiting is NOT attributed to a JS frame — idle is reported as idle', async () => {
  await withPhases('monitor', async () => {
    startPhaseProfile('monitor')
    await sleep(400)
    const summary = await new Promise((resolve) => stopPhaseProfile(resolve))
    // If idling showed up as a hot function, every phase would look CPU-bound
    // and the module would just relocate the original ambiguity.
    const burner = summary.top.find(t => /theDeliberateBurner/.test(t.frame))
    assert.equal(burner, undefined, 'no burner ran, none should be reported')
    assert.ok(summary.idleMs + summary.programMs >= summary.totalMs * 0.5,
      `an idle window should read as idle: idle ${summary.idleMs}ms + program ${summary.programMs}ms of ${summary.totalMs}ms`)
  })
})

test('stopping when nothing is running is a no-op, not a throw', () => {
  _resetForTests()
  let called = false
  assert.equal(stopPhaseProfile(() => { called = true }), false)
  assert.equal(called, false, 'the sink must not be invoked without a profile')
})

test('a second start while one is running does not clobber the first', async () => {
  await withPhases('*', async () => {
    assert.equal(startPhaseProfile('monitor'), true)
    assert.equal(startPhaseProfile('autopilot'), false, 'nested arming would silently discard the outer profile')
    const summary = await new Promise((resolve) => stopPhaseProfile(resolve))
    assert.equal(summary.phase, 'monitor')
  })
})

// summarizeProfile is pure, so the arithmetic can be pinned exactly rather than
// inferred from a sampled run.
test('self time merges the same function across call paths', () => {
  const frame = (id, name, line) => ({
    id, callFrame: { functionName: name, url: 'file:///app/agent/services/thing.js', lineNumber: line },
  })
  const profile = {
    nodes: [frame(1, 'hot', 9), frame(2, 'hot', 9), frame(3, 'cold', 20)],
    samples: [1, 2, 3, 1],
    timeDeltas: [1000, 2000, 500, 1000],
  }
  const s = summarizeProfile(profile, { phase: 'monitor' })
  assert.equal(s.totalMs, 4.5)
  // 1ms + 2ms + 1ms across two nodes for the same frame — reported as one 4ms
  // entry, not two small ones that both rank below `cold`.
  assert.equal(s.top[0].frame, 'hot @ services/thing.js:10')
  assert.equal(s.top[0].selfMs, 4)
  assert.equal(s.top[1].selfMs, 0.5)
})

test('the first sample has no preceding delta and must not be counted twice', () => {
  const s = summarizeProfile({
    nodes: [{ id: 1, callFrame: { functionName: 'f', url: 'file:///a/b.js', lineNumber: 0 } }],
    samples: [1, 1],
    timeDeltas: [0, 3000],
  }, {})
  assert.equal(s.totalMs, 3)
})

test('an empty profile summarises to zeros, never NaN', () => {
  const s = summarizeProfile({ nodes: [], samples: [], timeDeltas: [] }, { phase: 'x' })
  assert.equal(s.totalMs, 0)
  assert.deepEqual(s.top, [])
  assert.equal(s.samples, 0)
})

test('native database samples retain distinct application callers through dependency wrappers', () => {
  const frame = (id, name, url, children = [], lineNumber = 0) => ({
    id, children, callFrame: { functionName: name, url, lineNumber },
  })
  const s = summarizeProfile({
    nodes: [
      frame(1, '(root)', '', [2, 5, 7]),
      frame(2, 'report', 'file:///app/agent/routes/state.js', [3], 100),
      frame(3, 'wrapped', 'file:///app/agent/node_modules/sql/wrapper.js', [4]),
      frame(4, 'all', ''),
      frame(5, 'scan', 'file:///app/agent/services/scanner.js', [6], 200),
      frame(6, 'all', ''),
      frame(7, '(idle)', ''),
    ],
    samples: [4, 6, 4, 7], timeDeltas: [2000, 3000, 4000, 1000],
  })
  assert.equal(s.totalMs, 10)
  assert.equal(s.top[0].frame, 'all')
  assert.equal(s.top[0].selfMs, 9, 'caller breakdown must not double count self time')
  assert.deepEqual(s.top[0].callers, [
    { frame: 'report @ routes/state.js:101', selfMs: 6 },
    { frame: 'scan @ services/scanner.js:201', selfMs: 3 },
  ])
  assert.equal(s.idleMs, 1)
  assert.equal(s.top[1].callers, undefined)
})

test('native attribution is bounded and tolerates cyclic or missing profile parents', () => {
  const nodes = Array.from({ length: 5 }, (_, n) => ({
    id: n * 2 + 1, children: [n * 2 + 2],
    callFrame: { functionName: `caller${n}`, url: 'file:///app/agent/services/load.js', lineNumber: n },
  })).flatMap(parent => [parent, { id: parent.id + 1, callFrame: { functionName: 'get', url: '' } }])
  nodes.push({ id: 11, children: [12], callFrame: { functionName: 'a', url: 'node:internal' } },
    { id: 12, children: [11, 13], callFrame: { functionName: 'b', url: 'node:internal' } },
    { id: 13, callFrame: { functionName: 'run', url: '' } })
  const s = summarizeProfile({ nodes, samples: [2, 4, 6, 8, 10, 13, 99], timeDeltas: [1000, 2000, 3000, 4000, 5000, 1000, 1000] })
  const top = s.top.find(f => f.frame === 'get')
  assert.equal(top.callers.length, 3)
  assert.deepEqual(top.callers.map(f => f.selfMs), [5, 4, 3])
  assert.equal(s.top.find(f => f.frame === 'run').callers, undefined)
})
