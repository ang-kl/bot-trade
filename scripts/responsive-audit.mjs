// UI-7 responsive audit — render every page at tablet and phone widths and
// MEASURE, rather than eyeballing a screenshot.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/responsive-audit.mjs /risk,/tune,/desk
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
// The agent is unreachable from this sandbox and every fetch sits on a long
// timeout, which is what stalled the first audit run. Fail them instantly:
// this measures LAYOUT, and a page that only lays out correctly once data
// arrives is broken anyway.
await ctx.route('**', (route) =>
  route.request().url().includes('localhost:4173') ? route.continue() : route.abort())

for (const r of ROUTES) {
  for (const w of [1024, 820, 390]) {
    const p = await ctx.newPage()
    await p.setViewportSize({ width: w, height: 900 })
    await p.goto('http://localhost:4173' + r).catch(() => {})
    await p.waitForTimeout(700)
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
    })
    console.log(`${r} @${w} ov=${m.ov} touch<44=${m.small}/${m.total} minFont=${m.minPx}${m.wide.length ? ' WIDE: ' + m.wide.join(' | ') : ''}`)
    await p.close()
  }
}
await b.close()
