// go-live-readiness.test.js
//
// The behaviour under test is the THIRD verdict. A pass/fail gate would have
// reported this account's PF 0.84 as a clean "NO" all week, while 29.5% of
// rows contradicted themselves and two thirds had no strategy attached. The
// tests that matter here are the ones where the bar and the integrity check
// disagree.

import test from 'node:test'
import assert from 'node:assert/strict'
import { goLiveReadiness, integrityOf, edgeOf, bucketsOf, deadlineProjection, INTEGRITY_LIMITS, strategyOf } from './go-live-readiness.js'

const GOAL = { profitFactor: 1.68, winRatePct: 68, gateOn: 'profitFactor', minTrades: 30, deadline: '2026-08-12' }
const NOW = Date.parse('2026-08-08T00:00:00Z')

// A clean row: attributed, decidable, unflagged.
const row = (i, pnl, { strategy = 'vwap_trend', symbol = 'GD.US', tf = '1h', flag = 0, attributed = true } = {}) => ({
  id: i, symbol, side: 'BUY', entry_price: 100, exit_price: 100 + pnl / 10, volume: 1,
  net_pnl: pnl,
  label_strategy: attributed ? strategy : null,
  label_timeframe: tf,
  pnl_price_mismatch: flag, exit_price_suspect: 0,
})
// n clean rows alternating win/loss at a chosen ratio.
const clean = (n, { winEvery = 2, win = 100, loss = -50, ...rest } = {}) =>
  Array.from({ length: n }, (_, i) => row(i + 1, (i % winEvery === 0) ? win : loss, rest))

test('a clean record that fails the bar is NO — a real answer about the edge', () => {
  // 40 rows, half win 100 / half lose 200 → PF 0.5.
  const rows = clean(40, { winEvery: 2, win: 100, loss: -200 })
  const r = goLiveReadiness({ rows, goal: GOAL, nowMs: NOW })
  assert.equal(r.verdict, 'NO')
  assert.equal(r.integrity.clean, true)
  assert.match(r.headline, /Record is clean, so this is a real answer/)
})

test('a clean record that meets the bar is GO', () => {
  const rows = clean(40, { winEvery: 2, win: 400, loss: -100 }) // PF 4.0
  const r = goLiveReadiness({ rows, goal: GOAL, nowMs: NOW })
  assert.equal(r.verdict, 'GO')
  assert.equal(r.gate.profitFactor.met, true)
})

test('THE POINT: a met bar on a dirty record is UNMEASURABLE, not GO', () => {
  // Same PF 4.0 that just returned GO — but a fifth of the rows disagree with
  // themselves. A two-valued gate would have said GO on this, which is the
  // exact sentence this module exists to prevent.
  const rows = clean(40, { winEvery: 2, win: 400, loss: -100 })
  for (let i = 0; i < 8; i++) rows[i].pnl_price_mismatch = 1   // 20% flagged
  const r = goLiveReadiness({ rows, goal: GOAL, nowMs: NOW })
  assert.equal(r.gate.barMet, true, 'the bar IS met')
  assert.equal(r.verdict, 'UNMEASURABLE', 'and it still must not say GO')
  assert.match(r.headline, /not a verdict about the edge/)
  assert.match(r.integrity.blockers.join(' '), /disagreeing with themselves/)
})

test('the magnitude flag counts toward integrity too, not just the sign flag', () => {
  const rows = clean(40, { winEvery: 2, win: 400, loss: -100 })
  for (let i = 0; i < 8; i++) rows[i].exit_price_suspect = 1
  assert.equal(goLiveReadiness({ rows, goal: GOAL, nowMs: NOW }).verdict, 'UNMEASURABLE')
})

test("the 'other' bucket blocks a verdict once it dominates — 151 of 226 did", () => {
  const rows = [...clean(15, { win: 400, loss: -100 }), ...clean(25, { attributed: false, win: 400, loss: -100 })]
  const r = goLiveReadiness({ rows, goal: GOAL, nowMs: NOW })
  assert.equal(r.verdict, 'UNMEASURABLE')
  assert.match(r.integrity.blockers.join(' '), /no strategy attribution/)
  assert.ok(r.integrity.unattributedFrac > INTEGRITY_LIMITS.maxUnattributedFrac)
})

test('UNMEASURABLE is a different instruction from NO, and the headline says so', () => {
  const dirty = clean(40, { win: 100, loss: -200 })
  for (let i = 0; i < 20; i++) dirty[i].pnl_price_mismatch = 1
  const u = goLiveReadiness({ rows: dirty, goal: GOAL, nowMs: NOW })
  const n = goLiveReadiness({ rows: clean(40, { win: 100, loss: -200 }), goal: GOAL, nowMs: NOW })
  assert.equal(u.verdict, 'UNMEASURABLE')
  assert.equal(n.verdict, 'NO')
  assert.match(u.headline, /fix|cannot carry|integrity blocker/i)
  assert.notEqual(u.headline, n.headline)
})

test('an empty record is UNMEASURABLE, and PF is null rather than zero', () => {
  const r = goLiveReadiness({ rows: [], goal: GOAL, nowMs: NOW })
  assert.equal(r.verdict, 'UNMEASURABLE')
  // A PF of 0 reads as "terrible"; the truth is "no trades". Those must not
  // look alike on a go-live screen.
  assert.equal(r.edge.profitFactor, null)
  assert.equal(r.edge.winRatePct, null)
})

test('no losses at all is null PF, not an infinite edge', () => {
  const e = edgeOf([{ net_pnl: 10 }, { net_pnl: 20 }])
  assert.equal(e.profitFactor, null, 'Infinity would render as a triumph')
  assert.equal(e.winRatePct, 100)
})

