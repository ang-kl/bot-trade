// npx vitest run src/lib/llm-ui.test.jsx
//
// Owner, 24-08-2026, after removing both API keys: "the LLM related card in
// the webapp are collapse with the checkbox disabled". The agent's side made
// disabled a first-class state weeks ago; the webapp kept rendering Re-Risk
// runs, screener search and an LLM-spend dashboard whose every button could
// only produce a refusal. These tests pin the UI half of the contract.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { llmUiState, llmOffNote } from './llm-ui.js'
import LlmSwitch from '../components/LlmSwitch.jsx'

const ENV_OFF = { llmDisabled: true, llmDisabledBy: 'LLM_DISABLED env var' }
const KEY_OFF = { llmDisabled: true, llmDisabledBy: 'llm_disabled state key' }

describe('llmUiState', () => {
  it('the two kinds of off are kept apart — env-held cannot be toggled', () => {
    expect(llmUiState(ENV_OFF)).toEqual({ disabled: true, by: 'LLM_DISABLED env var', envHeld: true, canToggle: false })
    expect(llmUiState(KEY_OFF).canToggle).toBe(true)
  })

  it('ABSENT EVIDENCE RENDERS THE CARDS — only an explicit true disables', () => {
    // A failed /health fetch or an old agent build must not blank working
    // features: hiding on missing data is the wrong direction to fail.
    for (const h of [null, undefined, {}, { llmDisabled: false }, { llmDisabled: 'true' }]) {
      expect(llmUiState(h).disabled).toBe(false)
    }
  })

  it('the off-note says who holds the switch, and is null when on', () => {
    expect(llmOffNote(llmUiState(ENV_OFF))).toMatch(/LLM_DISABLED env variable/)
    expect(llmOffNote(llmUiState(ENV_OFF))).toMatch(/redeploy/)
    expect(llmOffNote(llmUiState(KEY_OFF))).toMatch(/checkbox on the Desk/)
    expect(llmOffNote(llmUiState({}))).toBe(null)
  })

  it('every off-note says trading is unaffected — the sentence that stops a panic', () => {
    for (const h of [ENV_OFF, KEY_OFF]) {
      expect(llmOffNote(llmUiState(h))).toMatch(/Trading is deterministic and unaffected/)
    }
  })
})

describe('LlmSwitch first render (react-dom/server — no effects)', () => {
  it('env-held renders a LOCKED, unticked box that names its holder', () => {
    const html = renderToStaticMarkup(<LlmSwitch health={ENV_OFF} />)
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('checked')
    expect(html).toMatch(/held by LLM_DISABLED env var/)
  })

  it('state-key off renders unticked but OPERABLE — it is the way back on', () => {
    const html = renderToStaticMarkup(<LlmSwitch health={KEY_OFF} />)
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('checked')
  })

  it('UNKNOWN health renders NO checkbox — a control must not assert on no evidence', () => {
    // Review on #755: with health still null a ticked, operable box claims
    // "AI is on", and a click POSTs disable. Cards fail open; a checkbox is
    // an assertion, so it waits for the state instead.
    const html = renderToStaticMarkup(<LlmSwitch health={null} />)
    expect(html).not.toContain('<input')
    expect(html).toMatch(/state unknown/)
  })

  it('enabled renders ticked and operable, with no off annotation', () => {
    const html = renderToStaticMarkup(<LlmSwitch health={{ llmDisabled: false }} />)
    expect(html).toContain('checked')
    expect(html).not.toMatch(/— off/)
  })
})

describe('the consumers read the endpoint that carries the flag', () => {
  // The review on #755 caught both new consumers fetching the public /health,
  // which has no llmDisabled field — so their gates read false on every
  // possible response and the collapse branches were unreachable, while this
  // file's invariants stayed green (CLAUDE.md #3/#4: the guard's trigger was
  // out of reach of what it guarded). Effects do not run under
  // react-dom/server, so the wiring is pinned at the source, comments
  // stripped (#2 — this very comment names both paths).
  it('RiskReassess and ScreenerChat fetch /state/health, never the bare /health', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['../components/RiskReassess.jsx', '../components/ScreenerChat.jsx']) {
      const code = readFileSync(new URL(f, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      expect(code).toContain("agentGet('/state/health')")
      expect(code).not.toMatch(/agentGet\('\/health'\)/)
    }
  })

  it('the off-branch keeps the sec-rerisk anchor the nav FAB scrolls to', async () => {
    const { readFileSync } = await import('node:fs')
    const code = readFileSync(new URL('../components/RiskReassess.jsx', import.meta.url), 'utf8')
    const offBranch = code.slice(code.indexOf('llmOff?.disabled'), code.indexOf('llmOff?.disabled') + 900)
    expect(offBranch).toContain('id="sec-rerisk"')
  })
})
