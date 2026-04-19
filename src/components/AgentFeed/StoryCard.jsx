// Story card - per-state rendering following the feed wireframe.
// WATCHING / PENDING / LIVE / WON / LOST / CANCELLED.
// All visual data comes from buildStory(); this component is presentational.

import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'
import ProgressBar from './ProgressBar.jsx'

function stateTone(state) {
  if (state === 'WON') return 'up'
  if (state === 'LOST' || state === 'CANCELLED') return 'down'
  if (state === 'LIVE') return 'info'
  if (state === 'PENDING') return 'warning'
  return 'neutral'
}

function formatPnl(pnl) {
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}$${Math.abs(pnl).toFixed(2)}`
}

function timeAgo(ts) {
  if (!ts) return ''
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime())
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// -- Action buttons per state --

function WatchingActions({ story, onAction }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="ghost" onClick={() => onAction?.('mute', story)}>Mute 1h</Button>
      <Button size="sm" variant="subtle" onClick={() => onAction?.('remove', story)}>Remove from watchlist</Button>
    </div>
  )
}

function PendingActions({ story, onAction }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="primary" onClick={() => onAction?.('approve', story)}>✓ Approve</Button>
      <Button size="sm" variant="danger" onClick={() => onAction?.('cancel', story)}>✗ Cancel</Button>
      <Button size="sm" variant="ghost" onClick={() => onAction?.('why', story)}>? Why</Button>
    </div>
  )
}

function LiveActions({ story, onAction }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="danger" onClick={() => onAction?.('stop', story)}>⏹ Stop</Button>
      <Button size="sm" variant="ghost" onClick={() => onAction?.('why', story)}>? Why</Button>
      <Button size="sm" variant="ghost" onClick={() => onAction?.('tighten-sl', story)}>⇧ Tighten SL</Button>
    </div>
  )
}

function ClosedActions({ story, onAction }) {
  return (
    <div className="flex gap-2 flex-wrap">
      <Button size="sm" variant="ghost" onClick={() => onAction?.('timeline', story)}>View timeline</Button>
      {story.state === 'WON' && (
        <Button size="sm" variant="ghost" onClick={() => onAction?.('save-vault', story)}>Save to Vault</Button>
      )}
      {story.state === 'LOST' && (
        <Button size="sm" variant="ghost" onClick={() => onAction?.('post-mortem', story)}>Post-mortem</Button>
      )}
      {story.state === 'CANCELLED' && (
        <Button size="sm" variant="ghost" onClick={() => onAction?.('why', story)}>? Why</Button>
      )}
    </div>
  )
}

// -- Main card --

export default function StoryCard({ story, onAction }) {
  const {
    headline, state, confidence, reasoning, stopLoss, takeProfit,
    currentPrice, pnl, pnlPct, progressToTP, side, timestamp,
    entryPrice,
  } = story
  const headlineColor = state === 'WATCHING'
    ? 'text-[var(--color-text)]'
    : side === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-up)]'
  const pnlColor = pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
  const ts = timeAgo(timestamp)

  return (
    <Card>
      {/* Header line */}
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`t-body font-bold ${headlineColor}`}>{headline}</span>
        <Badge tone={stateTone(state)}>{state}</Badge>
        {ts && <span className="t-meta text-[var(--color-muted-light)]">{ts}</span>}
      </div>

      {/* Agent + confidence */}
      <p className="t-meta text-[var(--color-muted)] mb-2">
        Agent{confidence != null ? ` - Confidence ${confidence}/10` : ' - Unscored'}
      </p>

      {/* Reasoning / thesis */}
      {reasoning ? (
        <p className="t-sub text-[var(--color-text-sub)] mb-2">{reasoning}</p>
      ) : state === 'WATCHING' ? (
        <p className="t-sub text-[var(--color-muted)] italic mb-2">Waiting for scan - hit Scan or Start AI above.</p>
      ) : null}

      {/* Scan metadata for WATCHING stories */}
      {state === 'WATCHING' && story.scanBias && (
        <div className="flex flex-wrap gap-2 mb-3 t-meta">
          <Badge tone={story.scanBias === 'long' ? 'up' : story.scanBias === 'short' ? 'down' : 'neutral'} pill>
            {story.scanBias === 'skip' ? 'SKIP' : story.scanBias?.toUpperCase()}
          </Badge>
          {story.scanTimeframe && (
            <span className="text-[var(--color-text-sub)]">{story.scanTimeframe}</span>
          )}
          {story.scanSessionFit && (
            <span className="text-[var(--color-muted)]">Session: {story.scanSessionFit}</span>
          )}
        </div>
      )}
      {state === 'WATCHING' && story.scanKeyLevels && story.scanKeyLevels !== 'watching' && (
        <p className="t-meta text-[var(--color-muted)] mb-3">Levels: {story.scanKeyLevels}</p>
      )}

      {/* PENDING: Entry / SL / TP line */}
      {state === 'PENDING' && entryPrice != null && (
        <p className="t-label text-[var(--color-text-sub)] mb-3">
          Entry {entryPrice?.toFixed?.(5) || '—'}
          {stopLoss != null && <span className="ml-3">SL {stopLoss.toFixed?.(5) || '—'}</span>}
          {takeProfit != null && <span className="ml-3">TP {takeProfit.toFixed?.(5) || '—'}</span>}
        </p>
      )}

      {/* LIVE: progress bar + PnL */}
      {state === 'LIVE' && (
        <>
          <ProgressBar
            side={side}
            stopLoss={stopLoss}
            takeProfit={takeProfit}
            currentPrice={currentPrice}
            progressToTP={progressToTP}
          />
          <div className="flex items-center gap-3 t-meta my-2">
            <span className={pnlColor}>{formatPnl(pnl)}</span>
            <span className="text-[var(--color-muted)]">{pnlPct.toFixed(1)}% → TP</span>
          </div>
        </>
      )}

      {/* WON/LOST: closed summary */}
      {(state === 'WON' || state === 'LOST') && (
        <div className="t-sub text-[var(--color-text-sub)] mb-3">
          {entryPrice != null && <span>Entry {entryPrice.toFixed?.(5) || '—'}</span>}
          {pnl !== 0 && (
            <span className={`ml-2 font-semibold ${pnlColor}`}>{formatPnl(pnl)}</span>
          )}
        </div>
      )}

      {/* Action buttons per state */}
      {state === 'WATCHING' && <WatchingActions story={story} onAction={onAction} />}
      {state === 'PENDING' && <PendingActions story={story} onAction={onAction} />}
      {state === 'LIVE' && <LiveActions story={story} onAction={onAction} />}
      {(state === 'WON' || state === 'LOST' || state === 'CANCELLED') && (
        <ClosedActions story={story} onAction={onAction} />
      )}
    </Card>
  )
}
