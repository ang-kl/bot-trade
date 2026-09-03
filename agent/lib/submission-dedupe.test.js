// node --test agent/lib/submission-dedupe.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { recentAmbiguousSubmission, isoBoundMinutesAgo } from './submission-dedupe.js'

const NOW = Date.parse('2026-09-03T09:55:00Z')
function seed(db, { minutesAgo, symbol = 'BTCUSD', side = 'BUY', accountId = '46130058', reason = 'order_ambiguous: {"description":"guard_no_target"}', space = false }) {
  let at = new Date(NOW - minutesAgo * 60_000).toISOString()
  if (space) at = at.replace('T', ' ').replace(/\.\d{3}Z$/, '')
  return db.prepare(`INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at) VALUES (?, ?, 0, ?, '{}', '{}', ?, ?)`)
    .run(symbol, side, reason, accountId, at).lastInsertRowid
}

test('the bound is ISO with a T, the shape risk_events.created_at is written in', () => {
  assert.equal(isoBoundMinutesAgo(20, NOW), '2026-09-03T09:35:00Z')
})

test('THE MEASURED CASE: an ambiguous row 61 minutes old is OUTSIDE a 20-minute window; one 5 minutes old is inside', () => {
  const db = initDB(':memory:')
  seed(db, { minutesAgo: 61 })
  assert.equal(recentAmbiguousSubmission(db, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW }), null,
    'before the fix the ISO "T" sorted after the datetime space and this row matched until midnight UTC')
  const id = seed(db, { minutesAgo: 5 })
  const hit = recentAmbiguousSubmission(db, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW })
  assert.equal(hit?.id, id)
})

test('scoped by symbol, side and account; unscoped legacy rows still count; a space-formatted timestamp is compared the same way', () => {
  const db = initDB(':memory:')
  seed(db, { minutesAgo: 5, symbol: 'ETHUSD' })
  seed(db, { minutesAgo: 5, side: 'SELL' })
  seed(db, { minutesAgo: 5, accountId: '47790949' })
  assert.equal(recentAmbiguousSubmission(db, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW }), null)
  const legacy = seed(db, { minutesAgo: 5, accountId: null })
  assert.equal(recentAmbiguousSubmission(db, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW })?.id, legacy)
  const db2 = initDB(':memory:')
  seed(db2, { minutesAgo: 61, space: true })
  assert.equal(recentAmbiguousSubmission(db2, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW }), null)
  const sp = seed(db2, { minutesAgo: 5, space: true })
  assert.equal(recentAmbiguousSubmission(db2, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW })?.id, sp)
})

test('only order_ambiguous rows count — an order_failed row (provably no position) never blocks a retry', () => {
  const db = initDB(':memory:')
  seed(db, { minutesAgo: 2, reason: 'order_failed: TRADING_BAD_VOLUME' })
  assert.equal(recentAmbiguousSubmission(db, { symbol: 'BTCUSD', side: 'BUY', accountId: '46130058', windowMin: 20, nowMs: NOW }), null)
})

test('loop wiring pin: autoTrade reads the ambiguous window through recentAmbiguousSubmission, never an inline datetime comparison', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  assert.match(src, /recentAmbiguousSubmission\(db, \{ symbol, side, accountId, windowMin: DEDUPE_WINDOW_MIN \}\)/)
  assert.doesNotMatch(src, /veto_reason LIKE 'order_ambiguous:%'[\s\S]{0,120}created_at >= datetime\('now'/, 'the ISO-vs-datetime comparison must not come back')
})
