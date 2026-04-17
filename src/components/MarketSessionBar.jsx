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

function isOpen(market, utcHour) {
  if (market.open < market.close) return utcHour >= market.open && utcHour < market.close
  return utcHour >= market.open || utcHour < market.close
}

function minsUntilOpen(market, utcHour, utcMin) {
  const nowMins = utcHour * 60 + utcMin
  const openMins = market.open * 60
  let diff = openMins - nowMins
  if (diff <= 0) diff += 1440
  return diff
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

  const utcH = now.getUTCHours()
  const utcM = now.getUTCMinutes()

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
            const open = isOpen(m, utcH)
            const mins = !open ? minsUntilOpen(m, utcH, utcM) : 0
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
