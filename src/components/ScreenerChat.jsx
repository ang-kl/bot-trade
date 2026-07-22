// ScreenerChat — the LLM-interpreted free-text screener search, as a popup
// chatbot (owner: "the search is an LLM search that if I type 'AI stock' or
// Network layer stocks or P.E. >3, you can interpret or even pop a botchat
// to interact" — and, on interaction model: "Build the chatbot popup now
// too"). Multi-turn: each reply can be narrowed ("broaden to mid-caps too")
// without retyping the whole query.
//
// The backend (agent/services/screener-search.js) is the one enforcing
// honesty here — any symbol the LLM proposes that isn't in the broker's own
// universe is dropped server-side, not shown as if it were real. This popup
// just surfaces that: the reasoning, the accepted symbols, and — if any were
// dropped — says so plainly instead of hiding it.
import { useState, useRef, useEffect } from 'react'
import Button from './common/Button.jsx'
import { agentPost } from '../lib/agent-api.js'

export default function ScreenerChat({ open, onClose, onApply }) {
  const [turns, setTurns] = useState([]) // [{role, content}]
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [lastSymbols, setLastSymbols] = useState(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [turns, busy])

  if (!open) return null

  const send = async () => {
    const query = draft.trim()
    if (!query || busy) return
    setErr('')
    setBusy(true)
    const history = turns.map(t => ({ role: t.role, content: t.content }))
    const nextTurns = [...turns, { role: 'user', content: query }]
    setTurns(nextTurns)
    setDraft('')
    try {
      const res = await agentPost('/actions/screener-search', { query, history })
      const parts = []
      if (res.symbols?.length) parts.push(`Found ${res.symbols.length}: ${res.symbols.join(', ')}`)
      else parts.push('No symbols in your broker\'s universe matched this.')
      if (res.reasoning) parts.push(res.reasoning)
      if (res.dropped?.length) parts.push(`(Ignored ${res.dropped.length} name(s) not offered by this broker: ${res.dropped.join(', ')})`)
      setTurns(t => [...t, { role: 'assistant', content: parts.join(' ') }])
      setLastSymbols(res.symbols || [])
    } catch (e) {
      setErr(e.message)
      setTurns(t => [...t, { role: 'assistant', content: `Search failed: ${e.message}` }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85dvh] flex flex-col bg-[var(--color-bg)] border border-[var(--color-border)] rounded-t-[10px] sm:rounded-[10px] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
          <span className="text-[13px] font-semibold">Search stocks/FX by description</span>
          <button type="button" className="text-[var(--color-text-sub)] cursor-pointer" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-[12px]">
          {turns.length === 0 && (
            <p className="text-[var(--color-text-sub)]">
              Try "AI stocks", "network layer stocks", "P/E &gt; 30", or a company name. Only
              symbols your broker actually offers can come back — anything else gets flagged, not
              invented.
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'text-right' : 'text-left'}>
              <span className={`inline-block rounded-[8px] px-2 py-1 max-w-[90%] ${t.role === 'user' ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-surface-2,rgba(127,127,127,0.1))]'}`}>
                {t.content}
              </span>
            </div>
          ))}
          {busy && <div className="text-[var(--color-text-sub)]">Searching…</div>}
        </div>
        {err && <div className="px-3 py-1 text-[11px] text-[var(--color-warning-text)]">{err}</div>}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-border)]">
          <input
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') send() }}
            placeholder="e.g. semiconductor stocks"
            className="glass-inset rounded-[7px] px-2 py-1.5 text-[12px] min-h-[32px] flex-1"
            disabled={busy}
          />
          <Button size="sm" onClick={send} disabled={busy || !draft.trim()}>Send</Button>
          {lastSymbols?.length > 0 && (
            <Button size="sm" variant="subtle" onClick={() => onApply?.(lastSymbols)}>
              Use these {lastSymbols.length}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
