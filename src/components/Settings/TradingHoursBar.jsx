// 24-hour trading hours bar — visual representation of when a symbol trades.
// Colored segments show active hours, grey = closed. Red line = now.

import { getHoursForSymbol, isTradingNow } from '../../lib/trading-hours.js'

const HOUR_LABELS = [0, 4, 8, 12, 16, 20]

export default function TradingHoursBar({ symbol, compact = false }) {
  const hours = getHoursForSymbol(symbol)
  const nowUTC = new Date().getUTCHours() + new Date().getUTCMinutes() / 60
  const trading = isTradingNow(symbol)

  // Build a 24-slot array: true = trading, false = closed
  const slots = Array.from({ length: 48 }, (_, i) => {
    const hour = i / 2
    return hours.some(h => {
      if (h.open < h.close) return hour >= h.open && hour < h.close
      return hour >= h.open || hour < h.close
    })
  })

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="flex h-[6px] w-[96px] rounded-full overflow-hidden bg-[var(--color-bg)] border border-[var(--color-border)]">
          {slots.map((active, i) => (
            <div
              key={i}
              className={active ? 'bg-[var(--color-accent)]' : 'bg-transparent'}
              style={{ width: `${100 / 48}%` }}
            />
          ))}
          {/* Now marker */}
          <div
            className="absolute h-[6px] w-[1px] bg-[var(--color-down)]"
            style={{ left: `${(nowUTC / 24) * 96}px` }}
          />
        </div>
        <span className={`text-[9px] font-bold ${trading ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'}`}>
          {trading ? 'OPEN' : 'CLOSED'}
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {/* Hour labels */}
      <div className="flex justify-between text-[9px] text-[var(--color-muted)] font-mono px-0.5">
        {HOUR_LABELS.map(h => (
          <span key={h} style={{ width: `${100 / HOUR_LABELS.length}%` }}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
        <span>24</span>
      </div>
      {/* Bar */}
      <div className="relative flex h-[10px] rounded-[3px] overflow-hidden bg-[var(--color-bg)] border border-[var(--color-border)]">
        {slots.map((active, i) => (
          <div
            key={i}
            className={active
              ? 'bg-[var(--color-accent)]/60'
              : 'bg-transparent'
            }
            style={{ width: `${100 / 48}%` }}
          />
        ))}
        {/* Now marker */}
        <div
          className="absolute top-0 bottom-0 w-[2px] bg-[var(--color-down)] z-10"
          style={{ left: `${(nowUTC / 24) * 100}%` }}
        />
      </div>
      {/* Status */}
      <div className="flex items-center gap-2 text-[10px]">
        <span className={`font-bold ${trading ? 'text-[var(--color-up)]' : 'text-[var(--color-muted)]'}`}>
          {trading ? '\u25CF OPEN' : '\u25CB CLOSED'}
        </span>
        <span className="text-[var(--color-muted)]">UTC hours</span>
        <span className="text-[var(--color-down)] font-mono">\u25C0 now</span>
      </div>
    </div>
  )
}
