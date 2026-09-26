import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { reassessApplyConfirmText, proposalStatus } from './risk-proposal-status.js'

// SAFE-0b (owner OD-14, 26-09-2026): Re-Risk's Apply writes the GLOBAL risk
// settings; its confirm names every key it will change. The agent refuses a
// stale or other-account proposal on its own (agent/routes/risk-reassess-apply.test.js).
const last = {
  at: '2026-09-25T10:00:00.000Z', accountId: '46979908',
  proposals: [
    { key: 'maxOpenPositions', label: 'Max open positions', proposed: 4 },
    { key: 'dailyLossLimit', label: 'Daily loss limit', proposed: 200 },
    { key: 'minRR', label: 'Min R:R', proposed: 1.8 },
  ],
}

describe('reassessApplyConfirmText — SAFE-0b', () => {
  it('names each selected key (label and config key) with its live → proposed values, and only those', () => {
    const text = reassessApplyConfirmText({ keys: ['maxOpenPositions', 'dailyLossLimit'], last, live: { maxOpenPositions: 5, dailyLossLimit: 300, minRR: 1.5 } })
    expect(text).toBe([
      'Apply 2 settings to the GLOBAL risk settings?',
      '• Max open positions (maxOpenPositions): 5 → 4',
      '• Daily loss limit (dailyLossLimit): 300 → 200',
      'proposal made 2026-09-25T10:00:00.000Z for account 46979908',
    ].join('\n'))
    expect(text).not.toContain('minRR')
  })
  it('uses the caller\'s formatter and falls back to the key when a proposal row is missing', () => {
    const text = reassessApplyConfirmText({ keys: ['minRR', 'ghost'], last, live: { minRR: 1.5 }, format: (k, v) => `<${k}:${v}>` })
    expect(text).toContain('• Min R:R (minRR): <minRR:1.5> → <minRR:1.8>')
    expect(text).toContain('• ghost (ghost): <ghost:undefined> → <ghost:undefined>')
    expect(text.startsWith('Apply 2 settings')).toBe(true)
  })
  it('singular for one key; an unknown account and time are said, not invented', () => {
    const text = reassessApplyConfirmText({ keys: ['minRR'], last: { proposals: last.proposals } })
    expect(text.split('\n')[0]).toBe('Apply 1 setting to the GLOBAL risk settings?')
    expect(text).toContain('proposal made at an unknown time for account unknown')
  })
  it('proposalStatus is unchanged', () => {
    expect(proposalStatus({ applied: false })).toBe('not_applied')
    expect(proposalStatus({ applied: true, proposed: 4, live: 4 })).toBe('holds')
    expect(proposalStatus({ applied: true, proposed: 4, live: 5 })).toBe('superseded')
  })
})

describe('RiskReassess.jsx wiring — SAFE-0b', () => {
  // A source read is the last resort (CLAUDE.md #2): the Apply handler runs
  // only on a click, and this suite has no DOM. Comments are stripped first so
  // the explanation cannot satisfy the assertion.
  const src = readFileSync(new URL('../components/RiskReassess.jsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const applyBody = src.slice(src.indexOf('const apply = async'), src.indexOf('const toggle ='))
  it('asks window.confirm with the key-naming text before posting, and stops on cancel', () => {
    // Fix round (checker blocker 2, 26-09-2026): the prefix alone could not
    // fail on the cancel claim — `)))) return` → `)))) void 0` let Cancel fall
    // through to the POST with this test green. The bare `return` that ends
    // the statement is asserted now; the behaviour itself is exercised on the
    // rendered component in src/components/risk-reassess-apply.test.jsx.
    expect(applyBody).toMatch(/^\s*if \(!window\.confirm\(reassessApplyConfirmText\(\{ keys, last, live,[^\n]*\}\)\)\) return$/m)
    expect(applyBody.indexOf('window.confirm(')).toBeLessThan(applyBody.indexOf("agentPost('/actions/risk-reassess-apply'"))
    expect(applyBody.match(/agentPost\(/g)).toHaveLength(1)
  })
})
