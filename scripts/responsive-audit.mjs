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
  for (const w of (LIVE ? [1024] : [1024, 820, 390])) {
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
      return { ov: de.scrollWidth - de.clientWidth, wide: [...new Set(wide)].slice(0, 3), small, total, minPx }
    }).catch(() => ({ ov: 0, wide: [], small: 0, total: 0, minPx: 0 }))
    // bodyLen is the blank-page canary: a crashed React tree still renders the
    // skip-link and nothing else, which is ~20 characters.
    const bodyLen = await p.evaluate(() => document.body.innerText.trim().length).catch(() => 0)
    if (errs.length || bodyLen < 200) failed++
    console.log(`${r} @${w} ov=${m.ov} touch<44=${m.small}/${m.total} minFont=${m.minPx} bodyLen=${bodyLen}`
      + `${errs.length ? ' ERR: ' + errs[0] : ''}${m.wide.length ? ' WIDE: ' + m.wide.join(' | ') : ''}`)
    await p.close()
  }
}
await b.close()
if (LIVE && failed) {
  console.error(`\nFAILED: ${failed} route/width combination(s) threw or rendered blank.`)
  process.exit(1)
}
