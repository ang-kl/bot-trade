// Market session strip — shows which markets are open/closed/opening soon.
// Sits below the main nav in App.jsx. Updates every 30s.

import { useState, useEffect } from 'react'

const MARKETS = [
  { id: 'sydney',    label: 'SYD',  flag: '\uD83C\uDDE6\uD83C\uDDFA', tz: 'Australia/Sydney',   open: 22, close: 5  },
  { id: 'tokyo',     label: 'TYO',  flag: '\uD83C\uDDEF\uD83C\uDDF5', tz: 'Asia/Tokyo',         open: 0,  close: 6  },
  { id: 'singapore', label: 'SGP',  flag: '\uD83C\uDDF8\uD83C\uDDEC', tz: 'Asia/Singapore',     open: 1,  close: 9  },
  { id: 'london',    label: 'LDN',  flag: '\uD83C\uDDEC\uD83C\uDDE7', tz: 'Europe/London',      open: 8,  close: 16 },
  { id: 'frankfurt', label: 'FRA',  flag: '\uD83C\uDDE9\uD83C\uDDEA', tz: 'Europe/Berlin',      open: 7,  close: 15 },
  { id: 'paris',     label: 'PAR',  flag: '\uD83C\uDDEB\uD83C\uDDF7', tz: 'Europe/Paris',       open: 8,  close: 16 },
  { id: 'nyse',      label: 'NYC',  flag: '\uD83C\uDDFA\uD83C\uDDF8', tz: 'America/New_York',   open: 14, close: 21 },
]

// Equity / FX sessions are closed on weekends (Sat UTC, Sun UTC until Sydney
// re-opens at 22:00 UTC for the Monday AEDT session). Crypto / 24-7 pairs
// would need a separate component — this bar is equity-focused.
function isOpen(market, now) {
  const day = now.getUTCDay()   // 0=Sun … 6=Sat
  const hour = now.getUTCHours()

  if (day === 6) return false                                    // Saturday
  if (day === 0) return market.id === 'sydney' && hour >= market.open   // Sunday → only Sydney re-opens late
  if (day === 5 && market.id === 'sydney' && hour >= 22) return false   // Fri 22:00+ UTC = Sat AEDT

  if (market.open < market.close) return hour >= market.open && hour < market.close
  return hour >= market.open || hour < market.close
}

function minsUntilOpen(market, now) {
  // Walk forward up to 4 days to find the next time this market opens.
  // Works for weekend skip (Sat → Mon) and Sydney's Sun-22-UTC edge case.
  const nowMs = now.getTime()
  for (let d = 0; d <= 4; d++) {
    const candidate = new Date(nowMs)
    candidate.setUTCDate(candidate.getUTCDate() + d)
    candidate.setUTCHours(market.open, 0, 0, 0)
    if (candidate.getTime() <= nowMs) continue
    if (isOpen(market, candidate)) {
      return Math.floor((candidate.getTime() - nowMs) / 60_000)
    }
  }
  return 0
}

function formatMinsUntil(mins) {
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatLocalTime(tz) {
  try {
    return new Date().toLocaleTimeString('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return '--:--'
  }
}

export default function MarketSessionBar() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const userTime = formatLocalTime(userTz)
  const utcTime = formatLocalTime('UTC')
  const nyTime = formatLocalTime('America/New_York')

  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div
        style={{ maxWidth: 'var(--content-max)', padding: '0 var(--content-pad)' }}
        className="mx-auto py-1.5"
      >
        {/* Top row: date + times — stacks on mobile */}
        <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap pb-1 mb-1 border-b border-[var(--color-border)] sm:border-0 sm:pb-0 sm:mb-0 sm:float-none">
          <span className="text-[10px] font-mono text-[var(--color-muted)]">{dateStr}</span>
          <span className="text-[10px] font-mono text-[var(--color-text-sub)]">
            {userTime} <span className="text-[var(--color-muted)]">({userTz.split('/').pop()})</span>
          </span>
          <span className="text-[10px] font-mono text-[var(--color-muted)]">
            {utcTime} UTC
          </span>
          <span className="text-[10px] font-mono text-[var(--color-muted)]">
            {nyTime} NY
          </span>
        </div>

        {/* Market pills — wraps on mobile */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {MARKETS.map(m => {
            const open = isOpen(m, now)
            const mins = !open ? minsUntilOpen(m, now) : 0
            return (
              <div
                key={m.id}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                  open
                    ? 'bg-[var(--color-success-bg)] border-[var(--color-success-border)] text-[var(--color-up)]'
                    : 'bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-muted)]'
                }`}
                title={`${m.label}: ${formatLocalTime(m.tz)} local`}
              >
                <span>{m.flag}</span>
                <span>{m.label}</span>
                {open ? (
                  <span className="text-[8px]">{'\u25CF'}</span>
                ) : (
                  <span className="text-[9px] font-normal opacity-70">
                    {formatMinsUntil(mins)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
