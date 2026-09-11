// DivergenceCard — the backtest-vs-live reader and the earned-floor row.
//
// react-dom/server: no jsdom in this repo, so effects never run and the
// default export renders its pre-fetch state. The pure bodies take
// {data, error} and are rendered with a fixture, empty, and in the failure
// state — the failure state is the one worth pinning (failure mode #3): a
// route that cannot be read must render "not verifiable", never the empty
// shape and never nothing.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import DivergenceCard, { DivergenceBody, EarnedFloorRow, ComboTable, EvidenceLevelTable } from './DivergenceCard.jsx'
import { fmt, pct, money } from '../lib/divergence-view.js'

const edge = (over = {}) => ({ trades: 0, wins: 0, winRatePct: null, profitFactor: null, netPnl: 0, expectancyR: null, rSample: 0, ...over })

const combo = (over = {}) => ({
  strategy: 'ema', symbol: 'XAUUSD', timeframe: 'M15', kind: 'matrix',
  armedAt: '2026-08-10T00:00:00Z', disarmedAt: null, disarmReason: null,
  bar: { minPf: 1.3, minWin: 45, minTrades: 30 },
  backtest: { profitFactor: 1.8, winRatePct: 58, trades: 120, wf: '3/4' },
  live: edge({ trades: 14, wins: 5, winRatePct: 35.7, profitFactor: 0.72, netPnl: -212.4, expectancyR: -0.21, rSample: 12 }),
  delta: { profitFactor: -1.08, winRatePct: -22.3 },
  execution: { slippageR: 0.04, spreadFracSl: 0.11, sample: 14 },
  status: 'diverging',
  ...over,
})

const divergence = (over = {}) => ({
  window: { days: 30, since: '2026-08-03 00:00:00', minLive: 10, wrGapPts: 15 },
  combos: [
    combo(),
    combo({ symbol: 'NAS100', status: 'holding', live: edge({ trades: 22, wins: 13, winRatePct: 59.1, profitFactor: 1.62, netPnl: 410.2, expectancyR: 0.31, rSample: 22 }) }),
    combo({ symbol: 'EURUSD', status: 'insufficient', live: edge({ trades: 3, wins: 2, winRatePct: 66.7, profitFactor: null, netPnl: 40, expectancyR: 0.5, rSample: 3 }) }),
  ],
  unevidencedArms: [{ kind: 'unevidenced', strategy: 'rsi2', symbol: 'GBPUSD', timeframe: 'H1', armedAt: '2026-08-20T00:00:00Z', disarmedAt: null }],
  evidenceLevels: {
    combo: edge({ trades: 39, wins: 20, winRatePct: 51.3, profitFactor: 1.21, netPnl: 237.8, expectancyR: 0.12, rSample: 37 }),
    symbol_tf: edge({ trades: 4, wins: 1, winRatePct: 25, profitFactor: 0.4, netPnl: -88, expectancyR: -0.6, rSample: 4 }),
    strategy_only: edge(),
    none: edge({ trades: 2, wins: 0, winRatePct: 0, profitFactor: 0, netPnl: -60, expectancyR: -1, rSample: 2 }),
  },
  optimism: { combos: 2, winRatePts: 11.6, profitFactor: 0.63 },
  integrity: { closes: 47, flaggedExcluded: 2 },
  ...over,
})

const earnedFloor = (over = {}) => ({
  config: { on: true, riskScale: 0.5, window: 30, minSample: 15, minE: 0.15 },
  target: { closes: 30, minPf: 1.5 },
  admittedApprovals: 7,
  admitEvents: 23,
  closedCohort: { trades: 5, wins: 3, winRate: 60, profitFactor: 1.9, net: 142.5 },
  verdict: 'pending 5/30 closes',
  ...over,
})

describe('DivergenceCard (default export)', () => {
  it('renders without throwing before any data has arrived, and says so', () => {
    const html = renderToStaticMarkup(<DivergenceCard />)
    expect(html).toContain('Backtest vs live')
    expect(html).toContain('Loading')
    // It names the OTHER divergence so the two cannot be confused.
    expect(html).toMatch(/pair divergence/)
  })
})

