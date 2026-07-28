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
  // Collapsed by default (owner 2026-07-28: "the setting is overshoot the
  // web browser screen size, make it dynamic") — one summary line unless
  // opened; the choice sticks per device.
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('tabs_panel_open') === 'true' } catch { return false } })
  const toggle = () => setOpen(o => { try { localStorage.setItem('tabs_panel_open', String(!o)) } catch { /* private mode */ } return !o })
  // Owner 2026-07-28: "each active/non-active web information should be seen
  // in details by clicking on it." The per-row detail was previously only in
  // a `title` tooltip — which needs a hover, so on a phone or tablet it was
  // simply unreachable. Clicking a row now expands it in place.
  const [openRow, setOpenRow] = useState(null)
  // "N minutes ago" needs a clock, and reading Date.now() during render makes
  // render impure (react-hooks/purity, correctly). Stamp it when the roster
  // arrives — every ~30s on the presence heartbeat — and again on the click
  // that opens a row, so the figure is current exactly when it is read.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => onClientSummary((s) => { setSum(s); setNowMs(Date.now()) }), [])
  if (!sum) return null
  const me = myTabId()
  const rows = [...(sum.tabs || []), ...(sum.recentlyClosed || []).slice(0, 3)]
  const rowKey = (t) => t.id + (t.closedAt || '')
  const fullTime = (iso) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) } catch { return '—' }
  }
  const sinceText = (iso) => {
    if (!iso) return null
    const ms = nowMs - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return null
    const m = Math.floor(ms / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`
  }
  const STATUS_HELP = {
    active: 'visible and polling normally.',
    background: 'another tab is in front — polling is paused, it resumes when you switch back.',
    idle: 'untouched past your sleep-after setting — polling stopped, any click or keypress wakes it.',
    closed: 'gone. Kept here briefly so you can see when it went.',
  }
  return (
    <div className="glass-inset rounded-[1px] px-3 py-2 mb-2 text-[8px] leading-relaxed">
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls="tabs-panel-roster"
        className="w-full flex items-baseline justify-between cursor-pointer bg-transparent border-0 p-0 text-inherit">
        <span className="font-semibold uppercase tracking-wide text-[var(--color-text-sub)]">{open ? '▾' : '▸'} Tabs</span>
        <span className="text-[var(--color-text-sub)]" title={`${sum.visibleTabs} active of ${sum.openTabs} open · warn above ${sum.warnThreshold}`}>
          {sum.openTabs} open · {sum.visibleTabs} active
        </span>
      </button>
      {open && <div id="tabs-panel-roster" className="mt-1 max-h-56 overflow-y-auto">
      {rows.map(t => {
        const k = rowKey(t)
        const expanded = openRow === k
        return (
          <div key={k} className="border-t border-[var(--glass-edge)]">
            <button type="button" aria-expanded={expanded}
              onClick={() => { setNowMs(Date.now()); setOpenRow(cur => (cur === k ? null : k)) }}
              className="w-full flex items-center gap-1.5 py-0.5 text-left cursor-pointer bg-transparent border-0 p-0 text-inherit">
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
              <span aria-hidden="true" className="text-[var(--color-text-sub)]">{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pb-1 pl-3 text-[7px]">
                <dt className="text-[var(--color-text-sub)]">Status</dt>
                <dd>
                  <span style={{ color: TONE[t.status] || 'var(--color-text-sub)' }}>{t.status}</span>
                  <span className="text-[var(--color-text-sub)]"> — {STATUS_HELP[t.status] || 'unknown state.'}</span>
                </dd>
                <dt className="text-[var(--color-text-sub)]">This tab?</dt>
                <dd>{t.id === me ? 'yes — the one you are looking at' : 'no — another tab or device'}</dd>
                <dt className="text-[var(--color-text-sub)]">Page</dt>
                <dd>{t.page || '—'}</dd>
                <dt className="text-[var(--color-text-sub)]">Opened</dt>
                <dd>{fullTime(t.openedAt)}{sinceText(t.openedAt) ? ` (${sinceText(t.openedAt)})` : ''}</dd>
                {t.status === 'closed' ? (
                  <>
                    <dt className="text-[var(--color-text-sub)]">Closed</dt>
                    <dd>{fullTime(t.closedAt)}{sinceText(t.closedAt) ? ` (${sinceText(t.closedAt)})` : ''}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-[var(--color-text-sub)]">Last seen</dt>
                    <dd>{fullTime(t.lastSeenAt)}{sinceText(t.lastSeenAt) ? ` (${sinceText(t.lastSeenAt)})` : ''}</dd>
                  </>
                )}
                <dt className="text-[var(--color-text-sub)]">Timezone</dt>
                <dd>{t.tz || 'unknown'}</dd>
                <dt className="text-[var(--color-text-sub)]">Country</dt>
                <dd>{t.country || 'unknown'} <span className="text-[var(--color-text-sub)]">(from the tab&apos;s own timezone, so a VPN will not change it)</span></dd>
                <dt className="text-[var(--color-text-sub)]">IP</dt>
                <dd>{t.ip || 'not reported'}</dd>
                <dt className="text-[var(--color-text-sub)]">Tab id</dt>
                <dd className="break-all">{t.id}</dd>
              </dl>
            )}
          </div>
        )
      })}
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
      </div>}
    </div>
  )
}
