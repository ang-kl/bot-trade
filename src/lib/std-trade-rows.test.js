import { describe, it, expect } from 'vitest'
import { brokerPositionRows, brokerOrderRows, brokerDealRows, bracketMoney, estimateMargin } from './std-trade-rows.js'
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

describe('brokerPositionRows: DB↔broker integrity cross-check (owner: verify each open position individually)', () => {
  it('no dbByPid passed → integrity stays null (existing callers unaffected)', () => {
    const [row] = brokerPositionRows([{ positionId: 1, symbol: 'EURUSD', side: 'BUY', sl: 1.09, tp: 1.11 }])
    expect(row.integrity).toBeNull()
  })

  it('broker position with no matching active DB row is flagged untracked', () => {
    const [row] = brokerPositionRows(
      [{ positionId: 1, symbol: 'EURUSD', side: 'BUY', sl: 1.09, tp: 1.11 }],
      { dbByPid: new Map() }
    )
    expect(row.integrity).toBe('untracked in DB')
  })

  it('matching DB row with the same side/SL/TP is OK', () => {
    const dbByPid = new Map([['1', { side: 'long', current_sl: 1.09, current_tp: 1.11 }]])
    const [row] = brokerPositionRows(
      [{ positionId: 1, symbol: 'EURUSD', side: 'BUY', sl: 1.09, tp: 1.11 }],
      { dbByPid }
    )
    expect(row.integrity).toBe('OK')
  })

  it('a reversed side is flagged as side drift', () => {
    const dbByPid = new Map([['1', { side: 'long', current_sl: 1.09, current_tp: 1.11 }]])
    const [row] = brokerPositionRows(
      [{ positionId: 1, symbol: 'EURUSD', side: 'SELL', sl: 1.11, tp: 1.09 }],
      { dbByPid }
    )
    expect(row.integrity).toBe('side drift')
  })

  it('a moved SL is flagged as SL drift', () => {
    const dbByPid = new Map([['1', { side: 'long', current_sl: 1.09, current_tp: 1.11 }]])
    const [row] = brokerPositionRows(
      [{ positionId: 1, symbol: 'EURUSD', side: 'BUY', sl: 1.05, tp: 1.11 }],
      { dbByPid }
    )
    expect(row.integrity).toBe('SL drift')
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

// ---------------------------------------------------------------------------
// Bracket money + margin (owner 2026-07-29: "[SL Loss in $]", "[TP Profit in
// $]", "missing fields <Margin Used>")
// ---------------------------------------------------------------------------
describe('bracketMoney', () => {
  it('prices a long stop as a LOSS and its take profit as a GAIN', () => {
    // EURUSD, 1 lot = 100k units. 50 pips = 0.0050 → $500 per lot.
    const { slMoney, tpMoney } = bracketMoney({
      symbol: 'EURUSD', side: 'BUY', qty: 1, entry: 1.1000, sl: 1.0950, tp: 1.1100,
    })
    expect(slMoney).toBeCloseTo(-500, 6)
    expect(tpMoney).toBeCloseTo(1000, 6)
  })

  it('flips the signs for a short — the stop sits ABOVE entry', () => {
    const { slMoney, tpMoney } = bracketMoney({
      symbol: 'EURUSD', side: 'SELL', qty: 1, entry: 1.1000, sl: 1.1050, tp: 1.0900,
    })
    expect(slMoney).toBeCloseTo(-500, 6)
    expect(tpMoney).toBeCloseTo(1000, 6)
  })

  it('reports a stop trailed PAST entry as locked-in profit, not a loss', () => {
    // The whole reason the sign is computed rather than assumed.
    const { slMoney } = bracketMoney({ symbol: 'EURUSD', side: 'BUY', qty: 1, entry: 1.1000, sl: 1.1030 })
    expect(slMoney).toBeCloseTo(300, 6)
  })

  it('scales with lots', () => {
    const one = bracketMoney({ symbol: 'EURUSD', side: 'BUY', qty: 1, entry: 1.1, sl: 1.095 })
    const ten = bracketMoney({ symbol: 'EURUSD', side: 'BUY', qty: 10, entry: 1.1, sl: 1.095 })
    expect(ten.slMoney).toBeCloseTo(one.slMoney * 10, 6)
  })

  it('gives each ladder leg its own lots and sums the whole plan', () => {
    const { tpMoney } = bracketMoney({
      symbol: 'EURUSD', side: 'BUY', qty: 2, entry: 1.1000,
      tps: [{ n: 1, price: 1.1050, lots: 1 }, { n: 2, price: 1.1100, lots: 1 }],
    })
    // 50 pips on 1 lot + 100 pips on 1 lot = 500 + 1000
    expect(tpMoney).toBeCloseTo(1500, 6)
  })

  it('converts a USD-base pair through its price instead of overstating ~150x', () => {
    // USDJPY: 1 lot = 100k USD. A 1.50 yen stop = 150,000 JPY ÷ 150 = $1,000.
    const { slMoney } = bracketMoney({ symbol: 'USDJPY', side: 'BUY', qty: 1, entry: 150, sl: 148.5, ref: 150 })
    expect(slMoney).toBeCloseTo(-1000, 3)
  })

  it('returns null for a cross with no rate map rather than guessing', () => {
    const { slMoney } = bracketMoney({ symbol: 'EURGBP', side: 'BUY', qty: 1, entry: 0.85, sl: 0.845 })
    expect(slMoney).toBeNull()
  })

  it('converts a cross when the rate map carries the USD major', () => {
    const { slMoney } = bracketMoney({
      symbol: 'EURGBP', side: 'BUY', qty: 1, entry: 0.85, sl: 0.845, rates: { GBPUSD: 1.25 },
    })
    // 0.0050 × 100k = 500 GBP → × 1.25 = 625 USD
    expect(slMoney).toBeCloseTo(-625, 6)
  })

  it('is null when a level or the size is missing — never a misleading zero', () => {
    expect(bracketMoney({ symbol: 'EURUSD', side: 'BUY', qty: 1, entry: 1.1 }).tpMoney).toBeNull()
    expect(bracketMoney({ symbol: 'EURUSD', side: 'BUY', qty: null, entry: 1.1, sl: 1.09 }).slMoney).toBeNull()
  })
})

describe('estimateMargin', () => {
  it('is notional ÷ leverage', () => {
    // 1 lot EURUSD at 1.10 = 110,000 notional; 1:100 → 1,100.
    expect(estimateMargin({ symbol: 'EURUSD', qty: 1, price: 1.1, leverage: 100 })).toBeCloseTo(1100, 6)
  })

  it('refuses a missing or zero leverage instead of dividing by it', () => {
    expect(estimateMargin({ symbol: 'EURUSD', qty: 1, price: 1.1, leverage: null })).toBeNull()
    expect(estimateMargin({ symbol: 'EURUSD', qty: 1, price: 1.1, leverage: 0 })).toBeNull()
  })
})

describe('bracket money on the row adapters', () => {
  it('prefers the server impacts over the client estimate', () => {
    const [row] = brokerPositionRows([{
      positionId: 1, symbol: 'EURUSD', side: 'BUY', lots: 1, entry: 1.1,
      sl: 1.095, tp: 1.11, currentPrice: 1.1, slNetImpact: -512.34, tpNetImpact: 987.65,
    }])
    expect(row.slMoney).toBe(-512.34)
    expect(row.tpMoney).toBe(987.65)
    expect(row.moneyEst).toBe(false)
  })

  it('falls back to the estimate and flags it when the server sent no impacts', () => {
    const [row] = brokerPositionRows([{
      positionId: 1, symbol: 'EURUSD', side: 'BUY', lots: 1, entry: 1.1, sl: 1.095, tp: 1.11, currentPrice: 1.1,
    }])
    expect(row.slMoney).toBeCloseTo(-500, 6)
    expect(row.moneyEst).toBe(true)
  })

  it('estimates a closed deal margin only when leverage is known', () => {
    const deal = { dealId: 1, positionId: 9, symbol: 'EURUSD', side: 'BUY', lots: 1, entryPrice: 1.1, closePrice: 1.11, netPnl: 1000 }
    expect(brokerDealRows([deal], { leverage: 100 })[0].margin).toBeCloseTo(1100, 6)
    expect(brokerDealRows([deal])[0].margin).toBeNull()
  })

  it('still formats its Reason line — regression on the money() shadowing', () => {
    // A local `const money = bracketMoney(...)` shadowed the module-level
    // money() formatter; this row build would have thrown.
    const [row] = brokerDealRows([{ dealId: 2, positionId: 3, symbol: 'EURUSD', side: 'BUY', lots: 1, entryPrice: 1.1, closePrice: 1.11, netPnl: 1000 }])
    expect(row.reason).toContain('net')
  })
})

describe('brokerPositionRows: durable cockpit identity from the DB row (owner 2026-08-01 fake-journal fix)', () => {
  it('stamps dbPositionId + accountId when the dbByPid row carries them', () => {
    const dbByPid = new Map([['9', { id: 41, account_id: 46130058, side: 'long', current_sl: 1.09, current_tp: 1.11 }]])
    const [row] = brokerPositionRows(
      [{ positionId: 9, symbol: 'EURUSD', side: 'BUY', sl: 1.09, tp: 1.11 }],
      { dbByPid }
    )
    expect(row.dbPositionId).toBe(41)
    expect(row.accountId).toBe('46130058')
  })

  it('stays null without dbByPid (existing callers) and for untracked positions', () => {
    const [bare] = brokerPositionRows([{ positionId: 9, symbol: 'EURUSD', side: 'BUY' }])
    expect(bare.dbPositionId).toBe(null)
    expect(bare.accountId).toBe(null)
    const [untracked] = brokerPositionRows([{ positionId: 9, symbol: 'EURUSD', side: 'BUY' }], { dbByPid: new Map() })
    expect(untracked.dbPositionId).toBe(null)
    expect(untracked.accountId).toBe(null)
  })
})
