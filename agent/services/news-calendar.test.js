// node --test agent/services/news-calendar.test.js — pure parts only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { symbolCurrencies, relevantEvents, formatNewsLines } from './news-calendar.js'

test('symbolCurrencies maps symbols to the currencies that move them', () => {
  assert.deepEqual(symbolCurrencies('EURUSD'), ['EUR', 'USD'])
  assert.deepEqual(symbolCurrencies('JPN225'), ['JPY'])
  assert.deepEqual(symbolCurrencies('NAS100'), ['USD'])
  assert.deepEqual(symbolCurrencies('XAUUSD'), ['USD'])
  assert.deepEqual(symbolCurrencies('MSFT.US'), ['USD'])
})

const now = Date.UTC(2026, 6, 10, 12, 0)
const ev = (country, impact, hoursFromNow, title = 'CPI') =>
  ({ country, impact, title, date: new Date(now + hoursFromNow * 3600_000).toISOString() })

test('relevantEvents: currency match, impact filter, time window, sorted, capped', () => {
  const events = [
    ev('USD', 'High', 3), ev('USD', 'Low', 1), ev('EUR', 'High', 5),
    ev('JPY', 'High', 2), ev('USD', 'Medium', -1), ev('USD', 'High', 40),
    ev('USD', 'High', 6), ev('USD', 'High', 8), ev('USD', 'Medium', 10), ev('USD', 'High', 12),
  ]
  const rel = relevantEvents(events, 'EURUSD', now)
  assert.ok(rel.every(e => ['USD', 'EUR'].includes(e.country)))
  assert.ok(rel.every(e => e.impact !== 'Low'))
  assert.ok(!rel.some(e => e.t > now + 24 * 3600_000), '40h event excluded')
  assert.equal(rel.length, 4, 'capped at 4')
  assert.ok(rel[0].t <= rel[1].t)
})

test('formatNewsLines: words + impact marker, past and future phrasing', () => {
  const lines = formatNewsLines(relevantEvents([ev('USD', 'High', 3), ev('USD', 'Medium', -1)], 'EURUSD', now), now)
  assert.match(lines.find(l => l.includes('HIGH')), /in 3h/)
  assert.match(lines.find(l => l.includes('med')), /60m ago/)
})
