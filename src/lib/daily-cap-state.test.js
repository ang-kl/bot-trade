// The warning the owner asked for, held down by tests.
//
// Owner, 04-08-2026: "all Daily cap fallback be (null) mean not used to check.
// if % is (null) means not used to check. then warn that daily cap fallback
// isn't use it will be uncapped."
//
// The one that matters most is the THIRD state — a % cap configured, a flat
// cap empty, and no balance. Nothing looks wrong: a limit is set. Nothing is
// enforced: there is no balance to take a percentage of. A page that only
// warned on "both fields empty" would call that state protected.
import { describe, it, expect } from 'vitest'
import { dailyCapState, describeBinding } from './daily-cap-state.js'

const cfg = (pct, flat) => ({ dailyLossPct: pct, dailyLossLimit: flat })

describe('dailyCapState', () => {
  it('takes the tighter of the two when both are on', () => {
    const s = dailyCapState(cfg(0.03, 300), 48386.46)
    expect(s.capUsd).toBe(300)
    expect(s.binding).toBe('flat')
    expect(s.severity).toBe('none')
    expect(s.message).toBeNull()
  })

  it('lets the percentage bind on a small account', () => {
    // The real production case: 3% of 538.67 = 16.16 blocked the day, while
    // the $300 "fallback" never applied at all.
    const s = dailyCapState(cfg(0.03, 300), 538.67)
    expect(s.binding).toBe('pct')
    expect(s.capUsd).toBeCloseTo(16.16, 2)
  })

  it('treats null, empty and zero alike as OFF', () => {
    for (const off of [null, undefined, 0, '', NaN]) {
      expect(dailyCapState(cfg(off, 300), 1000).pctOn).toBe(false)
      expect(dailyCapState(cfg(0.03, off), 1000).flatOn).toBe(false)
    }
  })

  it('WARNS, not errors, when one check is off and the other still holds', () => {
    const noFlat = dailyCapState(cfg(0.03, null), 1000)
    expect(noFlat.severity).toBe('warn')
    expect(noFlat.capUsd).toBe(30)
    expect(noFlat.message).toMatch(/flat \$ cap is off/)

    const noPct = dailyCapState(cfg(null, 300), 1000)
    expect(noPct.severity).toBe('warn')
    expect(noPct.capUsd).toBe(300)
    expect(noPct.message).toMatch(/% cap is off/)
  })

  it('calls BOTH-empty what it is: uncapped', () => {
    const s = dailyCapState(cfg(null, null), 1000)
    expect(s.uncapped).toBe(true)
    expect(s.capUsd).toBeNull()
    expect(s.severity).toBe('danger')
    expect(s.message).toMatch(/No daily loss cap/)
  })

  it('THE TRAP: a % cap with no balance and no flat cap is uncapped, and says so', () => {
    // Looks configured. Enforces nothing.
    const s = dailyCapState(cfg(0.03, null), null)
    expect(s.pctOn).toBe(true)
    expect(s.capUsd).toBeNull()
    expect(s.severity).toBe('danger')
    expect(s.message).toMatch(/Uncapped right now/)
  })

  it('a % cap with no balance is still protected while a flat cap exists', () => {
    const s = dailyCapState(cfg(0.03, 300), null)
    expect(s.capUsd).toBe(300)
    expect(s.severity).toBe('none')
  })
})

describe('describeBinding', () => {
  it('names which field to go and change', () => {
    expect(describeBinding(dailyCapState(cfg(0.03, 300), 48386.46))).toMatch(/flat \$ cap binds/)
    expect(describeBinding(dailyCapState(cfg(0.03, 300), 538.67))).toMatch(/% cap binds/)
    expect(describeBinding(dailyCapState(cfg(0.3, 300), 1000))).toMatch(/Both caps agree/)
  })

  it('says nothing at all when there is no cap to describe', () => {
    expect(describeBinding(dailyCapState(cfg(null, null), 1000))).toBeNull()
  })
})
