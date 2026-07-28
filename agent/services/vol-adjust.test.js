// vol-gate Layers 2-3. Log-only, so no test here touches an order — what
// these pin is the ARITHMETIC and the two rules that arithmetic exists to
// obey: min() not multiply across tools, and ONE lever not two across layers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  adjustCupAndHandle, adjustVWAP, adjustFibonacci, adjustVolumeProfile, adjustFVG,
  reconcileConfluence, evaluateVolGate, HIGH_VOL_STOP_ATR, THIN_VOLUME_RATIO,
} from './vol-adjust.js'

const HIGH = { regime: 'HIGH', percentile: 93 }
const NORMAL = { regime: 'NORMAL', percentile: 50 }
const LOW = { regime: 'LOW', percentile: 4 }

// ------------------------------------------------------- THE ONE-LEVER RULE

test('ONE LEVER: no adjuster ever returns a size ratio below 1', () => {
  const cases = [
    adjustCupAndHandle(HIGH, { atr: 0.01 }),
    adjustVWAP(HIGH, { bandUpper: 1.2, bandLower: 1.0 }),
    adjustFibonacci(HIGH, { atr: 0.01 }),
    adjustVolumeProfile(HIGH, { relativeVolume: 0.4 }),
    adjustFVG(HIGH, { originVolRegime: 'LOW', atr: 0.01 }),
  ]
  for (const c of cases) {
    // Sizing is risk-based: widening the stop ALREADY shrinks the position.
    // A ratio here as well would compound to ~0.375x instead of the spec's
    // 0.5-0.7x — the same mistake §4 forbids across tools, made across layers.
    assert.equal(c.sizeRatio, 1, `an adjuster moved the size lever: ${c.notes}`)
  }
})

test('ONE LEVER: HIGH vol widens the Cup & Handle stop by exactly 0.5xATR', () => {
  const a = adjustCupAndHandle(HIGH, { atr: 0.004 })
  assert.equal(a.stopWidenPrice, HIGH_VOL_STOP_ATR * 0.004)
  assert.match(a.notes, /stop widened/)
})

test('NORMAL and LOW vol change nothing at all', () => {
  for (const vol of [NORMAL, LOW]) {
    const a = adjustCupAndHandle(vol, { atr: 0.004 })
    assert.equal(a.stopWidenPrice, 0)
    assert.equal(a.sizeRatio, 1)
    assert.equal(a.confirmationCandles, 0)
    assert.equal(a.deferEntry, false)
  }
})

test('HIGH vol with no ATR does nothing and says so, rather than guessing', () => {
  const a = adjustCupAndHandle(HIGH, {})
  assert.equal(a.stopWidenPrice, 0)
  assert.match(a.notes, /no ATR/)
  // A widening invented without an ATR would be a wrong stop on a live
  // position — strictly worse than leaving it alone.
})

// ------------------------------------------------------------- per-tool rules

test('VWAP: HIGH vol demands two closes beyond the band, not one', () => {
  assert.equal(adjustVWAP(HIGH, { bandUpper: 1.2, bandLower: 1.0 }).confirmationCandles, 2)
  assert.equal(adjustVWAP(NORMAL, { bandUpper: 1.2, bandLower: 1.0 }).confirmationCandles, 0)
})

test('Fibonacci: the tolerance zone scales with ATR', () => {
  const a = adjustFibonacci(NORMAL, { atr: 0.01 })
  assert.equal(a.flags.fibTolerancePrice, 0.003)
  const h = adjustFibonacci(HIGH, { atr: 0.01 })
  assert.equal(h.flags.needsVolumeConfirmation, true)
})

test('THE DIVERGENCE CASE: HIGH vol on thin participation is the one to flinch at', () => {
  const thin = adjustVolumeProfile(HIGH, { relativeVolume: THIN_VOLUME_RATIO - 0.1 })
  assert.equal(thin.deferEntry, true)
  assert.equal(thin.flags.volVolumeDivergence, true)

  // HIGH vol WITH participation is not the same thing — that is real
  // repositioning, and treating it as danger would veto good trades.
  const thick = adjustVolumeProfile(HIGH, { relativeVolume: 1.4 })
  assert.equal(thick.deferEntry, false)
  assert.equal(thick.flags.volVolumeDivergence, undefined)
})

test('unknown relative volume cannot qualify participation, and does not pretend to', () => {
  const a = adjustVolumeProfile(HIGH, {})
  assert.equal(a.deferEntry, false, 'absence of data is not evidence of thin participation')
  assert.match(a.notes, /unknown/)
})

test('FVG with no origin regime takes the spec\'s unknown-origin path', () => {
  const a = adjustFVG(HIGH, {})
  assert.equal(a.flags.originRegimeUnknown, true)
  assert.equal(a.flags.fillTargetPct, 100)
})

test('FVG formed in calm and filling in HIGH vol flags overshoot risk', () => {
  const a = adjustFVG(HIGH, { originVolRegime: 'LOW', atr: 0.01 })
  assert.equal(a.flags.originCurrentDivergence, true)
  assert.equal(a.stopWidenPrice, HIGH_VOL_STOP_ATR * 0.01)
  assert.equal(adjustFVG(NORMAL, { originVolRegime: 'HIGH' }).flags.fillTargetPct, 50)
})

// ------------------------------------------------------------- §4 confluence

