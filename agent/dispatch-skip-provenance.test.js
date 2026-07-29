// Every gate that stops a signal must leave a row.
//
// WHY THIS TEST EXISTS. On 2026-07-29 the staging soak showed `risk_events`
// and `decision_log` both EMPTY while the scan was healthy, analyses were
// being written every cycle with auto_trade:true and conviction 10, and no
// trade had fired for a day. Two empty audit tables read as "the bot
// considered nothing". The truth was the opposite: it considered plenty, and
// the stage-matrix gate said no to every one of them — vwap_trend,
// donchian_breakout and fib_confluence were all proposing while their "Auto
// Trade & Open" cells were off.
//
// The gate was working exactly as configured. The defect was that it wrote a
// stdout line and nothing else, so from the outside a correctly-working
// filter was indistinguishable from a dead pipeline. It cost a day of soak
// and an investigation to tell those two apart.
//
// So: the assertion here is not about a specific reason string. It is that
// these skip sites persist SOMETHING a human can read later.
import { test } from 'node:test'
import assert from 'node:assert'
import { initDB, getState, setState } from './db.js'
import { recordDecision, recentDecisions } from './services/decision-log.js'
import { tradeStageGate, setStage } from './services/stage-matrix.js'

const db = () => initDB(':memory:')

test('the stage gate blocks a strategy whose trade cell is off', () => {
  const d = db()
  // Mirror the staging matrix through the REAL writer: the trade column is
  // derived from the enabled-strategies list, not from a stored matrix blob,
  // so hand-writing state here would test a shape the loader never reads.
  const io = { getState, setState }
  setStage(d, { kind: 'strategy', key: 'fib_618_fade', stage: 'trade', on: true }, io)
  setStage(d, { kind: 'strategy', key: 'vwap_trend', stage: 'trade', on: false }, io)
  assert.equal(tradeStageGate(d, getState, { strategy: 'fib_618_fade' }).ok, true)

  const blocked = tradeStageGate(d, getState, { strategy: 'vwap_trend' })
  assert.equal(blocked.ok, false, 'vwap_trend must be blocked when its trade cell is off')
  assert.match(blocked.reason, /vwap_trend/, 'the reason must name the strategy — a bare "blocked" is useless in an audit')
})

test('a stage-gate skip is READABLE afterwards, not just logged to stdout', () => {
  const d = db()
  recordDecision(d, {
    symbol: 'USDJPY', timeframe: '1mo', strategy: 'vwap_trend',
    stage: 'stage_matrix', decision: 'skip',
    reason: "strategy 'vwap_trend' is OFF in Auto Trade & Open",
  })
  const rows = recentDecisions(d, { limit: 10 })
  assert.equal(rows.length, 1, 'the skip must produce exactly one row')
  const r = rows[0]
  assert.equal(r.stage, 'stage_matrix')
  assert.equal(r.decision, 'skip')
  assert.equal(r.symbol, 'USDJPY')
  assert.equal(r.strategy, 'vwap_trend', 'without the strategy the row cannot answer "why did nothing trade"')
  assert.match(r.reason, /Auto Trade & Open/)
})

test('a style-filter skip names the style bucket and the TTL that chose it', () => {
  const d = db()
  recordDecision(d, {
    symbol: 'BTCUSD', timeframe: '4h', strategy: 'donchian_breakout',
    stage: 'style_filter', decision: 'skip', reason: 'swing_disabled ttl=600m',
  })
  const [r] = recentDecisions(d, { limit: 10 })
  assert.equal(r.stage, 'style_filter')
  assert.match(r.reason, /swing_disabled/)
  assert.match(r.reason, /ttl=600m/, 'the TTL is what selected the bucket — without it the skip is unexplainable')
})

test('decisions are filterable by stage, so "why did nothing trade" is one query', () => {
  const d = db()
  for (const sym of ['USDJPY', 'GBPUSD', 'BTCUSD']) {
    recordDecision(d, { symbol: sym, stage: 'stage_matrix', decision: 'skip', reason: 'off' })
  }
  recordDecision(d, { symbol: 'EURUSD', stage: 'lesson_decay', decision: 'skip', reason: 'alpha_decay_cooloff' })

  assert.equal(recentDecisions(d, { stage: 'stage_matrix', limit: 50 }).length, 3)
  assert.equal(recentDecisions(d, { stage: 'lesson_decay', limit: 50 }).length, 1)
  assert.equal(recentDecisions(d, { limit: 50 }).length, 4)
})

test('an empty decision log means nothing was considered — it must not be the normal state', () => {
  // The inverse of the bug: with no skips recorded the table is empty, and
  // that emptiness now genuinely means "no signal reached a gate", because
  // every gate on the dispatch path writes. This test documents the contract
  // rather than exercising code.
  const d = db()
  assert.deepEqual(recentDecisions(d, { limit: 10 }), [])
})
