import { expect, it } from 'vitest'
import { createReportQueue } from './report-read-queue.js'

it('coalesces matching reads and serializes different reports without blocking after a failure', async () => {
  const started = [], complete = []
  const queue = createReportQueue(key => new Promise((resolve, reject) => {
    started.push(key); complete.push({ resolve, reject })
  }))
  const first = queue('first'), duplicate = queue('first'), second = queue('second')
  const failure = expect(first).rejects.toThrow('failed')
  expect(duplicate).toBe(first)
  await Promise.resolve()
  expect(started).toEqual(['first'])
  complete[0].reject(Error('failed')); await failure
  await Promise.resolve(); await Promise.resolve()
  expect(started).toEqual(['first', 'second'])
  complete[1].resolve({ accountId: '22' })
  expect(await second).toEqual({ accountId: '22' })
})

it('does not start queued traffic after the browser sleeps and bounds waiting work', async () => {
  let awake = true, complete, calls = 0
  const queue = createReportQueue(() => { calls++; return new Promise(resolve => { complete = resolve }) },
    { canRead: () => awake, maxPending: 2 })
  const first = queue('first'), second = queue('second')
  const sleeping = expect(second).rejects.toThrow('Report refresh paused')
  await expect(queue('third')).rejects.toThrow('Report refresh already pending')
  awake = false; complete('one'); await first; await sleeping
  expect(calls).toBe(1)
})
