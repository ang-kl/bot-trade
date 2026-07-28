// event-loop-lag — the instrument that decides how #121 gets fixed, so it has
// to be trustworthy in both directions: it must SEE a block, and it must not
// invent one when the process was merely waiting.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startLagMonitor, sampleLag, _resetForTests } from './event-loop-lag.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const blockFor = (ms) => {
  const until = Date.now() + ms
  while (Date.now() < until) { /* deliberately block the event loop */ }
}

test('sampleLag returns null before the monitor is started', () => {
  _resetForTests()
  assert.equal(sampleLag(), null)
})

test('a real block shows up as lag', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)         // let the probe take a baseline sample
  sampleLag()              // discard the baseline window
  blockFor(220)
  await sleep(150)         // let the delayed probe fire and be recorded
  const lag = sampleLag()
  assert.ok(lag, 'expected a sample')
  // Generous threshold: CI machines are noisy and the point is only that a
  // ~220ms block is visible, not that the number is exact.
  assert.ok(lag.maxMs >= 100, `expected lag to reflect the block, got ${lag.maxMs}ms`)
})

test('waiting on a timer is NOT reported as blocking', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  await sleep(400)         // idle: the loop is free the whole time
  const lag = sampleLag()
  assert.ok(lag, 'expected a sample')
  // This is the distinction the whole module exists for. If idling registered
  // as lag, the instrument could not tell "phase was waiting on the broker"
  // from "phase was hogging the thread".
  assert.ok(lag.maxMs < 100, `idle time should not read as blocking, got ${lag.maxMs}ms`)
})

test('sampling resets the window, so phases do not inherit each other', async () => {
  _resetForTests()
  startLagMonitor()
  await sleep(120)
  sampleLag()
  blockFor(200)
  await sleep(150)
  const blocked = sampleLag()
  await sleep(300)
  const idle = sampleLag()
  assert.ok(blocked.maxMs > idle.maxMs, `expected the block window (${blocked.maxMs}ms) to exceed the idle window (${idle.maxMs}ms)`)
})

test('reported fields are finite numbers or explicit nulls, never NaN', async () => {
  _resetForTests()
  startLagMonitor()
  const lag = sampleLag()
  for (const k of ['maxMs', 'meanMs']) {
    const v = lag[k]
    assert.ok(v === null || Number.isFinite(v), `${k} was ${v}`)
  }
})
