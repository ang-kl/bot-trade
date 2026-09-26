// vitest — pins the ScrollTrigger-batching wiring into Risk.jsx.
//
// armScrollReveal's own behaviour (exactly one refresh, after the whole
// batch is wired) is covered by src/lib/scroll-reveal.test.js. What that
// file cannot see is whether Risk.jsx actually CALLS it — CLAUDE.md failure
// mode #4: "a repair that nothing calls ... the call site is invisible from
// the module under test and a refactor drops it in silence." Risk.jsx is not
// rendered in tests (no data/context harness exists for it here), so this
// pins the wiring at the source level instead of leaving it unpinned.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Comments stripped before asserting, so a comment that merely DESCRIBES the
// wiring cannot substitute for the wiring itself (CLAUDE.md failure mode #2).
const raw = readFileSync(new URL('./Risk.jsx', import.meta.url), 'utf8')
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('Risk.jsx wires the PERF-1 scroll-reveal batching helper', () => {
  it('imports armScrollReveal from the shared helper', () => {
    expect(src).toMatch(/import\s*\{\s*armScrollReveal\s*\}\s*from\s*['"]\.\.\/lib\/scroll-reveal\.js['"]/)
  })

  it('calls armScrollReveal on the [data-risk-reveal] cards, guarded by window.ScrollTrigger', () => {
    expect(src).toMatch(/if\s*\(\s*window\.ScrollTrigger\s*\)\s*\{[^}]*armScrollReveal\([^)]*data-risk-reveal[^)]*\)/s)
  })

  it('does not still build the ScrollTrigger reveal tween inline (the pre-fix shape)', () => {
    // The old code called scrollTrigger-configured fromTo() directly inside a
    // forEach over [data-risk-reveal] — that per-element creation is exactly
    // what caused the refresh-per-insertion cost. It must be gone, not just
    // supplemented.
    expect(src).not.toMatch(/querySelectorAll\(['"]\[data-risk-reveal\]['"]\)\.forEach/)
  })
})
