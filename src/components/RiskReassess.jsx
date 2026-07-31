// RiskReassess — the three buttons at the top of the Risk page, and the panel
// that shows what the last run said.
//
// Owner (2026-07-30):
//   "Reset: reset to default
//    Re-Risk: using Claude or OpenAI (prompt user to choose either LLM and
//      model name) to do a risk assessment base on the balance account and not
//      on watchlist.
//    Re-Risk+Watchlist: ... base on the balance account with watchlist in mind.
//    Result below the re-risk include last date/time of re-risk (watchlist
//      symbol number)"
//
// A run PROPOSES; it does not change anything. See the header of
// agent/services/risk-reassess.js for why: these keys are the money limits, and
// the risk gate would enforce a hallucinated decimal point faithfully. Each
// proposal gets a tick box and one Apply button, so what lands in the config is
// something the owner chose line by line.
import { useCallback, useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Button from './common/Button.jsx'
import Badge from './common/Badge.jsx'
import DoneCue from './common/DoneCue.jsx'
import { useDoneCue } from '../lib/use-done-cue.js'
import { agentGet, agentPost, agentConfigured } from '../lib/agent-api.js'

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', placeholder: 'gpt-5.6-luna' },
  { id: 'anthropic', label: 'Claude', placeholder: 'claude-sonnet-4-5' },
]
// Remember the last choice so a second run is one click, not three.
const PREF = 'risk_reassess_pref_v1'

