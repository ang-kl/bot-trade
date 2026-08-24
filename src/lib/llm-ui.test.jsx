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

  it('enabled renders ticked and operable, with no off annotation', () => {
    const html = renderToStaticMarkup(<LlmSwitch health={{ llmDisabled: false }} />)
    expect(html).toContain('checked')
    expect(html).not.toMatch(/— off/)
  })
})
