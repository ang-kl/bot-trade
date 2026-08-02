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
import { STRAT_SHORT, stratShort, STRAT_NAME, strategyLabel } from './strategy-labels.js'
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

// ---------------------------------------------------------------------------
// FULL names (owner 2026-07-30): "the abbreviatons and acryomns not proper
// capitalised". CSS `text-transform: capitalize` cannot know RSI is an
// acronym — it produced "Rsi2_reversion" — so the mapping has to be explicit,
// and it has to stay in step with the registry.
// ---------------------------------------------------------------------------
describe('strategy full names', () => {
  it('covers every strategy in the registry', () => {
    const missing = STRATEGY_REGISTRY.map(s => s.key).filter(k => !STRAT_NAME[k])
    expect(missing, `add these to STRAT_NAME or they render a humanised key: ${missing.join(', ')}`).toEqual([])
  })

  it('has no name pointing at a strategy the registry does not have', () => {
    const keys = new Set(STRATEGY_REGISTRY.map(s => s.key))
    const orphans = Object.keys(STRAT_NAME).filter(k => !keys.has(k))
    expect(orphans).toEqual([])
  })

  it('spells the acronyms the way the owner asked (2026-08-01)', () => {
    // The whole point of the change: these are the strings CSS got wrong.
    expect(strategyLabel('rsi2_reversion')).toBe('RSI 2 Reversion')
    expect(strategyLabel('vwap_trend')).toBe('VWAP Trend')
    expect(strategyLabel('fvg_retrace')).toBe('FVG Retrace')
    expect(strategyLabel('ema_pullback')).toBe('EMA Trend-Pullback')
    expect(strategyLabel('rsi_meanrev')).toBe('RSI Mean-Reversion')
    // And none of them still carries an underscore.
    for (const k of Object.keys(STRAT_NAME)) expect(strategyLabel(k)).not.toMatch(/_/)
  })

  it('names the non-strategy buckets the API can emit', () => {
    // strategy-insights.js COALESCEs an unlabelled trade to this literal.
    expect(strategyLabel('manual / external')).toBe('Manual / External')
    expect(strategyLabel('unlabelled')).toBe('Unlabelled')
  })

  it('humanises an unmapped key instead of showing snake_case or a blank', () => {
    // A strategy added to the registry without a name must stay identifiable —
    // degrading to an empty cell would hide it entirely.
    expect(strategyLabel('some_future_strategy')).toBe('Some Future Strategy')
    expect(strategyLabel('atr_squeeze')).toBe('ATR Squeeze')
    expect(strategyLabel('macd_cross')).toBe('MACD Cross')
  })

  it('keeps an acronym fused to digits shouting', () => {
    expect(strategyLabel('rsi2')).toBe('RSI2')
    expect(strategyLabel('ema200_pullback')).toBe('EMA200 Pullback')
    // Not an acronym — must not be upper-cased just because digits follow.
    expect(strategyLabel('range40')).toBe('Range40')
  })

  it('does not shout ordinary three-letter words', () => {
    // A "three letters = acronym" rule would have produced "DAY" and "GAP".
    expect(strategyLabel('day_break')).toBe('Day Break')
    expect(strategyLabel('gap_fill')).toBe('Gap Fill')
  })

  it('null and empty stay null so a caller can render a dash', () => {
    expect(strategyLabel(null)).toBe(null)
    expect(strategyLabel(undefined)).toBe(null)
    expect(strategyLabel('')).toBe(null)
  })

  it('is not fooled by inherited Object properties', () => {
    expect(strategyLabel('constructor')).toBe('Constructor')
    expect(strategyLabel('toString')).toBe('ToString')
  })

  it('passes a dash straight through', () => {
    // WorkflowAudit's row builder falls back to an em dash when no strategy was
    // recorded. It must stay a dash: dressing "no attribution" up as a strategy
    // name would be an invented fact in the one column that answers "which rule
    // placed this trade". Both dash forms, since only one is a split separator.
    expect(strategyLabel('\u2014')).toBe('\u2014')
    expect(strategyLabel('-')).toBe('-')
  })
})
