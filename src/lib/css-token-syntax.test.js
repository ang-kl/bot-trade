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

  it('never writes text-[var(--…)], which compiles to color and drops font-size', () => {
    const hits = []
    for (const f of FILES) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        // Any bare custom property in `text-[…]` is ambiguous, not just the
        // --fs-* ones: a colour token happens to resolve the way you wanted by
        // luck, so the rule is the syntax, not the token name.
        if (/text-\[var\(--/.test(line)) {
          // --color-* is the one case where the accidental resolution IS the
          // intent (Tailwind picks color, and color is what was meant), and
          // hundreds of call sites use it. Allow it explicitly, so the guard
          // stays about the bug rather than becoming a mass rewrite.
          if (/text-\[var\(--color-/.test(line) && !/text-\[var\(--(?!color-)/.test(line)) return
          hits.push(`${f.replace(SRC, 'src/')}:${i + 1}  ${line.trim().slice(0, 120)}`)
        }
      })
    }
    expect(hits, `Use text-(length:--token) for font sizes:\n${hits.join('\n')}`).toEqual([])
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
