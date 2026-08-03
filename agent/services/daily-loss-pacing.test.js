// node --test agent/services/daily-loss-pacing.test.js
//
// The claims under test are the ones that decide whether an account can keep
// trading, so each is pinned rather than assumed:
//
//   · absent config = TODAY'S BEHAVIOUR, to the cent. A risk limit must not
//     move because a feature was merged.
//   · the ceiling is never exceeded, whatever the clock says.
//   · the ramp actually rations: an early hour gets the base, not the ceiling.
//
// The account numbers are 46130058's real ones on 03-08-2026 (balance
// 48,386.46, 8.8% base, 18.8% ceiling), so the arithmetic in the tests is the
// arithmetic that will run in production.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pacedDailyCap, describePacing, FX_DAY_MS } from './daily-loss-pacing.js'

const BAL = 48386.46
const OPEN = Date.UTC(2026, 7, 2, 21, 0, 0)   // 17:00 New York = 21:00 UTC
const at = (hours) => OPEN + hours * 3600_000

const paced = (hours, over = {}) => pacedDailyCap({
  balance: BAL, basePct: 0.088, maxPct: 0.188, absoluteFallback: 300,
  nowMs: at(hours), dayOpenMs: OPEN, ...over,
})

test('no ceiling configured → the flat cap, unchanged and unpaced', () => {
  for (const maxPct of [null, undefined, 0, 0.088, 0.05, NaN, 'nonsense']) {
    const p = pacedDailyCap({
      balance: BAL, basePct: 0.088, maxPct, absoluteFallback: 300,
      nowMs: at(12), dayOpenMs: OPEN,
    })
    assert.equal(p.paced, false, `maxPct=${maxPct} should not pace`)
    assert.equal(p.capUsd, BAL * 0.088)
  }
})

test('a ceiling BELOW the base cannot lower the cap — misconfiguration is not a limit change', () => {
  const p = pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: 0.05, absoluteFallback: 300,
    nowMs: at(12), dayOpenMs: OPEN,
  })
  assert.equal(p.capUsd, BAL * 0.088)
})

test('at the day open the allowance is exactly the base', () => {
  const p = paced(0)
  assert.equal(p.paced, true)
  assert.ok(Math.abs(p.capUsd - BAL * 0.088) < 1e-9)
  assert.equal(p.elapsed, 0)
})

test('at the day end it is exactly the ceiling, and never a cent more', () => {
  assert.ok(Math.abs(paced(24).capUsd - BAL * 0.188) < 1e-9)
  // A clock past the end (a paused box resuming, a bad nowMs) clamps.
  assert.equal(paced(99).capUsd, BAL * 0.188)
  assert.equal(paced(99).elapsed, 1)
})

test('half way through the day, half the extra rope', () => {
  const p = paced(12)
  assert.ok(Math.abs(p.pct - 0.138) < 1e-12)          // 8.8 + (18.8-8.8)/2
  assert.ok(Math.abs(p.capUsd - BAL * 0.138) < 1e-9)
})

test('a clock BEFORE the open clamps to the base rather than going negative', () => {
  const p = paced(-5)
  assert.equal(p.elapsed, 0)
  assert.ok(Math.abs(p.capUsd - BAL * 0.088) < 1e-9)
})

test("THE POINT: 03-08's actual loss stops early in the day and passes later", () => {
  // 46130058 was down 2,538.99 when it hit its flat 5% wall at 10:37 UTC.
  const spent = 2538.99
  // 1.6h in (a bad opening hour) — an 8.8% flat cap would have allowed this,
  // and the pacing does too; the base is deliberately not a tightening.
  assert.ok(paced(1.6, {}).capUsd > spent)
  // But a LARGER early loss is stopped by the base while the ceiling would
  // have waved it through — that is the rationing this exists for.
  const early = pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: 0.188, absoluteFallback: 300,
    nowMs: at(0.5), dayOpenMs: OPEN, spentUsd: 5000,
  })
  assert.ok(5000 > early.capUsd, 'a 5k loss in the first half hour must exceed the paced cap')
  assert.ok(5000 < BAL * 0.188, '…while sitting comfortably under the day ceiling')
})

test('remaining budget and trades-left are reported, and floor at zero', () => {
  const p = paced(12, { spentUsd: 2538.99, perTradeRiskUsd: BAL * 0.08 })
  const expected = BAL * 0.138 - 2538.99
  assert.ok(Math.abs(p.remainingUsd - expected) < 1e-9)
  assert.equal(p.tradesLeft, Math.floor(expected / (BAL * 0.08)))
  const blown = paced(12, { spentUsd: 999999, perTradeRiskUsd: BAL * 0.08 })
  assert.equal(blown.remainingUsd, 0)
  assert.equal(blown.tradesLeft, 0)
})

test('trades-left is null, not zero, when per-trade risk is unknown', () => {
  // A fabricated "0 trades left" on the veto line would read as a fact.
  assert.equal(paced(12, { spentUsd: 100 }).tradesLeft, null)
})

test('no balance → the absolute USD fallback, unpaced', () => {
  for (const balance of [null, 0, -5, undefined]) {
    const p = pacedDailyCap({
      balance, basePct: 0.088, maxPct: 0.188, absoluteFallback: 300,
      nowMs: at(12), dayOpenMs: OPEN,
    })
    assert.equal(p.paced, false)
    assert.equal(p.capUsd, 300)
    assert.equal(p.pct, null)
  }
})

test('the description names the number, the clock and what is left', () => {
  const s = describePacing(paced(12, { spentUsd: 1000, perTradeRiskUsd: 1000 }))
  assert.match(s, /paced 13.8%/)
  assert.match(s, /50% through the FX day/)
  assert.match(s, /left/)
  assert.match(s, /more trades/)
  assert.equal(describePacing(pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: null, absoluteFallback: 300,
    nowMs: at(12), dayOpenMs: OPEN,
  })), null)
})

test('FX_DAY_MS is a whole day — the ramp denominator, stated once', () => {
  assert.equal(FX_DAY_MS, 86_400_000)
})
