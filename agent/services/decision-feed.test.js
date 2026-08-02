import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { decisionFeed, REASONS_PER_STAGE, MAX_ROWS } from './decision-feed.js'

const NOW = Date.parse('2026-08-02T12:00:00Z')
const HOUR = 3_600_000

function freshDb() {
  return initDB(':memory:')
}

/** Insert one decision. `atMs` defaults to just inside the default window. */
function log(db, { account = null, symbol = 'EURUSD', stage = 'style_filter', decision = 'skip', reason = 'wrong style', atMs = NOW - HOUR, strategy = 'ema' } = {}) {
  db.prepare(`
    INSERT INTO decision_log (account_id, symbol, timeframe, strategy, stage, decision, reason, created_at)
    VALUES (?, ?, 'H1', ?, ?, ?, ?, ?)
  `).run(account, symbol, strategy, stage, decision, reason,
    // SQLite's own datetime('now') form — space separated, no zone. Writing
    // rows this way is the point: it is what production actually stores.
    new Date(atMs).toISOString().replace('T', ' ').replace('Z', ''))
}

test('an empty window is an empty window, not an error', () => {
  const db = freshDb()
  const out = decisionFeed(db, { now: NOW })
  assert.equal(out.total, 0)
  assert.deepEqual(out.stages, [])
  assert.deepEqual(out.rows, [])
})

test('rows written in SQLite space form are inside the window', () => {
  // The bug this pins: comparing a 'T' ISO cutoff against space-separated
  // created_at matches nothing, and the panel would read "no decisions at
  // all" — the most misleading answer a why-didn-t-it-trade view can give.
  const db = freshDb()
  log(db, { atMs: NOW - HOUR })
  const out = decisionFeed(db, { now: NOW })
  assert.equal(out.total, 1)
  assert.equal(out.rows.length, 1)
})

test('the window actually excludes older rows', () => {
  const db = freshDb()
  log(db, { atMs: NOW - 2 * HOUR })
  log(db, { atMs: NOW - 40 * HOUR })
  assert.equal(decisionFeed(db, { now: NOW, hours: 24 }).total, 1)
  assert.equal(decisionFeed(db, { now: NOW, hours: 48 }).total, 2)
})

test('the summary decomposes by stage and decision, ranked by volume', () => {
  const db = freshDb()
  for (let i = 0; i < 5; i++) log(db, { stage: 'dispatch', decision: 'skip', reason: 'account may not trade' })
  for (let i = 0; i < 2; i++) log(db, { stage: 'style_filter', decision: 'skip', reason: 'wrong style' })
  log(db, { stage: 'dispatch', decision: 'proceed', reason: null })
  const out = decisionFeed(db, { now: NOW })
  assert.equal(out.total, 8)
  assert.equal(out.stages[0].stage, 'dispatch', 'busiest stage first')
  assert.equal(out.stages[0].count, 6)
  assert.equal(out.stages[0].decisions.skip, 5)
  assert.equal(out.stages[0].decisions.proceed, 1)
  assert.equal(out.totals.skip, 7)
  assert.equal(out.totals.proceed, 1)
})

test('repeats are counted AND collapsed: a few stuck setups vs a universe-wide filter', () => {
  const db = freshDb()
  // 30 rows, 3 symbols — one waiting setup per symbol retrying every cycle.
  for (const s of ['EURUSD', 'GBPUSD', 'XAUUSD']) {
    for (let i = 0; i < 10; i++) log(db, { symbol: s, stage: 'stuck' })
  }
  // 30 rows, 30 symbols — a filter rejecting the whole universe.
  for (let i = 0; i < 30; i++) log(db, { symbol: `SYM${i}`, stage: 'wide' })
  const out = decisionFeed(db, { now: NOW })
  const stuck = out.stages.find(s => s.stage === 'stuck')
  const wide = out.stages.find(s => s.stage === 'wide')
  assert.equal(stuck.count, 30)
  assert.equal(wide.count, 30, 'the raw counts are identical — volume alone cannot tell them apart')
  assert.equal(stuck.distinctSymbols, 3)
  assert.equal(wide.distinctSymbols, 30)
  assert.equal(stuck.repeatRatio, 10)
  assert.equal(wide.repeatRatio, 1)
})

test('per-stage distinct symbols are not summed from the per-reason counts', () => {
  const db = freshDb()
  // ONE symbol, two reasons. Adding the per-reason distinct counts would say
  // 2 symbols and halve the repeat ratio.
  log(db, { symbol: 'EURUSD', stage: 'gate', reason: 'reason A' })
  log(db, { symbol: 'EURUSD', stage: 'gate', reason: 'reason B' })
  const stage = decisionFeed(db, { now: NOW }).stages.find(s => s.stage === 'gate')
  assert.equal(stage.distinctSymbols, 1)
  assert.equal(stage.reasons.length, 2)
  assert.equal(stage.repeatRatio, 2)
})

