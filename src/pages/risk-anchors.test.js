// vitest — every proposable risk setting must be reachable from its proposal row.
//
// Owner (2026-08-04): "Each row should have a small triangle to show where it
// is located below in this RISK page, hyperlink to change." A triangle that
// jumps nowhere is worse than no triangle: it promises a destination and
// silently fails, which is the same shape as the summary that claimed values
// it never read back.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { proposalStatus } from '../lib/risk-proposal-status.js'

const riskPage = readFileSync(new URL('./Risk.jsx', import.meta.url), 'utf8')
const reassessRaw = readFileSync(new URL('../components/RiskReassess.jsx', import.meta.url), 'utf8')
// COMMENTS STRIPPED for the negative assertions below. The first draft of this
// file asserted the old wording was gone and failed against the comments
// EXPLAINING that it was gone — the same "grep matched prose, not code" trap
// that put two innocent modules in a write-authority inventory earlier in this
// workstream. A negative assertion has to read what ships, not what documents.
const reassess = reassessRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const proposable = readFileSync(new URL('../../agent/services/risk-reassess.js', import.meta.url), 'utf8')

/** The keys the model is allowed to propose, read from the server's own list. */
function proposableKeys() {
  const body = proposable.slice(proposable.indexOf('export const PROPOSABLE'))
  return [...body.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map(m => m[1])
}

describe('risk page deep links', () => {
  it('reads a non-empty proposable list from the server module', () => {
    // If this regex ever stops matching, every assertion below would pass
    // vacuously — the failure mode that makes a coverage test worthless.
    expect(proposableKeys().length).toBeGreaterThan(5)
  })

  it('EVERY proposable setting has an anchored field on the page', () => {
    const anchored = new Set([...riskPage.matchAll(/anchor="([A-Za-z0-9_]+)"/g)].map(m => m[1]))
    const missing = proposableKeys().filter(k => !anchored.has(k))
    expect(missing).toEqual([])
  })

  it('the proposal row links by config key, not by label', () => {
    // A label can be reworded; the key is what the field registers under.
    expect(reassess).toMatch(/href=\{`#risk-\$\{p\.key\}`\}/)
    expect(reassess).toMatch(/jumpTo\(p\.key\)/)
  })

  it('the jump opens collapsed ancestors before scrolling', () => {
    // The fields live inside collapsibles. Scrolling to a zero-height element
    // looks exactly like a broken link.
    expect(reassess).toMatch(/DETAILS/)
    expect(reassess).toMatch(/scrollIntoView/)
  })
})

describe('the proposal table reads the live config back', () => {
  it('the Now column shows the LIVE value, not the frozen snapshot', () => {
    expect(reassess).toMatch(/show\(p\.key, live\[p\.key\], proposable\)/)
    // p.current is the value at ASSESSMENT time — a fact about the past, and
    // it must not sit under a heading that says "Now".
    expect(reassess).not.toMatch(/show\(p\.key, p\.current, proposable\)/)
  })

  it('the footer counts what still holds, not what was submitted', () => {
    expect(reassess).toMatch(/still hold/)
    expect(reassess).not.toMatch(/the settings below hold these values now/)
  })

  it('a superseded row says so rather than claiming APPLIED', () => {
    expect(reassess).toMatch(/superseded/)
    expect(reassess).toMatch(/changed since apply/)
  })
})

describe('proposalStatus', () => {
  it('separates holding from superseded', () => {
    expect(proposalStatus({ applied: true, proposed: 150, live: 150 })).toBe('holds')
    expect(proposalStatus({ applied: true, proposed: 150, live: 300 })).toBe('superseded')
    expect(proposalStatus({ applied: false, proposed: 150, live: 150 })).toBe('not_applied')
  })
})
