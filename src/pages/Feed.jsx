// Agent Feed — Phase 5. Story cards driven by the strategy-store watchlist
// (until the advisor endpoint starts emitting real positions). Tighten-SL
// hits api/ctrader.js amend-position; other actions are wired but currently
// route through the same thin client so the UI is one upgrade away from
// real execution.

import { useMemo, useState } from 'react'
import AgentBrief from '../components/AgentFeed/AgentBrief.jsx'
import Editorial from '../components/AgentFeed/Editorial.jsx'
import StoryCard from '../components/AgentFeed/StoryCard.jsx'
import TimelineStrip from '../components/AgentFeed/TimelineStrip.jsx'
import AskDock from '../components/AgentFeed/AskDock.jsx'
import TightenSLDialog from '../components/AgentFeed/TightenSLDialog.jsx'
import { buildStory } from '../lib/story-builder.js'
import { useStrategy } from '../lib/strategy-store.js'

// Empty-state seed: turn each enabled watchlist symbol into a WATCHING
// story so the page has content before the advisor runs.
function seedStories(watchlist) {
  return watchlist
    .filter((w) => w.enabled)
    .map((w) =>
      buildStory(
        {
          id: `watch-${w.symbol}`,
          symbol: w.symbol,
          side: 'long',
          volume: 0,
          entryPrice: 0,
          currentPrice: 0,
        },
        'WATCHING',
      ),
    )
}

async function amendPosition(story, nextStopLoss) {
  const body = {
    action: 'amend-position',
    positionId: story.id,
    stopLoss: nextStopLoss,
    takeProfit: story.takeProfit,
  }
  const res = await fetch('/api/ctrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `ctrader amend ${res.status}`)
  return data
}

export default function Feed() {
  const { state } = useStrategy()
  const stories = useMemo(() => seedStories(state.watchlist), [state.watchlist])
  const [tightenFor, setTightenFor] = useState(null)
  const [actionLog, setActionLog] = useState([])

  const logAction = (entry) => setActionLog((prev) => [...prev.slice(-4), entry])

  const handleAction = (action, story) => {
    if (action === 'tighten-sl') {
      setTightenFor(story)
      return
    }
    logAction({ action, symbol: story.symbol, at: new Date().toISOString() })
  }

  const handleTightenConfirm = async (nextSL, story) => {
    await amendPosition(story, nextSL)
    logAction({ action: 'tighten-sl', symbol: story.symbol, sl: nextSL, at: new Date().toISOString() })
    setTightenFor(null)
  }

  const editorialText = state.news.latestRundown || null

  return (
    <section className="space-y-4">
      <AgentBrief stories={stories} />
      <Editorial text={editorialText} />
      {stories.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-subtle)]">
          No active stories yet. Add symbols to your watchlist in Settings to seed this feed.
        </p>
      ) : (
        <ul className="space-y-3">
          {stories.map((story) => (
            <li key={story.id}>
              <TimelineStrip state={story.state} />
              <StoryCard story={story} onAction={handleAction} />
            </li>
          ))}
        </ul>
      )}
      {actionLog.length > 0 && (
        <details className="text-xs text-[var(--color-fg-subtle)]">
          <summary>Recent actions ({actionLog.length})</summary>
          <ul className="mt-1 space-y-1">
            {actionLog.map((a, i) => (
              <li key={i}>{a.at} · {a.action} · {a.symbol}{a.sl != null ? ` · SL ${a.sl}` : ''}</li>
            ))}
          </ul>
        </details>
      )}
      <AskDock />
      {tightenFor && (
        <TightenSLDialog
          story={tightenFor}
          onCancel={() => setTightenFor(null)}
          onConfirm={handleTightenConfirm}
        />
      )}
    </section>
  )
}
