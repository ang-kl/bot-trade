// UI render audit — render every page and MEASURE, rather than eyeballing a
// screenshot.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/responsive-audit.mjs /risk,/tune,/desk            # layout
//   node scripts/responsive-audit.mjs /performance --live          # + real agent
//
// THE --live PASS EXISTS BECAUSE ITS ABSENCE SHIPPED A BLANK APP. On
// 2026-07-29 a temporal-dead-zone error in Performance.jsx took down every
// route for several hours (#482 → fixed in #489). This script was run for
// that PR and reported clean, because it aborts every non-localhost request:
// with no agent, Performance returns early and never reaches the broken line.
// Tests, lint and build cannot see a render-time error either. A UI change is
// NOT verified until it has been rendered against a reachable agent, and a
// PAGE ERROR IS A FAILURE, not a footnote — so `err` is reported on every row
// and --live exits non-zero if any route throws.
//
// Reports per route x width:
//   ov        horizontal overflow in px (must be 0)
//   touch<44  interactive controls whose EFFECTIVE tap height is under the
//             44px HIG minimum — counting the ::after halo, not just the box
//   minFont   smallest font size actually painted
//   WIDE      the outermost elements sticking past the viewport edge
//
// NOTE: `NAV.flex.gap-1` is expected in the WIDE list at 390px. The tab strip
// is INSIDE a horizontally-scrolling region, so extending past the viewport
// is correct behaviour, not a bug. What was a bug — the theme button sitting
// off-screen because `ml-auto` resolves against scroll width — no longer
// appears there.
import { chromium } from 'playwright'
const ROUTES = process.argv[2].split(',')
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
// hasTouch is REQUIRED for `pointer: coarse` to match — without it the
// phone media query never applies and the audit would score the fix as a
// no-op while it works fine on a real phone.
const ctx = await b.newContext({ hasTouch: true })
// LAYOUT mode aborts every off-host request: each one otherwise sits on a
// long timeout, which stalled the first audit run, and layout must be right
// before data arrives anyway. LIVE mode lets them through, which is the only
// way to exercise the code paths that run once data is present.
const LIVE = process.argv.includes('--live')
const AGENT = process.env.AUDIT_AGENT_URL || 'https://sg-trade.up.railway.app'
if (!LIVE) {
  await ctx.route('**', (route) =>
    route.request().url().includes('localhost:4173') ? route.continue() : route.abort())
}
let failed = 0

