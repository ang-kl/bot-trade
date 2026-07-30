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
import Input from './common/Input.jsx'
import Badge from './common/Badge.jsx'
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

  // Fresh proposals start unticked. Deliberate: ticking them for the owner
  // would make Apply a single click on values a model chose.
  useEffect(() => { setPicked(new Set()) }, [last?.at])

  const reset = async () => {
    if (!window.confirm('Reset EVERY risk setting to its built-in default? Current overrides are discarded.')) return
    setBusy('reset'); setError('')
    try {
      await agentPost('/actions/risk-config', { reset: true })
      onChanged?.()
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  const run = async () => {
    if (!ask) return
    setBusy('run'); setError('')
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
    setBusy('apply'); setError('')
    try {
      await agentPost('/actions/risk-reassess-apply', { keys })
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
          onClick={() => { setAsk({ includeWatchlist: false }); setError('') }}
          disabled={!!busy}
          title="Ask an LLM to re-derive the limits from the account balance and its closed-trade record. Instruments are NOT considered."
        >
          Re-Risk
        </Button>
        <Button
          onClick={() => { setAsk({ includeWatchlist: true }); setError('') }}
          disabled={!!busy}
          title="Same, but the account's watchlist is part of the assessment — how many instruments, how correlated, which asset classes."
        >
          Re-Risk + Watchlist
        </Button>
        <span className="text-[9px] text-[var(--color-text-sub)]">
          Re-Risk <strong>proposes</strong> — nothing changes until you apply it
        </span>
      </div>

      {/* ---- the provider/model prompt ------------------------------------ */}
      {ask && (
        <div className="rounded-[6px] border border-[var(--color-border)] p-2 space-y-2">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">
            {ask.includeWatchlist ? 'Re-Risk + Watchlist' : 'Re-Risk'} — choose the model
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PROVIDERS.map(p => {
              const on = provider === p.id
              const has = available[p.id] !== false
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!has}
                  onClick={() => { setProvider(p.id); if (!model) setModel(p.placeholder) }}
                  title={has ? `Use ${p.label}` : `No API key for ${p.label} is set on the agent`}
                  className={`rounded-[4px] border px-2 py-0.5 text-[9px] font-semibold disabled:opacity-40 ${
                    on
                      ? 'border-[var(--color-state-on-border)] bg-[var(--color-state-on-bg)] text-[var(--color-state-on-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-sub)]'
                  }`}
                >
                  {p.label}{has ? '' : ' (no key)'}
                </button>
              )
            })}
            <Input
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder={PROVIDERS.find(p => p.id === provider)?.placeholder}
              className="w-48"
              aria-label="model name"
            />
            <Button onClick={run} disabled={!!busy || !model.trim()}>
              {busy === 'run' ? 'Assessing…' : 'Run assessment'}
            </Button>
            <Button onClick={() => setAsk(null)} disabled={!!busy}>Cancel</Button>
          </div>
          <div className="text-[9px] text-[var(--color-text-sub)]">
            Type the model name exactly as the provider spells it — it is sent through as typed, so a
            wrong id comes back as the provider&apos;s own error rather than a silent substitution.
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-[6px] border px-2 py-1 text-[9px] border-[var(--color-state-off-border)]
                        bg-[var(--color-state-off-bg)] text-[var(--color-state-off-text)]">
          {error}
        </div>
      )}

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
                    {last.proposals.map(p => (
                      <tr key={p.key} className="border-t border-[var(--color-border)]">
                        <td className="pr-2 py-0.5">
                          <input
                            type="checkbox"
                            checked={picked.has(p.key)}
                            onChange={() => toggle(p.key)}
                            aria-label={`apply ${p.label}`}
                          />
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
                        <td className="pr-2 py-0.5 text-[var(--color-text-sub)]">{show(p.key, p.current, proposable)}</td>
                        <td className="pr-2 py-0.5 font-semibold">{show(p.key, p.proposed, proposable)}</td>
                        <td className="py-0.5 text-[var(--color-text-sub)]">{p.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={apply} disabled={!!busy || picked.size === 0}>
                  {busy === 'apply' ? 'Applying…' : `Apply ${picked.size || ''} selected`}
                </Button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set(last.proposals.map(p => p.key)))}
                  className="text-[9px] underline text-[var(--color-text-sub)]"
                >
                  select all
                </button>
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