test('a combo short only of SAMPLE gets a countdown; one failing on PF does not', () => {
  const rows = [
    // 10 trades, PF 4.0, 50% wins → passes PF, fails the 60% win-rate bar.
    ...clean(10, { winEvery: 2, win: 400, loss: -100, symbol: 'A' }),
    // 10 trades, PF 8.0, 80% wins → passes both, short on trades only.
    ...Array.from({ length: 10 }, (_, i) =>
      row(100 + i, i % 5 === 0 ? -100 : 100, { symbol: 'B' })),
  ]
  const b = bucketsOf(rows)
  const a = b.find(x => x.symbol === 'A')
  const bb = b.find(x => x.symbol === 'B')
  assert.equal(a.tradesToArm, null, 'failing on a ratio is not N trades away')
  assert.ok(a.failing.some(f => /winRate/.test(f)))
  assert.equal(bb.tradesToArm, 15, '25 - 10')
  assert.equal(bb.armed, false)
})

test('unattributed rows never form a bucket — a bucket needs a strategy', () => {
  assert.deepEqual(bucketsOf(clean(20, { attributed: false })), [])
  assert.deepEqual(bucketsOf([{ symbol: 'X', label_strategy: 'other', net_pnl: 5 }]), [])
})

test('the deadline projection refuses to guess without a clock', () => {
  const p = deadlineProjection({ deadline: '2026-08-12', nowMs: null, trades: 10, windowDays: 30, tradesNeeded: 20 })
  assert.equal(p.daysLeft, null)
  assert.equal(p.willMakeIt, null)
  assert.match(p.note, /not computed rather than guessed/)
})

test('a zero trade rate with trades needed is "cannot say", not "no"', () => {
  const p = deadlineProjection({ deadline: '2026-08-12', nowMs: NOW, trades: 0, windowDays: 30, tradesNeeded: 30 })
  assert.equal(p.willMakeIt, null, 'a rate of zero is no data, not a slow yes')
  assert.equal(p.daysLeft, 4)
})

test('the live arithmetic: 13 trades in 30 days against a 12-08 deadline', () => {
  // vwap_trend's real rate. 30 needed, 13 in the window → 0.43/day → 40 days
  // to close a 17-trade gap, against 4 days left.
  const p = deadlineProjection({ deadline: '2026-08-12', nowMs: NOW, trades: 13, windowDays: 30, tradesNeeded: 17 })
  assert.equal(p.daysLeft, 4)
  assert.equal(p.tradesPerDay, 0.43)
  assert.ok(p.daysToClose > 30, `daysToClose ${p.daysToClose}`)
  assert.equal(p.willMakeIt, false)
})

test('gateOn is honoured — profitFactor alone by owner decision 03-08', () => {
  // PF 4.0 with a 50% win rate: passes on profitFactor, fails on 'both'.
  const rows = clean(40, { winEvery: 2, win: 400, loss: -100 })
  assert.equal(goLiveReadiness({ rows, goal: { ...GOAL, gateOn: 'profitFactor' }, nowMs: NOW }).verdict, 'GO')
  assert.equal(goLiveReadiness({ rows, goal: { ...GOAL, gateOn: 'both' }, nowMs: NOW }).verdict, 'NO')
})

test('integrity counts decidability separately from flags', () => {
  // Rows with the money but no exit price: not flagged, not judgeable.
  const rows = clean(40, { win: 400, loss: -100 }).map(r => ({ ...r, exit_price: null }))
  const i = integrityOf(rows)
  assert.equal(i.flagged, 0)
  assert.equal(i.decidable, 0)
  assert.match(i.blockers.join(' '), /fields needed to judge/)
})

// ---------------------------------------------------------------------------
// 'other' is the ABSENCE of an answer — it must never shadow one.
//
// The loop writes BOTH columns: `trades.strategy` gets the real key, and
// `label_strategy` gets whatever survives a round-trip through the broker
// label. A strategy with no code in trade-labels.js round-trips as the string
// 'other', which is not null — so `label_strategy ?? strategy` preferred it.
//
// Production, 2026-08-14: 629 of 882 closed rows (71.3%) read as unattributed
// and the gate returned UNMEASURABLE. The ledger knew what those trades were.
// ---------------------------------------------------------------------------

test('strategyOf: a real strategy column is not shadowed by a label that says "other"', () => {
  assert.equal(strategyOf({ label_strategy: 'other', strategy: 'va_breakout' }), 'va_breakout')
  assert.equal(strategyOf({ label_strategy: null, strategy: 'fvg_retrace' }), 'fvg_retrace')
  assert.equal(strategyOf({ label_strategy: 'vp_value', strategy: 'other' }), 'vp_value')
  // genuinely unattributed stays unattributed — the fix must not invent one
  assert.equal(strategyOf({ label_strategy: 'other', strategy: 'other' }), null)
  assert.equal(strategyOf({ label_strategy: 'OTHER', strategy: '  ' }), null)
  assert.equal(strategyOf({}), null)
  assert.equal(strategyOf(null), null)
})

test('rows recoverable from trades.strategy no longer block the verdict', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    label_strategy: 'other',          // the label vocabulary lost it…
    strategy: 'va_breakout',          // …the ledger did not
    symbol: 'US30', label_timeframe: '15m',
    net_pnl: i % 2 ? 12 : -5, entry_price: 100, exit_price: 101,
  }))
  const i = integrityOf(rows)
  assert.equal(i.unattributed, 0, 'these were never unattributed — they were misread')
  assert.deepEqual(i.blockers, [])
  // and they now form a bucket instead of being dropped on the floor
  assert.equal(bucketsOf(rows).length, 1)
  assert.equal(bucketsOf(rows)[0].strategy, 'va_breakout')
})
