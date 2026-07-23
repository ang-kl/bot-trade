// Live market-session clock — owner: "clock of different market now."
// Renders each session's OWN local time (IANA tz, via Intl — no fixed UTC
// offset math that would drift across DST) plus whether it's in session
// right now, and the viewer's own local time via the BROWSER's timezone.
// Deliberately does not ask for or assume the viewer's timezone anywhere —
// Intl.DateTimeFormat().resolvedOptions().timeZone reads it from the
// browser, so there is nothing to get wrong or fabricate.
import { useEffect, useState } from 'react'
import Card from './common/Card.jsx'
import Badge from './common/Badge.jsx'
import { SESSIONS, isWeekend } from '../../agent/lib/sessions.js'

function sessionOpenNow(session, now) {
  const utcHour = now.getUTCHours()
  if (session.open < session.close) return utcHour >= session.open && utcHour < session.close
  return utcHour >= session.open || utcHour < session.close
}

function fmtInTz(now, tz) {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  } catch { return '—' }
}

export default function MarketClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])

  const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const weekend = isWeekend(now)

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-[12px] font-semibold">Market sessions</div>
        <span className="text-[11px] text-[var(--color-text-sub)]">
          your time ({viewerTz}): <span className="font-semibold text-[var(--color-text)]">{fmtInTz(now, viewerTz)}</span>
        </span>
        {weekend && <Badge tone="warning">FX/CFD weekend — closed</Badge>}
      </div>
      <div className="flex flex-wrap gap-2">
        {SESSIONS.map(s => {
          const open = !weekend && sessionOpenNow(s, now)
          return (
            <div key={s.id} className="flex items-center gap-1.5 rounded-[8px] glass-inset px-2 py-1">
              <Badge tone={open ? 'up' : 'neutral'}>{open ? 'OPEN' : 'CLOSED'}</Badge>
              <span className="text-[12px] font-semibold">{s.label}</span>
              <span className="text-[12px] text-[var(--color-text-sub)] tabular-nums">{fmtInTz(now, s.tz)}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
