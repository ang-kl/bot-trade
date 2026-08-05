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
//                                      i.e. body + 2. This was first read as
//                                      "+1pt ⇒ body + 3" and that over-read a
//                                      single element into a whole ladder.
//   "the text font size is to big" (05-08 pm) → shown the measurements, the
//                                      owner chose HEADINGS ONLY, and the
//                                      ladder became +1 / +2 / +3. The +1pt is
//                                      SET ASIDE, not relocated — --fs-h on
//                                      touch (11.5px) is below the 11px
//                                      reference plus a point.
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
const TOUCH = { '--fs-body': 9.5, '--fs-head': 10.5, '--fs-h': 11.5, '--fs-title': 12.5 }
const DESK = { '--fs-body': 11, '--fs-head': 12, '--fs-h': 13, '--fs-title': 14 }
const DESK_MIN_WIDTH = 1280

// THERE IS NO EXCEPTION TABLE ANY MORE (owner 05-08-2026: "fix C1").
//
// There used to be one: six files with a list of allowed px literals — tab-bar
// icons, × close marks, the wordmark, the FABs, the phone BUY/SELL/CLOSE
// buttons. It was honest about WHY each was excluded, but an exception list is
// a list of things nobody owns, and it only ever grows.
//
// Split by what the thing actually is instead:
//   · the phone action-button LABELS were text, and text belongs on the canon
//     → --fs-h. Their boxes (py-2.5, w-full) are untouched: the tap target has
//     nothing to do with the type scale.
//   · the icons and the wordmark are not text → --fs-glyph-* / --fs-wordmark,
//     flat across both tiers. They must NOT ride --fs-body, because an icon
//     that resized with the type tier would change its own tap target.
//
// So the rule below is now absolute: no px literal, anywhere, in any file.
const GLYPH_TOKENS = ['--fs-glyph-sm', '--fs-glyph-md', '--fs-glyph-lg', '--fs-glyph-xl', '--fs-wordmark']

// A COMMENT MUST NOT BE ABLE TO SATISFY THIS GUARD. Two ways the old
// `block.match(/NAME:\s*([\d.]+)px/)` could be fooled, in a file where most
// lines are prose ABOUT sizes:
//
//   1. Write `--fs-h: 11.5px` in a comment above the declaration and change
//      the declaration to 12.5px. The first match wins, the test reads the
//      comment, the browser renders 12.5 — silent on the exact change the
//      guard exists to catch.
//   2. Declare a token twice. The cascade takes the LAST; an un-anchored
//      first match takes the FIRST. That is the same shadowing this file just
//      removed for --fs-body, which survived only because `1rem` is not `px`
//      and the regex skipped it by luck rather than by design.
//
// So: strip comments, and collect ALL declarations. One is the only correct
// count — zero and two are both reported, by `declsOf`'s own test below.
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const declsOf = (block, name) =>
  [...stripCssComments(block).matchAll(new RegExp(`${name}:\\s*([\\d.]+)px`, 'g'))].map(m => Number(m[1]))
