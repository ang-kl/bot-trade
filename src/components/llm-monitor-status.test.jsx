// LlmMonitorStatus — the badge is invisible while healthy, which is right, but
// until 02-09-2026 it was ALSO invisible when the health route could not be
// read: an unreachable monitor looked exactly like a fine one (UI audit).
// react-dom/server: no effects run, so the pre-fetch render is what is checked
// directly; the failure branch is pinned in source with comments stripped.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import LlmMonitorStatus from './LlmMonitorStatus.jsx'

describe('LlmMonitorStatus', () => {
  it('renders nothing before any fetch — no reading is not a failure yet', () => {
    expect(renderToStaticMarkup(<LlmMonitorStatus />)).toBe('')
  })

  it('renders a NOT VERIFIABLE badge on fetch failure, muted, distinct from degraded', () => {
    const src = readFileSync(new URL('./LlmMonitorStatus.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toMatch(/\.catch\(e => \{ if \(alive\) setFetchError/)
    expect(src).not.toMatch(/\.catch\(\(\) => \{\s*\}\)/)
    expect(src).toMatch(/if \(fetchError && !health\?\.degraded\) \{/)
    expect(src).toMatch(/AI monitor: not verifiable/)
    // Degraded still wins over a stale fetch error: the amber badge is the
    // real alarm and must not be replaced by the muted one.
    expect(src.indexOf('fetchError && !health?.degraded')).toBeLessThan(src.indexOf("if (!health?.degraded) return null"))
  })
})
