// Thin SL → TP track with a filled bar showing progressToTP.
// Colour matches the side: blue for long, red for short. Never green.

export default function ProgressBar({ side, stopLoss, takeProfit, currentPrice, progressToTP }) {
  const pct = Math.max(0, Math.min(100, (progressToTP || 0) * 100))
  const trackColor = side === 'short' ? 'var(--color-down)' : 'var(--color-up)'
  return (
    <div>
      <div className="flex justify-between text-[10px] text-[var(--color-fg-subtle)] mb-1">
        <span>SL {stopLoss ?? '—'}</span>
        <span aria-hidden>now {currentPrice ?? '—'}</span>
        <span>TP {takeProfit ?? '—'}</span>
      </div>
      <div
        className="h-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Progress to take profit"
      >
        <div className="h-full" style={{ width: `${pct}%`, background: trackColor }} />
      </div>
    </div>
  )
}
