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

  // Checker NIT 3 (W1.4 fix round; plan A1: "the sidebar and the health
  // panel say 'AI off'" — the health panel already does, buildLabel). Effects
  // do not run under react-dom/server, so the wiring is pinned at the source
  // the same way the fetch-failure branch above already is.
  it('renders nothing before any fetch, even with the AI-off wiring added', () => {
    expect(renderToStaticMarkup(<LlmMonitorStatus />)).toBe('')
  })

  it('reads /state/health through llmUiState and renders an "AI off" badge, ahead of degraded and fetch-failure', () => {
    const src = readFileSync(new URL('./LlmMonitorStatus.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toMatch(/import \{ llmUiState \} from '\.\.\/lib\/llm-ui\.js'/)
    expect(src).toMatch(/agentGet\('\/state\/health'\)\.catch\(\(\) => null\)/)
    expect(src).toMatch(/setAiOff\(llmUiState\(h\)\.disabled\)/)
    expect(src).toMatch(/if \(aiOff\) \{/)
    expect(src).toMatch(/AI off/)
    // Off must be checked BEFORE the fetch-error and degraded branches, so a
    // stale degraded reading from before the switch was thrown cannot
    // override the authoritative "nothing is happening because it is off".
    const offAt = src.indexOf('if (aiOff)')
    const errAt = src.indexOf('fetchError && !health?.degraded')
    const degradedAt = src.indexOf('if (!health?.degraded) return null')
    expect(offAt).toBeGreaterThan(0)
    expect(offAt).toBeLessThan(errAt)
    expect(offAt).toBeLessThan(degradedAt)
  })

  it('a failed /state/health read leaves aiOff at its default (false), never inventing "off" from missing evidence', () => {
    const src = readFileSync(new URL('./LlmMonitorStatus.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    // The catch resolves to null, not a swallowed/thrown failure — llmUiState
    // reads absent evidence as NOT disabled (llm-ui.test.jsx: "ABSENT
    // EVIDENCE RENDERS THE CARDS").
    expect(src).toMatch(/const \[aiOff, setAiOff\] = useState\(false\)/)
  })
})
