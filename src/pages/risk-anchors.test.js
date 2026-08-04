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

// ---------------------------------------------------------------------------
// EVERY GRID KEY MUST HAVE SOMEWHERE TO LAND (owner, 04-08-2026, with a PDF:
// "Risk Setup Summary isnt wired … and coherent to the setups?").
//
// The summary table's VALUES were correct — measured against
// /state/risk-config on production, zero disagreements. What was not wired was
// the navigation: 29 of its 45 ▸ triangles pointed at an anchor that did not
// exist, and for 17 of those the reason was that the setting had no control
// anywhere in the UI at all. Every one is enforced on real entries.
//
// A link that goes nowhere is worse than no link: it tells the reader the
// setting is somewhere below and sends them looking. This test is the thing
// that would have caught it, and it is written against the SAME list the grid
// renders from, so a new group key cannot ship without a home.
// ---------------------------------------------------------------------------

describe('Risk Setup Summary deep links', () => {
  it('every key the summary table renders has an anchor on the page', async () => {
    const { RISK_GROUPS } = await import('../../agent/services/risk-matrix.js')
    const src = readFileSync(new URL('./Risk.jsx', import.meta.url), 'utf8')
    const anchors = new Set([
      ...[...src.matchAll(/anchor="([A-Za-z0-9_]+)"/g)].map(m => m[1]),
      // Booleans and free-text rows are not Fields, so they carry the id the
      // Field would have generated. Both forms are a valid landing place.
      ...[...src.matchAll(/id="risk-([A-Za-z0-9_]+)"/g)].map(m => m[1]),
    ])
    const missing = RISK_GROUPS.flatMap(g => g.keys).filter(k => !anchors.has(k))
    expect(missing, `these grid keys have no landing place: ${missing.join(', ')}`).toEqual([])
  })

  it('every key the OWNER has actually set is in a declared group', async () => {
    // ungroupedKeys() checks DEFAULT_RISK_CONFIG, which misses a key written
    // into an overlay but never given a default — `kellyFraction` was live on
    // production and invisible in the grid for exactly that reason. It turned
    // out to be RETIRED rather than merely ungrouped, so it is declared dead
    // instead of grouped; the case below keeps those two answers apart.
    const { RISK_GROUPS } = await import('../../agent/services/risk-matrix.js')
    const { DEFAULT_RISK_CONFIG } = await import('../../agent/services/risk.js')
    const grouped = new Set(RISK_GROUPS.flatMap(g => g.keys))
    const missing = Object.keys(DEFAULT_RISK_CONFIG).filter(k => !grouped.has(k))
    expect(missing, `ungrouped settings vanish from the table: ${missing.join(', ')}`).toEqual([])
  })

  it('a retired key is neither grouped nor given an editable control', async () => {
    // Both would be lies: a row implies the grid enforces it, a Field implies
    // editing it changes something. The grid reports retired keys separately.
    const { RISK_GROUPS, RETIRED_KEYS } = await import('../../agent/services/risk-matrix.js')
    const { DEFAULT_RISK_CONFIG } = await import('../../agent/services/risk.js')
    const grouped = new Set(RISK_GROUPS.flatMap(g => g.keys))
    const src = readFileSync(new URL('./Risk.jsx', import.meta.url), 'utf8')
    for (const key of Object.keys(RETIRED_KEYS)) {
      expect(grouped.has(key), `${key} is retired but still has a grid row`).toBe(false)
      expect(src.includes(`anchor="${key}"`), `${key} is retired but still editable`).toBe(false)
      // A retired key must also be genuinely gone from the engine's defaults —
      // otherwise it is still shipping to every account and is not retired.
      expect(DEFAULT_RISK_CONFIG, `${key} is retired but still a default`).not.toHaveProperty(key)
    }
  })
})
