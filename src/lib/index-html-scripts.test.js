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
})
