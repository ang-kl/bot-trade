// npx vitest run src/lib/type-canon.test.js
//
// THE TYPE CANON, enforced against the source.
//
// Owner, 05-08-2026, across four messages:
//   "i like the all body font size to be the same as the picture text
//    '7d', '30d'"                    → Segmented `md` → the BODY size
//   "i like the header's font size to be same as the picture header text
//    'Strategy Liveness table' but increase by 1pt."
//                                    → .t-h3 was 11px against a 9px body,
//                                      i.e. body + 2, so +1pt makes it body + 3
//   "please canonical for tablet and iphones"
//   "9.5px will be ideal as minimum" / "11 px for desktop"
//
// Both original reference elements were read out of the source before anything
// moved (Segmented.jsx and StrategyLivenessCard.jsx:160), so the canon is
// measured from what the owner was actually looking at, not from what a size
// "should" be. The reference tests below pin those two elements, because if
// either drifts the whole canon silently means something else.
//
// TWO TIERS, ONE BREAKPOINT. Tablet and iPhone share a tier: both are held
// devices whose constraint is fitting a dense table on a narrow screen. The
// desk is a fixed screen with room to spare. That is why desktop is LARGER
// than phone here and not the reverse.
//
// WHY A SOURCE SCAN. The last font audit (docs/ui-audit-2026-07-30.md) claimed
// a scale had been adopted while no call site ever received a size from it —
// see css-token-syntax.test.js. A claim in a doc is not a guarantee; a test
// that reads every file is. This one names the file and line of any new size.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('..', import.meta.url).pathname
const SELF = new URL(import.meta.url).pathname

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(jsx?|tsx?)$/.test(name)) out.push(p)
  }
  return out
}
const FILES = walk(SRC).filter(f => f !== SELF && !/\.test\.jsx?$/.test(f))

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')

const rel = (f) => f.replace(SRC, 'src/')
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8')

// ---------------------------------------------------------------------------
// The canon: four tokens, two tiers. The FLOOR is the owner's stated minimum.
const FLOOR = 9.5
const TOUCH = { '--fs-body': 9.5, '--fs-head': 10.5, '--fs-h': 12.5, '--fs-title': 13.5 }
const DESK = { '--fs-body': 11, '--fs-head': 12, '--fs-h': 14, '--fs-title': 15 }
const DESK_MIN_WIDTH = 1280

// The deliberate exceptions, each with the reason it is not body text. An
// exception is keyed by file + the exact size, so adding a fourth 16px thing
// somewhere new still fails — the escape hatch does not widen on its own.
//
// Every entry is a GLYPH (an icon or a wordmark drawn with the font) or a
// full-width phone action button whose tap target is the point. None of them
// is text a reader reads at body size, and none should breathe with the type
// tier: an icon that resized with the body would change the tap target, which
// is the one thing about it that must not move.
const EXCEPT = {
  'src/components/MobileTabBar.jsx': [14, 16],        // tab bar icons + ⋯ glyph
  'src/components/TradeChronograph.jsx': [16],        // × close glyph
  'src/App.jsx': [13, 14, 15],                        // "bot-trade" wordmark; sidebar icons
  'src/pages/Trade.jsx': [22],                        // + floating action button glyph
  'src/components/OrderManager.jsx': [14, 15],        // phone BUY/SELL + CLOSE buttons
  'src/components/PositionManager.jsx': [14, 15],     // same
}

const tokenIn = (block, name) => {
  const m = block.match(new RegExp(`${name}:\\s*([\\d.]+)px`))
  return m ? Number(m[1]) : null
}

