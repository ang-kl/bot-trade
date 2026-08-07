// Economic-calendar feed (ForexFactory weekly JSON via the faireconomy
// mirror — the community-standard free endpoint). News lines ride on alerts
// and charts; since 2026-07-24 the cached calendar ALSO powers the optional
// news-window entry gate (newsWindowEvent — pure/sync, config-gated OFF by
// default in risk.js). Cached ~6h in agent_state; every failure degrades to
// "no news data", which for the gate means "no block" — never a stuck veto.

import { getState, setState } from '../db.js'

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const CACHE_KEY = 'news_calendar_json'
const CACHE_AT = 'news_calendar_fetched_ms'
const CACHE_MS = 6 * 3600_000
// P8 / AUDIT F-L7-02. Both failure branches of loadFeed used to return the
// previous cache with NO age check, and cachedEventsSync memoised on the fetch
// timestamp alone — so it could not tell a 6-hour-old calendar from a 6-week-
// old one. A mirror that goes away permanently left the entry gate operating
// on a calendar that aged indefinitely: releases long past still inside their
// window, and this week's releases entirely absent.
//
// Past this bound the cache is treated as NO DATA, which for the gate means NO
// BLOCK — the module's own documented degrade path (see the file header), not
// a new policy. The feed publishes one week at a time, so a cache older than
// that describes a different week.
const MAX_CACHE_AGE_MS = 7 * 24 * 3600_000

// Which currencies move a symbol — deliberately simple and reviewable.
export function symbolCurrencies(symbol) {
  const s = String(symbol).toUpperCase()
  if (/\.(US|UK|DE|AU)$/.test(s)) return [s.endsWith('.UK') ? 'GBP' : s.endsWith('.DE') ? 'EUR' : s.endsWith('.AU') ? 'AUD' : 'USD']
  if (/^(US30|US500|NAS100|USTEC|DOW|US2000|VIX)/.test(s)) return ['USD']
  if (/^(GER40|FRA40|EUSTX)/.test(s)) return ['EUR']
  if (/^(UK100)/.test(s)) return ['GBP']
  if (/^(JPN225)/.test(s)) return ['JPY']
  if (/^(AUS200)/.test(s)) return ['AUD']
  if (/^X(AU|AG|PT|PD)/.test(s)) return ['USD']
  if (/^(NATGAS|OIL|BRENT|SPOTCRUDE)/.test(s)) return ['USD']
  if (/^[A-Z]{6}$/.test(s)) return [s.slice(0, 3), s.slice(3, 6)]
  return ['USD']
}

/** Pure filter — unit-testable. events: [{title,country,date(ISO),impact}] */
export function relevantEvents(events, symbol, nowMs, { aheadMs = 24 * 3600_000, behindMs = 2 * 3600_000 } = {}) {
  const curs = symbolCurrencies(symbol)
  return (events || [])
    .filter(e => curs.includes(String(e.country || '').toUpperCase()))
    .filter(e => ['High', 'Medium'].includes(e.impact))
    .map(e => ({ ...e, t: Date.parse(e.date) }))
    .filter(e => Number.isFinite(e.t) && e.t > nowMs - behindMs && e.t < nowMs + aheadMs)
    .sort((a, b) => a.t - b.t)
    .slice(0, 4)
}

