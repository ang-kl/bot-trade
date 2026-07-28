// ---------------------------------------------------------------------------
// agent/services/client-presence.js — who has the dashboard open right now
// (owner, 2026-07-28: "Can you monitor the number of website open ... and
// timezone?" then "in the left navigation at the bottom ... how many tabs
// are opened and when open/last used ... is closed also stated there and
// when closed ... and which country IP address").
//
// Every open tab is an independent polling client, so N visible tabs = N×
// the query load. Each tab heartbeats ~30s (a single tiny GET, sent even
// when hidden/idle so the roster stays honest) and fires a keepalive
// "closed" ping on pagehide. The roster keeps the full lifecycle per tab:
// openedAt → lastSeenAt (+ visible/hidden/idle) → closedAt, plus the
// request IP and a country derived from the reported IANA timezone
// (Asia/Singapore → SG; Australia/Brisbane → AU — moving cities just
// changes what the tab reports, nothing breaks).
//
// In-memory by design: a restart forgets the roster and live tabs
// re-announce within 30s. Active TTL 90s (three missed heartbeats = shown
// stale, then treated as closed); closed tabs are kept for 24h, max 20.
// ---------------------------------------------------------------------------

const tabs = new Map() // tabId → { tz, page, hidden, idle, ua, ip, openedAt, at, closedAt }
const TTL_MS = 90_000
const CLOSED_KEEP_MS = 24 * 3600_000
const CLOSED_KEEP_MAX = 20
const WARN_THRESHOLD = Math.max(1, Number(process.env.CLIENT_TAB_WARN || 6))
const WARN_EVERY_MS = 60 * 60_000
let lastWarnAt = 0

// Country from the IANA timezone the tab reports. Continent zones map by
// region where the region IS the country; the short list covers the rest of
// the zones this desk realistically sees. Unknown → the raw tz is shown.
const TZ_COUNTRY = {
  'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID',
  'Asia/Bangkok': 'TH', 'Asia/Hong_Kong': 'HK', 'Asia/Shanghai': 'CN',
  'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Dubai': 'AE', 'Asia/Kolkata': 'IN',
  'Europe/London': 'GB', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Zurich': 'CH',
  'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US',
}
export function countryFromTz(tz) {
  const t = String(tz || '')
  if (TZ_COUNTRY[t]) return TZ_COUNTRY[t]
  if (t.startsWith('Australia/')) return 'AU'
  if (t.startsWith('Pacific/Auckland')) return 'NZ'
  if (t.startsWith('America/')) return 'Americas'
  if (t.startsWith('Europe/')) return 'Europe'
  if (t.startsWith('Africa/')) return 'Africa'
  return t || 'unknown'
}

function sweep(nowMs) {
  const closed = []
  for (const [k, v] of tabs) {
    if (v.closedAt) {
      if (nowMs - v.closedAt > CLOSED_KEEP_MS) tabs.delete(k)
      else closed.push([k, v])
    } else if (nowMs - v.at > TTL_MS) {
      // Missed three heartbeats without a close beacon (crashed tab, killed
      // browser) — treat the last heartbeat as the close time.
      v.closedAt = v.at
      closed.push([k, v])
    }
  }
  // Bound the closed history to the newest CLOSED_KEEP_MAX.
  if (closed.length > CLOSED_KEEP_MAX) {
    closed.sort((a, b) => b[1].closedAt - a[1].closedAt)
    for (const [k] of closed.slice(CLOSED_KEEP_MAX)) tabs.delete(k)
  }
}

/** Register one heartbeat (or a close beacon). Returns the live summary. */
export function registerClientPing({ tab, tz, page, hidden, idle, closed, ua, ip } = {}, nowMs = Date.now()) {
  if (tab) {
    const id = String(tab).slice(0, 64)
    const prev = tabs.get(id)
    tabs.set(id, {
      tz: String(tz || prev?.tz || 'unknown').slice(0, 64),
      page: String(page || prev?.page || '/').slice(0, 128),
      hidden: hidden === true || hidden === 'true' || hidden === '1',
      idle: idle === true || idle === 'true' || idle === '1',
      ua: String(ua || prev?.ua || '').slice(0, 120),
      ip: String(ip || prev?.ip || '').slice(0, 64),
      openedAt: prev?.openedAt ?? nowMs,
      at: nowMs,
      closedAt: (closed === true || closed === 'true' || closed === '1') ? nowMs : null,
    })
  }
  sweep(nowMs)
  const summary = clientSummary(nowMs)
  if (summary.visibleTabs > WARN_THRESHOLD && nowMs - lastWarnAt > WARN_EVERY_MS) {
    lastWarnAt = nowMs
    import('./telegram-control.js')
      .then(m => m.notifyOwner(
        `🗔 ${summary.visibleTabs} dashboard tabs are OPEN AND VISIBLE right now (${summary.openTabs} total incl. background) — each visible tab polls the agent every 5-20s, so this multiplies query load. Timezones: ${summary.timezones.join(', ')}. Consider closing extras (threshold ${WARN_THRESHOLD}).`
      ))
      .catch(() => {})
  }
  return summary
}

/** Roster: open tabs (freshest first) + recent closures + counts/timezones. */
export function clientSummary(nowMs = Date.now()) {
  sweep(nowMs)
  const all = [...tabs.entries()].map(([id, t]) => ({ id, ...t }))
  const open = all.filter(t => !t.closedAt).sort((a, b) => b.at - a.at)
  const closed = all.filter(t => t.closedAt).sort((a, b) => b.closedAt - a.closedAt)
  const shape = (t) => ({
    id: t.id, tz: t.tz, country: countryFromTz(t.tz), ip: t.ip || null, page: t.page,
    status: t.closedAt ? 'closed' : t.idle ? 'idle' : t.hidden ? 'background' : 'active',
    openedAt: new Date(t.openedAt).toISOString(),
    lastSeenAt: new Date(t.at).toISOString(),
    closedAt: t.closedAt ? new Date(t.closedAt).toISOString() : null,
  })
  return {
    openTabs: open.length,
    visibleTabs: open.filter(t => !t.hidden && !t.idle).length,
    warnThreshold: WARN_THRESHOLD,
    timezones: [...new Set(open.map(t => t.tz))],
    tabs: open.map(shape),
    recentlyClosed: closed.map(shape),
  }
}