describe('the reference elements the canon is measured from', () => {
  it('Segmented md carries the body token — it IS the picture\'s "7d"', () => {
    const src = readFileSync(join(SRC, 'components/common/Segmented.jsx'), 'utf8')
    expect(src).toMatch(/px-2\.5 text-\(length:--fs-body\)/)
  })

  it('the Strategy Liveness heading is still .t-h3 — it IS the picture\'s header', () => {
    const src = readFileSync(join(SRC, 'components/StrategyLivenessCard.jsx'), 'utf8')
    expect(src).toMatch(/<h3 className="t-h3">Strategy Liveness table<\/h3>/)
  })

  it('the type classes read the tokens, never a literal', () => {
    expect(CSS).toMatch(/\.t-h1, \.t-heading \{ font-size: var\(--fs-title\)/)
    expect(CSS).toMatch(/\.t-h2\s+\{ font-size: var\(--fs-h\)/)
    expect(CSS).toMatch(/\.t-h3\s+\{ font-size: var\(--fs-h\)/)
    for (const k of ['t-body', 't-label', 't-sub', 't-meta']) {
      expect(CSS).toMatch(new RegExp(`\\.${k}\\s+\\{ font-size: var\\(--fs-body\\)`))
    }
    expect(CSS).toMatch(/tbody td \{\n\s+font-size: var\(--fs-body\)/)
  })
})

describe('the two tiers', () => {
  // :root is the TOUCH tier — tablet and iPhone are the base, the desk is the
  // override. Written that way round on purpose: the smaller, more constrained
  // device is what the layout has to survive, so it is what the file states
  // first and what a missing media query falls back to.
  const root = CSS.match(/:root \{([\s\S]*?)\n\}/)[1]
  const desk = CSS.match(/@media \(min-width: 1280px\) \{([\s\S]*?)\n\}/)?.[1] || ''

  it('the desk tier is declared at the same 1280px boundary the layout uses', () => {
    expect(CSS).toMatch(new RegExp(`@media \\(min-width: ${DESK_MIN_WIDTH}px\\)`))
  })

  for (const [name, px] of Object.entries(TOUCH)) {
    it(`tablet/iPhone ${name} is ${px}px`, () => expect(tokenIn(root, name)).toBe(px))
  }
  for (const [name, px] of Object.entries(DESK)) {
    it(`desktop ${name} is ${px}px`, () => expect(tokenIn(desk, name)).toBe(px))
  }

  it('NOTHING is below the 9.5px floor in either tier', () => {
    for (const tier of [TOUCH, DESK]) {
      for (const px of Object.values(tier)) expect(px).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  it('both tiers keep the same ladder: head +1, heading +3, title +4', () => {
    for (const tier of [TOUCH, DESK]) {
      expect(tier['--fs-head'] - tier['--fs-body']).toBe(1)
      expect(tier['--fs-h'] - tier['--fs-body']).toBe(3)
      expect(tier['--fs-title'] - tier['--fs-body']).toBe(4)
    }
  })

  it('the desk tier is the larger one — a phone is not a small desktop', () => {
    expect(DESK['--fs-body']).toBeGreaterThan(TOUCH['--fs-body'])
  })

  it('form fields ride the ladder rather than pinning their own 10px', () => {
    expect(CSS).toMatch(/--font-field-max: var\(--fs-head\)/)
  })
})

describe('no font size outside the canon', () => {
  it('has files to scan (a silent empty scan would pass forever)', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('no Tailwind text-[Npx] survives outside the listed glyphs', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          if ((EXCEPT[rel(f)] || []).includes(Number(m[1]))) continue
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}px — ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(bad, `Use text-(length:--fs-body) / --fs-h / --fs-title:\n${bad.join('\n')}`).toEqual([])
  })

  it('every inline fontSize is a token, never a raw px literal', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/fontSize: *'(\d+(?:\.\d+)?)px'/g)) {
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}px — a literal, not a token`)
        }
      })
    }
    expect(bad, `Use var(--fs-body) / var(--fs-h):\n${bad.join('\n')}`).toEqual([])
  })

  // The old --fs-dN scale was named for pixel values, which is exactly what a
  // responsive canon cannot have: a token called d9 that renders 11px on a
  // desk is a lie in the source. Only --fs-d18 survives, and only because it
  // is the ☰ FAB glyph, which does not move with the type tier.
  it('the px-named --fs-dN scale is gone except the one glyph size', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(--fs-d\d+)/g)) {
          if (m[1] === '--fs-d18' && rel(f) === 'src/components/common/SectionNavFab.jsx') continue
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}`)
        }
      })
    }
    expect(bad, `Semantic tokens only — --fs-body / --fs-head / --fs-h / --fs-title:\n${bad.join('\n')}`).toEqual([])
  })
})

