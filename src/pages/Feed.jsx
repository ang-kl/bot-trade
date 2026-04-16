// Agent Feed - story cards driven by the strategy-store watchlist.
// Scans enabled symbols through /api/scan for AI-generated theses.
// Bottom bar shows token usage and a discrete logout link.

import { useMemo, useState, useCallback, useEffect } from 'react'
import AgentBrief from '../components/AgentFeed/AgentBrief.jsx'
import Editorial from '../components/AgentFeed/Editorial.jsx'
import StoryCard from '../components/AgentFeed/StoryCard.jsx'
import TimelineStrip from '../components/AgentFeed/TimelineStrip.jsx'
import AskDock from '../components/AgentFeed/AskDock.jsx'
import TightenSLDialog from '../components/AgentFeed/TightenSLDialog.jsx'
import BottomBar from '../components/AgentFeed/BottomBar.jsx'
import Card from '../components/common/Card.jsx'
import Button from '../components/common/Button.jsx'
import Badge from '../components/common/Badge.jsx'
import { buildStory } from '../lib/story-builder.js'
import { useStrategy } from '../lib/strategy-store.js'

// Seed: turn each enabled watchlist symbol into a WATCHING story
// so the feed has content before the advisor runs.
function seedStories(watchlist, scanResults) {
  return watchlist
    .filter((w) => w.enabled)
    .map((w) => {
      const scan = scanResults[w.symbol]
      const story = buildStory(
        {
          id: `watch-${w.symbol}`,
          symbol: w.symbol,
          side: scan?.bias === 'short' ? 'short' : 'long',
          volume: 0,
          entryPrice: 0,
          currentPrice: 0,
          reasoning: scan?.thesis || null,
          confidence: scan?.confidence || null,
        },
        'WATCHING',
      )
      // Attach scan metadata for richer card rendering
      if (scan) {
        story.scanBias = scan.bias
        story.scanTimeframe = scan.timeframe
        story.scanSessionFit = scan.session_fit
        story.scanKeyLevels = scan.key_levels
      }
      return story
    })
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

async function runScan(symbols, timezone) {
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbols, timezone }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `scan ${res.status}`)
  return data
}

export default function Feed() {
  const { state, dispatch } = useStrategy()
  const [scanResults, setScanResults] = useState({})
  const [deskNote, setDeskNote] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState(null)

  const stories = useMemo(
    () => seedStories(state.watchlist, scanResults),
    [state.watchlist, scanResults],
  )

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
        showToast(story.reasoning || 'Thesis pending - agents not yet scanned.')
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

  const editorialText = deskNote || state.news.latestRundown || null

  // Auto-clean expired mutes so stories reappear.
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

  // Filter out dismissed and muted stories.
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

  const enabledSymbols = useMemo(
    () => state.watchlist.filter(w => w.enabled),
    [state.watchlist],
  )
  const enabledCount = enabledSymbols.length
  const isArmed = state.risk.armed
  const scannedCount = Object.keys(scanResults).length

  // --- Scanner ---
  const handleScan = useCallback(async () => {
    if (enabledSymbols.length === 0) return
    setScanning(true)
    setScanError(null)
    setDismissed(new Set())
    setMuted({})

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore'

    try {
      const data = await runScan(enabledSymbols, tz)
      // Map scan results by symbol
      const map = {}
      for (const s of (data.scans || [])) {
        if (s.symbol) map[s.symbol.toUpperCase()] = s
      }
      setScanResults(map)
      if (data.desk_note) setDeskNote(data.desk_note)
      if (data.usage?.output_tokens) {
        setTokenCount(prev => prev + data.usage.output_tokens)
      }
      const found = Object.values(map).filter(s => s.bias !== 'skip' && s.bias !== 'neutral').length
      showToast(`Scan complete. ${found} setups found across ${data.scans?.length || 0} symbols.`)
    } catch (e) {
      setScanError(e.message)
      showToast(`Scan failed: ${e.message}`)
    } finally {
      setScanning(false)
    }
  }, [enabledSymbols, showToast])

  const handleStartAI = useCallback(() => {
    dispatch({ type: 'RISK_TOGGLE_ARMED' })
    if (!isArmed) {
      // Arm + scan
      handleScan()
      showToast('AI trader armed. Scanning enabled symbols...')
    } else {
      showToast('AI trader disarmed.')
    }
  }, [isArmed, dispatch, showToast, handleScan])

  return (
    <section className="space-y-4">
      <AgentBrief stories={visibleStories} />

      {/* Desk note / editorial */}
      {editorialText ? (
        <Editorial text={editorialText} />
      ) : (
        <Editorial text="No desk notes yet. Hit scan to wake the agents up." />
      )}

      {/* Feed controls */}
      <Card className="flex items-center gap-3 flex-wrap">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleScan}
          disabled={enabledCount === 0 || scanning}
        >
          {scanning ? 'Scanning...' : `\u21BB Scan Watchlist (${enabledCount})`}
        </Button>
        {scannedCount > 0 && (
          <span className="t-meta text-[var(--color-text-sub)]">
            {scannedCount} scanned
          </span>
        )}
        <div className="flex-1" />
        <Badge tone={isArmed ? 'up' : 'neutral'} pill>
          {isArmed ? 'ARMED' : 'DISARMED'}
        </Badge>
        <Button
          size="sm"
          variant={isArmed ? 'danger' : 'primary'}
          onClick={handleStartAI}
          disabled={enabledCount === 0}
        >
          {isArmed ? '\u25A0 Stop AI' : '\u25B6 Start AI Trader'}
        </Button>
      </Card>

      {/* Scan error */}
      {scanError && (
        <Card className="border-l-4 border-l-[var(--color-down)]">
          <p className="t-sub text-[var(--color-down)]">{scanError}</p>
        </Card>
      )}

      {/* Scanning indicator */}
      {scanning && (
        <Card className="text-center py-6">
          <p className="t-body text-[var(--color-accent)] mb-1">Agents scanning...</p>
          <p className="t-meta text-[var(--color-muted)]">
            Analysing {enabledCount} symbols across active market sessions.
          </p>
        </Card>
      )}

      {/* Story cards */}
      {!scanning && visibleStories.length === 0 ? (
        <Card className="text-center py-8">
          <p className="t-body text-[var(--color-text-sub)] mb-2">
            No active stories yet.
          </p>
          <p className="t-meta text-[var(--color-muted)]">
            Enable symbols in Settings, then hit Scan or Start AI to wake the agents.
          </p>
        </Card>
      ) : !scanning && (
        <ul className="space-y-3">
          {visibleStories.map((story) => (
            <li key={story.id}>
              <TimelineStrip state={story.state} />
              <StoryCard story={story} onAction={handleAction} />
            </li>
          ))}
        </ul>
      )}
      {!scanning && visibleStories.length > 0 && (
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
