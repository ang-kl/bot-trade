// npx vitest run src/lib/css-token-syntax.test.js
//
// THE REGRESSION THIS EXISTS TO CATCH — it shipped, and the owner saw it.
//
// In Tailwind v4 the `text-*` utility is ambiguous: it sets EITHER font-size
// or color. Given `text-[var(--fs-caption)]` the compiler cannot tell which is
// meant from a bare custom property, and it resolves to **color**. So the
// class silently produced
//
//     color: var(--fs-caption)      /* i.e. color: 0.6875rem — invalid */
//
// and NO font-size at all. Two failures at once: the element inherited the
// body font size (which is how a page footer came to render its build stamp at
// heading size, overlapping the strategy table), and its colour declaration
// was invalid-at-computed-value so the intended muted grey was lost too.
//
// The whole "rem type scale adopted" claim in docs/ui-audit-2026-07-30.md was
// wrong for this reason: the tokens existed in :root but no call site ever
// received a font-size from them. The correct v4 syntax is explicit:
//
//     text-(length:--fs-caption)    →  font-size: var(--fs-caption)
//
// A source scan is the right shape of guard here rather than a DOM test: it is
// deterministic, needs no browser, and names the exact file and line.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('..', import.meta.url).pathname

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(p)
  }
  return out
}

// This file quotes the broken pattern in its own comments so the next reader
// knows what to look for — so it must not scan itself.
const SELF = new URL(import.meta.url).pathname
const FILES = walk(SRC).filter(f => f !== SELF)

// Comments must be stripped before scanning. Explaining the bug is exactly how
// the next person avoids reintroducing it, so a guard that punishes writing it
// down pushes the explanation out of the codebase — which is the opposite of
// what it is for. Only real class strings are policed.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))    // line comments (incl. JSX `// …` inside {/* */} already gone)
    .join('\n')
}

describe('font-size design tokens use the unambiguous Tailwind v4 syntax', () => {
  it('has files to scan (a silent empty scan would pass forever)', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  // Tailwind resolves an ambiguous `text-[var(--x)]` to COLOR. For a token that
  // IS a colour that is the intended outcome, and hundreds of call sites rely
  // on it — so the guard has to judge the TOKEN, not the line. A token counts
  // as a colour when its name says so; anything else (a length, a duration, a
  // shadow) is a latent version of the --fs-* bug and must be explicit.
  // --md-* are the M3 tonal tokens (owner task 02-08-2026); every one that a
  // text- utility consumes (on-surface, on-*-container, error…) is a colour.
  const isColourToken = (name) => /^--color-/.test(name) || /^--md-/.test(name)
    || /-(text|bg|border|fg|background)$/.test(name)

  it('never writes text-[var(--…)] for anything that is not a colour token', () => {
    const hits = []
    for (const f of FILES) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/text-\[var\((--[\w-]+)/g)) {
          if (isColourToken(m[1])) continue
          hits.push(`${f.replace(SRC, 'src/')}:${i + 1}  ${m[1]} — ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(hits, `Use text-(length:--token) for non-colour tokens:\n${hits.join('\n')}`).toEqual([])
  })

  it('the --fs-* scale is only ever consumed as a length', () => {
    const bad = []
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, 'utf8'))
      // font-size tokens reached through any other Tailwind arbitrary form.
      for (const m of src.matchAll(/text-\[[^\]]*--fs-[^\]]*\]/g)) {
        bad.push(`${f.replace(SRC, 'src/')}  ${m[0]}`)
      }
    }
    expect(bad, `--fs-* must be used as text-(length:--fs-…):\n${bad.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// THE SECOND CASCADE TRAP, same root cause as the first: unlayered CSS in
// index.css outranks ALL of Tailwind's layered utilities.
//
// `.glass-panel` sets `position: relative` for its ::before sheen. So
// `class="glass-panel absolute"` silently computes to `relative`. Measured
// consequences, both shipped: Tune's timeframe dropdown stayed in flow as a
// 210px flex item and shoved the chip row onto another line (the layout jump in
// the owner's screenshot), and the session popover positioned against the
// sidebar instead of the viewport (left: -159px, off-screen).
//
// The fix is the `.glass-panel.pos-absolute` / `.pos-fixed` pair. This guard
// makes sure nobody writes `glass-panel absolute` without it again — a source
// scan, because the failure is invisible in the markup and only shows up as a
// layout bug on a page that arms real money.
describe('glass-panel never relies on a Tailwind position utility alone', () => {
  it('declares the override pair, after .glass-panel', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8')
    expect(css).toMatch(/\.glass-panel\.pos-absolute\s*\{\s*position:\s*absolute/)
    expect(css).toMatch(/\.glass-panel\.pos-fixed\s*\{\s*position:\s*fixed/)
    // Order matters for the specificity tie-break to land the right way.
    expect(css.indexOf('.glass-panel.pos-absolute')).toBeGreaterThan(
      css.search(/^\.glass-panel \{/m))
  })

  it('every glass-panel + absolute/fixed call site carries pos-*', () => {
    const bad = []
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, 'utf8'))
      // Each className string that mentions glass-panel at all.
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] || m[2] || ''
        if (!/\bglass-panel\b/.test(cls)) continue
        const wantsAbsolute = /(^|\s)absolute(\s|$)/.test(cls)
        const wantsFixed = /(^|\s)fixed(\s|$)/.test(cls)
        if (wantsAbsolute && !/\bpos-absolute\b/.test(cls)) {
          bad.push(`${f.replace(SRC, 'src/')}  needs pos-absolute:  ${cls.slice(0, 90)}`)
        }
        if (wantsFixed && !/\bpos-fixed\b/.test(cls)) {
          bad.push(`${f.replace(SRC, 'src/')}  needs pos-fixed:  ${cls.slice(0, 90)}`)
        }
      }
    }
    expect(bad, `glass-panel's unlayered position:relative beats these:\n${bad.join('\n')}`).toEqual([])
  })
})
