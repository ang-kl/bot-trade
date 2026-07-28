// Sidebar tab roster (owner 2026-07-28: "in the left navigation at the
// bottom ... how many tabs are opened and when open/last used ... is closed
// also stated there and when closed. and show current. and which country IP
// address"). Data rides on the presence heartbeat App.jsx already sends —
// this panel subscribes to the cached roster, it never issues its own pings.
//
// "Close after 5 minutes inactive": a web page CANNOT close a browser tab
// the user opened (window.close is blocked by every browser) — so an
// inactive tab SLEEPS instead: all polling stops (the same zero-load effect
// as closing) and it shows here as "idle". Any click/key/scroll wakes it.
import { useEffect, useState } from 'react'
import { onClientSummary, myTabId, getIdleMinutes, setIdleMinutes } from '../../lib/agent-api.js'

// Sleep-after choices (owner: "can we set to 60 minutes or 4 hours if i
// want, there should be session setting") — saved per device.
const IDLE_CHOICES = [
  { min: 5, label: '5m' },
  { min: 15, label: '15m' },
  { min: 60, label: '1h' },
  { min: 240, label: '4h' },
]

const hhmm = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) } catch { return '—' }
}
const TONE = {
  active: 'var(--color-up)',
  background: 'var(--color-warning-text)',
  idle: 'var(--color-warning-text)',
  closed: 'var(--color-text-sub)',
}

export default function TabsPanel() {
  const [sum, setSum] = useState(null)
  const [idleMin, setIdleMin] = useState(getIdleMinutes)
  useEffect(() => onClientSummary(setSum), [])
  if (!sum) return null
  const me = myTabId()
  const rows = [...(sum.tabs || []), ...(sum.recentlyClosed || []).slice(0, 3)]
  return (
    <div className="glass-inset rounded-[1px] px-3 py-2 mb-2 text-[8px] leading-relaxed">
      <div className="flex items-baseline justify-between mb-1">
        <span className="font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">Tabs</span>
        <span className="text-[var(--color-text-sub)]" title={`${sum.visibleTabs} active of ${sum.openTabs} open · warn above ${sum.warnThreshold}`}>
          {sum.openTabs} open · {sum.visibleTabs} active
        </span>
      </div>
      {rows.map(t => (
        <div key={t.id + (t.closedAt || '')} className="flex items-center gap-1.5 py-0.5 border-t border-[var(--glass-edge)]" title={`${t.page} · tz ${t.tz} · ip ${t.ip || 'unknown'} · opened ${hhmm(t.openedAt)}`}>
          <span aria-hidden="true" style={{ color: TONE[t.status] || 'var(--color-text-sub)', fontSize: 7 }}>●</span>
          <span className="truncate flex-1">
            {t.id === me && <b>this tab · </b>}{t.page}
            <span className="text-[var(--color-text-sub)]"> · {t.country}{t.ip ? ` · ${t.ip}` : ''}</span>
          </span>
          <span className="text-[var(--color-text-sub)] whitespace-nowrap">
            {t.status === 'closed'
              ? `closed ${hhmm(t.closedAt)}`
              : `${t.status} · ${hhmm(t.openedAt)}→${hhmm(t.lastSeenAt)}`}
          </span>
        </div>
      ))}
      <div className="pt-1 flex items-center gap-1 text-[7px] text-[var(--color-text-sub)]">
        <span>sleep after</span>
        {IDLE_CHOICES.map(c => (
          <button key={c.min} type="button"
            onClick={() => { setIdleMinutes(c.min); setIdleMin(c.min) }}
            className={`rounded-[1px] px-1.5 py-0.5 border cursor-pointer ${idleMin === c.min
              ? 'border-[var(--color-accent)] text-[var(--color-text)] bg-[var(--color-accent-soft)]'
              : 'border-[var(--glass-edge)]'}`}
          >{c.label}</button>
        ))}
        <span className="ml-auto" title="A sleeping tab stops all polling (zero load) and wakes on any click/key — browsers don't allow a website to close your tabs outright.">ⓘ</span>
      </div>
    </div>
  )
}
