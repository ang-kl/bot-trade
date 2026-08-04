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
import { pacedDailyCap, describePacing, describeBinding, FX_DAY_MS } from './daily-loss-pacing.js'

const BAL = 48386.46
const OPEN = Date.UTC(2026, 7, 2, 21, 0, 0)   // 17:00 New York = 21:00 UTC
const at = (hours) => OPEN + hours * 3600_000

const paced = (hours, over = {}) => pacedDailyCap({
  balance: BAL, basePct: 0.088, maxPct: 0.188, absoluteFallback: null,
  nowMs: at(hours), dayOpenMs: OPEN, ...over,
})

test('no ceiling configured → the flat cap, unchanged and unpaced', () => {
  for (const maxPct of [null, undefined, 0, 0.088, 0.05, NaN, 'nonsense']) {
    const p = pacedDailyCap({
      balance: BAL, basePct: 0.088, maxPct, absoluteFallback: null,
      nowMs: at(12), dayOpenMs: OPEN,
    })
    assert.equal(p.paced, false, `maxPct=${maxPct} should not pace`)
    assert.equal(p.capUsd, BAL * 0.088)
  }
})

test('a ceiling BELOW the base cannot lower the cap — misconfiguration is not a limit change', () => {
  const p = pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: 0.05, absoluteFallback: null,
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
    balance: BAL, basePct: 0.088, maxPct: 0.188, absoluteFallback: null,
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

test('no balance → the flat USD cap, unpaced', () => {
  for (const balance of [null, 0, -5, undefined]) {
    const p = pacedDailyCap({
      balance, basePct: 0.088, maxPct: 0.188, absoluteFallback: 300,
      nowMs: at(12), dayOpenMs: OPEN,
    })
    assert.equal(p.paced, false)
    assert.equal(p.capUsd, 300)
    assert.equal(p.binding, 'usd')
    assert.equal(p.pct, null, 'a percentage of an unknown balance is not a number')
  }
})

// ---------------------------------------------------------------------------
// TWO INDEPENDENT CHECKS, EITHER DISABLE-ABLE (owner 04-08-2026)
//
// The flat $ cap used to apply ONLY when the balance was unknown, which meant
// it was dead on every account that had one. Both are live now, null on either
// turns that one off, and null on both leaves the day genuinely uncapped —
// which must be reported as null, never as a number a caller could enforce.
// ---------------------------------------------------------------------------

const both = (over = {}) => pacedDailyCap({
  balance: BAL, basePct: 0.03, maxPct: null, absoluteFallback: 300,
  nowMs: at(12), dayOpenMs: OPEN, ...over,
})

test('with both set, the TIGHTER one binds', () => {
  // 3% of 48,386.46 = 1,451.59, so the flat $300 is the real limit here.
  const p = both()
  assert.equal(p.capUsd, 300)
  assert.equal(p.binding, 'usd')
  assert.ok(Math.abs(p.pctCapUsd - BAL * 0.03) < 1e-9, 'the % cap is still reported, just not binding')
  assert.equal(p.usdCapUsd, 300)
})

test('…and on a SMALL account the percentage is the tighter one', () => {
  // The 04-08 production case: 3% of 538.67 is 16.16, which is what actually
  // blocked the account — the $300 never applied because it was a fallback.
  const p = both({ balance: 538.67 })
  assert.ok(Math.abs(p.capUsd - 16.1601) < 1e-4)
  assert.equal(p.binding, 'pct')
})

test('a null % turns THAT check off, leaving the flat cap alone', () => {
  for (const basePct of [null, undefined, 0, NaN, 'nonsense']) {
    const p = both({ basePct })
    assert.equal(p.capUsd, 300, `basePct=${basePct}`)
    assert.equal(p.pctCapUsd, null)
    assert.equal(p.binding, 'usd')
    assert.equal(p.uncapped, false)
  }
})

test('a null flat cap turns THAT check off, leaving the percentage alone', () => {
  for (const absoluteFallback of [null, undefined, 0, NaN, '']) {
    const p = both({ absoluteFallback })
    assert.ok(Math.abs(p.capUsd - BAL * 0.03) < 1e-9, `fallback=${absoluteFallback}`)
    assert.equal(p.usdCapUsd, null)
    assert.equal(p.binding, 'pct')
    assert.equal(p.uncapped, false)
  }
})

test('BOTH null = UNCAPPED, reported as null and never as a number', () => {
  // Zero would read as "cap of zero dollars" and veto every entry forever; a
  // large number would read as "plenty of room". Only null forces the caller
  // to decide what an absent limit means.
  const p = both({ basePct: null, absoluteFallback: null })
  assert.equal(p.capUsd, null)
  assert.equal(p.uncapped, true)
  assert.equal(p.binding, null)
  assert.equal(p.remainingUsd, null)
  assert.equal(p.tradesLeft, null)
})

test('no balance AND no flat cap is uncapped, however the % is set', () => {
  // The most misleading state: the config looks protected — a percentage IS
  // configured — and enforces nothing, because there is no balance to take a
  // percentage of.
  const p = pacedDailyCap({
    balance: null, basePct: 0.03, maxPct: null, absoluteFallback: null,
    nowMs: at(12), dayOpenMs: OPEN,
  })
  assert.equal(p.capUsd, null)
  assert.equal(p.uncapped, true)
})

test('pacing is not claimed when the flat cap is what holds the line', () => {
  // A ramp the flat cap sits below is not rationing anything, and saying
  // "paced 13.8%" would explain the day's allowance with the wrong mechanism.
  const p = pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: 0.188, absoluteFallback: 300,
    nowMs: at(12), dayOpenMs: OPEN,
  })
  assert.equal(p.capUsd, 300)
  assert.equal(p.paced, false)
  assert.equal(describePacing(p), null)
})

test('the binding line names WHICH field to go and change', () => {
  assert.match(describeBinding(both()), /flat \$ cap binds/)
  assert.match(describeBinding(both({ absoluteFallback: null })), /% cap .*flat \$ check off/)
  assert.match(describeBinding(both({ basePct: null })), /flat \$ cap .*% check off/)
  assert.match(describeBinding(both({ basePct: 300 / BAL })), /both caps agree/)
  assert.equal(describeBinding(both({ basePct: null, absoluteFallback: null })), null)
})

test('the description names the number, the clock and what is left', () => {
  const s = describePacing(paced(12, { spentUsd: 1000, perTradeRiskUsd: 1000 }))
  assert.match(s, /paced 13.8%/)
  assert.match(s, /50% through the FX day/)
  assert.match(s, /left/)
  assert.match(s, /more trades/)
  assert.equal(describePacing(pacedDailyCap({
    balance: BAL, basePct: 0.088, maxPct: null, absoluteFallback: null,
    nowMs: at(12), dayOpenMs: OPEN,
  })), null)
})

test('FX_DAY_MS is a whole day — the ramp denominator, stated once', () => {
  assert.equal(FX_DAY_MS, 86_400_000)
})
