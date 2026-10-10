// node --test agent/services/performance-targets-measured.test.js
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
// The latest-20 block's DISPLAY-ONLY measured figures: what the rows that do
// carry a finite net show, beside a verdict that still withholds every figure
// until all 20 are broker-proven.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessPerformanceTargets } from './performance-targets.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-13T01:00:00Z')
const row = (id, pnl, complete = true) => ({ accountId: '11', positionId: String(id), netPnl: pnl, closedAtMs: NOW - DAY - id, complete })

test('incomplete sample: measured figures over the priced rows; the verdict stays unmeasurable and every existing figure null', () => {
  // 20 closes: 12 proven (9 wins of +2, 3 losses of -3), 8 without proof (no net).
  const records = Array.from({ length: 20 }, (_, i) => i < 9 ? row(i, 2) : i < 12 ? row(i, -3) : row(i, null, false))
  const out = assessPerformanceTargets(records, { now: NOW })
  const m = out.latest20
  // Unchanged contract: nothing is assessed while any row lacks proof.
  assert.equal(m.n, 20); assert.equal(m.eligible, 12); assert.equal(m.pending, 8)
  assert.equal(m.winRatePct, null); assert.equal(m.profitFactor, null); assert.equal(m.wins, null)
  assert.equal(out.winRate.latest20Status, 'unmeasurable')
  assert.equal(out.profitFactor.latest20Status, 'unmeasurable')
  assert.equal(out.winRate.qualified, false)
  assert.equal(out.profitFactor.qualified, false)
  assert.notEqual(out.winRate.status, 'met')
  // The display-only block.
  assert.deepEqual(m.measured, { n: 12, wins: 9, losses: 3, winRatePct: 75, profitFactor: 2, grossWin: 18, grossLoss: 9 })
})

test('measured never changes a verdict: the same records with and without it assess identically', () => {
  const records = Array.from({ length: 20 }, (_, i) => row(i, i < 16 ? 1 : -1))
  const out = assessPerformanceTargets(records, { now: NOW })
  assert.equal(out.winRate.qualified, true)
  assert.equal(out.latest20.measured.n, 20)
  assert.equal(out.latest20.measured.winRatePct, out.latest20.winRatePct)
  assert.equal(out.latest20.measured.profitFactor, out.latest20.profitFactor)
  const { measured, ...rest } = out.latest20
  assert.ok(measured)
  assert.deepEqual(Object.keys(rest).sort(), ['eligible', 'grossLoss', 'grossWin', 'losses', 'n', 'oldestAt', 'pending', 'positionIds', 'profitFactor', 'winRatePct', 'wins'])
})

test('no losses and no priced rows: profit factor null, win rate null on an empty sample', () => {
  const allWins = assessPerformanceTargets([row(1, 3), row(2, null, false)], { now: NOW })
  assert.equal(allWins.latest20.measured.profitFactor, null)
  assert.equal(allWins.latest20.measured.winRatePct, 100)
  const none = assessPerformanceTargets([row(1, null, false)], { now: NOW })
  assert.deepEqual(none.latest20.measured, { n: 0, wins: 0, losses: 0, winRatePct: null, profitFactor: null, grossWin: 0, grossLoss: 0 })
})
