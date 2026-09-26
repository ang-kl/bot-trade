// npx vitest run src/lib/index-html-scripts.test.js
//
// 18-09-2026: the owner saw a blank site. The page loaded two GSAP scripts
// from cdnjs with `defer`; deferred scripts execute in document order and
// the app's module script waits for them, so on a network where the CDN
// hangs the app never mounts (measured: blank >20 s with a hanging CDN,
// rendered in 1.5 s with a fast failure). The fonts were already
// self-hosted for the same reason. This pins the rule for scripts.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')

describe('index.html scripts', () => {
  it('loads every script from this origin — no third-party host can gate the app', () => {
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1])
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) expect(s, `script ${s} must be same-origin`).toMatch(/^\/(?!\/)/)
  })
  it('the self-hosted GSAP files exist where the page points', () => {
    for (const f of ['gsap.min.js', 'ScrollTrigger.min.js']) {
      expect(html).toContain(`/vendor/gsap/${f}`)
      expect(existsSync(resolve(__dirname, '../../public/vendor/gsap', f))).toBe(true)
    }
  })

  // PERF-1 (26-09 UI plan §13): the trace's console flagged a font preload
  // whose credentials mode did not match its @font-face fetch — a silent
  // double download. The fix is `crossorigin` on the preload; without it,
  // the preload is worse than no preload at all.
  it('the preloaded heading-weight font is same-origin, carries crossorigin, and exists on disk', () => {
    const m = html.match(/<link[^>]*rel="preload"[^>]*as="font"[^>]*>/)
    expect(m, 'expected a <link rel="preload" as="font"> for the heading weight').toBeTruthy()
    const tag = m[0]
    expect(tag).toMatch(/\scrossorigin(?:=|\s|>)/)
    const href = tag.match(/href="([^"]+)"/)?.[1]
    expect(href, 'preload tag has no href').toBeTruthy()
    expect(href).toMatch(/^\/(?!\/)/) // same-origin, like the scripts above
    expect(existsSync(resolve(__dirname, '../../public', href.replace(/^\//, '')))).toBe(true)
  })
})
