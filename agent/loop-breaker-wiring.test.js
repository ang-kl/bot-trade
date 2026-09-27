// Wiring of lib/loop-breaker.js into runLoop. runLoop is not exported and a
// cycle cannot be run in isolation, so the call sites are pinned from the
// source — comments stripped first, so an explanatory comment naming a call
// cannot stand in for the call (recurring failure mode #2). The behaviour
// itself is exercised in lib/loop-breaker.test.js; this file only proves the
// loop still calls it in the order that behaviour assumes (failure mode #4).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/.*$/gm, '$1')

const src = stripComments(readFileSync(new URL('./loop.js', import.meta.url), 'utf8'))
const bodyStart = src.indexOf('async function runLoop(db) {')
const bodyEnd = src.indexOf('\n}\n', bodyStart)
const body = src.slice(bodyStart, bodyEnd)

const at = (needle, from = 0) => {
  const i = body.indexOf(needle, from)
  assert.ok(i >= 0, `runLoop: ${needle} not found`)
  return i
}

test('runLoop is found (the scan did not run on nothing)', () => {
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart && body.length > 10_000)
})

test('the breaker gate, cycle start, failure and end are called in order', () => {
  const gate = at('if (loopBreaker.isTripped())')
  const begin = at('loopBreaker.beginCycle()')
  const tryAt = at('let cycleErrored = false')
  const catchAt = at('cycleErrored = true')
  const fail = at('loopBreaker.recordFailure(', catchAt)
  const backoff = at('if (failure.backoffMs > 0)', fail)
  const end = at('loopBreaker.endCycle()', backoff)
  assert.ok(gate < begin && begin < tryAt && tryAt < catchAt, 'gate → beginCycle → try → catch')
  assert.ok(fail - catchAt < 400, 'recordFailure sits in the cycle catch')
  assert.ok(end > fail)
})

test('nothing else clears the in-process count inside runLoop', () => {
  assert.equal(body.split('loopBreaker.reset()').length - 1, 0)
  assert.equal(body.split('loopBreaker.endCycle()').length - 1, 1)
  assert.doesNotMatch(body, /consecutiveErrors\s*=\s*0/)
})

test('the persisted trip stamp is cleared only by a clean cycle', () => {
  const clear = at("setState(db, 'circuit_breaker_tripped_at', null)")
  const guard = body.lastIndexOf('if (cycleEnd.clean', clear)
  assert.ok(guard >= 0 && clear - guard < 200, 'the tripped_at clear is guarded by cycleEnd.clean')
  assert.equal(body.split("setState(db, 'circuit_breaker_tripped_at', null)").length - 1, 1)
})

test('the manual reset route reaches the same breaker', () => {
  const fn = src.slice(src.indexOf('export function resetCircuitBreaker('))
  assert.match(fn.slice(0, 400), /loopBreaker\.reset\(\)/)
})

test('the tripped path returns before the cycle takes the mutex', () => {
  const gate = at('if (loopBreaker.isTripped())')
  const running = at('loopRunning = true', gate)
  const tripped = body.slice(gate, running)
  assert.match(tripped, /\breturn\b/, 'a tripped loop must return before loopRunning = true')
  assert.match(tripped, /loopBreaker\.tripNeedsAnnouncing\(/, 'the trip gate announces by tripNeedsAnnouncing, not by !stamp')
  assert.match(tripped, /loopBreaker\.park\(setTimeout\(/, 'the re-check timer is parked so a reset can resume')
  assert.ok(body.indexOf('loopBreaker.unpark()') < gate, 'a fired re-check timer is unparked before the gate')
})

test('startLoop clears a stale trip stamp at boot', () => {
  const helper = src.slice(src.indexOf('function bootBreaker(db) {'), src.indexOf('export function startLoop(db) {'))
  assert.match(helper, /clearStaleTripStampAtBoot\(\{/, 'bootBreaker clears the stamp')
  const start = src.slice(src.indexOf('export function startLoop(db) {'))
  const boot = start.indexOf('bootBreaker(db)')
  const first = start.indexOf('setTimeout(() => runLoop(db)')
  assert.ok(boot >= 0 && first > boot, 'the stamp is cleared before the first cycle is scheduled')
})

test('the watchdog decides by this process\'s breaker, not the persisted stamp', () => {
  const wd = src.slice(src.indexOf('function startLoopWatchdog(db) {'))
  const tick = wd.slice(0, wd.indexOf('process.exit(1)'))
  assert.match(tick, /watchdogVerdict\(\{[^}]*tripped: loopBreaker\.isTripped\(\)/)
  assert.doesNotMatch(tick, /circuit_breaker_tripped_at/)
})
