import { describe, it, expect } from 'vitest'
import { pillState, sweepLabel, advanceSweep } from './backtest-sweep.js'

describe('pillState', () => {
  const ctx = { runs: { fib_618_fade: {} }, runningKey: 'rsi_2', queue: ['ema_cross', 'fvg'] }

  it('classifies running, done, queued and idle', () => {
    expect(pillState('rsi_2', ctx)).toBe('running')
    expect(pillState('fib_618_fade', ctx)).toBe('done')
    expect(pillState('ema_cross', ctx)).toBe('queued')
    expect(pillState('cup_handle', ctx)).toBe('idle')
  })

  it('a re-run of a finished strategy reads as running, not done', () => {
    expect(pillState('fib_618_fade', { ...ctx, runningKey: 'fib_618_fade' })).toBe('running')
  })
})

describe('sweepLabel', () => {
  it('counts the strategy in flight, starting at 1', () => {
    expect(sweepLabel({ running: true, total: 12, remaining: 11, runningKey: 'fib_618_fade' }))
      .toBe('Testing 1 of 12 · fib_618_fade')
    expect(sweepLabel({ running: true, total: 12, remaining: 0, runningKey: 'fvg' }))
      .toBe('Testing 12 of 12 · fvg')
  })

  it('a single-strategy run keeps the symbol-count wording', () => {
    expect(sweepLabel({ running: true, total: 1, remaining: 0, symbolCount: 7 })).toBe('Testing 7 symbols…')
    expect(sweepLabel({ running: true, total: 1, remaining: 0, symbolCount: 1 })).toBe('Testing 1 symbol…')
  })

  it('idle shows the symbol count', () => {
    expect(sweepLabel({ running: false, symbolCount: 5 })).toBe('Run backtest (5)')
  })
})

describe('advanceSweep', () => {
  it('stores the finished result under the strategy the JOB ran and dispatches the next', () => {
    const out = advanceSweep({ ranKey: 'rsi_2', result: { symbols: {} }, queue: ['ema_cross', 'fvg'] })
    expect(out.store).toEqual({ key: 'rsi_2', result: { symbols: {} } })
    expect(out.nextKey).toBe('ema_cross')
    expect(out.remaining).toEqual(['fvg'])
    expect(out.done).toBe(false)
    expect(out.error).toBe(null)
  })

  it('a failed strategy names itself and the sweep continues', () => {
    const out = advanceSweep({ ranKey: 'fvg', error: 'no bars for XAUUSD', queue: ['cup_handle'] })
    expect(out.store).toBe(null)
    expect(out.error).toBe('fvg: no bars for XAUUSD')
    expect(out.nextKey).toBe('cup_handle')
    expect(out.done).toBe(false)
  })

  it('an empty queue ends the sweep', () => {
    const out = advanceSweep({ ranKey: 'fvg', result: {}, queue: [] })
    expect(out.nextKey).toBe(null)
    expect(out.done).toBe(true)
  })

  it('a result with no attributable strategy is not stored under a guessed key', () => {
    const out = advanceSweep({ ranKey: null, result: { symbols: {} }, queue: [] })
    expect(out.store).toBe(null)
  })
})
