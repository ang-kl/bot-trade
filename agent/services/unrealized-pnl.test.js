// Floating P&L derived from position + live spot, because the broker's own
// figure (GET_POSITION_UNREALIZED_PNL_REQ) is refused in production with
// CANT_ROUTE_REQUEST on every pass — leaving the per-position loss cap with
// no numbers at all while a USDZAR position ran to −$2,186 against an $800 cap.
import test from 'node:test'
import assert from 'node:assert/strict'
import { unrealizedUsd, deriveUnrealizedMap } from './unrealized-pnl.js'

test('a USD-quoted long: profit and loss are signed correctly', () => {
  // EURUSD, 1 lot (100,000), 100 pips in favour = $1,000.
  const p = { symbol: 'EURUSD', side: 'BUY', entryPrice: 1.0800, lots: 1 }
  assert.ok(Math.abs(unrealizedUsd(p, 1.0900) - 1000) < 1)
  assert.ok(Math.abs(unrealizedUsd(p, 1.0700) + 1000) < 1)
})

test('a short is the mirror of a long — the sign is not a coin flip', () => {
  const short = { symbol: 'EURUSD', side: 'SELL', entryPrice: 1.0800, lots: 1 }
  assert.ok(unrealizedUsd(short, 1.0700) > 0, 'price down on a short is a PROFIT')
  assert.ok(unrealizedUsd(short, 1.0900) < 0, 'price up on a short is a LOSS')
})

test('an unrecognised side returns null rather than guessing', () => {
  // Guessing wrong inverts the sign and could close a WINNER for breaching a
  // loss cap. One uncovered position is the cheaper error.
  assert.equal(unrealizedUsd({ symbol: 'EURUSD', side: 'sideways', entryPrice: 1.08, lots: 1 }, 1.09), null)
  assert.equal(unrealizedUsd({ symbol: 'EURUSD', side: null, entryPrice: 1.08, lots: 1 }, 1.09), null)
})

test('a USD-BASE pair converts through the price — the ~150x JPY trap', () => {
  // USDJPY 1 lot, 100 pips (1.00) in favour. The move lands in JPY, so USD =
  // 100,000 × 1.00 / 150 ≈ $667. Without the division it would read $100,000.
  const p = { symbol: 'USDJPY', side: 'BUY', entryPrice: 149.00, lots: 1 }
  const usd = unrealizedUsd(p, 150.00)
  assert.ok(usd > 600 && usd < 700, `expected ~$667, got ${usd}`)
})

test('a metal uses its contract size, not the FX default', () => {
  // XAUUSD contract is 100 oz. $10 move × 100 oz × 1 lot = $1,000.
  const p = { symbol: 'XAUUSD', side: 'BUY', entryPrice: 3300, lots: 1 }
  assert.ok(Math.abs(unrealizedUsd(p, 3310) - 1000) < 1)
})

test('missing or nonsensical inputs return null, never 0', () => {
  // Zero would read downstream as "flat, nothing to see" — the exact failure
  // this module exists to end.
  assert.equal(unrealizedUsd({ symbol: 'EURUSD', side: 'BUY', entryPrice: 0, lots: 1 }, 1.09), null)
  assert.equal(unrealizedUsd({ symbol: 'EURUSD', side: 'BUY', entryPrice: 1.08, lots: 0 }, 1.09), null)
  assert.equal(unrealizedUsd({ symbol: 'EURUSD', side: 'BUY', entryPrice: 1.08, lots: 1 }, null), null)
  assert.equal(unrealizedUsd(null, 1.09), null)
})

// ---------------------------------------------------------------------------
// The map builder, in the shape wsGetUnrealizedPnl returns.
// ---------------------------------------------------------------------------

const POS = (id, symbolId, volumeUnits, side, price) => ({
  positionId: id, price,
  tradeData: { symbolId, volume: volumeUnits, tradeSide: side },
})

test('a position with no fresh price is OMITTED, not reported as flat', () => {
  const positions = [POS(1, 10, 10_000_000, 'BUY', 1.08), POS(2, 20, 10_000_000, 'BUY', 1.08)]
  const r = deriveUnrealizedMap(positions, (id) => (id === 10 ? 1.09 : null), {
    symbolOf: (id) => (id === 10 ? 'EURUSD' : 'GBPUSD'),
  })
  assert.ok(r.map['1'], 'the covered position is present')
  assert.equal(r.map['2'], undefined, 'the stale one must not appear as net 0')
  assert.equal(r.covered, 1)
  assert.equal(r.missingPrice, 1, 'and it is COUNTED, so the caller can say it is unprotected')
})

test('broker units are converted to lots via contract size', () => {
  // 10,000,000 units / 100 = 100,000 = 1 lot of EURUSD (contractSize 100k).
  const r = deriveUnrealizedMap([POS(1, 10, 10_000_000, 'BUY', 1.0800)], () => 1.0900,
    { symbolOf: () => 'EURUSD' })
  assert.ok(Math.abs(r.map['1'].net - 1000) < 1, `expected ~$1000, got ${r.map['1'].net}`)
})

test('the result is flagged approximate — swap and commission are excluded', () => {
  const r = deriveUnrealizedMap([POS(1, 10, 10_000_000, 'BUY', 1.08)], () => 1.09,
    { symbolOf: () => 'EURUSD' })
  assert.equal(r.map['1'].approximate, true,
    'the caller must be able to tell a derived figure from the broker one')
})

test('an unknown symbolId is skipped and counted, never priced as something else', () => {
  const r = deriveUnrealizedMap([POS(1, 999, 10_000_000, 'BUY', 1.08)], () => 1.09,
    { symbolOf: () => null })
  assert.equal(Object.keys(r.map).length, 0)
  assert.equal(r.missingPrice, 1)
})