describe('a wide column rescales instead of the table', () => {
  // Owner, 05-08-2026: "please rescale the column to scrollable within table
  // cell or word wrap." Raising the desk body to 11px widens every column, and
  // the previous answer — nowrap heads plus a horizontal page scroll — stops
  // being honest once the table is wider than the screen by more than a nudge.
  it('table heads wrap rather than forcing the column wider', () => {
    const head = CSS.match(/thead th \{([\s\S]*?)\n\}/)[1]
    expect(head).toMatch(/white-space: normal/)
    expect(head).toMatch(/overflow-wrap: anywhere/)
    expect(head).not.toMatch(/white-space: nowrap/)
  })

  it('grid heads wrap too, and no longer ellipsise the label away', () => {
    const gh = CSS.match(/\.t-gridhead > \* \{([\s\S]*?)\n\}/)[1]
    expect(gh).toMatch(/white-space: normal/)
    expect(gh).not.toMatch(/text-overflow: ellipsis/)
  })

  it('data cells break an unbreakable run instead of stretching', () => {
    const td = CSS.match(/tbody td \{([\s\S]*?)\n\}/)[1]
    expect(td).toMatch(/overflow-wrap: anywhere/)
    // NOT white-space: this rule is unlayered and would beat the
    // `whitespace-nowrap` that keeps prices and timestamps on one line.
    expect(td).not.toMatch(/white-space:/)
  })

  it('.cell-scroll exists for the cells that must stay on one line', () => {
    expect(CSS).toMatch(/\.cell-scroll \{[\s\S]*?overflow-x: auto[\s\S]*?white-space: nowrap/)
  })
})

// ---------------------------------------------------------------------------
// Contrast. Owner: "darker font colour during light mode and light-brighter in
// dark mode."
//
// The ratios are computed against the surface the app ACTUALLY paints — the
// card is rgba(255,255,255,.62) over --color-bg, not --color-bg itself — so a
// token that passes here passes on screen. Even 11px is never "large text"
// under WCAG, so 4.5:1 is the floor for every one of them, including the muted
// greys that used to sit near 2.5:1 and were effectively invisible.
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255] }
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a, b) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
  return (hi + 0.05) / (lo + 0.05)
}
const composite = (fg, alpha, bg) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)))

const SURFACES = {
  ':root': { bg: '#eef1fb', panel: [[255, 255, 255], 0.62] },
  '\\[data-theme="dark"\\]': { bg: '#060913', panel: [[20, 26, 48], 0.55] },
  '\\[data-theme="sepia"\\]': { bg: '#f0e9d8', panel: [[252, 248, 238], 0.6] },
}
const TEXT_TOKENS = ['--color-text', '--color-text-sub', '--color-muted', '--color-muted-light']

describe('text tokens clear 4.5:1 on the card each theme paints', () => {
  for (const [selector, s] of Object.entries(SURFACES)) {
    const block = CSS.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1]
    it(`${selector.replace(/\\/g, '')} — block exists`, () => expect(block).toBeTruthy())

    for (const token of TEXT_TOKENS) {
      it(`${selector.replace(/\\/g, '')} ${token}`, () => {
        const value = block.match(new RegExp(`${token}: *(#[0-9a-f]{6})`, 'i'))?.[1]
        expect(value, `${token} not found in ${selector}`).toBeTruthy()
        const card = composite(s.panel[0], s.panel[1], hex(s.bg))
        expect(contrast(hex(value), card)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
