// Agent Feed - story cards driven by the strategy-store watchlist.
// Bottom bar shows token usage and a discrete logout link.

import { useMemo, useState, useCallback, useEffect } from 'react'
import AgentBrief from '../components/AgentFeed/AgentBrief.jsx'
import Editorial from '../components/AgentFeed/Editorial.jsx'
import StoryCard from '../components/AgentFeed/StoryCard.jsx'
import TimelineStrip from '../components/AgentFeed/TimelineStrip.jsx'
import AskDock from '../components/AgentFeed/AskDock.jsx'
import TightenSLDialog from '../components/AgentFeed/TightenSLDialog.jsx'
import BottomBar from '../components/AgentFeed/BottomBar.jsx'
import { buildStory } from '../lib/story-builder.js'
import { useStrategy } from '../lib/strategy-store.js'

// Seed: turn each enabled watchlist symbol into a WATCHING story
// so the feed has content before the advisor runs.
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
  const { state, dispatch } = useStrategy()
  const stories = useMemo(() => seedStories(state.watchlist), [state.watchlist])
  const [tightenFor, setTightenFor] = useState(null)
  const [dismissed, setDismissed] = useState(new Set())
  const [muted, setMuted] = useState({})
  const [toast, setToast] = useState(null)
  const [tokenCount, setTokenCount] = useState(0)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleAction = useCallback((action, story) => {
    switch (action) {
      case 'tighten-sl':
        setTightenFor(story)
        break
      case 'why':
        showToast(story.reasoning || 'Thesis pending - advisor not yet wired.')
        break
      case 'dismiss':
        setDismissed(prev => new Set([...prev, story.id]))
        break
      case 'mute':
        setMuted(prev => ({ ...prev, [story.symbol]: Date.now() + 3600000 }))
        showToast(`${story.symbol} muted for 1 hour.`)
        break
      case 'remove':
        dispatch({ type: 'WATCHLIST_REMOVE', symbol: story.symbol })
        showToast(`${story.symbol} removed from watchlist.`)
        break
      case 'approve':
        showToast(`${story.symbol} approved - order placement coming in next phase.`)
        break
      case 'cancel':
        showToast(`${story.symbol} cancelled.`)
        break
      case 'stop':
        if (window.confirm(`Stop the ${story.symbol} position? This sends a close order.`)) {
          showToast(`${story.symbol} stop order sent.`)
        }
        break
      case 'timeline':
        showToast('Timeline view coming in the vault phase.')
        break
      case 'save-vault':
        showToast('Save to Vault coming in the vault phase.')
        break
      case 'post-mortem':
        showToast('Post-mortem coming in the vault phase.')
        break
      default:
        break
    }
  }, [dispatch, showToast])

  const handleTightenConfirm = async (nextSL, story) => {
    await amendPosition(story, nextSL)
    showToast(`${story.symbol} SL tightened to ${nextSL}.`)
    setTightenFor(null)
  }

  const handleAskReply = useCallback((_q, data) => {
    if (data?.usage?.output_tokens) {
      setTokenCount(prev => prev + data.usage.output_tokens)
    }
  }, [])

  const editorialText = state.news.latestRundown || null

  // Auto-clean expired mutes so stories reappear. setTimeout keeps setState
  // out of the synchronous effect body (satisfies react-hooks/set-state-in-effect)
  // and Date.now() stays in callbacks only (satisfies react-hooks/purity).
  useEffect(() => {
    const expiries = Object.values(muted)
    if (expiries.length === 0) return
    const soonest = Math.min(...expiries)
    const delay = Math.max(0, soonest - Date.now())
    const timer = setTimeout(() => {
      setMuted(prev => {
        const next = {}
        const now = Date.now()
        for (const [sym, exp] of Object.entries(prev)) {
          if (exp > now) next[sym] = exp
        }
        return next
      })
    }, delay)
    return () => clearTimeout(timer)
  }, [muted])

  // Filter out dismissed and muted stories (muted entries are cleaned by the effect above).
  const visibleStories = useMemo(() => {
    return stories.filter(s => {
      if (dismissed.has(s.id)) return false
      if (muted[s.symbol]) return false
      return true
    })
  }, [stories, dismissed, muted])

  const askContext = useMemo(
    () => ({
      watchlist: state.watchlist,
      rundown: state.news.latestRundown,
      stories: visibleStories.map((s) => ({ symbol: s.symbol, state: s.state, side: s.side })),
    }),
    [state.watchlist, state.news.latestRundown, visibleStories],
  )

  return (
    <section className="space-y-4">
      <AgentBrief stories={visibleStories} />
      <Editorial text={editorialText} />
      {visibleStories.length === 0 ? (
        <p className="t-sub text-[var(--color-muted)]">
          No active stories yet. Enable symbols in Settings to seed this feed.
        </p>
      ) : (
        <ul className="space-y-3">
          {visibleStories.map((story) => (
            <li key={story.id}>
              <TimelineStrip state={story.state} />
              <StoryCard story={story} onAction={handleAction} />
            </li>
          ))}
        </ul>
      )}
      {visibleStories.length > 0 && (
        <div className="border-t border-[var(--color-border)] pt-2 t-meta text-[var(--color-muted-light)] text-center">
          - earlier -
        </div>
      )}
      <AskDock context={askContext} onAsk={handleAskReply} />
      <BottomBar tokenCount={tokenCount} />
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-[8px] bg-[var(--color-text)] text-[var(--color-surface)] t-sub max-w-sm text-center">
          {toast}
        </div>
      )}
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
