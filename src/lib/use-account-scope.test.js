import { describe, it, expect } from 'vitest'
import { deriveScopeState, MODES, TONE_BY_STATE } from './use-account-scope.js'

// The rules live in a pure function precisely so they can be pinned without
// rendering anything. Every case below is one of the two production failures
// that started this work, or a way the mechanism could quietly fail open.

const scoped = (pct, total = 100, attributable = null) => ({
  scope: {
    account: 'AAA',
    explicit: false,
    scoped: true,
    coverage: { pct, total, attributable: attributable ?? total, complete: pct === 100 },
  },
})

describe('deriveScopeState', () => {
  it('a clean per-account read is blue with no reason', () => {
    const s = deriveScopeState({ id: 'x', mode: MODES.ACCOUNT, payload: scoped(100, 253) })
    expect(s.state).toBe('ok')
    expect(s.tone).toBe('blue')
    expect(s.reason).toBeNull()
  })

  it('THE GO-LIVE CARD: 0% attributable is amber and SAYS the number', () => {
    // Six panels, six per-account headings, 245 pooled rows in every one.
    const s = deriveScopeState({ id: 'goal.card', mode: MODES.ACCOUNT, payload: scoped(0, 245, 0) })
    expect(s.tone).toBe('amber')
    expect(s.state).toBe('partial')
    expect(s.reason).toContain('0%')
    expect(s.reason).toContain('245')
  })

  it('anything below 100% is amber, with the count — 87% is not "close enough"', () => {
    const s = deriveScopeState({ id: 'x', mode: MODES.ACCOUNT, payload: scoped(87, 253) })
    expect(s.tone).toBe('amber')
    expect(s.reason).toBe('87% of 253 rows attributable to this account')
  })

  it('a declared global component is GREY, not amber — declaring is the point', () => {
    const s = deriveScopeState({ id: 'stage.matrix', mode: MODES.GLOBAL, payload: null })
    expect(s.tone).toBe('grey')
    expect(s.state).toBe('global')
    expect(s.reason).toMatch(/every account/)
  })

  it('portfolio is grey too, and says it spans accounts rather than pretending to be one', () => {
    const s = deriveScopeState({ id: 'roll.up', mode: MODES.PORTFOLIO, payload: scoped(100) })
    expect(s.tone).toBe('grey')
    expect(s.state).toBe('portfolio')
    expect(s.reason).toMatch(/spans every enabled account/)
  })

  it('account data with NO scope block is amber and names the gap', () => {
    // The pre-S1 state of most routes: the component wants to be scoped and
    // the route gives it nothing to scope with.
    const s = deriveScopeState({ id: 'x', mode: MODES.ACCOUNT, payload: { rows: [1, 2, 3] } })
    expect(s.tone).toBe('amber')
    expect(s.state).toBe('unscoped')
    expect(s.reason).toMatch(/no scope/)
  })

  it('coverage of null is UNKNOWN, never healthy — the signal must not fail open', () => {
    // scopeCoverage() degrades to pct:null when its query throws. Treating
    // that as green would make the whole mechanism worse than useless.
    const s = deriveScopeState({ id: 'x', mode: MODES.ACCOUNT, payload: scoped(null) })
    expect(s.tone).toBe('amber')
    expect(s.reason).toBe('coverage unknown')
  })

  it('a failed fetch is RED even for a global component', () => {
    // 2026-07-29 broker outage: a panel that went quiet read as "all clear".
    // Silence at exactly the wrong moment is worse than never building it.
    const s = deriveScopeState({ id: 'x', mode: MODES.GLOBAL, failed: true, error: 'fetch failed: 500' })
    expect(s.tone).toBe('red')
    expect(s.state).toBe('failed')
    expect(s.reason).toBe('fetch failed: 500')
  })

  it('an unknown mode is amber, not silently treated as fine', () => {
    // A typo in the declaration is the same defect one level up.
    const s = deriveScopeState({ id: 'x', mode: 'acccount', payload: scoped(100) })
    expect(s.tone).toBe('amber')
    expect(s.reason).toMatch(/unknown mode/)
  })

  it('covers() overrides the route figure, so a component can check its own rows', () => {
    // The case the plan calls out: right parameter, wrong rows. The route says
    // 100%; the component looked at what actually arrived and disagrees.
    const s = deriveScopeState({ id: 'x', mode: MODES.ACCOUNT, payload: scoped(100, 245), covers: 0 })
    expect(s.tone).toBe('amber')
    expect(s.reason).toContain('0%')
  })

  it('every amber and red state carries a reason — a dot without one is a mood', () => {
    const cases = [
      deriveScopeState({ id: 'a', mode: MODES.ACCOUNT, payload: null }),
      deriveScopeState({ id: 'b', mode: MODES.ACCOUNT, payload: scoped(50) }),
      deriveScopeState({ id: 'c', mode: MODES.ACCOUNT, payload: scoped(null) }),
      deriveScopeState({ id: 'd', mode: MODES.ACCOUNT, failed: true }),
      deriveScopeState({ id: 'e', mode: 'nonsense' }),
    ]
    for (const s of cases) {
      expect(['amber', 'red']).toContain(s.tone)
      expect(s.reason, `${s.id} (${s.state}) must explain itself`).toBeTruthy()
    }
  })

  it('the state→tone map has no green — the owner is red/green colour-blind', () => {
    expect(Object.values(TONE_BY_STATE)).not.toContain('green')
    expect(new Set(Object.values(TONE_BY_STATE))).toEqual(new Set(['blue', 'grey', 'amber', 'red']))
  })
})
