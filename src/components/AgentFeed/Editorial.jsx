// Desk notes / narrative blurb above the feed. Accepts arbitrary text
// so Phase 6 can pipe the rundown briefing straight in.

import Card from '../common/Card.jsx'

export default function Editorial({ title = 'Desk notes', text }) {
  return (
    <Card>
      <h2 className="font-semibold mb-2">{title}</h2>
      {text ? (
        <p className="text-sm whitespace-pre-wrap">{text}</p>
      ) : (
        <p className="text-sm text-[var(--color-fg-subtle)]">
          No notes yet. The rundown briefing will land here once Phase 4's news tab has generated one.
        </p>
      )}
    </Card>
  )
}
