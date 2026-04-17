// Ask Dock - chat bar at the bottom of the feed. Hits /api/chat with
// the current watchlist and rundown as grounding context.

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Input from '../common/Input.jsx'
import Button from '../common/Button.jsx'

export default function AskDock({ context, onAsk }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState(null)
  const [error, setError] = useState(null)

  const submit = async () => {
    const question = q.trim()
    if (!question) return
    setBusy(true); setReply(null); setError(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: question, context }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `chat ${res.status}`)
      setReply(data.answer || '(no reply)')
      onAsk?.(question, data)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-t-2 border-t-[var(--color-accent)]">
      <p className="t-section-label mb-2">ASK DOCK</p>
      <div className="flex gap-2 mb-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask the agent about any trade or the market..."
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
          aria-label="Question"
        />
        <Button size="sm" onClick={submit} disabled={busy || !q.trim()}>
          {busy ? 'Asking...' : 'Ask'}
        </Button>
      </div>
      <p className="t-meta text-[var(--color-muted-light)] mb-2">
        e.g. "why are you bullish BTC?" - "pause EURUSD for 2h"
      </p>
      {error && <p className="t-sub text-[var(--color-down)]">{error}</p>}
      {reply && <p className="t-sub whitespace-pre-wrap text-[var(--color-text-sub)]">{reply}</p>}
    </Card>
  )
}
