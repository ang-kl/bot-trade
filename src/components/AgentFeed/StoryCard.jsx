// One trade / watching story. All visual data comes from buildStory()
// so this component is dumb — no business logic except dispatching actions.

import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'
import ProgressBar from './ProgressBar.jsx'

function stateTone(state) {
  if (state === 'WON') return 'up'
  if (state === 'LOST' || state === 'CANCELLED') return 'down'
  return 'neutral'
}

function formatPnl(pnl) {
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}${pnl.toFixed(2)}`
}

export default function StoryCard({ story, onAction }) {
  const {
    headline, state, confidence, reasoning, stopLoss, takeProfit,
    currentPrice, pnl, pnlPct, progressToTP, actions, side,
  } = story
  const headlineColor = side === 'short' ? 'text-[var(--color-down)]' : 'text-[var(--color-up)]'
  const pnlColor = pnl >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
  return (
    <Card>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className={`text-base font-semibold ${headlineColor}`}>{headline}</span>
        <Badge tone={stateTone(state)}>{state}</Badge>
      </div>
      <p className="text-xs text-[var(--color-fg-subtle)] mb-2">
        Agent • {confidence != null ? `Confidence ${confidence}/10` : 'Unscored'}
      </p>
      {reasoning && <p className="text-sm mb-3">{reasoning}</p>}
      <ProgressBar
        side={side}
        stopLoss={stopLoss}
        takeProfit={takeProfit}
        currentPrice={currentPrice}
        progressToTP={progressToTP}
      />
      <div className="flex items-center gap-3 text-xs my-2">
        <span className={pnlColor}>{formatPnl(pnl)}</span>
        <span className="text-[var(--color-fg-subtle)]">{pnlPct.toFixed(1)}% → TP</span>
      </div>
      <div className="flex gap-2 flex-wrap">
        {actions.includes('stop') && (
          <Button size="sm" variant="danger" onClick={() => onAction?.('stop', story)}>⏹ Stop</Button>
        )}
        {actions.includes('cancel') && (
          <Button size="sm" variant="danger" onClick={() => onAction?.('cancel', story)}>Cancel</Button>
        )}
        {actions.includes('tighten-sl') && (
          <Button size="sm" variant="ghost" onClick={() => onAction?.('tighten-sl', story)}>⇧ Tighten SL</Button>
        )}
        {actions.includes('why') && (
          <Button size="sm" variant="ghost" onClick={() => onAction?.('why', story)}>? Why</Button>
        )}
        {actions.includes('dismiss') && (
          <Button size="sm" variant="ghost" onClick={() => onAction?.('dismiss', story)}>Dismiss</Button>
        )}
      </div>
    </Card>
  )
}
