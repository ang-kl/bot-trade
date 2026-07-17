// node --test agent/services/llm-spend.test.js
//
// LLM cost accounting: per-model pricing, upsert accumulation, the spend
// view aggregation + projection, and the once-per-day cap alert.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { costUsd, recordTokenUsage, spendView, checkSpendAlert } from './llm-spend.js'

const T = new Date('2026-07-17T12:00:00Z')

test('costUsd prices per published rates; unknown models price at Opus tier (surprise-down)', () => {
  // sonnet 4.6: $3/M in, $15/M out
  assert.equal(costUsd('claude-sonnet-4-6', { input: 1_000_000, output: 1_000_000 }), 18)
  // haiku: $1/$5
  assert.equal(costUsd('claude-haiku-4-5', { input: 1_000_000 }), 1)
  // cache read = 0.1× input rate; cache write = 1.25×
  assert.equal(costUsd('claude-sonnet-4-6', { cacheRead: 1_000_000 }), 0.3)
  assert.equal(costUsd('claude-sonnet-4-6', { cacheWrite: 1_000_000 }), 3.75)
  // unknown model → Opus $5/$25, never cheaper than reality
  assert.equal(costUsd('mystery-model', { input: 1_000_000, output: 1_000_000 }), 30)
  // dated variants match by prefix
  assert.equal(costUsd('claude-sonnet-4-5-20250929', { output: 1_000_000 }), 15)
})

test('recordTokenUsage accumulates per day×purpose×model', () => {
  const db = initDB(':memory:')
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 }
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage, now: T })
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage, now: T })
  recordTokenUsage(db, { purpose: 'weekend_watch', model: 'claude-sonnet-4-6', usage: { output_tokens: 50 }, now: T })
  const row = db.prepare(`SELECT * FROM token_usage WHERE purpose = 'position_monitor'`).get()
  assert.equal(row.calls, 2)
  assert.equal(row.input_tokens, 2000)
  assert.equal(row.output_tokens, 400)
  assert.equal(row.cache_read_tokens, 1000)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM token_usage').get().n, 2)
})

test('spendView: today/7d/30d windows, per-purpose rows, monthly projection', () => {
  const db = initDB(':memory:')
  const day = (offset) => new Date(T.getTime() - offset * 86400_000)
  // 100k output tokens on sonnet ($15/M → $1.50) today, 8 days ago, 40 days ago
  const usage = { output_tokens: 100_000 }
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage, now: day(0) })
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage, now: day(8) })
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage, now: day(40) })

  const v = spendView(db, { now: T })
  assert.equal(v.today.cost_usd, 1.5)
  assert.equal(v.last7d.cost_usd, 1.5)     // 8-days-ago is outside 7d
  assert.equal(v.last30d.cost_usd, 3)      // 40-days-ago is outside 30d
  assert.equal(v.by_purpose.length, 1)
  assert.equal(v.by_purpose[0].calls, 2)   // 30d scope
  // 2 active days in 30d window → $1.50/day avg → $45 projected
  assert.equal(v.projected_month_usd, 45)
})

test('checkSpendAlert: off without a cap; fires once per day when crossed; re-arms next day', () => {
  const db = initDB(':memory:')
  const alerts = []
  const notify = (t) => alerts.push(t)
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage: { output_tokens: 200_000 }, now: T }) // $3

  assert.equal(checkSpendAlert(db, { now: T, notify }), null) // no cap set

  setState(db, 'llm_daily_cost_alert_usd', '10')
  assert.equal(checkSpendAlert(db, { now: T, notify }), null) // $3 < $10

  setState(db, 'llm_daily_cost_alert_usd', '2')
  assert.deepEqual(checkSpendAlert(db, { now: T, notify }), { alerted: true, spent: 3 })
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /\$3\.00/)
  // second check same day → no re-alert
  assert.deepEqual(checkSpendAlert(db, { now: T, notify }), { alerted: false, spent: 3 })
  assert.equal(alerts.length, 1)

  // next day with fresh spend → alerts again
  const T2 = new Date(T.getTime() + 86400_000)
  recordTokenUsage(db, { purpose: 'position_monitor', model: 'claude-sonnet-4-5', usage: { output_tokens: 200_000 }, now: T2 })
  assert.equal(checkSpendAlert(db, { now: T2, notify }).alerted, true)
  assert.equal(alerts.length, 2)
})
