import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { describeArmBenchmarks, armBenchmarksLine } from './arm-benchmarks.js'

describe('describeArmBenchmarks — the agent\'s stored arm-time stats, read back', () => {
  it('not read / none / stored', () => {
    expect(describeArmBenchmarks(null).status).toBe('not_read')
    expect(describeArmBenchmarks({}).status).toBe('not_read')
    expect(describeArmBenchmarks({ benchmarks: null }).status).toBe('none')
    expect(describeArmBenchmarks({ benchmarks: {} }).status).toBe('none')
    const d = describeArmBenchmarks({ benchmarks: { 'EURUSD|4h': { profitFactor: 1.42, expectancyPct: 0.31, trades: 57 }, 'BTCUSD|1d': { profitFactor: null, expectancyPct: null, trades: 0 } } })
    expect(d.status).toBe('stored')
    expect(d.rows).toEqual([
      { key: 'BTCUSD|1d', symbol: 'BTCUSD', tf: '1d', profitFactor: '—', expectancyPct: '—', trades: '0' },
      { key: 'EURUSD|4h', symbol: 'EURUSD', tf: '4h', profitFactor: '1.42', expectancyPct: '0.31%', trades: '57' },
    ])
  })
  it('the display line names the source and every pair', () => {
    expect(armBenchmarksLine({ benchmarks: { 'EURUSD|4h': { profitFactor: 1.42, expectancyPct: 0.31, trades: 57 } } }))
      .toBe('arm-time benchmarks (stored at Apply, 1 pair): EURUSD 4h PF 1.42 · exp 0.31% · 57 trades')
    expect(armBenchmarksLine(undefined)).toBe('arm-time benchmarks: not read')
  })
})

describe('Tune reads the benchmarks back (source pin, comment-stripped)', () => {
  it('fetches /state/arm-benchmarks in the page load and renders armBenchmarksLine', () => {
    const src = readFileSync(new URL('../pages/Tune.jsx', import.meta.url), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    expect(src).toMatch(/agentGet\('\/state\/arm-benchmarks'\)/)
    expect(src).toMatch(/armBenchmarksLine\(armBenchmarks\)/)
    // The write still happens on both arm buttons.
    expect(src.match(/agentPost\('\/actions\/arm-benchmarks'/g)?.length).toBe(2)
  })
})
