// npx vitest run src/lib/type-canon.test.js
//
// THE TYPE CANON, enforced against the source.
//
// Owner, 05-08-2026, by screenshot rather than by number:
//   "i like the all body font size to be the same as the picture text
//    '7d', '30d'"                    → Segmented `md`  →  9px
//   "i like the header's font size to be same as the picture header text
//    'Strategy Liveness table' but increase by 1pt."
//                                    → .t-h3 (11px)    → 12px
//
// Both reference elements were read out of the source before anything moved
// (Segmented.jsx and StrategyLivenessCard.jsx:160), so the canon is measured
// from what the owner was actually looking at, not from what a size "should"
// be. The two ARE_THE_REFERENCE tests below pin those two elements, because
// if either drifts the whole canon silently means something else.
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

// ---------------------------------------------------------------------------
// The canon. Three sizes and nothing else.
const BODY = 9
const HEADING = 12
const PAGE_TITLE = 13

// The deliberate exceptions, each with the reason it is not body text. An
// exception is keyed by file + the exact size, so adding a fourth 16px thing
// somewhere new still fails — the escape hatch does not widen on its own.
//
// Every entry here is a GLYPH (an icon or a wordmark drawn with the font) or a
// full-width phone action button whose tap target is the point. None of them
// is text a reader reads at body size.
const EXCEPT = {
  'src/components/MobileTabBar.jsx': [14, 16],        // tab bar icons + ⋯ glyph
  'src/components/TradeChronograph.jsx': [16],        // × close glyph
  'src/App.jsx': [13, 14, 15],                        // "bot-trade" wordmark; sidebar icons
  'src/pages/Trade.jsx': [22],                        // + floating action button glyph
  'src/components/OrderManager.jsx': [14, 15],        // phone BUY/SELL + CLOSE buttons
  'src/components/PositionManager.jsx': [14, 15],     // same
}

describe('the two reference elements the canon is measured from', () => {
  it('Segmented md is still the body size — it IS the picture\'s "7d"', () => {
    const src = readFileSync(join(SRC, 'components/common/Segmented.jsx'), 'utf8')
    expect(src).toMatch(new RegExp(`px-2\\.5 text-\\[${BODY}px\\]`))
  })

  it('the Strategy Liveness heading is still .t-h3 — it IS the picture\'s header', () => {
    const src = readFileSync(join(SRC, 'components/StrategyLivenessCard.jsx'), 'utf8')
    expect(src).toMatch(/<h3 className="t-h3">Strategy Liveness table<\/h3>/)
  })

  it('index.css sets the three canon sizes and no other heading size', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    expect(css).toMatch(new RegExp(`\\.t-h1, \\.t-heading \\{ font-size: ${PAGE_TITLE}px`))
    expect(css).toMatch(new RegExp(`\\.t-h2\\s+\\{ font-size: ${HEADING}px`))
    expect(css).toMatch(new RegExp(`\\.t-h3\\s+\\{ font-size: ${HEADING}px`))
    for (const k of ['t-body', 't-label', 't-sub', 't-meta']) {
      expect(css).toMatch(new RegExp(`\\.${k}\\s+\\{ font-size: ${BODY}px`))
    }
  })
})

describe('no font size outside the canon', () => {
  it('has files to scan (a silent empty scan would pass forever)', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  const allowed = (file, px) =>
    px === BODY || px === HEADING || px === PAGE_TITLE ||
    (EXCEPT[rel(file)] || []).includes(px)

  it('every Tailwind text-[Npx] is 9, 12 or 13 — or a listed glyph', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          const px = Number(m[1])
          if (!allowed(f, px)) bad.push(`${rel(f)}:${i + 1}  ${px}px — ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(bad, `Body is ${BODY}px, headings ${HEADING}px, page titles ${PAGE_TITLE}px:\n${bad.join('\n')}`).toEqual([])
  })

  it('every inline fontSize is a --fs-d token, never a raw px literal', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/fontSize: *'(\d+(?:\.\d+)?)px'/g)) {
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}px — a literal, not a token`)
        }
      })
    }
    expect(bad, `Use var(--fs-d9) / var(--fs-d12):\n${bad.join('\n')}`).toEqual([])
  })

  // The --fs-dN tokens are named for their pixel value, so the token NAME is
  // the size and a scan of names is a scan of sizes. d18 is the ☰ FAB glyph.
  it('every --fs-dN token in use is d9, d12 or a listed glyph size', () => {
    const bad = []
    const OK_TOKENS = new Set(['--fs-d9', '--fs-d12'])
    const GLYPH_TOKENS = { 'src/components/common/SectionNavFab.jsx': ['--fs-d18'] }
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(--fs-d\d+)/g)) {
          if (OK_TOKENS.has(m[1])) continue
          if ((GLYPH_TOKENS[rel(f)] || []).includes(m[1])) continue
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}`)
        }
      })
    }
    expect(bad, `Only --fs-d9 (body) and --fs-d12 (heading) are in the canon:\n${bad.join('\n')}`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Contrast. Owner, same message: "it has to be darker font colour during light
// mode and light-brighter in dark mode."
//
// The ratios are computed against the surface the app ACTUALLY paints — the
// card is rgba(255,255,255,.62) over --color-bg, not --color-bg itself — so a
// token that passes here passes on screen. Text this small is never "large
// text" under WCAG, so 4.5:1 is the floor for every one of them, including the
// muted greys that used to sit near 2.5:1 and were effectively invisible.
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
  const css = readFileSync(join(SRC, 'index.css'), 'utf8')

  for (const [selector, s] of Object.entries(SURFACES)) {
    const block = css.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1]
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
