// EvidenceRows — the prior cohort watch row (02-09-2026 plan, part 1).
// react-dom/server, no jsdom: pure bodies rendered with a fixture, empty,
// and in the failure state; the fetch wiring is source-pinned.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import EvidenceRows, { PriorCohortRow } from './EvidenceRows.jsx'

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

describe('fetch wiring (source pin, comments stripped)', () => {
  it('reads /state/earned-floor and routes the failure into its own error state', () => {
    const src = readFileSync(new URL('./EvidenceRows.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toContain("agentGet('/state/earned-floor')")
    expect((src.match(/\.catch\(e => \{ if \(alive\) setFloor\(\{ data: null, error: e\?\.message \|\| String\(e\) \}\) \}\)/g) || []).length).toBe(1)
    expect(src).not.toMatch(/\.catch\(\(\) => \{\s*\}\)/)
  })
  it('is rendered on Tune beside DivergenceCard', () => {
    const tune = readFileSync(new URL('../pages/Tune.jsx', import.meta.url), 'utf8')
    expect(tune).toContain("import EvidenceRows from '../components/EvidenceRows.jsx'")
    expect(tune).toContain('<EvidenceRows />')
  })
})
