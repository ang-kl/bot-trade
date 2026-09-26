// Ai — UI-7: one page for every AI/LLM surface, replacing five scattered
// half-truths (owner principle 6, no fake result):
//   1. The health panel's "llm anthropic:…" line named a provider whenever
//      OPENAI_API_KEY was unset, whether or not that provider had a key or
//      the LLM_DISABLED switch was on (fixed at the source: agent/index.js
//      now reports 'off' honestly — see agent/lib/llm-provider.js
//      llmStatusLabel — so this page's status line inherits the fix).
//   2. Re-Risk's Apply (components/RiskReassess.jsx) — MOVED here in full
//      (checker BLOCKER 4, W1.4 fix round: a link-only page did not match
//      the brief, which names RiskReassess.jsx as an in-scope file). Its
//      proposal rows deep-link BACK to Risk's own anchored fields as real
//      cross-page navigation (`<Link to="/risk#risk-${key}">`), and Risk.jsx
//      opens any collapsed ancestor and scrolls to the target once it lands
//      there — the same behaviour the same-page click handler used to run,
//      now triggered by arrival instead of by the click (src/pages/Risk.jsx,
//      src/pages/risk-anchors.test.js).
//   3. Desk's "LLM spend" card — MOVED here in full (LlmSpendCard.jsx).
//   4. Tune's "Search by description…" screener chat — a real control tied
//      to Tune's own screener STATE (curated symbols, custom list, the
//      results table it searches into) rather than to a single anchored
//      field, so moving it here would strand it with no table to populate.
//      It already reads llmUiState honestly (components/ScreenerChat.jsx),
//      so it stays on Tune, and this page links to it.
//   5. The sidebar badge (LlmMonitorStatus.jsx) — unchanged: it reports
//      monitor DEGRADATION, a different fact from "is the layer switched on".
import { Link } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'
import SectionNavFab from '../components/common/SectionNavFab.jsx'
import Card from '../components/common/Card.jsx'
import Badge from '../components/common/Badge.jsx'
import LlmSpendCard from '../components/LlmSpendCard.jsx'
import RiskReassess from '../components/RiskReassess.jsx'
import { agentGet, agentConfigured } from '../lib/agent-api.js'
import { llmUiState, llmOffNote } from '../lib/llm-ui.js'

export default function Ai() {
  const [health, setHealth] = useState(null)
  const [agentHealth, setAgentHealth] = useState(null)

  // Checker NIT 4 (W1.4 fix round): the read itself, shared — LlmSpendCard
  // used to run its OWN independent /state/health poll; it now takes `health`
  // as a prop and calls this (as `onHealthChanged`) to refresh the ONE copy
  // this page holds instead of duplicating the request.
  const fetchHealth = useCallback(() => {
    if (!agentConfigured()) return Promise.resolve({ h: null, ah: null })
    // /state/health carries the switch (llmDisabled/llmDisabledBy); /health
    // carries the honest provider label (agent/index.js llmStatusLabel) —
    // two different routes, both already fetched elsewhere in the app, read
    // here together so this page states ONE verdict instead of two partial
    // ones.
    return Promise.all([
      agentGet('/state/health').catch(() => null),
      agentGet('/health').catch(() => null),
    ]).then(([h, ah]) => ({ h, ah }))
  }, [])
  // The action-triggered reload (LlmSwitch flips, then awaits this): no
  // unmount guard, the same convention RiskReassess.jsx's own load()/apply()
  // already use for a reload made in direct response to a click.
  const loadHealth = useCallback(() => fetchHealth().then(({ h, ah }) => { setHealth(h); setAgentHealth(ah) }), [fetchHealth])

  useEffect(() => {
    let alive = true
    fetchHealth().then(({ h, ah }) => { if (alive) { setHealth(h); setAgentHealth(ah) } })
    return () => { alive = false }
  }, [fetchHealth])

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
            below. Its proposal rows jump to the changed field on <Link to="/risk" className="underline">Risk</Link>,
            which is still where every risk setting itself lives.
          </li>
          <li>
            <b>Screener search by description</b> — the "Search by description…" button
            on <Link to="/tune" className="underline">Tune</Link>'s Screener panel. It stays there:
            it searches straight into that page's own curated-symbol table, and already
            reads this same off/on state and refuses to send while the layer is off.
          </li>
        </ul>
      </Card>

      {/* Reset / Re-Risk (UI-7, checker BLOCKER 4): the actual card, not a
          link — `onChanged`/`onApplied` are optional on RiskReassess and
          omitted here on purpose. This page shows no risk FIELD to refresh
          or highlight; Risk.jsx re-reads /state/risk-reassess on its own
          mount instead of depending on a sibling's callback (it can no
          longer assume this card is mounted beside it). */}
      <RiskReassess />

      <LlmSpendCard health={health} onHealthChanged={loadHealth} />
    </div>
  )
}
