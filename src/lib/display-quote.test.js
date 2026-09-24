import { it, expect } from 'vitest'
import { mergeDisplayQuote, displayQuote } from './display-quote.js'
it('one-sided ticks keep the other observed side and its age', () => {
  const a = mergeDisplayQuote(null, { accountId: '11', host: 'broker', bid: 100, ask: 102 }, 1000)
  const b = mergeDisplayQuote(a, { accountId: '11', host: 'broker', bid: 102, ask: null }, 2000)
  expect(displayQuote(b, 2000)).toEqual({ price: 102, delta: (102 / 101 - 1) * 100 })
  expect(b.askReceivedAt).toBe(1000)
  expect(displayQuote(b, 16001).price).toBeNull()
})
it('new account cannot inherit an old side or baseline; an incomplete first tick has no midpoint', () => {
  const a = mergeDisplayQuote(null, { accountId: '11', bid: 100, ask: 102 }, 1000)
  const b = mergeDisplayQuote(a, { accountId: '22', bid: 200, ask: null }, 2000)
  expect(b.ask).toBeNull(); expect(b.firstMid).toBeNull(); expect(displayQuote(b, 2000).price).toBeNull()
  const c = mergeDisplayQuote(b, { accountId: '22', bid: null, ask: 202 }, 3000)
  expect(displayQuote(c, 3000)).toEqual({ price: 201, delta: 0 })
})
