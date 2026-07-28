// ---------------------------------------------------------------------------
// agent/services/client-presence.js — who has the dashboard open right now
// (owner, 2026-07-28: "Can you monitor the number of website open ... and
// timezone? I don't think I need to open more than 6 at the same time.
// More website open means more queries right?").
//
// Yes: every open tab is an independent polling client (Desk 5-20s, page
// timers, health pings), so N tabs = N× the query load on the agent. This
// module is the visibility half of the fix — each tab heartbeats every
// ~30s (a single tiny GET, sent even when the tab is hidden so the count
// stays honest), and the roster is surfaced on /health and warned about on
// Telegram when the VISIBLE tab count exceeds the threshold. The load half
// is client-side: hidden tabs stop their heavy polls entirely.
//
// In-memory by design: a restart forgets the roster and tabs re-announce
// within 30s. TTL 90s — three missed heartbeats and a tab is gone.
// ---------------------------------------------------------------------------

const tabs = new Map() // tabId → { tz, page, hidden, ua, at }
const TTL_MS = 90_000
const WARN_THRESHOLD = Math.max(1, Number(process.env.CLIENT_TAB_WARN || 6))
const WARN_EVERY_MS = 60 * 60_000
let lastWarnAt = 0

function prune(nowMs) {
  for (const [k, v] of tabs) if (nowMs - v.at > TTL_MS) tabs.delete(k)
}

/** Register one heartbeat. Returns the post-registration summary. */
export function registerClientPing({ tab, tz, page, hidden, ua } = {}, nowMs = Date.now()) {
  if (tab) {
    tabs.set(String(tab).slice(0, 64), {
      tz: String(tz || 'unknown').slice(0, 64),
      page: String(page || '/').slice(0, 128),
      hidden: hidden === true || hidden === 'true' || hidden === '1',
      ua: String(ua || '').slice(0, 120),
      at: nowMs,
    })
  }
  prune(nowMs)
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

/** Current roster: counts, timezones, and per-tab detail (freshest first). */
export function clientSummary(nowMs = Date.now()) {
  prune(nowMs)
  const list = [...tabs.values()].sort((a, b) => b.at - a.at)
  return {
    openTabs: list.length,
    visibleTabs: list.filter(t => !t.hidden).length,
    warnThreshold: WARN_THRESHOLD,
    timezones: [...new Set(list.map(t => t.tz))],
    tabs: list.map(t => ({
      tz: t.tz, page: t.page, hidden: t.hidden,
      secondsAgo: Math.round((nowMs - t.at) / 1000),
    })),
  }
}
