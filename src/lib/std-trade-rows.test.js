import { describe, it, expect } from 'vitest'
import { brokerPositionRows, brokerOrderRows } from './std-trade-rows.js'
import { stratShort } from './strategy-labels.js'

describe('broker rows carry strategy + timeframe for segmentation', () => {
  it('position rows surface parsed strategy/timeframe', () => {
    const [row] = brokerPositionRows([
      { positionId: 1, symbol: 'US30', side: 'BUY', lots: 0.1, label: 'x', strategy: 'rsi2_reversion', timeframe: '8h' },
    ])
    expect(row.strategy).toBe('rsi2_reversion')
    expect(row.timeframe).toBe('8h')
  })

  it('order rows surface parsed strategy/timeframe', () => {
    const [row] = brokerOrderRows([
      { orderId: 9, symbol: 'JPN225', side: 'SELL', lots: 1, label: 'x', strategy: 'fib_618_fade', timeframe: '4h' },
    ])
    expect(row.strategy).toBe('fib_618_fade')
    expect(row.timeframe).toBe('4h')
  })

  it('manual positions (no label) leave the fields null', () => {
    const [row] = brokerPositionRows([{ positionId: 2, symbol: 'EURUSD', side: 'BUY', lots: 0.5 }])
    expect(row.strategy).toBeNull()
    expect(row.timeframe).toBeNull()
  })
})

describe('stratShort', () => {
  it('maps known keys, falls back to the raw key, null for empty', () => {
    expect(stratShort('rsi2_reversion')).toBe('RSI2')
    expect(stratShort('fib_618_fade')).toBe('FIB')
    expect(stratShort('unknown_key')).toBe('unknown_key')
    expect(stratShort(null)).toBeNull()
  })
})
