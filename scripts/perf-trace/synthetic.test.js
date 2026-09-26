// NEW-1: the trace harness opens every page as a synthetic presence.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { withSynthetic, syntheticInit, SYNTHETIC_TAG } from './synthetic.mjs'

describe('perf-trace synthetic flag', () => {
  it('withSynthetic adds ?synthetic=trace and keeps an existing query', () => {
    expect(withSynthetic('https://example.test/performance')).toBe('https://example.test/performance?synthetic=trace')
    expect(withSynthetic('https://example.test/?a=1')).toBe('https://example.test/?a=1&synthetic=trace')
    expect(SYNTHETIC_TAG).toBe('trace')
  })

  it('the init script marks the tab synthetic for its whole session', () => {
    const store = {}
    const sessionStorage = { setItem: (k, v) => { store[k] = v } }
    new Function('sessionStorage', syntheticInit())(sessionStorage)
    expect(store).toEqual({ synthetic_presence: 'trace' })
  })

  it('trace.mjs navigates to every page through withSynthetic and runs the synthetic init', () => {
    // Source scan (the harness needs Chromium + MCP to run); comments stripped
    // first so an explanatory comment cannot satisfy it (failure mode #2).
    const src = readFileSync(new URL('./trace.mjs', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).toMatch(/url:\s*withSynthetic\(BASE \+ p\)/)
    expect(src).not.toMatch(/url:\s*BASE \+ p[,\s}]/)
    expect(src).toMatch(/const init = `[^\n]*`\s*\+\s*syntheticInit\(\)/)
  })
})
