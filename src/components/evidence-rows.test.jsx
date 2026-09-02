// EvidenceRows — the prior cohort watch row (02-09-2026 plan, part 1).
// react-dom/server, no jsdom: pure bodies rendered with a fixture, empty,
// and in the failure state; the fetch wiring is source-pinned.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import EvidenceRows, { PriorCohortRow, TargetReviewRow, ExitChainRow } from './EvidenceRows.jsx'

const report = (over = {}) => ({
  config: { on: true, demoOnly: false, riskScale: 1, priorAdmit: true, priorRiskScale: 0.5 },
  target: { closes: 30, minPf: 1.5 },
  admittedApprovals: 16,
  viaPrior: { admittedApprovals: 3, closed: 2, wins: 1, winRate: 50, profitFactor: 2.1, net: 42.5 },
  byAccount: {
    '111': { closed: 5, wins: 2, winRate: 40, profitFactor: 1.2, net: 10, viaPrior: { closed: 2, wins: 1, winRate: 50, profitFactor: 2.1, net: 42.5 } },
    unscoped: { closed: 3, wins: 1, winRate: 33.3, profitFactor: 0.8, net: -20, viaPrior: { closed: 0, wins: 0, winRate: null, profitFactor: 0, net: 0 } },
  },
  closedCohort: { trades: 8, wins: 3, winRate: 37.5, profitFactor: 1.59, net: 277.01 },
  verdict: 'pending 8/30 closes',
  ...over,
})

describe('PriorCohortRow', () => {
  it('renders the prior population, the criterion as read (not enforced), and the per-account split', () => {
    const html = renderToStaticMarkup(<PriorCohortRow data={report()} error={null} />)
    expect(html).toContain('Prior population:')
    expect(html).toContain('3 admitted')
    expect(html).toContain('2 closes')
    expect(html).toContain('PF 2.1')
    expect(html).toContain('pooled not met')
    expect(html).toContain('8/30 closes')
    expect(html).toContain('prior alone not met')
    expect(html).toContain('2/15 closes')
    expect(html).toContain('not enforced')
    expect(html).toContain('unscoped')
    expect(html).toContain('…111')
    expect(html).toContain('prior admit on')
  })
  it('reads the criterion as met only when both populations clear it, and shows ∞ for a lossless cohort', () => {
    const met = report({
      closedCohort: { trades: 31, wins: 20, winRate: 64.5, profitFactor: null, net: 900 },
      viaPrior: { admittedApprovals: 20, closed: 15, wins: 10, winRate: 66.7, profitFactor: 1.5, net: 300 },
    })
    const html = renderToStaticMarkup(<PriorCohortRow data={met} error={null} />)
    expect(html).toContain('pooled met')
    expect(html).toContain('prior alone met')
    expect(html).toContain('∞ (no losses yet)')
    const half = renderToStaticMarkup(<PriorCohortRow data={report({ viaPrior: { closed: 15, wins: 5, winRate: 33.3, profitFactor: 0.9, net: -5 } })} error={null} />)
    expect(half).toContain('prior alone not met')
  })
  it('a failed read renders not verifiable, never the empty shape', () => {
    const html = renderToStaticMarkup(<PriorCohortRow data={null} error="ECONNREFUSED" />)
    expect(html).toContain('not verifiable')
    expect(html).toContain('ECONNREFUSED')
    expect(html).not.toContain('Prior population:')
    expect(renderToStaticMarkup(<PriorCohortRow data={null} error={null} />)).toContain('Loading')
  })
  it('default export renders its pre-fetch state', () => {
    expect(renderToStaticMarkup(<EvidenceRows />)).toContain('Loading')
  })
})

const review = () => ({
  reportOnly: true, days: 30, hardMinRr: 3, prefilterRr: 1.5, minE: 0.1, k: 20,
  gates: { minProposals: 20, minCloses: 30 },
  strategies: {
    rsi2_reversion: {
      declaredTarget: { rr: 1.2, basis: 'fixed' }, ownFloor: 1,
      proposals: { n: 40, withRr: 38, medianRr: 1.2, shareBelowHard: 1, badRrVetoes: 30 },
      prior: { shrunkWinRatePct: 52.5, expectancyR: { declared: 0.155, median: 0.155, hard: 1.1 }, breakEvenRr: 0.905, rrForMinE: 1.095, wouldAdmit: { declared: true, median: true } },
      realised: { closes: 4, insufficient: true, need: 30 },
    },
    ema_pullback: {
      declaredTarget: { rr: 2, basis: 'fixed' }, ownFloor: 1.5,
      proposals: { n: 3, withRr: 3, insufficient: true, need: 20 },
      prior: null,
      realised: { closes: 31, actual: { expectancyR: -0.21, profitFactor: 0.8, winRate: 30 }, rules: {} },
    },
  },
})