test('reasons are ranked and capped, with the overflow reported', () => {
  const db = freshDb()
  for (let i = 0; i < REASONS_PER_STAGE + 3; i++) {
    // Descending volume so the ranking is checkable.
    for (let k = 0; k <= i; k++) log(db, { stage: 'gate', reason: `reason ${i}` })
  }
  const stage = decisionFeed(db, { now: NOW }).stages.find(s => s.stage === 'gate')
  assert.equal(stage.reasons.length, REASONS_PER_STAGE)
  assert.equal(stage.moreReasons, 3)
  assert.ok(stage.reasons[0].count > stage.reasons[1].count, 'ranked by volume')
})

test('account scoping includes the unstamped rows and says how many', () => {
  const db = freshDb()
  log(db, { account: 'A' })
  log(db, { account: 'A' })
  log(db, { account: null })          // predates per-account stamping
  log(db, { account: 'B' })
  const scoped = decisionFeed(db, { now: NOW, accountId: 'A' })
  assert.equal(scoped.total, 3, "account A's own rows plus the unstamped one")
  assert.equal(scoped.unstamped, 1, 'never presented silently as A own')
  const all = decisionFeed(db, { now: NOW, accountId: 'all' })
  assert.equal(all.total, 4)
  assert.equal(all.accountId, null)
})

test('another account rows never leak into a scoped read', () => {
  const db = freshDb()
  for (let i = 0; i < 10; i++) log(db, { account: 'B', symbol: `B${i}` })
  const scoped = decisionFeed(db, { now: NOW, accountId: 'A' })
  assert.equal(scoped.total, 0)
  assert.equal(scoped.rows.length, 0)
})

test('stage, decision and symbol filters apply to BOTH the rows and the summary', () => {
  const db = freshDb()
  log(db, { stage: 'gate', decision: 'veto', symbol: 'EURUSD' })
  log(db, { stage: 'gate', decision: 'skip', symbol: 'EURUSD' })
  log(db, { stage: 'other', decision: 'veto', symbol: 'GBPUSD' })
  const byStage = decisionFeed(db, { now: NOW, stage: 'gate' })
  assert.equal(byStage.total, 2)
  assert.equal(byStage.rows.length, 2)
  const byDecision = decisionFeed(db, { now: NOW, decision: 'veto' })
  assert.equal(byDecision.total, 2)
  const bySymbol = decisionFeed(db, { now: NOW, symbol: 'gbpusd' })
  assert.equal(bySymbol.total, 1, 'symbol match is case-insensitive on the query side')
})

test('rows are newest first and the cap is reported rather than hidden', () => {
  const db = freshDb()
  for (let i = 0; i < 12; i++) log(db, { symbol: `S${i}`, atMs: NOW - (12 - i) * 60_000 })
  const out = decisionFeed(db, { now: NOW, limit: 5 })
  assert.equal(out.rows.length, 5)
  assert.equal(out.rows[0].symbol, 'S11', 'newest first')
  assert.equal(out.truncated, true)
  assert.equal(out.total, 12, 'the summary still counts every row in the window')
})

test('the row limit is clamped, so a caller cannot ask for the whole table', () => {
  const db = freshDb()
  log(db)
  assert.equal(decisionFeed(db, { now: NOW, limit: 100_000 }).rows.length, 1)
  // The clamp is on the SQL LIMIT; with one row present we can only assert it
  // did not throw and did not return more than exists. MAX_ROWS is the
  // documented ceiling.
  assert.ok(MAX_ROWS <= 500)
})

test('an unknown decision value is counted, not dropped', () => {
  const db = freshDb()
  log(db, { decision: 'deferred' })
  const out = decisionFeed(db, { now: NOW })
  assert.equal(out.total, 1)
  assert.equal(out.totals.other, 1, 'a value outside proceed/skip/veto still appears in the total')
})

test('a NULL reason does not collapse into another reason bucket', () => {
  const db = freshDb()
  log(db, { stage: 'gate', reason: null })
  log(db, { stage: 'gate', reason: 'named' })
  const stage = decisionFeed(db, { now: NOW }).stages.find(s => s.stage === 'gate')
  assert.equal(stage.reasons.length, 2)
  assert.ok(stage.reasons.some(r => r.reason === null))
})
