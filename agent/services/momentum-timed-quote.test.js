import test from 'node:test'
import assert from 'node:assert/strict'
import { readMomentumTimedQuote } from './momentum-timed-quote.js'

const creds = { host: 'demo.ctraderapi.com', accountId: '11', clientId: 'x', clientSecret: 'y', accessToken: 'z' }
const at = 1790264000000

test('bounded quote keeps broker timestamp and closes its subscription', async () => {
  let closed = 0, options
  const quote = await readMomentumTimedQuote(creds, '22', { now: () => at, timeoutMs: 30,
    stream: async (...args) => { options = args[8]; queueMicrotask(() => args[6]({ symbolId: '22', accountId: '11', bid: 100, ask: 101, brokerAtMs: at - 40 }));
      return { close: () => { closed++ } } },
  })
  assert.equal(options.timestamped, true)
  assert.equal(quote.timestamp, at - 40)
  assert.equal(quote.bid, 10000000)
  assert.equal(closed, 1)
})

test('timeout closes a late subscription and never refreshes missing timestamps', async () => {
  let closed = 0, resolveConnection
  const result = readMomentumTimedQuote(creds, '22', { timeoutMs: 5,
    stream: () => new Promise(resolve => { resolveConnection = resolve }),
  })
  assert.equal(await result, null)
  resolveConnection({ close: () => { closed++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
  const noTime = await readMomentumTimedQuote(creds, '22', { timeoutMs: 10,
    stream: async (...args) => { queueMicrotask(() => args[6]({ symbolId: '22', accountId: '11', bid: 100, ask: 101 })); return { close() {} } },
  })
  assert.equal(noTime, null)
})

test('foreign events and one-sided quotes are never joined into an invented current quote', async () => {
  // The clock is pinned to the events' time, so these are refused for their
  // identity and sides, not for their age.
  const quote = await readMomentumTimedQuote(creds, '22', { now: () => at, timeoutMs: 10,
    stream: async (...args) => { queueMicrotask(() => {
      args[6]({ symbolId: '22', accountId: '12', bid: 100, ask: 101, brokerAtMs: at })
      args[6]({ symbolId: '23', accountId: '11', bid: 100, ask: 101, brokerAtMs: at })
      args[6]({ symbolId: '22', accountId: '11', bid: 100, ask: null, brokerAtMs: at })
      args[6]({ symbolId: '22', accountId: '11', bid: null, ask: 101, brokerAtMs: at })
    }); return { close() {} } },
  })
  assert.equal(quote, null)
})

// T1 (V3 P0-1a): the initial subscription event is often the last close's
// quote. Returning it made the decoder refuse fresh_quote_required on every
// pass for a quiet symbol, although a fresh event arrived inside the budget.
test('a stale event followed by a fresh one returns the fresh one', async () => {
  let closed = 0
  const quote = await readMomentumTimedQuote(creds, '22', { now: () => at, maxAgeMs: 5000, timeoutMs: 50,
    stream: async (...args) => {
      queueMicrotask(() => args[6]({ symbolId: '22', accountId: '11', bid: 90, ask: 91, brokerAtMs: at - 3_600_000 }))
      setTimeout(() => args[6]({ symbolId: '22', accountId: '11', bid: 100, ask: 101, brokerAtMs: at - 10 }), 5)
      return { close: () => { closed++ } }
    },
  })
  assert.equal(quote.timestamp, at - 10)
  assert.equal(quote.bid, 10000000)
  assert.equal(closed, 1)
})

test('only stale or future-dated events wait out the deadline and return nothing', async () => {
  let closed = 0
  const started = Date.now()
  const quote = await readMomentumTimedQuote(creds, '22', { now: () => at, maxAgeMs: 5000, timeoutMs: 30,
    stream: async (...args) => {
      queueMicrotask(() => {
        args[6]({ symbolId: '22', accountId: '11', bid: 90, ask: 91, brokerAtMs: at - 5001 })
        args[6]({ symbolId: '22', accountId: '11', bid: 90, ask: 91, brokerAtMs: at + 1 })
      })
      return { close: () => { closed++ } }
    },
  })
  assert.equal(quote, null)
  assert.ok(Date.now() - started >= 25, 'a stale event must not end the wait early')
  assert.equal(closed, 1)
  // The boundary is the decoder's: exactly maxAgeMs old is still fresh.
  const edge = await readMomentumTimedQuote(creds, '22', { now: () => at, maxAgeMs: 5000, timeoutMs: 30,
    stream: async (...args) => { queueMicrotask(() => args[6]({ symbolId: '22', accountId: '11', bid: 90, ask: 91, brokerAtMs: at - 5000 })); return { close() {} } },
  })
  assert.equal(edge.timestamp, at - 5000)
})

test('an invalid clock or age bound refuses before subscribing', async () => {
  let subscribed = 0
  const stream = async () => { subscribed++; return { close() {} } }
  for (const options of [{ now: null }, { maxAgeMs: 0 }, { maxAgeMs: 10001 }, { maxAgeMs: NaN }]) {
    assert.equal(await readMomentumTimedQuote(creds, '22', { stream, timeoutMs: 10, ...options }), null, JSON.stringify(options))
  }
  assert.equal(subscribed, 0)
})