const tokenIn = (block, name) => {
  const d = declsOf(block, name)
  return d.length === 1 ? d[0] : null
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

  it('each token is declared EXACTLY ONCE per tier, in code and not in prose', () => {
    // `tokenIn` returns null for a count other than one, so a duplicate would
    // already fail the per-token tests above — but with the message "expected
    // null to be 11.5", which sends the reader looking for a missing
    // declaration rather than a second one. This names it.
    for (const [block, tier, label] of [[root, TOUCH, ':root'], [desk, DESK, '@media 1280']]) {
      for (const name of Object.keys(tier)) {
        expect(declsOf(block, name).length, `${name} in ${label}`).toBe(1)
      }
    }
  })

  it('NOTHING is below the 9.5px floor in either tier', () => {
    for (const tier of [TOUCH, DESK]) {
      for (const px of Object.values(tier)) expect(px).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  it('both tiers keep the same ladder: head +1, heading +2, title +3', () => {
    // Was +1/+3/+4 until 05-08-2026. The owner said "the text font size is to
    // big"; measured, nothing exceeded the canon, so the canon itself was the
    // complaint — and shown the numbers they chose "Headings only". Body and
    // column heads are unchanged because 9.5/11 and 10.5/12 are the owner's
    // own figures and were never what read wrong.
    for (const tier of [TOUCH, DESK]) {
      expect(tier['--fs-head'] - tier['--fs-body']).toBe(1)
      expect(tier['--fs-h'] - tier['--fs-body']).toBe(2)
      expect(tier['--fs-title'] - tier['--fs-body']).toBe(3)
    }
  })

  it('BODY and column heads are untouched — they were never the complaint', () => {
    // Pinned separately from the ladder above so a future ladder change cannot
    // quietly drag the one number the owner stated twice ("9.5px will be ideal
    // as minimum" / "11 px for desktop") along with it.
    expect(TOUCH['--fs-body']).toBe(9.5)
    expect(DESK['--fs-body']).toBe(11)
    expect(TOUCH['--fs-head']).toBe(10.5)
    expect(DESK['--fs-head']).toBe(12)
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

  it('NO Tailwind text-[Npx] survives anywhere — no exceptions left', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
          bad.push(`${rel(f)}:${i + 1}  ${m[1]}px — ${line.trim().slice(0, 90)}`)
        }
      })
    }
    expect(bad, `Text → --fs-body/--fs-h/--fs-title. Icons → --fs-glyph-*:\n${bad.join('\n')}`).toEqual([])
  })

  it('every glyph token is declared, and flat across both tiers', () => {
    const desk = CSS.match(/@media \(min-width: 1280px\) \{([\s\S]*?)\n\}/)?.[1] || ''
    for (const t of GLYPH_TOKENS) {
      expect(CSS, `${t} is used but never declared`).toMatch(new RegExp(`${t}: *[\\d.]+px`))
      // An icon that grew with the desk tier would change its own tap target.
      expect(desk, `${t} must not be re-declared per tier`).not.toContain(t)
    }
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
  // desk is a lie in the source. It is gone entirely — --fs-d18 was the last
  // survivor and is now --fs-glyph-lg, named for what it is.
  it('the px-named --fs-dN scale is gone completely', () => {
    const bad = []
    for (const f of FILES) {
      stripComments(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(--fs-d\d+)/g)) bad.push(`${rel(f)}:${i + 1}  ${m[1]}`)
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

// ---------------------------------------------------------------------------
// THE COMMENT MUST NOT CONTRADICT THE CODE (05-08-2026)
//
// The automated reviewer on #658 caught this and it was a real defect: the
// ladder moved, the declarations moved, and the ASCII table in the comment
// twenty lines above them did not. A reader hits a numbered table asserting
// values the same block no longer declares — and in a file whose entire
// argument is "recorded so it is not re-derived by someone reading the
// original instruction", the stale table is the most authoritative-looking
// thing in it.
//
// The prose is deliberately not checked; prose that lags is a nuisance. A
// TABLE OF NUMBERS that lags is a trap, because it reads as the spec.
// ---------------------------------------------------------------------------

describe('the canon table in the CSS comment states what the CSS declares', () => {
  const row = (label) => {
    const m = CSS.match(new RegExp(`${label}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`))
    expect(m, `the "${label}" row is missing from the canon comment`).toBeTruthy()
    return m.slice(1).map(Number)
  }

  it('the touch row matches :root', () => {
    expect(row('tablet/iPhone')).toEqual(
      [TOUCH['--fs-body'], TOUCH['--fs-head'], TOUCH['--fs-h'], TOUCH['--fs-title']])
  })

  it('the desk row matches the 1280px block', () => {
    expect(row('desktop ≥1280')).toEqual(
      [DESK['--fs-body'], DESK['--fs-head'], DESK['--fs-h'], DESK['--fs-title']])
  })

  it('the "+1pt was set aside" argument still quotes the live --fs-h values', () => {
    // The one piece of PROSE in this file that is pinned. The rest is exempt on
    // purpose (prose that lags is a nuisance), but this paragraph's conclusion
    // — the +1pt was set aside, not relocated — is true only because the touch
    // --fs-h sits below the 11px reference plus a point. Move the tier and the
    // paragraph would go on arguing, confidently, for the opposite of what the
    // same file declares twenty lines below it.
    const touch = CSS.match(/the touch --fs-h is now ([\d.]+)px/)
    expect(touch, 'the touch --fs-h sentence is missing from the +1pt paragraph').toBeTruthy()
    expect(Number(touch[1])).toBe(TOUCH['--fs-h'])
    const deskH = CSS.match(/The desk --fs-h \(([\d.]+)px\)/)
    expect(deskH, 'the desk --fs-h sentence is missing from the +1pt paragraph').toBeTruthy()
    expect(Number(deskH[1])).toBe(DESK['--fs-h'])
    // And the argument itself: below the reference + a point on touch.
    expect(TOUCH['--fs-h']).toBeLessThan(12.3)
  })

  it('the offsets printed in the header match the offsets that exist', () => {
    const m = CSS.match(/body\s+\+(\d) head\s+\+(\d) heading\s+\+(\d) title/)
    expect(m, 'the offset header line is missing from the canon comment').toBeTruthy()
    const [head, heading, title] = m.slice(1).map(Number)
    expect(head).toBe(TOUCH['--fs-head'] - TOUCH['--fs-body'])
    expect(heading).toBe(TOUCH['--fs-h'] - TOUCH['--fs-body'])
    expect(title).toBe(TOUCH['--fs-title'] - TOUCH['--fs-body'])
  })
})

// ---------------------------------------------------------------------------
// NO SIZE ATTACHED TO A TYPE ROLE OUTSIDE THE CANON BLOCK (05-08-2026)
//
// Fourth attempt. The first three each failed differently and each failure is
// the argument for this one:
//
//   1. "no px 8-16 in any comment"        → twelve false positives. Unusable.
//   2. "no >=2 lines LEADING with a px"   → passed by luck; seven prose lines
//                                           already match and merely are not
//                                           adjacent. One reword = CI fails on
//                                           a contrast note.
//   3. "px + a verbatim role phrase"      → passed VACUOUSLY. `page titles`
//                                           defeats \bpage title\b on the
//                                           plural `s`; `column header` defeats
//                                           \bcolumn head\b on `er`; and a
//                                           block wrapping "header font size"
//                                           onto one line and "10px" onto
//                                           another is invisible to a
//                                           line-at-a-time scan.
//
// Silence is the worst of those failure modes. A misdirecting message gets
// investigated; a green test gets believed.
//
// So: scan whole COMMENT BLOCKS, not lines — wrapping is how these hide — and
// key on what a reader can actually ACT on. A block that names a type SELECTOR
// or TOKEN, or a role in any inflection, AND carries a px figure in the type
// range, is stating a size for a role. That belongs in one place.
// ---------------------------------------------------------------------------

describe('no size is attached to a type role outside the canon block', () => {
  it('only the canon block states what size a role is', () => {
    const lines = CSS.split('\n')
    const start = lines.findIndex(l => l.includes('TWO TIERS, ONE BREAKPOINT'))
    expect(start, 'the canon block banner is missing').toBeGreaterThan(-1)

    // Selectors and tokens cannot be defeated by inflection; the role list
    // takes suffixes because "page titles" and "column header" are the exact
    // forms that slipped through attempt 3. `ing` is in the group too —
    // "column heading" and "table heading" are the same word wearing the other
    // suffix, and `(?:er)?s?` alone could not consume them.
    const NAMES = /\.t-h[123]\b|\.t-heading\b|--fs-(?:body|head|h|title)\b/
    // …and BARE NOUNS. Inflection was one of two ways attempt 3 failed; the
    // other is the plain word, which is the commoner phrasing in this file:
    // "the canon's body size … 9px", "heading font size keep to 11px",
    // "raising the desk body size to 11px". A closed vocabulary of compound
    // phrases matched none of them. `body`/`heading` count only when the block
    // is talking about a SIZE or a FONT, which is what makes them a claim
    // rather than a word.
    const ROLE = /\b(?:page title|section head|column head|table head|data cell|body text|major head)(?:er|ing)?s?\b/i
    const BARE = /\b(?:body|headings?)\b[^.]{0,40}\b(?:size|font)\b|\b(?:size|font)\b[^.]{0,40}\b(?:body|headings?)\b/i
    // A RATIO ATTACHED TO A ROLE READS AS THE SPEC just as strongly as a px
    // figure does — "H1 = 1.6× body" is a ladder, stated in a different unit.
    const SIZE = /\b(\d{1,2}(?:\.\d)?)px\b/g
    const MULT = /\b\d(?:\.\d+)?\s*(?:×|x)\s*(?:body|\.t-body)/i

    // Gather /* ... */ comment blocks, flattened, with their start line.
    // Flattening is the point: these hide by WRAPPING, e.g. "header font size"
    // on one line and "10px" three lines later.
    const blocks = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('/*')) continue
      let text = lines[i]
      let k = i
      while (!lines[k].includes('*/') && k < lines.length - 1) { k++; text += ' ' + lines[k] }
      blocks.push({ at: i + 1, endAt: k + 1, text })
      i = k
    }

    const offenders = []
    for (const b of blocks) {
      // The canon block itself is where the numbers belong. `start` is
      // 0-indexed (findIndex); `at`/`endAt` are 1-indexed — so the banner's own
      // line number is start + 1, and the exemption must be exactly that wide.
      // Anything looser silently exempts the block above or below it.
      if (b.at <= start + 1 && b.endAt >= start + 1) continue
      // A block that ANNOUNCES ITSELF as history may quote superseded figures —
      // that is provenance, not a trap. The distinction the guard enforces is
      // "reads as current" vs "says it is past", which is the only distinction
      // a reader can act on. Marking is cheap and explicit; silence is not.
      //
      // DELIBERATELY CASE-SENSITIVE. Prose that merely uses the word — "these
      // were superseded by the 05-08 canon", index.css:686 — is not a marker;
      // it is a sentence, and exempting it would hand the escape hatch to every
      // block that mentions its own history in passing. The shout is the
      // signal. The failure message below names the convention so nobody has to
      // find it here.
      if (/\bSUPERSEDED\b|\bHISTORY —/.test(b.text)) continue
      // A DECLARATION'S OWN COMMENT MAY STATE ITS OWN VALUE. --fs-session sits
      // deliberately off the canon (the owner capped that one line at 10px by
      // name), and the comment directly above it is the only place that cap is
      // recorded. The rule this guard enforces is "one place per size", not
      // "no sizes outside the canon block" — and for an off-canon token the one
      // place IS its declaration. Recognised structurally, by the token being
      // declared on the next line or two, not by a marker anyone can type.
      const declaresOwn = lines.slice(b.endAt, b.endAt + 2)
        .some(l => /^\s*(--fs-[\w-]+):/.test(l) && b.text.includes(l.trim().split(':')[0]))
      if (declaresOwn) continue
      if (!NAMES.test(b.text) && !ROLE.test(b.text) && !BARE.test(b.text)) continue
      const sizes = [...b.text.matchAll(SIZE)].map(m => Number(m[1])).filter(n => n >= 8 && n <= 16)
      const ratio = MULT.test(b.text)
      if (!sizes.length && !ratio) continue
      const what = sizes.length ? `sizes ${[...new Set(sizes)].join('/')}px` : 'a ratio of body'
      offenders.push(`index.css:${b.at}  ${what} — ${b.text.trim().slice(0, 88)}`)
    }

    expect(offenders, `A size attached to a type role, outside the canon block. Sizes live in ONE place — strip the figure, or, if the block is genuinely a record of a past decision, open it with "HISTORY —" or the word SUPERSEDED in capitals (the check is case-sensitive: the shout is the marker, a passing mention is not):\n${offenders.join('\n\n')}`)
      .toEqual([])
  })
})
