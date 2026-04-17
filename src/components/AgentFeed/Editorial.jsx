// Desk notes / narrative blurb above the feed. Accepts arbitrary text
// so the rundown briefing can pipe straight in.

import Card from '../common/Card.jsx'

export default function Editorial({ title = 'Desk notes', text }) {
  return (
    <Card>
      <h2 className="t-label mb-2">{title}</h2>
      {text ? (
        <p className="t-sub whitespace-pre-wrap text-[var(--color-text-sub)]">{text}</p>
      ) : (
        <p className="t-sub text-[var(--color-muted)]">
          No notes yet. The rundown briefing appears here once the News tab has generated one.
        </p>
      )}
    </Card>
  )
}
