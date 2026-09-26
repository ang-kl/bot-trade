// LlmSpendCard — UI-7: the "LLM spend" card, moved off Desk onto the new AI
// page (pages/Ai.jsx) so every AI-related surface lives in one place
// (owner principle 6: no fake result — this page is where "is the AI layer
// actually doing anything" gets one honest answer).
//
// `health` is a PROP (checker NIT 4, W1.4 fix round), not a fetch of its own:
// Ai.jsx already reads /state/health for its own status card, and a second,
// independent poll of the same route from this sibling would double the
// request for no reason — the same shape of duplication AgentHealthPanel.jsx
// exists to avoid for its two mount sites. This card still owns its OWN
// /state/llm-spend fetch, which nothing else on the page needs.
//
// Unchanged from the card Desk used to render: real token usage priced in
// USD (today/7d/30d + projection), the by-purpose breakdown, and an
// owner-set daily cost-alert cap (POST /actions/llm-budget).
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Collapse from './common/Collapse.jsx'
import Button from './common/Button.jsx'
import Input from './common/Input.jsx'
import LlmSwitch from './LlmSwitch.jsx'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'
import { llmUiState, llmOffNote } from '../lib/llm-ui.js'

export default function LlmSpendCard({ health = null, onHealthChanged = null }) {
  const [llmSpend, setLlmSpend] = useState(null)
  const [capDraft, setCapDraft] = useState('')
  const [capNote, setCapNote] = useState('')

  async function loadSpend() {
    if (!agentConfigured()) return
    const ls = await agentGet('/state/llm-spend').catch(() => null)
    setLlmSpend(ls)
  }
  // Deferred a tick: react-hooks/set-state-in-effect forbids state writes
  // synchronously inside an effect body (same idiom as Tune.jsx's load()).
  useEffect(() => {
    const t = setTimeout(loadSpend, 0)
    return () => clearTimeout(t)
  }, [])
  // The switch flips a value on THIS record's own /state/health, so both the
  // parent's copy (the AI status card above) and this card's own llm-spend
  // read (its cap/history did not change, but the reload is cheap and keeps
  // the two calls symmetric) need a fresh answer, not just one of them.
  const load = async () => { await Promise.all([onHealthChanged?.(), loadSpend()]) }

  const off = llmUiState(health).disabled

  return (
    <Card id="sec-llmspend" data={llmSpend}>
      <h2 className="t-h3 mb-1.5">LLM spend</h2>
      {/* The switch always renders — it is the way back on. What collapses
          behind it is only the FORWARD-LOOKING per-call detail; the headline
          totals are records of money already spent (same side of the line
          as Trade lessons), and the daily cost-alert cap is a deterministic
          Telegram threshold that must stay editable while the layer is off. */}
      <div className="mb-2"><LlmSwitch health={health} onChanged={load} /></div>
      {off && (
        <p className="text-(length:--fs-body) text-[var(--color-text-sub)] mb-2">{llmOffNote(llmUiState(health))}</p>
      )}
      {!llmSpend && !off && <p className="text-(length:--fs-body) text-[var(--color-text-sub)]">No data yet.</p>}
      {llmSpend && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-(length:--fs-body) tabular-nums mb-2">
            <span>Today <span className="font-semibold">${(llmSpend.today?.cost_usd ?? 0).toFixed(2)}</span> · {llmSpend.today?.calls ?? 0} calls</span>
            <span>7 days <span className="font-semibold">${(llmSpend.last7d?.cost_usd ?? 0).toFixed(2)}</span></span>
            <span>30 days <span className="font-semibold">${(llmSpend.last30d?.cost_usd ?? 0).toFixed(2)}</span></span>
            {/* The one genuinely forward-looking number on the card — a
                forecast of spend that cannot happen while the layer is off,
                so it is the figure that hides. History always renders; the
                forecast is gated. */}
            {!off && (
              <span>Projected month <span className="font-semibold">${(llmSpend.projected_month_usd ?? 0).toFixed(2)}</span></span>
            )}
          </div>
          {(llmSpend.by_purpose?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <Collapse id="Ai_llmspend_bypurpose" label="Spend by Purpose Rows">
                <table className="std-cols w-full text-(length:--fs-body) tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <th className="py-1 pr-3">Purpose</th>
                      <th className="py-1 pr-3">Model</th>
                      <th className="py-1 pr-3 text-right">Calls</th>
                      <th className="py-1 pr-3 text-right">In</th>
                      <th className="py-1 pr-3 text-right">Out</th>
                      <th className="py-1 text-right">Est. cost (30d)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmSpend.by_purpose.map(p2 => (
                      <tr key={`${p2.purpose}|${p2.model}`} className="border-b border-[var(--color-border)]">
                        <td className="py-1 pr-3">{p2.purpose}</td>
                        <td className="py-1 pr-3 text-[var(--color-text-sub)]">{p2.model}</td>
                        <td className="py-1 pr-3 text-right">{p2.calls.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.input_tokens.toLocaleString()}</td>
                        <td className="py-1 pr-3 text-right">{p2.output_tokens.toLocaleString()}</td>
                        <td className="py-1 text-right">${p2.cost_usd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Collapse>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="block text-(length:--fs-body)">
              <span className="text-[var(--color-text-sub)]">Daily cost alert (USD, 0 = off) — currently {llmSpend.daily_cap_usd ? `$${llmSpend.daily_cap_usd}` : 'off'}</span>
              <Input type="number" step="0.1" min="0" value={capDraft} onChange={e => setCapDraft(e.target.value)} placeholder={llmSpend.daily_cap_usd ? String(llmSpend.daily_cap_usd) : 'e.g. 1.00'} className="w-28" />
            </label>
            <Button
              size="sm" variant="subtle"
              onClick={async () => {
                try {
                  const r = await agentPost('/actions/llm-budget', { dailyCapUsd: capDraft === '' ? 0 : Number(capDraft) })
                  setCapNote(r.dailyCapUsd ? `Alert armed at $${r.dailyCapUsd}/day.` : 'Alert disarmed.')
                  await load()
                } catch (e) { setCapNote(e.message) }
              }}
            >Save cap</Button>
            {capNote && <span className="text-(length:--fs-body) text-[var(--color-text-sub)]">{capNote}</span>}
          </div>
          <p className="mt-1 text-(length:--fs-body) text-[var(--color-text-sub)]">
            Scanning, backtests, and all trading decisions are deterministic — zero tokens. The only LLM consumers are the position monitor and the weekend watch, priced at published per-model rates (estimates, not the invoice).
          </p>
        </>
      )}
    </Card>
  )
}
