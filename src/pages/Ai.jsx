// Ai — UI-7: one page for every AI/LLM surface, replacing five scattered
// half-truths (owner principle 6, no fake result):
//   1. The health panel's "llm anthropic:…" line named a provider whenever
//      OPENAI_API_KEY was unset, whether or not that provider had a key or
//      the LLM_DISABLED switch was on (fixed at the source: agent/index.js
//      now reports 'off' honestly — see agent/lib/llm-provider.js
//      llmStatusLabel — so this page's status line inherits the fix).
//   2. Re-Risk's Apply (components/RiskReassess.jsx) — a real control, still
//      on the Risk page: it deep-links to Risk's own anchored fields
//      (`href="#risk-${key}"`, `jumpTo`, src/pages/risk-anchors.test.js), so
//      moving it here would break that jump. This page links to it instead.
//   3. Desk's "LLM spend" card — MOVED here in full (LlmSpendCard.jsx).
//   4. Tune's "Search by description…" screener chat — also a real control
//      tied to Tune's own screener state (curated symbols, custom list); it
//      already reads llmUiState honestly (components/ScreenerChat.jsx), so
//      it stays, and this page links to it.
//   5. The sidebar badge (LlmMonitorStatus.jsx) — unchanged: it reports
//      monitor DEGRADATION, a different fact from "is the layer switched on".
import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import LlmSpendCard from '../components/LlmSpendCard.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import { llmUiState, llmOffNote } from '../lib/llm-ui.js'

export default function Ai() {
  const [health, setHealth] = useState(null)
  const [agentHealth, setAgentHealth] = useState(null)

  useEffect(() => {
    if (!agentConfigured()) return
    let alive = true
    // /state/health carries the switch (llmDisabled/llmDisabledBy); /health
    // carries the honest provider label (agent/index.js llmStatusLabel) —
    // two different routes, both already fetched elsewhere in the app, read
    // here together so this page states ONE verdict instead of two partial
    // ones.
    Promise.all([
      agentGet('/state/health').catch(() => null),
      agentGet('/health').catch(() => null),
    ]).then(([h, ah]) => { if (alive) { setHealth(h); setAgentHealth(ah) } })
    return () => { alive = false }
  }, [])

  const state = llmUiState(health)
  // 'off' already covers "no key" and "LLM_DISABLED" (llmStatusLabel); the
  // switch (state.disabled) covers the runtime toggle specifically, so
  // either one showing off is reported as off — never invented as on.
  const providerLabel = agentHealth?.llmProvider || null
  const layerOff = state.disabled || providerLabel === 'off'
  const statusTone = health == null && agentHealth == null ? 'neutral' : layerOff ? 'off' : 'on'
  const statusText = health == null && agentHealth == null
    ? 'AI status unknown — waiting for the agent'
    : layerOff
      ? 'AI off'
      : `AI on${providerLabel && providerLabel !== 'off' ? ` — ${providerLabel}` : ''}`

  return (
    <div className="space-y-8">
      <SectionNavFab />

      <Card id="sec-ai-status">
        <h2 className="t-h3 mb-1.5">AI status</h2>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Badge tone={statusTone}>{statusText}</Badge>
          {state.disabled && (
            <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">{llmOffNote(state)}</span>
          )}
        </div>
        <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-3">
          Scanning, entries, sizing and the risk gate are deterministic and unaffected either way — nothing here changes a trade. The LLM is used only for the position monitor, the weekend watch, Re-Risk proposals and the screener's natural-language search.
        </p>
        <ul className="text-(length:--fs-body) text-[var(--color-text-sub)] list-disc ml-4 space-y-1">
          <li>
            <b>Re-Risk</b> (propose risk settings from an LLM read, then apply or discard) —
            the Reset / Re-Risk card on <Link to="/risk" className="underline">Risk</Link>. It stays
            there because its proposal rows jump to the anchored field they would change, on that page.
          </li>
          <li>
            <b>Screener search by description</b> — the "Search by description…" button
            on <Link to="/tune" className="underline">Tune</Link>'s Screener panel. It already
            reads this same off/on state and refuses to send while the layer is off.
          </li>
        </ul>
      </Card>

      <LlmSpendCard />
    </div>
  )
}
