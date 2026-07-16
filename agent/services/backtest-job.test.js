// node --test agent/services/backtest-job.test.js
//
// Single-slot background backtest job: results survive the browser page
// that fired them; a second run while one is in flight is refused with the
// running job's metadata; failures land in job.error, never thrown.

import test from 'node:test'
import assert from 'node:assert/strict'
import { startBacktestJob, currentJob, jobMeta, _resetBacktestJob } from './backtest-job.js'

const flush = () => new Promise(r => setImmediate(r))

test('a job runs to done and keeps its result server-side', async () => {
  _resetBacktestJob()
  const { job, conflict } = startBacktestJob({ symbols: ['EURUSD'] }, async () => ({ answer: 42 }))
  assert.equal(conflict, undefined)
  assert.equal(job.status, 'running')
  await flush()
  assert.equal(currentJob().status, 'done')
  assert.deepEqual(currentJob().result, { answer: 42 })
  assert.ok(currentJob().finishedAt)
  // meta view never carries the (potentially huge) result payload
  assert.equal('result' in jobMeta(), false)
})

test('a second start while running is a conflict, not a second run', async () => {
  _resetBacktestJob()
  let release
  const gate = new Promise(r => { release = r })
  const first = startBacktestJob({ symbols: ['A'] }, () => gate)
  const second = startBacktestJob({ symbols: ['B'] }, async () => 'never')
  assert.ok(second.conflict, 'second start must be refused')
  assert.equal(second.conflict.id, first.job.id)
  release('ok')
  await flush()
  assert.equal(currentJob().result, 'ok')
  // after completion a new run is allowed again
  const third = startBacktestJob({ symbols: ['C'] }, async () => 'third')
  assert.equal(third.conflict, undefined)
  await flush()
  assert.equal(currentJob().result, 'third')
})

test('a throwing work fn becomes status=error with the message captured', async () => {
  _resetBacktestJob()
  startBacktestJob({}, async () => { throw new Error('broker timeout') })
  await flush()
  assert.equal(currentJob().status, 'error')
  assert.equal(currentJob().error, 'broker timeout')
  assert.equal(currentJob().result, null)
})
