// Agent Brief - wireframe-spec sticky summary card.
// Watching N symbols. X live, Y pending. Risk used: Z% / max%. Macro one-liner.
// [Arm ▸] / [Pause all ⏸] action buttons.

import Card from '../common/Card.jsx'
import Badge from '../common/Badge.jsx'
import Button from '../common/Button.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

export default function AgentBrief({ stories = [] }) {
  const { state, dispatch } = useStrategy()
  const { risk, news } = state

  const watching = stories.filter(s => s.state === 'WATCHING').length
  const live = stories.filter(s => s.state === 'LIVE').length
  const pending = stories.filter(s => s.state === 'PENDING').length

  // First meaningful sentence of the rundown as a macro one-liner.
  const macro = news.latestRundown
    ? news.latestRundown.split(/[.\n]/).find(l => l.trim().length > 10)?.trim() || null
    : null

  const toggleArm = () => dispatch({ type: 'RISK_TOGGLE_ARMED' })

  return (
    <Card className="sticky top-2 z-10">
      <div className="flex items-center gap-2 mb-1">
        <span className="t-section-label">◆ AGENT BRIEF</span>
        <span className="t-meta text-[var(--color-muted-light)] ml-auto">just now</span>
      </div>
      <p className="t-body text-[var(--color-text)] mb-1">
        Watching {watching} symbols.
        {live > 0 && <> {live} live trade{live !== 1 ? 's' : ''}.</>}
        {pending > 0 && <> {pending} pending.</>}
        {' '}Risk used: {risk.perTradePct}% / {risk.dailyMaxLossPct}% daily.
      </p>
      {macro && (
        <p className="t-sub text-[var(--color-text-sub)] mb-2">
          Macro: {macro}
        </p>
      )}
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant={risk.armed ? 'danger' : 'primary'} onClick={toggleArm}>
          {risk.armed ? 'Disarm ■' : 'Arm ▸'}
        </Button>
        <Badge tone={risk.armed ? 'up' : 'neutral'} pill>
          {risk.armed ? 'ARMED' : 'DISARMED'}
        </Badge>
      </div>
    </Card>
  )
}
