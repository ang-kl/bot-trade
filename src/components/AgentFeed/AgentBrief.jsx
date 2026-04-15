// Sticky summary header above the story list. Counts by state so the
// trader can see everything the agent is watching / has live at a glance.

import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'

const ORDER = ['WATCHING', 'PENDING', 'LIVE', 'WON', 'LOST', 'CANCELLED']

function toneFor(state) {
  if (state === 'WON') return 'up'
  if (state === 'LOST' || state === 'CANCELLED') return 'down'
  return 'neutral'
}

export default function AgentBrief({ stories = [] }) {
  const counts = stories.reduce((acc, s) => {
    acc[s.state] = (acc[s.state] || 0) + 1
    return acc
  }, {})
  const total = stories.length
  return (
    <Card className="sticky top-2 z-10">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="font-semibold">Agent brief</h2>
        <span className="text-xs text-[var(--color-fg-subtle)]">{total} total</span>
        <div className="flex gap-2 flex-wrap ml-auto">
          {ORDER.map((k) => (
            <Badge key={k} tone={toneFor(k)}>
              {k} {counts[k] || 0}
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  )
}
