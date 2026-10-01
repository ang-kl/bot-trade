import test from 'node:test'
import assert from 'node:assert/strict'
import {
  observePosition, wilderAtr, foldExcursion, recordObserve, observeIntervalMs,
  chandelierSinceEntry, OBSERVE_STATE_KEY,
} from './mae-chandelier-observe.js'

function barsFrom(closes) {
  return closes.map(c => ({ h: c + 1, l: c - 1, c }))
}

test('interval stays on the monitor clock and never below one second', () => {
  assert.equal(observeIntervalMs({}), 3000)
  assert.equal(observeIntervalMs({ FAST_MONITOR_MS: '250' }), 1000)
  assert.equal(observeIntervalMs({ FAST_MONITOR_MS: '5000' }), 5000)
})

test('a long that has not paid is recorded and may not amend', () => {
  const bars = barsFrom(Array.from({ length: 30 }, (_, i) => 100 + i))
  const reading = observePosition({
    side: 'LONG', entry: 120, price: 112, sl: 110, bars,
  })
  assert.equal(reading.mayAmend, false)
  assert.equal(reading.mae, 8)
  assert.ok(reading.maeOverRisk > 0.7)
  assert.equal(reading.reason, 'observe_only')
  assert.equal(JSON.stringify(reading).includes('"mayAmend":true'), false)
})

test('22-session chandelier and since-entry chandelier are not the same high', () => {
  const bars = []
  for (let i = 0; i < 22; i++) bars.push({ h: 200, l: 190, c: 195 })
  for (let i = 0; i < 5; i++) bars.push({ h: 110, l: 100, c: 105 })
  const atr = wilderAtr(bars, 22)
  assert.ok(atr > 0)
  const since = chandelierSinceEntry(bars, 22, 1, atr, 3)
  const book = observePosition({ side: 'LONG', entry: 108, price: 104, sl: 100, bars })
  assert.ok(book.chandelier22 > since)
  assert.equal(book.mayAmend, false)
})

test('fold keeps the worst heat and never raises mayAmend', () => {
  const folded = foldExcursion({ mae: 2, mfe: 1 }, { mae: 5, mfe: 0.5, mayAmend: true })
  assert.equal(folded.mae, 5)
  assert.equal(folded.mfe, 1)
  assert.equal(folded.mayAmend, false)
})

test('state write is observe-only', async () => {
  const store = new Map()
  const db = {}
  const io = {
    read: (_db, key) => store.get(key) || null,
    write: (_db, key, value) => store.set(key, value),
  }
  await recordObserve(db, [{ id: '242243012', symbol: 'MA.US', mae: 18.89, mfe: 6.34, mayAmend: true }], 0, io)
  const saved = JSON.parse(store.get(OBSERVE_STATE_KEY))
  assert.equal(saved.mayAmend, false)
  assert.equal(saved.mode, 'observe_only')
  assert.equal(saved.positions['242243012'].mayAmend, false)
  assert.equal(saved.positions['242243012'].mae, 18.89)
})
