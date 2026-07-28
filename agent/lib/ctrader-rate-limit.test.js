// node --test agent/lib/ctrader-rate-limit.test.js
//
// Incident 2026-07-28: cTrader allows only 5 req/s for HISTORICAL requests
// (trendbars, deal list). The scan phase fanned out 6 concurrent connections
// each pipelining one trendbar request per timeframe — 20-40 historical
// req/s, 4-8x the allowance. The broker throttled us, requests stretched to
// ~29s, retries piled on, and the scan starved the HTTP server. These tests
// lock in the token bucket that paces those requests.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateBucket, historicalRateStatus } from './ctrader-ws.js'

/** Virtual clock so pacing is asserted deterministically, not by wall time. */
function fakeClock() {
  let t = 0
  const queue = [] // { at, fn }
  return {
    now: () => t,
    setTimeout: (fn, ms) => { queue.push({ at: t + Math.max(0, ms), fn }) },
    /** Advance time, firing due callbacks in order, letting microtasks drain. */
    async advance(ms) {
      const target = t + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at)
        const next = queue[0]
        if (!next || next.at > target) break
        queue.shift()
        t = next.at
        next.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
      t = target
      await Promise.resolve()
    },
  }
}

test('a burst is paced to the configured rate instead of going out at once', async () => {
  const clock = fakeClock()
  const bucket = createRateBucket(4, clock) // 4 per second
  const done = []
  // 12 concurrent historical requests — what one scan chunk looks like.
  const all = Promise.all(
    Array.from({ length: 12 }, (_, i) => bucket.take().then(waited => { done.push({ i, at: clock.now(), waited }) }))
  )

  // The bucket starts full: exactly `perSec` go immediately, not all 12.
  await clock.advance(0)
  assert.equal(done.length, 4, `expected 4 immediate, got ${done.length}`)

  // After one more second, 4 more tokens have accrued — 8 total.
  await clock.advance(1000)
  assert.ok(done.length >= 8 && done.length <= 9, `after 1s expected ~8 released, got ${done.length}`)

  // Everything drains, and nothing is lost.
  await clock.advance(3000)
  await all
  assert.equal(done.length, 12)

  // The whole burst took at least (12-4)/4 = 2s of real pacing.
  const last = Math.max(...done.map(d => d.at))
  assert.ok(last >= 2000, `12 requests at 4/s should span >= 2000ms, spanned ${last}ms`)
})

test('immediate grants report zero wait; queued ones report what they waited', async () => {
  const clock = fakeClock()
  const bucket = createRateBucket(2, clock)
  const waits = []
  const all = Promise.all(
    Array.from({ length: 4 }, () => bucket.take().then(w => waits.push(w)))
  )
  await clock.advance(0)
  await clock.advance(2000)
  await all
  const immediate = waits.filter(w => w === 0)
  const queued = waits.filter(w => w > 0)
  assert.equal(immediate.length, 2, 'bucket of 2 should grant 2 immediately')
  assert.equal(queued.length, 2, 'the other 2 must report a real wait')
  // The wait must be credited back to the caller's timeout, so it has to be
  // a truthful duration, not a flag.
  for (const w of queued) assert.ok(w >= 400, `queued wait ${w}ms looks unrealistically short for 2/s`)
})

test('an idle bucket refills to full and never exceeds its cap', async () => {
  const clock = fakeClock()
  const bucket = createRateBucket(3, clock)
  await Promise.all([bucket.take(), bucket.take(), bucket.take()])
  assert.ok(bucket.status().tokens < 1, 'bucket should be drained')
  await clock.advance(60_000) // long idle
  const st = bucket.status()
  assert.equal(st.tokens, 3, 'refill must cap at perSec, not accumulate a giant burst allowance')
  assert.equal(st.queued, 0)
})

test('the live historical limiter is wired and reports its rate', () => {
  const st = historicalRateStatus()
  assert.ok(st.perSec >= 1 && st.perSec <= 5, `historical rate ${st.perSec}/s must stay at or under the broker's 5/s`)
  assert.equal(typeof st.queued, 'number')
})