for (const r of ROUTES) {
  // LIVE used to run only at 1024. That is precisely the blind spot that let a
  // DUPLICATED session strip ship to the owner's iPhone (2026-07-30): the
  // duplicate only exists below 700px AND only renders once data is present, so
  // the desktop-only live pass and the data-less phone pass each missed it from
  // opposite sides. Live now covers the same widths as layout mode.
  for (const w of (LIVE ? [1024, 820, 390] : [1024, 820, 390])) {
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', e => errs.push(String(e.message).slice(0, 110)))
    await p.setViewportSize({ width: w, height: 900 })
    if (LIVE) {
      // Point the app at a real agent the way a browser would, then reload so
      // the pages fetch on mount.
      await p.goto('http://localhost:4173/').catch(() => {})
      await p.evaluate((u) => localStorage.setItem('agent_url', u), AGENT)
    }
    await p.goto('http://localhost:4173' + r).catch(() => {})
    await p.waitForTimeout(LIVE ? 8000 : 700)
    const m = await p.evaluate(() => {
      const de = document.documentElement, vw = de.clientWidth
      const wide = []
      for (const el of document.querySelectorAll('body *')) {
        const c = el.getBoundingClientRect()
        if (c.width > 0 && c.right > vw + 1 &&
            (!el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1)) {
          wide.push((el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.')).slice(0, 58))
        }
      }
      // DUPLICATE-RENDER CONTRACT. Any component that must appear at most once
      // per page carries data-once="<name>"; more than one VISIBLE element with
      // the same name is a bug. Visibility matters: a responsive pair where one
      // side is hidden is correct, two painted copies is the iPhone defect.
      // This is an explicit contract rather than a text-similarity heuristic —
      // table rows legitimately repeat, so a heuristic would be all noise.
      //
      // VISIBILITY IS NOT getBoundingClientRect HERE. The first version of this
      // check filtered on a non-zero rect and silently detected nothing — a
      // `display: contents` wrapper has NO box of its own, so its rect is
      // always 0x0 even while its children paint. Verified by restoring the
      // duplicate on purpose: the check reported clean. checkVisibility() is
      // the right question ("is this rendered, considering CSS"), with a
      // descendant-rect fallback for engines that lack it.
      // NOT checkVisibility(): Chromium returns FALSE for a `display: contents`
      // element because it generates no box of its own — even while its
      // children paint normally. Measured directly, both copies present and
      // one reported cv:false. Two wrong attempts here, both caught only by
      // deliberately restoring the duplicate and demanding the check fail:
      //   1. filter on a non-zero rect        → contents wrapper is 0x0
      //   2. gate on checkVisibility()        → contents wrapper is "invisible"
      // What "visible" actually means for this contract is "does this subtree
      // paint": display:none and visibility:hidden are definitive, everything
      // else asks the box, then the descendants.
      const isShown = (el) => {
        const st = getComputedStyle(el)
        if (st.display === 'none' || st.visibility === 'hidden') return false
        const own = el.getBoundingClientRect()
        if (own.width > 0 && own.height > 0) return true
        for (const d of el.querySelectorAll('*')) {
          const r3 = d.getBoundingClientRect()
          if (r3.width > 0 && r3.height > 0) return true
        }
        return false
      }
      const onceSeen = {}
      for (const el of document.querySelectorAll('[data-once]')) {
        if (!isShown(el)) continue
        const k = el.getAttribute('data-once')
        onceSeen[k] = (onceSeen[k] || 0) + 1
      }
      const dupes = Object.entries(onceSeen).filter(([, n]) => n > 1)
        .map(([k, n]) => `${k}x${n}`)

      // Effective TAP height = the visual box, or the ::after halo when one
      // is painted. Measuring only the box would score the fix as a no-op.
      let small = 0, total = 0
      for (const el of document.querySelectorAll('button,a[href],input,select')) {
        const c = el.getBoundingClientRect()
        if (!c.height) continue
        total++
        const after = getComputedStyle(el, '::after')
        const halo = after.content !== 'none' ? parseFloat(after.minHeight) || 0 : 0
        if (Math.max(c.height, halo) < 44) small++
      }
      let minPx = 99
      for (const el of document.querySelectorAll('body *')) {
        if (!el.textContent?.trim() || el.children.length) continue
        const f = parseFloat(getComputedStyle(el).fontSize)
        if (f > 0 && f < minPx) minPx = f
      }
      return { ov: de.scrollWidth - de.clientWidth, wide: [...new Set(wide)].slice(0, 3), small, total, minPx, dupes }
    }).catch(() => ({ ov: 0, wide: [], small: 0, total: 0, minPx: 0, dupes: [] }))
    // bodyLen is the blank-page canary: a crashed React tree still renders the
    // skip-link and nothing else, which is ~20 characters.
    const bodyLen = await p.evaluate(() => document.body.innerText.trim().length).catch(() => 0)
    // A duplicated singleton is a FAILURE, not a footnote — same rule the
    // page-error case already follows, and for the same reason: the owner
    // found it before the tooling did.
    const dupes = m.dupes || []
    // bodyLen is only meaningful in LIVE mode — layout mode aborts every
    // off-host request, so a data-driven page renders near-empty BY DESIGN and
    // failing on it would make the layout pass permanently red.
    if (errs.length || dupes.length || (LIVE && bodyLen < 200)) failed++
    console.log(`${r} @${w} ov=${m.ov} touch<44=${m.small}/${m.total} minFont=${m.minPx} bodyLen=${bodyLen}`
      + `${errs.length ? ' ERR: ' + errs[0] : ''}${dupes.length ? ' DUP: ' + dupes.join(',') : ''}`
      + `${m.wide.length ? ' WIDE: ' + m.wide.join(' | ') : ''}`)
    await p.close()
  }
}
await b.close()
// Duplicate renders and page errors fail in BOTH modes; the blank-page canary
// only means something in live mode (layout mode renders empty by design).
if (failed) {
  console.error(`\nFAILED: ${failed} route/width combination(s) threw, duplicated a singleton, or rendered blank.`)
  process.exit(1)
}
