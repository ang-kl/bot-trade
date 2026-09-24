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
  const quote = await readMomentumTimedQuote(creds, '22', { timeoutMs: 10,
    stream: async (...args) => { queueMicrotask(() => {
      args[6]({ symbolId: '22', accountId: '12', bid: 100, ask: 101, brokerAtMs: at })
      args[6]({ symbolId: '23', accountId: '11', bid: 100, ask: 101, brokerAtMs: at })
      args[6]({ symbolId: '22', accountId: '11', bid: 100, ask: null, brokerAtMs: at })
      args[6]({ symbolId: '22', accountId: '11', bid: null, ask: 101, brokerAtMs: at })
    }); return { close() {} } },
  })
  assert.equal(quote, null)
})
