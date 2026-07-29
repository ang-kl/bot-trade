import { describe, it, expect } from 'vitest'
import { ratchetExample, keeperExample, guardianExample, closedMarketExample } from './worked-examples.js'
import { DEFAULT_PROFIT_KEEPER } from '../../agent/services/profit-keeper.js'
import { DEFAULT_LOSS_GUARDIAN } from '../../agent/services/loss-guardian.js'

// The whole point of this module is that the numbers come from the engine's
// config rather than from prose someone typed once. So the tests import the
// engine defaults directly: if a default moves and the example stops matching
// it, that is a FAILURE, not a cosmetic drift.

const joined = (lines) => lines.join(' ')

describe('ratchetExample', () => {
  it('derives the auto step as 1% of balance and states where the first floor lands', () => {
    const lines = ratchetExample({ balance: 49_847 })
    expect(joined(lines)).toContain('$498.47')          // 1% of balance
    expect(joined(lines)).toContain('$50,345.47')       // balance + one step = first bank
    expect(joined(lines)).toContain('auto')
  })

  it('clamps the auto step to $25–$500 the same way autoStepUsd does', () => {
    expect(joined(ratchetExample({ balance: 1_000 }))).toContain('$25.00')      // 1% = $10 → floor
    expect(joined(ratchetExample({ balance: 500_000 }))).toContain('$500.00')   // 1% = $5k → cap
  })

  it('uses the fixed step when one is set, and labels it fixed', () => {
    const lines = ratchetExample({ balance: 49_847, stepUsd: 1_000 })
    expect(joined(lines)).toContain('$1,000.00 (fixed)')
    expect(joined(lines)).not.toContain('auto')
  })

  it('returns null rather than inventing a balance', () => {
    expect(ratchetExample({})).toBeNull()
    expect(ratchetExample({ balance: 0 })).toBeNull()
    expect(ratchetExample({ balance: null })).toBeNull()
    expect(ratchetExample()).toBeNull()
  })
})

describe('keeperExample', () => {
  it('describes ADAPTIVE mode by default — the mode the engine actually ships in', () => {
    expect(DEFAULT_PROFIT_KEEPER.mode).toBe('adaptive')
    const lines = keeperExample(DEFAULT_PROFIT_KEEPER, { balance: 50_000 })
    const text = joined(lines)
    expect(text).toContain('ATR')
    // 1×ATR on 1.0 lot EURUSD at ATR 0.0042 = $420; 0.1% of $50k = $50 → arms at $420.
    expect(text).toContain('$420')
    expect(text).toContain('$50')
    expect(text).not.toContain('40%')          // that is the fixed-mode giveback
  })

  it('says the balance side is unknown rather than assuming one', () => {
    const text = joined(keeperExample(DEFAULT_PROFIT_KEEPER))
    expect(text).toContain('Balance unknown')
  })

  it('quotes the real trail distance and the spike tightening', () => {
    const text = joined(keeperExample(DEFAULT_PROFIT_KEEPER, { balance: 50_000 }))
    expect(text).toContain(`${DEFAULT_PROFIT_KEEPER.trailAtrMult}×ATR`)
    expect(text).toContain(`${DEFAULT_PROFIT_KEEPER.spikeTrailAtrMult}×ATR`)
    expect(text).toContain('$1,050')           // 2.5 × 0.0042 × 100,000
  })

  it('omits the spike clause when spike tightening is off', () => {
    const text = joined(keeperExample({ ...DEFAULT_PROFIT_KEEPER, spikeTightenEnabled: false }, { balance: 50_000 }))
    expect(text).not.toContain('spike')
  })

  it('mentions scale-out and the hard take-profit only when they are configured', () => {
    const off = joined(keeperExample(DEFAULT_PROFIT_KEEPER, { balance: 50_000 }))
    expect(off).not.toContain('banked the moment')
    expect(off).not.toContain('Hard exit')
    const on = joined(keeperExample({ ...DEFAULT_PROFIT_KEEPER, scaleOutFrac: 0.5, takeProfitUsd: 900 }, { balance: 50_000 }))
    expect(on).toContain('50% is banked')
    expect(on).toContain('$900.00')
  })

  it('switches arithmetic entirely in FIXED mode', () => {
    const lines = keeperExample({ ...DEFAULT_PROFIT_KEEPER, mode: 'fixed' })
    const text = joined(lines)
    expect(text).toContain('$50.00')           // armProfitUsd
    expect(text).toContain('60%')              // 100 − givebackPct 40
    expect(text).toContain('$120.00')          // illustrative peak 2.4 × arm
    expect(text).toContain('$72.00')           // 60% of that peak
    expect(text).not.toContain('ATR')
  })

  it('clamps givebackPct to 0..95 exactly as the engine does', () => {
    const text = joined(keeperExample({ mode: 'fixed', armProfitUsd: 100, givebackPct: 200 }))
    expect(text).toContain('5%')               // 100 − clamp(200) = 5
    expect(text).not.toContain('-100%')
  })

  it('returns null when the mode it is asked for has no usable config', () => {
    expect(keeperExample({ mode: 'fixed', armProfitUsd: null, givebackPct: 40 })).toBeNull()
    expect(keeperExample({ mode: 'adaptive' })).toBeNull()
    expect(keeperExample(null)).toBeNull()
  })
})

describe('guardianExample', () => {
  it('places the protective stop at maxAtrMult × ATR below the stated entry', () => {
    const lines = guardianExample(DEFAULT_LOSS_GUARDIAN)
    const text = joined(lines)
    // 1.0850 − 3 × 0.0042 = 1.0724
    expect(text).toContain('1.07240')
    expect(text).toContain(`${DEFAULT_LOSS_GUARDIAN.maxAtrMult}×ATR`)
  })

  it('states the no-ATR fallback as a percentage of ENTRY, matching the engine', () => {
    const text = joined(guardianExample(DEFAULT_LOSS_GUARDIAN))
    expect(text).toContain('2.00%')
    expect(text).toContain('1.06330')          // 1.0850 × 0.98
  })

  it('reports the time cap as off when it is null, and quotes it when set', () => {
    expect(joined(guardianExample(DEFAULT_LOSS_GUARDIAN))).toContain('Time cap off')
    expect(joined(guardianExample({ ...DEFAULT_LOSS_GUARDIAN, maxHoldHours: 48 }))).toContain('after 48h')
  })

  it('returns null without the two numbers the example is built from', () => {
    expect(guardianExample({ maxAtrMult: 3 })).toBeNull()
    expect(guardianExample({})).toBeNull()
    expect(guardianExample()).toBeNull()
  })
})

describe('closedMarketExample', () => {
  it('describes the resting broker limit when on', () => {
    const text = joined(closedMarketExample({ on: true }))
    expect(text).toContain('LIMIT')
    expect(text).toContain('SAME risk gate')
  })

  it('describes the internal queue and the gap risk when off — off is not "nothing happens"', () => {
    const text = joined(closedMarketExample({ on: false }))
    expect(text).toContain('MARKET order')
    expect(text).toContain('gap')
  })

  it('returns null when the toggle state has not loaded yet', () => {
    expect(closedMarketExample({})).toBeNull()
    expect(closedMarketExample({ on: null })).toBeNull()
    expect(closedMarketExample()).toBeNull()
  })
})
