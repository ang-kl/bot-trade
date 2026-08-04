// npx vitest run src/components/config-proposals.test.jsx
//
// The point of this card is that a reader can CHECK it. So the tests are about
// what it shows, not that it renders: the arithmetic must be on screen, the
// two kinds of silence must stay distinguishable, and there must be no way to
// apply a change from here.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ConfigProposals, { Proposal, AccountBlock } from './ConfigProposals.jsx'
import { commandFor, pct, num } from '../lib/config-proposal-format.js'

const P = {
  rule: 'minRR_below_breakeven',
  setting: 'minRR',
  current: 1.5,
  proposed: 3.2,
  severity: 'danger',
  why: '34.4% win rate over 93 closed trades. At that rate a trade must average 1.91× its risk just to break even, and 3.20× to reach the 1.68 profit-factor target. minRR is 1.5. That is BELOW breakeven: the gate is approving trades that lose money in expectation.',
  expect: 'Fewer entries. Each one carries enough planned reward to survive this win rate.',
}

const ACCOUNT = {
  accountId: '46130058',
  sampleOk: true,
  skipped: null,
  econ: { trades: 93, winRate: 0.344, payoff: 1.71, profitFactor: 0.9 },
  proposals: [P],
}

describe('a proposal', () => {
  it('shows the change, the severity, and the arithmetic behind it', () => {
    const html = renderToStaticMarkup(<Proposal accountId="46130058" p={P} />)
    expect(html).toContain('minRR')
    expect(html).toContain('1.5')
    expect(html).toContain('3.2')
    expect(html).toContain('DANGER')
    // Without the derivation this is an instruction to obey or ignore.
    expect(html).toContain('break even')
    expect(html).toContain('BELOW breakeven')
    expect(html).toContain('Expect')
  })

  it('shows the command rather than offering a button', () => {
    // No Apply. A one-tap apply turns propose-only into an auto-adjusting
    // controller with a human as a rubber stamp.
    const html = renderToStaticMarkup(<Proposal accountId="46130058" p={P} />)
    expect(html).toContain('/actions/risk-config')
    expect(html.toLowerCase()).not.toContain('<button')
    expect(html.toLowerCase()).not.toContain('apply')
  })

  it('the command is valid JSON for the real route', () => {
    const cmd = commandFor('46130058', 'minRR', 3.2)
    const body = JSON.parse(cmd.slice(cmd.indexOf('{')))
    expect(body).toEqual({ accountId: '46130058', minRR: 3.2 })
    // Booleans must not arrive quoted — "false" is truthy on the far end.
    const b = commandFor('46130058', 'allowNegativeExpectancyOverride', false)
    expect(JSON.parse(b.slice(b.indexOf('{'))).allowNegativeExpectancyOverride).toBe(false)
  })
})

describe('the two kinds of silence stay apart', () => {
  it('a thin sample says so', () => {
    const html = renderToStaticMarkup(<AccountBlock a={{
      ...ACCOUNT, proposals: [], sampleOk: false,
      skipped: 'insufficient_sample: 10 closed trades with realised P&L in 30d, need 30',
    }} />)
    expect(html).toContain('No advice')
    expect(html).toContain('insufficient_sample')
  })

  it('a healthy account with nothing to change says THAT instead', () => {
    const html = renderToStaticMarkup(<AccountBlock a={{ ...ACCOUNT, proposals: [], skipped: null }} />)
    expect(html).toContain('Nothing to propose')
    expect(html).not.toContain('No advice')
  })
})

describe('formatters', () => {
  it('render unknowns as dashes rather than zeros', () => {
    expect(pct(null)).toBe('—')
    expect(num(null)).toBe('—')
    expect(num(NaN)).toBe('—')
    expect(pct(0.344)).toBe('34.4%')
    expect(num(1.7123)).toBe('1.71')
  })
})

describe('the card', () => {
  it('renders nothing without an agent rather than an error strip', () => {
    expect(renderToStaticMarkup(<ConfigProposals />)).toBe('')
  })
})
