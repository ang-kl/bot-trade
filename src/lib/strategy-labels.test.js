// The shared strategy→label map must cover every strategy the agent can run.
//
// This map has drifted TWICE. First when rsi2_reversion was added to the
// registry and not here (documented in strategy-labels.js's own header), then
// again in veto-words.js, which kept a hand-copied "mirror" that was missing
// rsi2_reversion AND fib_confluence and spelled inv_cup_handle 'Inv C&H'
// where every other table said 'ICUP'. A veto line for an uncovered strategy
// renders a raw snake_case key at the owner.
//
// The second copy is now gone — veto-words.js imports this one. This test
// closes the remaining hole: a strategy added to the registry with no label.
import { describe, it, expect } from 'vitest'
import { STRAT_SHORT, stratShort } from './strategy-labels.js'
import { STRATEGY_REGISTRY } from '../../agent/services/strategies.js'

describe('strategy labels', () => {
  it('covers every strategy in the registry', () => {
    const missing = STRATEGY_REGISTRY.map(s => s.key).filter(k => !STRAT_SHORT[k])
    expect(missing, `add these to STRAT_SHORT or they render as raw keys: ${missing.join(', ')}`).toEqual([])
  })

  it('has no label pointing at a strategy the registry does not have', () => {
    // A stale entry is harmless but signals the map was edited by hand
    // against a registry that has since changed — worth knowing.
    const keys = new Set(STRATEGY_REGISTRY.map(s => s.key))
    const orphans = Object.keys(STRAT_SHORT).filter(k => !keys.has(k))
    expect(orphans).toEqual([])
  })

  it('short codes are unique — two strategies sharing a code are unreadable', () => {
    const codes = Object.values(STRAT_SHORT)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('falls back to the raw key rather than blank, and null stays null', () => {
    // Never blank for a real strategy: a missing label must degrade to
    // something identifiable, not to an empty cell.
    expect(stratShort('some_future_strategy')).toBe('some_future_strategy')
    expect(stratShort(null)).toBe(null)
    expect(stratShort('')).toBe(null)
  })
})