export function formatNewsLines(events, nowMs) {
  return events.map(e => {
    const mins = Math.round((e.t - nowMs) / 60_000)
    const when = mins < 0 ? `${-mins}m ago` : mins < 90 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`
    const mark = e.impact === 'High' ? '🟠 HIGH' : '🔹 med'
    return `${mark} ${e.country} ${e.title} — ${when}`
  })
}

/** The cached events, or [] when the cache is missing, corrupt, or too old. */
function cachedEventsWithinBound(db, nowMs = Date.now()) {
  const at = Number(getState(db, CACHE_AT)) || 0
  if (!at || nowMs - at > MAX_CACHE_AGE_MS) return []
  try {
    const parsed = JSON.parse(getState(db, CACHE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

async function loadFeed(db) {
  const at = Number(getState(db, CACHE_AT)) || 0
  if (Date.now() - at < CACHE_MS) {
    try { return JSON.parse(getState(db, CACHE_KEY) || '[]') } catch { /* refetch below */ }
  }
  try {
    const res = await fetch(FEED_URL, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`feed ${res.status}`)
    const events = await res.json()
    if (Array.isArray(events)) {
      setState(db, CACHE_KEY, JSON.stringify(events).slice(0, 500_000))
      setState(db, CACHE_AT, String(Date.now()))
      return events
    }
  } catch { /* fall through to the cache, bounded */ }
  // Bounded fallback: a recent-enough cache is better than nothing; an ancient
  // one is worse than nothing, because the gate would read it as current.
  return cachedEventsWithinBound(db)
}

/**
 * News-window gate (owner-approved 2026-07-24): the scheduled release
 * currently blocking entries on `symbol`, or null. PURE and SYNCHRONOUS —
 * the caller hands in the cached event list; nothing here touches the
 * network, so the trade path never waits on a feed. Blocking window:
 * from `minBefore` minutes BEFORE the release to `minAfter` minutes after.
 */
export function newsWindowEvent(events, symbol, nowMs, { minBefore = 15, minAfter = 15, impacts = ['High'] } = {}) {
  const curs = symbolCurrencies(symbol)
  for (const e of events || []) {
    if (!curs.includes(String(e.country || '').toUpperCase())) continue
    if (!impacts.includes(e.impact)) continue
    const t = Date.parse(e.date)
    if (!Number.isFinite(t)) continue
    if (nowMs >= t - minBefore * 60_000 && nowMs <= t + minAfter * 60_000) {
      return { title: e.title, country: e.country, impact: e.impact, t }
    }
  }
  return null
}

/**
 * Cached events, sync (for the risk gate). Memoized per cache write.
 *
 * `nowMs` is the moment the staleness bound is measured against, and it
 * defaults to the wall clock so every existing caller is unchanged. It exists
 * because the bound was previously the ONE part of this read that ignored its
 * caller's clock: buildEnvironment(db, symbol, nowMs) honours nowMs for event
 * filtering, window matching and age reporting, then called in here and got a
 * verdict measured against real time. Rendering the cockpit for any moment
 * more than a week ago therefore returned zero events — not because the cache
 * was empty at that moment, but because it is old NOW. The failure is silent
 * and reads as "no news scheduled", which is the one thing this module's
 * header says it must never fabricate.
 */
let gateParseMemo = { at: null, events: [] }
export function cachedEventsSync(db, nowMs = Date.now()) {
  try {
    const at = getState(db, CACHE_AT)
    // P8: the bound is checked BEFORE the memo, not inside it. Memoising on
    // the fetch timestamp alone means the key never changes as the cache ages,
    // so a memo populated while the calendar was fresh would keep serving it
    // forever — the same fossil-read this bound exists to stop.
    const ts = Number(at) || 0
    if (!ts || nowMs - ts > MAX_CACHE_AGE_MS) return []
    // The memo holds PARSED EVENTS, which do not depend on nowMs — the
    // time-varying part is the bound above, and it has already been applied.
    if (gateParseMemo.at === at) return gateParseMemo.events
    const events = cachedEventsWithinBound(db, nowMs)
    gateParseMemo = { at, events }
    return gateParseMemo.events
  } catch { return [] }
}

/** Refresh the cache (6h TTL) — called once per loop cycle, best-effort. */
export async function refreshNewsCalendar(db) {
  try { await loadFeed(db) } catch { /* degrade to stale/no data */ }
}

/** "⚠ news" lines for a symbol — [] on any failure, never throws. */
export async function newsLinesFor(db, symbol, nowMs = Date.now()) {
  try {
    const events = await loadFeed(db)
    const rel = relevantEvents(events, symbol, nowMs)
    return formatNewsLines(rel, nowMs)
  } catch { return [] }
}