test('THE §4 RULE: sizes are min()-ed, never multiplied', () => {
  const merged = reconcileConfluence([
    { sizeRatio: 0.7, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: false, flags: {}, notes: 'a' },
    { sizeRatio: 0.6, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: false, flags: {}, notes: 'b' },
    { sizeRatio: 0.8, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: false, flags: {}, notes: 'c' },
  ])
  // 0.7 x 0.6 x 0.8 = 0.336 — compounding three tools into near-nothing is
  // exactly what the spec forbids.
  assert.equal(merged.sizeRatio, 0.6)
  assert.equal(merged.toolCount, 3)
})

test('confluence takes the WIDEST protective stop and any confirmation demand', () => {
  const merged = reconcileConfluence([
    { sizeRatio: 1, stopWidenPrice: 0.002, confirmationCandles: 0, deferEntry: false, flags: {}, notes: '' },
    { sizeRatio: 1, stopWidenPrice: 0.005, confirmationCandles: 2, deferEntry: false, flags: {}, notes: '' },
  ])
  assert.equal(merged.stopWidenPrice, 0.005)
  assert.equal(merged.confirmationCandles, 2)
})

test('one tool asking to stand down carries the whole confluence', () => {
  const merged = reconcileConfluence([
    { sizeRatio: 1, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: true, flags: { volVolumeDivergence: true }, notes: 'thin' },
    { sizeRatio: 1, stopWidenPrice: 0.001, confirmationCandles: 1, deferEntry: false, flags: {}, notes: 'ok' },
  ])
  assert.equal(merged.deferEntry, true)
})

test('material disagreement is FLAGGED, not averaged away', () => {
  const merged = reconcileConfluence([
    { sizeRatio: 1, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: true, flags: {}, notes: 'stand down' },
    { sizeRatio: 1, stopWidenPrice: 0, confirmationCandles: 0, deferEntry: false, flags: {}, notes: 'nothing to adjust' },
  ])
  assert.equal(merged.conflict, true)
  assert.match(merged.notes, /^CONFLICT:/)
  // Averaging two opposite readings produces a number neither tool would
  // endorse, and hides that they disagreed at all.
})

test('agreement is not a conflict', () => {
  const merged = reconcileConfluence([
    { sizeRatio: 1, stopWidenPrice: 0.002, confirmationCandles: 0, deferEntry: false, flags: {}, notes: '' },
    { sizeRatio: 1, stopWidenPrice: 0.003, confirmationCandles: 0, deferEntry: false, flags: {}, notes: '' },
  ])
  assert.equal(merged.conflict, false)
})

test('no adjusters at all is a clean no-op, not a crash', () => {
  const m = reconcileConfluence([])
  assert.equal(m.toolCount, 0)
  assert.equal(m.sizeRatio, 1)
  assert.equal(m.stopWidenPrice, 0)
})

// ------------------------------------------------------------------ the pass

test('evaluateVolGate routes each signal to its own adjuster and merges', () => {
  const out = evaluateVolGate(HIGH, [
    { strategy: 'cup_handle', atr: 0.01 },
    { strategy: 'vp_value', relativeVolume: 0.3 },
  ])
  assert.equal(out.confluenceToolCount, 2)
  assert.equal(out.stopWidenPrice, HIGH_VOL_STOP_ATR * 0.01)
  assert.equal(out.volVolumeDivergence, true)
  assert.equal(out.deferEntry, true)
  assert.equal(out.entryVolRegime, 'HIGH')
  assert.equal(out.sizeRatio, 1)
})

test('an unknown strategy is skipped, not guessed at', () => {
  const out = evaluateVolGate(HIGH, [{ strategy: 'something_new', atr: 0.01 }])
  assert.equal(out.confluenceToolCount, 0)
  assert.equal(out.stopWidenPrice, 0)
})

test('the mode is log_only and defer is recorded rather than acted on', () => {
  const out = evaluateVolGate(HIGH, [{ strategy: 'vp_value', relativeVolume: 0.2 }])
  assert.equal(out.mode, 'log_only')
  assert.equal(out.deferEntry, true, 'recorded — so we learn how often it would fire')
  // Acting on a defer needs a deferred-entry queue this system does not have.
  // Building one next to the order path is how the 4x duplicate USDIDR
  // incident happened in a neighbouring path.
})

test('an insufficient-history reading carries its flag through the pass', () => {
  const out = evaluateVolGate(
    { regime: 'NORMAL', percentile: null, insufficientHistory: true, characterRegime: 'quiet' },
    [{ strategy: 'cup_handle', atr: 0.01 }],
  )
  assert.equal(out.insufficientHistory, true)
  assert.equal(out.entryVolPercentile, null)
  assert.equal(out.characterRegime, 'quiet', 'the character axis rides along, unmodified')
})

test('the module does not import risk or execution — it can only advise', () => {
  const src = fs.readFileSync(new URL('./vol-adjust.js', import.meta.url), 'utf8')
  // Import statements only. Scanning the whole file would also match the
  // header comment, which cites risk.js and cup-handle.js by name to explain
  // WHY the size lever is left alone — prose about a module is not a
  // dependency on it.
  const imports = src.split('\n').filter(l => /^\s*import\b/.test(l))
  assert.equal(imports.length, 0,
    `a log-only advisor should import nothing at all; found: ${imports.join(' ')}`)
  for (const forbidden of ['risk.js', 'exec-engine', 'ctrader-ws', './loop.js']) {
    assert.ok(!imports.some(l => l.includes(forbidden)),
      `vol-adjust imports ${forbidden} — a log-only advisor must have no path to an order`)
  }
})