describe('TargetReviewRow', () => {
  it('renders one line per strategy with numbers only past the gates', () => {
    const html = renderToStaticMarkup(<TargetReviewRow data={review()} error={null} />)
    expect(html).toContain('Target review')
    expect(html).toContain('nothing enforced')
    expect(html).toContain('rsi2_reversion:')
    expect(html).toContain('declared 1.20R')
    expect(html).toContain('median 1.20R')
    expect(html).toContain('W′ 52.5%')
    expect(html).toContain('break-even 0.91R')
    expect(html).toContain('closes 4/30')
    expect(html).toContain('ema_pullback:')
    expect(html).toContain('proposals 3/20')
    expect(html).toContain('no prior')
    expect(html).toContain('realised E -0.21R over 31')
  })
  it('a failed read renders not verifiable', () => {
    const html = renderToStaticMarkup(<TargetReviewRow data={null} error="500" />)
    expect(html).toContain('not verifiable')
    expect(html).not.toContain('Target review</span>')
  })
})

const chain = () => ({
  reportOnly: true, verdict: 'INSUFFICIENT', days: 90, minCloses: 100, n: 7, stamped: 7,
  families: {
    mean_reversion: { n: 5, stamped: 5, minCloses: 100, status: 'insufficient', byState: { opened: { n: 5, expectancyR: 0.1, winRate: 40 } } },
    breakout: { n: 2, stamped: 2, minCloses: 100, status: 'insufficient', byState: {} },
    trend: { n: 0, stamped: 0, minCloses: 100, status: 'insufficient', byState: {} },
  },
  biases: ['a', 'b'],
})

describe('ExitChainRow', () => {
  it('shows counts against the floor for insufficient families and numbers only when fitted', () => {
    const html = renderToStaticMarkup(<ExitChainRow data={chain()} error={null} />)
    expect(html).toContain('Exit chain')
    expect(html).toContain('7 stamped of 7 closes')
    expect(html).toContain('scaffold, not advice')
    expect(html).toContain('mean_reversion:')
    expect(html).toContain('insufficient 5/100 stamped closes')
    expect(html).toContain('insufficient 0/100 stamped closes')
    expect(html).not.toContain('E 0.10R')
    const fitted = chain()
    fitted.verdict = 'FITTED'
    fitted.families.mean_reversion = { ...fitted.families.mean_reversion, status: 'fitted', stamped: 120, byState: { scaled_out: { n: 80, expectancyR: 0.85, winRate: 62.5 }, opened: { n: 40, expectancyR: -0.9, winRate: 5 } } }
    const h2 = renderToStaticMarkup(<ExitChainRow data={fitted} error={null} />)
    expect(h2).toContain('fitted on 120')
    expect(h2).toContain('scaled_out n=80')
    expect(h2).toContain('E 0.85R')
    expect(html).toContain('journal biases: 2 recorded')
  })
  it('a failed read renders not verifiable', () => {
    expect(renderToStaticMarkup(<ExitChainRow data={null} error="502" />)).toContain('not verifiable')
  })
})

describe('fetch wiring (source pin, comments stripped)', () => {
  it('reads /state/earned-floor and routes the failure into its own error state', () => {
    const src = readFileSync(new URL('./EvidenceRows.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toContain("agentGet('/state/earned-floor')")
    expect((src.match(/\.catch\(e => \{ if \(alive\) setFloor\(\{ data: null, error: e\?\.message \|\| String\(e\) \}\) \}\)/g) || []).length).toBe(1)
    expect(src).toContain("agentGet('/state/target-review')")
    expect(src).toContain("agentGet('/state/exit-chain')")
    expect((src.match(/\.catch\(e => \{ if \(alive\) setChain\(\{ data: null, error: e\?\.message \|\| String\(e\) \}\) \}\)/g) || []).length).toBe(1)
    expect((src.match(/\.catch\(e => \{ if \(alive\) setReview\(\{ data: null, error: e\?\.message \|\| String\(e\) \}\) \}\)/g) || []).length).toBe(1)
    expect(src).not.toMatch(/\.catch\(\(\) => \{\s*\}\)/)
  })
  it('is rendered on Tune beside DivergenceCard', () => {
    const tune = readFileSync(new URL('../pages/Tune.jsx', import.meta.url), 'utf8')
    expect(tune).toContain("import EvidenceRows from '../components/EvidenceRows.jsx'")
    expect(tune).toContain('<EvidenceRows />')
  })
})
