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

})

describe('Re-Risk with the AI layer off — rendered, not described', () => {
  // renderToStaticMarkup on the REAL component, off state seeded via the
  // test seam. This IMPORTS the module, so a file that does not parse fails
  // here — the gap that let a SyntaxError ship behind source-text tests.
  it('collapses ONLY the run pipeline; Reset and the anchor stay', async () => {
    const { default: RiskReassess } = await import('../components/RiskReassess.jsx')
    const off = llmUiState({ llmDisabled: true, llmDisabledBy: 'LLM_DISABLED env var' })
    const html = renderToStaticMarkup(<RiskReassess initialLlmOff={off} />)
    expect(html).toContain('id="sec-rerisk"')
    // The deterministic half survives: Reset is a plain server POST and the
    // section's nav label promises it ("Reset / Re-Risk").
    expect(html).toMatch(/>Reset</)
    // The model half is gone, replaced by the note.
    expect(html).not.toMatch(/>Re-Risk</)
    expect(html).not.toMatch(/Re-Risk \+ Watchlist/)
    expect(html).toMatch(/Trading is deterministic and unaffected/)
  })

  it('with the layer ON the run buttons render and the note does not', async () => {
    const { default: RiskReassess } = await import('../components/RiskReassess.jsx')
    const html = renderToStaticMarkup(<RiskReassess initialLlmOff={llmUiState({ llmDisabled: false })} />)
    expect(html).toMatch(/Re-Risk \+ Watchlist/)
    expect(html).not.toMatch(/Trading is deterministic and unaffected/)
  })
})

describe('the env-lock is textual — pin the text on both sides', () => {
  it("the agent's reason strings still say what /env/i distinguishes", async () => {
    // llmUiState locks the checkbox on /env/i against a human-readable
    // sentence. If llm-switch.js ever rewords 'LLM_DISABLED env var', the
    // lock silently unlocks with no test failing (review on #755). Until the
    // flag becomes structural, pin the literals at their source.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../agent/lib/llm-switch.js', import.meta.url), 'utf8')
    expect(src).toContain("'LLM_DISABLED env var'")
    expect(src).toContain("'llm_disabled state key'")
    expect(llmUiState({ llmDisabled: true, llmDisabledBy: 'LLM_DISABLED env var' }).envHeld).toBe(true)
    expect(llmUiState({ llmDisabled: true, llmDisabledBy: 'llm_disabled state key' }).envHeld).toBe(false)
  })
})