/** Local date+time of the run, in the viewer's own zone. */
function stamp(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** Show a fraction as a percentage, everything else as itself. */
function show(key, v, proposable) {
  if (v == null || v === '') return '—'
  const kind = proposable?.[key]?.kind
  if (kind === 'fraction') return `${(Number(v) * 100).toFixed(2)}%`
  if (kind === 'usd') return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  return String(v)
}

export default function RiskReassess({ onChanged }) {
  const [data, setData] = useState(null)      // { last, providers, proposable }
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [ask, setAsk] = useState(null)        // null | { includeWatchlist }
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  // Transient confirmation. Owner: "Apply 13 selected > if done, show 'done'
  // visual cue and reset the checkboxes." An action whose only feedback is the
  // numbers quietly changing somewhere else reads as "did that work?".
  const [done, setDone] = useDoneCue()

  const load = useCallback(() => {
    if (!agentConfigured()) return
    agentGet('/state/risk-reassess')
      .then(d => setData(d))
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    load()
    try {
      const p = JSON.parse(localStorage.getItem(PREF) || 'null')
      if (p?.provider) setProvider(p.provider)
      if (p?.model) setModel(p.model)
    } catch { /* private mode */ }
  }, [load])

  const last = data?.last || null
  const proposable = data?.proposable || {}
  const available = data?.providers || {}
  // The agent's REASONING-tier model, per the model router — a risk
  // reassessment is `financial_analysis` in llm_ai_doc/AI_Model_Router_
  // Instruction.md. Offered as the placeholder/prefill; the typed value still
  // wins, because the owner asked to choose the model by name.
  const suggested = data?.suggestedModel?.openai || null
  const suggestedTier = data?.suggestedModel?.tier || null
  // OpenAI options come from the agent's configured tiers; Claude's are the
  // curated list in model-router.js. Both are labelled with what they are.
  const options = provider === 'openai'
    ? (data?.modelOptions?.openai || [])
    : (data?.modelOptions?.anthropic || []).map(o => ({ model: o.model, tier: o.label }))

  // Fresh proposals start unticked. Deliberate: ticking them for the owner
  // would make Apply a single click on values a model chose.
  useEffect(() => { setPicked(new Set()) }, [last?.at])

  const reset = async () => {
    if (!window.confirm('Reset EVERY risk setting to its built-in default? Current overrides are discarded.')) return
    setBusy('reset'); setError('')
    try {
      await agentPost('/actions/risk-config', { reset: true })
      setDone('Reset to defaults')
      setPicked(new Set())
      onChanged?.()
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  const run = async () => {
    if (!ask) return
    setBusy('run'); setError(''); setDone('')
    try {
      try { localStorage.setItem(PREF, JSON.stringify({ provider, model })) } catch { /* private mode */ }
      const r = await agentPost('/actions/risk-reassess', {
        provider, model, includeWatchlist: ask.includeWatchlist,
      })
      setAsk(null)
      setData(d => ({ ...(d || {}), last: r.result }))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  const apply = async () => {
    const keys = [...picked]
    if (keys.length === 0) return
    setBusy('apply'); setError(''); setDone('')
    try {
      // `at` binds this apply to the assessment ON SCREEN. If another tab ran a
      // fresh assessment since this one rendered, the agent 409s instead of
      // applying the newer run's numbers under the same key names.
      await agentPost('/actions/risk-reassess-apply', { keys, at: last.at })
      // Confirm, then clear the ticks: they have been spent, and leaving them
      // ticked invites a second identical apply.
      setDone(`Applied ${keys.length} setting${keys.length === 1 ? '' : 's'}`)
      setPicked(new Set())
      load()
      onChanged?.()
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  const toggle = (key) => setPicked(s => {
    const n = new Set(s)
    if (n.has(key)) n.delete(key); else n.add(key)
    return n
  })

  return (
    <Card id="sec-rerisk" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={reset} disabled={!!busy} title="Discard every override and go back to the built-in defaults">
          {busy === 'reset' ? 'Resetting…' : 'Reset'}
        </Button>
        <Button
          onClick={() => { setAsk({ includeWatchlist: false }); setError(''); if (!model && suggested) setModel(suggested) }}
          disabled={!!busy}
          title="Ask an LLM to re-derive the limits from the account balance and its closed-trade record. Instruments are NOT considered."
        >
          Re-Risk
        </Button>
        <Button
          onClick={() => { setAsk({ includeWatchlist: true }); setError(''); if (!model && suggested) setModel(suggested) }}
          disabled={!!busy}
          title="Same, but the account's watchlist is part of the assessment — how many instruments, how correlated, which asset classes."
        >
          Re-Risk + Watchlist
        </Button>
        <span className="text-[9px] text-[var(--color-text-sub)]">
          Re-Risk <strong>proposes</strong> — nothing changes until you apply it
        </span>
      </div>

      {/* ---- the provider/model prompt: ONE dense row --------------------
          Owner: "i have given the list in the earlier .MD file for OPENAI. use
          dropdown for both MODEL and be UI dense." Both are <select>s now, and
          the OpenAI list is this agent's OWN three configured tiers (served by
          /state/risk-reassess from the model router) rather than a hardcoded
          list that would drift from what is set on Railway. */}
      {ask && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-[6px] border
                        border-[var(--color-border)] px-2 py-1">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">
            {ask.includeWatchlist ? 'Re-Risk + Watchlist' : 'Re-Risk'}
          </span>
          <select
            value={provider}
            onChange={e => { setProvider(e.target.value); setModel('') }}
            aria-label="LLM provider"
            className="rounded-[4px] border border-[var(--color-border)] bg-[var(--color-bg)]
                       px-1 py-0.5 text-[9px] font-semibold text-[var(--color-text)]"
          >
            {PROVIDERS.map(p => (
              <option key={p.id} value={p.id} disabled={available[p.id] === false}>
                {p.label}{available[p.id] === false ? ' (no key)' : ''}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            aria-label="model"
            className="rounded-[4px] border border-[var(--color-border)] bg-[var(--color-bg)]
                       px-1 py-0.5 text-[9px] font-semibold tabular-nums text-[var(--color-text)]"
          >
            <option value="">choose a model…</option>
            {options.map(o => (
              <option key={o.model} value={o.model}>
                {o.model}{o.tier ? ` · ${o.tier.toLowerCase()}` : ''}
              </option>
            ))}
          </select>
          <Button onClick={run} disabled={!!busy || !model}>
            {busy === 'run' ? 'Assessing…' : 'Run'}
          </Button>
          <Button onClick={() => setAsk(null)} disabled={!!busy}>Cancel</Button>
          <span className="text-[8px] text-[var(--color-text-sub)]">
            {ask.includeWatchlist
              ? 'watchlist composition included'
              : 'balance + record only, no instruments'}
            {suggestedTier ? ` · suggested tier: ${suggestedTier.toLowerCase()}` : ''}
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-[6px] border px-2 py-1 text-[9px] border-[var(--color-state-off-border)]
                        bg-[var(--color-state-off-bg)] text-[var(--color-state-off-text)]">
          {error}
        </div>
      )}

      {/* One shared cue component across the app — see DoneCue.jsx for why it
          is blue rather than green or accent. */}
      <DoneCue message={done && `${done} — done`} />

      {/* ---- last run ------------------------------------------------------ */}
      {!last && !ask && (
        <div className="text-[9px] text-[var(--color-text-sub)]">No reassessment has been run yet.</div>
      )}
      {last && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-2 text-[9px]">
            <span className="font-semibold text-[var(--color-text-sub)] uppercase tracking-wide">Last Re-Risk</span>
            <span className="tabular-nums">{stamp(last.at)}</span>
            <Badge tone="info">{last.provider === 'anthropic' ? 'Claude' : 'OpenAI'} · {last.model}</Badge>
            {/* Owner asked for the watchlist symbol number on this line. */}
            <Badge tone={last.includeWatchlist ? 'on' : 'off'}>
              {last.includeWatchlist ? `watchlist: ${last.watchlistCount} symbols` : 'watchlist excluded'}
            </Badge>
            {last.balanceUsd != null && (
              <span className="text-[var(--color-text-sub)] tabular-nums">
                balance ${Number(last.balanceUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                {last.leverage ? ` · 1:${last.leverage}` : ''}
              </span>
            )}
            {last.applied && <Badge tone="on">applied {stamp(last.appliedAt)}</Badge>}
          </div>

          {last.summary && <div className="text-[9px] leading-snug">{last.summary}</div>}

          {last.stats?.closedTrades != null && (
            <div className="text-[9px] text-[var(--color-text-sub)] tabular-nums">
              judged on {last.stats.closedTrades} closed trades
              {last.stats.winRatePct != null ? ` · ${last.stats.winRatePct}% win` : ''}
              {last.stats.worstLossUsd != null ? ` · worst single loss $${Math.abs(last.stats.worstLossUsd).toLocaleString()}` : ''}
            </div>
          )}

          {last.warnings?.length > 0 && (
            <ul className="space-y-0.5">
              {last.warnings.map((w, i) => (
                <li key={i} className="rounded-[4px] border px-2 py-0.5 text-[9px]
                                       border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]
                                       text-[var(--color-warning-text)]">{w}</li>
              ))}
            </ul>
          )}

          {last.proposals?.length === 0 && (
            <div className="text-[9px] text-[var(--color-text-sub)]">
              No changes proposed — the model judged the current limits appropriate.
            </div>
          )}

          {last.proposals?.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[9px] tabular-nums">
                  <thead>
                    <tr className="text-left text-[var(--color-text-sub)]">
                      <th className="pr-2 font-semibold">Apply</th>
                      <th className="pr-2 font-semibold">Setting</th>
                      <th className="pr-2 font-semibold">Now</th>
                      <th className="pr-2 font-semibold">Proposed</th>
                      <th className="font-semibold">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {last.proposals.map(p => {
                      // Owner (2026-07-31): "I applied 'Apply' ... and it
                      // didn't wired to the field to change. why?" It DID
                      // apply (the fields below refresh from the server) —
                      // but this table kept showing the pre-apply row with a
                      // live checkbox, so the action looked like a no-op.
                      // Applied rows now say so, and cannot be re-ticked.
                      const applied = last.applied && (last.appliedKeys || []).includes(p.key)
                      return (
                      <tr key={p.key} className="border-t border-[var(--color-border)]">
                        <td className="pr-2 py-0.5">
                          {applied
                            ? <span className="font-semibold text-[var(--color-accent)]" title={`Applied ${stamp(last.appliedAt)} — the setting below now holds the proposed value`}>✓</span>
                            : <input
                                type="checkbox"
                                checked={picked.has(p.key)}
                                onChange={() => toggle(p.key)}
                                aria-label={`apply ${p.label}`}
                              />}
                        </td>
                        <td className="pr-2 py-0.5">
                          {p.label}
                          {p.clamped && (
                            <span className="ml-1 text-[var(--color-warning-text)]"
                                  title="The model asked for a value outside the allowed range; it was clamped to the limit.">
                              clamped
                            </span>
                          )}
                        </td>
                        <td className="pr-2 py-0.5 text-[var(--color-text-sub)]">
                          {applied
                            ? <span title="This was the value before the apply"><s>{show(p.key, p.current, proposable)}</s></span>
                            : show(p.key, p.current, proposable)}
                        </td>
                        <td className="pr-2 py-0.5 font-semibold">
                          {show(p.key, p.proposed, proposable)}
                          {applied && <span className="ml-1 text-[8px] font-semibold uppercase text-[var(--color-accent)]">applied</span>}
                        </td>
                        <td className="py-0.5 text-[var(--color-text-sub)]">{p.reason}</td>
                      </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={apply} disabled={!!busy || picked.size === 0}
                  title={picked.size === 0 ? 'Tick the proposals you accept first — nothing applies until a row is selected' : undefined}>
                  {busy === 'apply' ? 'Applying…' : `Apply ${picked.size || ''} selected`}
                </Button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set(last.proposals
                    .filter(p => !(last.applied && (last.appliedKeys || []).includes(p.key)))
                    .map(p => p.key)))}
                  className="text-[9px] underline text-[var(--color-text-sub)]"
                >
                  select all
                </button>
                {picked.size === 0 && !last.applied && (
                  <span className="text-[9px] text-[var(--color-text-sub)]">tick the rows you accept, then Apply — the fields below update immediately</span>
                )}
                {last.applied && (
                  <span className="text-[9px] text-[var(--color-accent)]">
                    {(last.appliedKeys || []).length} applied {stamp(last.appliedAt)} — the settings below hold these values now
                  </span>
                )}
              </div>
            </>
          )}

          {last.rejected?.length > 0 && (
            <div className="text-[9px] text-[var(--color-text-sub)]">
              Ignored from the model&apos;s answer: {last.rejected.map(r => `${r.key} (${r.why})`).join('; ')}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
