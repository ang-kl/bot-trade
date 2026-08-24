// The AI-features checkbox — the UI end of agent/lib/llm-switch.js.
//
// One box, whole layer: position monitor, weekend watch, Re-Risk, screener
// search, cockpit explain. Unticking POSTs the runtime kill switch, so the
// calls are never attempted (no 401 storms, no failure streaks); the LLM
// cards across the app read the same /health flags and collapse to a note.
//
// When the LLM_DISABLED env var holds the layer off, the box renders ticked-
// off AND locked: the route cannot release an env brake, and a control that
// looks operable but is not teaches the operator to distrust controls.
import { useState } from 'react'
import { agentPost } from '../lib/agent-api.js'
import { llmUiState } from '../lib/llm-ui.js'

export default function LlmSwitch({ health, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // The route's own answer, held until the parent's refetch lands. Without
  // it the box re-enabled still showing the OLD state (checked follows the
  // health prop, and Desk's load() is a Promise.all over many endpoints), so
  // a successful untick read as "that didn't take" — and the natural second
  // click POSTed enabled:true, re-enabling the layer the owner had just
  // switched off (#755 review). effectiveEnabled already accounts for the
  // env override, which also keeps the display honest when a POST succeeds
  // but the env brake means nothing changed.
  const [settled, setSettled] = useState(null) // null = follow health
  const s = llmUiState(health)
  const disabled = settled == null ? s.disabled : !settled

  // A checkbox is not a card: it does not merely render, it ASSERTS a state.
  // Before /state/health resolves (or if it never does) a ticked, operable
  // box would claim "AI is on" on no evidence — and a click in that window
  // would POST disable. The fail-open rule is right for the CARDS, whose
  // absence hides working features; here the honest render is no control at
  // all until the state is known.
  if (health == null) {
    return (
      <div className="text-(length:--fs-body) text-[var(--color-text-sub)]">
        <span className="font-semibold">AI features</span> — state unknown (waiting for /state/health)
      </div>
    )
  }

  const flip = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await agentPost('/actions/llm-switch', { enabled: disabled })
      if (typeof r?.effectiveEnabled === 'boolean') setSettled(r.effectiveEnabled)
      await onChanged?.()
      setSettled(null) // parent is fresh — follow it again
    } catch (e) { setErr(e?.message || String(e)) }
    setBusy(false)
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-(length:--fs-body)">
      <label className={`flex items-center gap-1.5 ${s.canToggle ? 'cursor-pointer' : 'opacity-60'}`}>
        <input
          type="checkbox"
          checked={!disabled}
          disabled={busy || !s.canToggle}
          onChange={flip}
        />
        <span className="font-semibold">AI features</span>
      </label>
      <span className="text-[var(--color-text-sub)]">
        position monitor · weekend watch · Re-Risk · screener · explain
      </span>
      {disabled && (
        <span className="text-[var(--color-text-sub)]">
          — off{s.envHeld ? ' (held by LLM_DISABLED env var; the box cannot release it)' : ''}
        </span>
      )}
      {err && <span className="text-[var(--color-down)]">{err}</span>}
    </div>
  )
}
