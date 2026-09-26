// LlmSpendCard — UI-7: the "LLM spend" card moved off Desk onto the AI page.
// react-dom/server renders first-pass only (no effects), so `health` and
// `llmSpend` are null here — exactly the pre-fetch state the card must
// render safely, same convention as engine-status-panel.test.jsx.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import LlmSpendCard from './LlmSpendCard.jsx'

describe('LlmSpendCard', () => {
  it('renders before any fetch resolves, without throwing', () => {
    expect(() => renderToStaticMarkup(<LlmSpendCard />)).not.toThrow()
  })

  it('names the card "LLM spend" and shows the AI-features switch state as unknown before /state/health answers', () => {
    const html = renderToStaticMarkup(<LlmSpendCard />)
    expect(html).toMatch(/LLM spend/)
    expect(html).toMatch(/state unknown/)
  })
})
