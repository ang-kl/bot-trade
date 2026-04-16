// Ask Dock — small chat-bar at the bottom of the feed. Hits /api/chat
// which forwards the question to Claude along with the current watchlist
// and rundown so replies stay grounded in what the user is actually
// watching. Non-streaming for now; upgrade to SSE when the API does.

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
    <Card>
      <h2 className="font-semibold mb-2">Ask dock</h2>
      <div className="flex gap-2 mb-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Why did we buy AAPL?"
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          aria-label="Question"
        />
        <Button size="sm" onClick={submit} disabled={busy || !q.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </Button>
      </div>
      {error && <p className="text-sm text-[var(--color-down)]">{error}</p>}
      {reply && <p className="text-sm whitespace-pre-wrap">{reply}</p>}
    </Card>
  )
}
