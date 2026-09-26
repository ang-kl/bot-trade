// LlmSpendCard — UI-7: the "LLM spend" card moved off Desk onto the AI page.
// react-dom/server renders first-pass only (no effects), so `health` and
// `llmSpend` are null here — exactly the pre-fetch state the card must
// render safely, same convention as engine-status-panel.test.jsx.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import LlmSpendCard from './LlmSpendCard.jsx'

describe('LlmSpendCard', () => {
  it('renders before any fetch resolves, without throwing', () => {
    expect(() => renderToStaticMarkup(<LlmSpendCard />)).not.toThrow()
  })

  it('names the card "LLM spend" and shows the AI-features switch state as unknown with no health prop', () => {
    const html = renderToStaticMarkup(<LlmSpendCard />)
    expect(html).toMatch(/LLM spend/)
    expect(html).toMatch(/state unknown/)
  })

  it('reads the switch state straight from a passed-in health PROP, not from its own fetch', () => {
    const on = renderToStaticMarkup(<LlmSpendCard health={{ llmDisabled: false }} />)
    expect(on).not.toMatch(/state unknown/)
    const off = renderToStaticMarkup(<LlmSpendCard health={{ llmDisabled: true, llmDisabledBy: 'LLM_DISABLED env var' }} />)
    expect(off).toMatch(/Trading is deterministic and unaffected/)
  })

  // Checker NIT 4 (W1.4 fix round): this card used to run its own
  // independent /state/health poll — duplicating the SAME read Ai.jsx (its
  // only mount site) already makes for its own status card. `health` is now
  // a prop; source-pinned since effects do not run under react-dom/server
  // and this file has no fetch mock harness of its own.
  it('no longer fetches /state/health itself — the prop is the only source', () => {
    const src = readFileSync(new URL('./LlmSpendCard.jsx', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/agentGet\('\/state\/health'\)/)
    expect(src).toMatch(/export default function LlmSpendCard\(\{ health = null, onHealthChanged = null \}\)/)
    // The switch's onChanged still refreshes BOTH this card's own spend read
    // and the parent's health copy — flipping the switch must not leave
    // either one stale.
    expect(src).toMatch(/onHealthChanged\?\.\(\)/)
    expect(src).toMatch(/agentGet\('\/state\/llm-spend'\)/)
  })
})
