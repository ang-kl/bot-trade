// News tab - Market Rundown configuration + Telegram channel curation.
// Two-step prompt flow: (1) build a structure outline, (2) generate today's
// briefing against that structure. Sources include wires, Telegram, X, RSS,
// and ForexFactory. The API lives at api/rundown.js.

import { useState, useCallback } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Input from '../common/Input.jsx'
import Badge from '../common/Badge.jsx'
import {
  useStrategy,
  SOURCE_OPTIONS,
} from '../../lib/strategy-store.js'

const SOURCE_LABELS = {
  osinet: 'OSINet',
  reuters: 'Reuters',
  bloomberg: 'Bloomberg',
  ft: 'FT',
  telegram: 'Telegram',
  x: 'X.com',
  rss: 'RSS',
  forexfactory: 'ForexFactory',
}

async function callRundown(action, body = {}) {
  const res = await fetch('/api/rundown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `rundown ${action} ${res.status}`)
  return data
}

async function callTelegramFeed(action, body = {}) {
  const res = await fetch('/api/telegram-feed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `telegram-feed ${action} ${res.status}`)
  return data
}

export default function NewsTab() {
  const { state, dispatch } = useStrategy()
  const { sources, telegramChannels, structure, latestRundown, lastGeneratedAt } = state.news
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  // Telegram channel management
  const [channelDraft, setChannelDraft] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState(null)
  const [feedPreview, setFeedPreview] = useState(null)
  const [feedLoading, setFeedLoading] = useState(false)

  const onBuildStructure = async () => {
    setBusy('structure'); setError(null)
    try {
      const data = await callRundown('structure')
      dispatch({ type: 'NEWS_SET_STRUCTURE', structure: data.markdown ?? null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const onGenerate = async () => {
    setBusy('generate'); setError(null)
    try {
      const enabledChannels = telegramChannels.filter(c => c.enabled).map(c => c.username || c.name)
      const data = await callRundown('generate', { sources, telegramChannels: enabledChannels, structure })
      dispatch({ type: 'NEWS_SET_RUNDOWN', rundown: data.markdown ?? null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const handleAddChannel = useCallback(async () => {
    const raw = channelDraft.trim().replace(/^@/, '')
    if (!raw) return
    // Verify channel if bot token is available
    if (state.telegram.botToken) {
      try {
        const data = await callTelegramFeed('verify', {
          botToken: state.telegram.botToken,
          username: raw,
        })
        if (data.ok && data.channel) {
          dispatch({
            type: 'NEWS_ADD_TELEGRAM_CHANNEL',
            name: data.channel.title || raw,
            username: data.channel.username || raw,
          })
          setChannelDraft('')
          setDiscoverError(null)
          return
        }
        // Channel not accessible by bot — still add but warn
        setDiscoverError(`@${raw}: ${data.error || 'not accessible'}. ${data.hint || ''}`)
      } catch {
        // API call failed — still add manually
      }
    }
    dispatch({
      type: 'NEWS_ADD_TELEGRAM_CHANNEL',
      name: raw,
      username: raw,
    })
    setChannelDraft('')
  }, [channelDraft, dispatch, state.telegram.botToken])

  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setDiscoverError(null)
    try {
      const data = await callTelegramFeed('discover', {
        botToken: state.telegram.botToken,
      })
      // Auto-add discovered channels
      for (const ch of (data.channels || [])) {
        dispatch({
          type: 'NEWS_ADD_TELEGRAM_CHANNEL',
          name: ch.title || ch.username || '',
          username: ch.username || '',
        })
      }
    } catch (e) {
      setDiscoverError(e.message)
    } finally {
      setDiscovering(false)
    }
  }, [state.telegram.botToken, dispatch])

  const handlePreviewFeed = useCallback(async () => {
    setFeedLoading(true)
    setFeedPreview(null)
    try {
      const enabledChannels = telegramChannels.filter(c => c.enabled).map(c => c.username || c.name)
      const data = await callTelegramFeed('fetch', {
        botToken: state.telegram.botToken,
        channels: enabledChannels,
      })
      setFeedPreview(data.messages || [])
    } catch (e) {
      setFeedPreview([])
      setDiscoverError(e.message)
    } finally {
      setFeedLoading(false)
    }
  }, [telegramChannels, state.telegram.botToken])

  return (
    <div className="space-y-4">
      {/* Sources */}
      <Card>
        <h2 className="t-label mb-2">News Sources</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Select sources for the daily market rundown. The AI curates and
          synthesises across all enabled sources.
        </p>
        <div className="flex gap-3 flex-wrap">
          {SOURCE_OPTIONS.map((s) => (
            <label key={s} className="t-sub flex items-center gap-1.5 cursor-pointer min-h-[36px]">
              <input
                type="checkbox"
                checked={sources.includes(s)}
                onChange={() => dispatch({ type: 'NEWS_TOGGLE_SOURCE', source: s })}
                className="w-4 h-4 accent-[var(--color-accent)]"
              />
              <span className="font-medium">{SOURCE_LABELS[s] || s}</span>
            </label>
          ))}
        </div>
      </Card>

      {/* Telegram Channels */}
      <Card>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="t-label">Telegram Channels</h2>
          <Badge tone="info" pill>{telegramChannels.length} channels</Badge>
        </div>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Add market news Telegram channels. Messages from enabled channels
          are curated as part of the daily rundown when Telegram source is active.
        </p>

        {/* Add channel */}
        <div className="flex gap-2 mb-3">
          <Input
            value={channelDraft}
            onChange={(e) => setChannelDraft(e.target.value)}
            placeholder="@channel_username"
            onKeyDown={(e) => e.key === 'Enter' && handleAddChannel()}
            className="flex-1"
          />
          <Button size="sm" onClick={handleAddChannel} disabled={!channelDraft.trim()}>
            Add
          </Button>
          {state.telegram.botToken && (
            <Button size="sm" variant="ghost" onClick={handleDiscover} disabled={discovering}>
              {discovering ? 'Discovering...' : 'Discover'}
            </Button>
          )}
        </div>

        {discoverError && (
          <p className="t-meta text-[var(--color-down)] mb-2">{discoverError}</p>
        )}

        {state.telegram.botToken && telegramChannels.length === 0 && (
          <div className="mb-3 p-2 rounded-[7px] bg-[var(--color-accent-soft)] text-[11px] text-[var(--color-text-sub)]">
            <span className="font-bold text-[var(--color-accent)]">Tip:</span>{' '}
            Discover only finds channels where your bot has unread messages.
            For public channels, type the @username above and click Add — the bot will verify access automatically.
            Make sure your bot is a member of each channel (add via Telegram &gt; Channel Info &gt; Admins/Members).
          </div>
        )}

        {/* Channel list */}
        {telegramChannels.length > 0 ? (
          <div className="space-y-1.5 mb-3">
            {telegramChannels.map(ch => (
              <div
                key={ch.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-[7px] bg-[var(--color-bg)] border border-[var(--color-border)]"
              >
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={() => dispatch({ type: 'NEWS_TOGGLE_TELEGRAM_CHANNEL', id: ch.id })}
                  className="w-4 h-4 accent-[var(--color-accent)]"
                />
                <span className="t-sub font-medium flex-1">
                  {ch.name || ch.username}
                  {ch.username && ch.username !== ch.name && (
                    <span className="text-[var(--color-muted)] ml-1">@{ch.username}</span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dispatch({ type: 'NEWS_REMOVE_TELEGRAM_CHANNEL', id: ch.id })}
                  className="text-[var(--color-down)] text-[10px]"
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="t-meta text-[var(--color-muted)] mb-3">
            No channels added. Enter a channel username or use Discover to find channels your bot can access.
          </p>
        )}

        {/* Preview feed */}
        {telegramChannels.some(c => c.enabled) && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={handlePreviewFeed}
              disabled={feedLoading}
            >
              {feedLoading ? 'Loading...' : 'Preview Latest Messages'}
            </Button>
            {feedPreview && feedPreview.length > 0 && (
              <div className="mt-2 max-h-48 overflow-auto bg-[var(--color-bg)] rounded-[7px] border border-[var(--color-border)] p-2 space-y-1">
                {feedPreview.slice(0, 20).map((msg, i) => (
                  <div key={i} className="text-[11px]">
                    <span className="font-bold text-[var(--color-accent)]">{msg.channel}</span>
                    <span className="text-[var(--color-muted)] ml-1">
                      {msg.date ? new Date(msg.date).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
                    </span>
                    <p className="text-[var(--color-text-sub)] truncate">{msg.text}</p>
                  </div>
                ))}
              </div>
            )}
            {feedPreview && feedPreview.length === 0 && (
              <p className="mt-2 t-meta text-[var(--color-muted)]">No recent messages found.</p>
            )}
          </div>
        )}
      </Card>

      {/* Structure (Prompt 1) */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Structure (Prompt 1)</h2>
          <Button size="sm" variant="ghost" onClick={onBuildStructure} disabled={busy === 'structure'}>
            {busy === 'structure' ? 'Building...' : 'Rebuild'}
          </Button>
        </div>
        {structure ? (
          <pre className="t-meta whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded-[7px] border border-[var(--color-border)]">{structure}</pre>
        ) : (
          <p className="t-sub text-[var(--color-text-sub)]">No structure cached. Click Rebuild to generate the markdown outline that every daily rundown will follow.</p>
        )}
      </Card>

      {/* Today's rundown (Prompt 2) */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Today's Rundown (Prompt 2)</h2>
          <Button size="sm" onClick={onGenerate} disabled={busy === 'generate'}>
            {busy === 'generate' ? 'Generating...' : 'Generate'}
          </Button>
        </div>
        {error && <p className="t-sub text-[var(--color-down)] mb-2">{error}</p>}
        {lastGeneratedAt && (
          <p className="t-meta text-[var(--color-text-sub)] mb-2">
            Last generated {new Date(lastGeneratedAt).toLocaleString()}
          </p>
        )}
        {latestRundown ? (
          <pre className="t-meta whitespace-pre-wrap max-h-96 overflow-auto bg-[var(--color-bg)] p-2 rounded-[7px] border border-[var(--color-border)]">{latestRundown}</pre>
        ) : (
          <p className="t-sub text-[var(--color-text-sub)]">No rundown yet. Click Generate to produce today's briefing.</p>
        )}
      </Card>
    </div>
  )
}
