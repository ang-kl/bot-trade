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
import { STRATEGIES } from '../../agent/lib/trade-labels.js'

// THE REGISTRY IS NOT THE WHOLE VOCABULARY (2026-09-20). Every guard in this
// file keyed off STRATEGY_REGISTRY, which made it blind by construction to a
// strategy that is deliberately NOT in the registry. `tick_momentum_breakout`
// is exactly that: the sidecar fires it, the reconciler stamps it on the trade
// row from the filled intent, and it stays out of the registry so the fast
// monitor manages it unconditionally (see the note at the registry's tail).
// It reached the UI with no short code and rendered its raw 22-character key
// in a four-letter mobile column, and no test here could have said so.
//
// So the coverage guard below runs against the BROKER LABEL vocabulary
// (agent/lib/trade-labels.js's STRATEGIES) — the set of strategy keys that can
// actually appear on a stored trade — minus the buckets no producer stamps.
//
// THE EXCLUSION LIST IS THE WEAK POINT OF THIS GUARD, so it is kept as short
// as the facts allow. Its first version read "never stamped by a producer" and
// listed `burnin`, which is stamped: burn-in.js writes `strategy: 'burnin'` on
// every order it places and reads the rows back by `label_strategy`. The
// producer is retired, the closed rows are not, and they render. It now has a
// short code and is off this list — excluding a key that really does reach the
// UI is the blind spot this guard exists to close, not one to document.
//
// What remains is the free-text vocabulary that predates the registry:
// buckets an LLM's prose strategy falls into so the label still round-trips,
// plus encodeLabel's catch-all. Nothing stamps these on a row as a strategy
// key, so they have no column to render badly in.
const LABEL_ONLY_BUCKETS = new Set([
  'trend', 'meanrev', 'breakout', 'scalp', 'swing', 'news', 'reversal',
  'other', // encodeLabel's catch-all for an unrecognised key
])

describe('strategy labels', () => {
  it('covers every strategy in the registry', () => {
    const missing = STRATEGY_REGISTRY.map(s => s.key).filter(k => !STRAT_SHORT[k])
    expect(missing, `add these to STRAT_SHORT or they render as raw keys: ${missing.join(', ')}`).toEqual([])
  })

  it('covers every strategy the BROKER LABEL can carry, registry or not', () => {
    const missing = Object.keys(STRATEGIES)
      .filter(k => !LABEL_ONLY_BUCKETS.has(k) && !STRAT_SHORT[k])
    expect(missing, `add these to STRAT_SHORT or they render as raw keys: ${missing.join(', ')}`).toEqual([])
  })

  it('has no label pointing at a strategy neither the registry nor the label vocabulary has', () => {
    // A stale entry is harmless but signals the map was edited by hand
    // against a registry that has since changed — worth knowing. The label
    // vocabulary counts as legitimate: a key can be stampable without being
    // a registry strategy.
    const keys = new Set([...STRATEGY_REGISTRY.map(s => s.key), ...Object.keys(STRATEGIES)])
    const orphans = Object.keys(STRAT_SHORT).filter(k => !keys.has(k))
    expect(orphans).toEqual([])
  })

  it('short codes are unique — two strategies sharing a code are unreadable', () => {
    const codes = Object.values(STRAT_SHORT)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('renders the tick strategy short AND long, though it is not a registry key', () => {
    expect(stratShort('tick_momentum_breakout')).toBe('TICK')
    // STRAT_NAME deliberately carries no entry: the humaniser already produces
    // the right words, and an entry there would trip the registry-orphan guard
    // in the full-names block below.
    expect(strategyLabel('tick_momentum_breakout')).toBe('Tick Momentum Breakout')
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

// ---------------------------------------------------------------------------
// Owner, 2026-08-03, screenshot of Performance > "Strategy × market — 30D":
// every row label read "Fib_confluence", "Inv_cup_handle", "Rsi2_reversion",
// "Vwap_trend". That table had never adopted strategyLabel — it rendered the
// raw KEY under an inline `textTransform: 'capitalize'`, which is precisely
// the defect this module was written to end, escaping one table at a time.
//
// So the guard is on the MECHANISM, not on one table: no source file may use
// the inline capitalize style prop. Tailwind's `capitalize` class on mode
// chips (Tune.jsx) is untouched — those render fixed English words, not keys.
// ---------------------------------------------------------------------------
describe('capitalize regression guard', () => {

  // A SECOND strategy-name map is how this drifts. Trade.jsx carried one that
  // was missing six of the twelve registry strategies and spelled the rest in
  // sentence case; the Accounts page and the strategy-insights panel each had
  // their own before that. Only this module may key a map on strategy ids —
  // a copy elsewhere cannot have the registry-coverage guarantee above.
  it('no OTHER module defines its own strategy-name map', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, basename } = await import('node:path')
    const offenders = []
    const walk = (dir) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(jsx?|tsx?)$/.test(e) || e.endsWith('.test.js')) continue
        if (basename(p) === 'strategy-labels.js') continue
        const src = readFileSync(p, 'utf8')
        // A map LITERAL keyed on a strategy id — `fib_618_fade: '...'`. Bare
        // mentions of the key (filters, comparisons, comments) are untouched.
        if (/^\s*(fib_618_fade|cup_handle|vwap_trend|fib_confluence)\s*:\s*['"`]/m.test(src)) offenders.push(p)
      }
    }
    walk(new URL('..', import.meta.url).pathname)
    expect(offenders, `import strategyLabel instead: ${offenders.join(', ')}`).toEqual([])
  })

  it('no source file re-introduces inline textTransform capitalize', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const offenders = []
    const walk = (dir) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!/\.(jsx?|tsx?)$/.test(e) || e.endsWith('.test.js')) continue
        const src = readFileSync(p, 'utf8')
        // The comments in this file and its callers legitimately NAME the
        // property while explaining why not to use it; only the style prop
        // itself is an offence.
        if (/textTransform:\s*['"]capitalize['"]/.test(src)) offenders.push(p)
      }
    }
    walk(new URL('..', import.meta.url).pathname)
    expect(offenders, `use strategyLabel() instead: ${offenders.join(', ')}`).toEqual([])
  })
})