describe('DivergenceBody', () => {
  it('renders optimism, the evidence-level table, the combos and the unevidenced count from a fixture', () => {
    const html = renderToStaticMarkup(<DivergenceBody data={divergence()} />)
    expect(html).toContain('+11.6 pts')          // optimism winRatePts
    expect(html).toContain('PF +0.63')           // optimism profitFactor
    expect(html).toContain('2 combos')           // optimism combos
    for (const lvl of ['combo', 'symbol/timeframe only', 'strategy only', 'no backtest evidence']) expect(html).toContain(lvl)
    expect(html).toContain('51.3%')              // combo-level WR
    expect(html).toContain('−$88.00')            // symbol_tf net, minus sign not hyphen
    expect(html).toContain('XAUUSD')
    expect(html).toContain('NAS100')
    expect(html).toContain('diverging')
    expect(html).toContain('holding')
    expect(html).toContain('insufficient')
    expect(html).toMatch(/1<\/span> unevidenced arm/)
    expect(html).toContain('1 diverging')
  })

  it('puts diverging rows in the error tint and leaves holding rows plain', () => {
    const html = renderToStaticMarkup(<ComboTable combos={divergence().combos} />)
    const rows = html.match(/<tr[^>]*>/g).slice(1) // drop the header row
    expect(rows[0]).toContain('--color-error-bg') // diverging first, tinted
    expect(rows[1]).not.toContain('--color-error-bg')
  })

  it('shows at most 8 combos and says how many it dropped', () => {
    const many = Array.from({ length: 11 }, (_, i) => combo({ symbol: `SYM${i}`, status: 'holding' }))
    const html = renderToStaticMarkup(<DivergenceBody data={divergence({ combos: many })} />)
    expect((html.match(/SYM\d+/g) || []).length).toBe(8)
    expect(html).toContain('top 8 of 11')
  })

  it('says "no evidenced arms yet" on an empty report rather than rendering a blank table', () => {
    const html = renderToStaticMarkup(<DivergenceBody data={divergence({ combos: [], unevidencedArms: [], optimism: { combos: 0, winRatePts: null, profitFactor: null }, evidenceLevels: {} })} />)
    expect(html).toContain('no evidenced arms yet')
    expect(html).toContain('no combo has a measurable live sample yet')
    expect(html).not.toContain('<table')
  })

  it('renders NOT VERIFIABLE on a fetch error — never the empty state', () => {
    const html = renderToStaticMarkup(<DivergenceBody data={null} error="HTTP 500 divergence" />)
    expect(html).toContain('not verifiable')
    expect(html).toContain('HTTP 500 divergence')
    expect(html).not.toContain('no evidenced arms yet')
    expect(html).not.toContain('Loading')
  })

  it('renders — for a null PF rather than 0 or NaN', () => {
    expect(fmt(null)).toBe('—')
    expect(pct(undefined)).toBe('—')
    expect(money(null)).toBe('—')
    expect(money(-3.5)).toBe('−$3.50')
    const html = renderToStaticMarkup(<EvidenceLevelTable levels={{ strategy_only: edge() }} />)
    expect(html).not.toContain('NaN')
  })
})

describe('EarnedFloorRow', () => {
  it('renders config, cohort, admitted counts and the verdict from a fixture', () => {
    const html = renderToStaticMarkup(<EarnedFloorRow data={earnedFloor()} />)
    expect(html).toContain('pending 5/30 closes')
    expect(html).toContain('every account')
    expect(html).not.toMatch(/demo only|live included/)
    expect(html).toContain('risk scale 0.50')
    expect(html).toContain('window 30')
    expect(html).toContain('min sample 15')
    expect(html).toContain('min E 0.15R')
    expect(html).toContain('5 closes')
    expect(html).toContain('3 wins (60.0%)')
    expect(html).toContain('PF 1.90')
    expect(html).toContain('$142.50')
    expect(html).toMatch(/7<\/span> admitted setups/)
    expect(html).toContain('23 approval events')
    expect(html).toContain('target 30 closes at PF ≥ 1.5')
  })

  it('reads a null PF with closes as no-losses-yet, not as missing', () => {
    const html = renderToStaticMarkup(<EarnedFloorRow data={earnedFloor({ closedCohort: { trades: 2, wins: 2, winRate: 100, profitFactor: null, net: 50 } })} />)
    expect(html).toContain('no losses yet')
  })

  it('renders NOT VERIFIABLE on a fetch error', () => {
    const html = renderToStaticMarkup(<EarnedFloorRow data={null} error="ECONNREFUSED" />)
    expect(html).toContain('not verifiable')
    expect(html).toContain('ECONNREFUSED')
    expect(html).not.toContain('Config:')
  })
})

describe('fetch wiring (source pin, comments stripped)', () => {
  it('routes BOTH fetch failures into their own error state — no swallowed catch', () => {
    const src = readFileSync(new URL('./DivergenceCard.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toContain("agentGet(`/state/divergence?days=${DAYS}`)")
    expect(src).toContain("agentGet('/state/earned-floor')")
    expect((src.match(/\.catch\(e => \{ if \(alive\) set(Div|Floor)\(\{ data: null, error: e\?\.message \|\| String\(e\) \}\) \}\)/g) || []).length).toBe(2)
    expect(src).not.toMatch(/\.catch\(\(\) => \{\s*\}\)/)
  })
})
