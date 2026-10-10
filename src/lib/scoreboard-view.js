// scoreboard-view.js — the Scoreboard card's formatters and its poll timer.
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// Kept apart from src/components/Scoreboard.jsx so that file exports only
// components (react-refresh). Display only: nothing here computes a figure the
// server did not send; it formats, labels and schedules the read.
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'

export const SCOREBOARD_POLL_MS = 60_000
export const SCOREBOARD_PATH = '/state/scoreboard?account=all&days=30'
/** Bars in the R strip are clipped at ± this many R. */
export const R_CLIP = 3

export const finite = v => typeof v === 'number' && Number.isFinite(v)
const MINUS = '−'
const signed = (v, digits) => finite(v) ? `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}` : '—'
export const fmtPct = v => finite(v) ? `${Math.round(v)}%` : '—'
export const fmtR = v => finite(v) ? `${signed(v, 2)}R` : '—'
/** Money in ONE account's currency; a currency the server could not verify is said once, in the card header. */
export const fmtMoney = (v, currency) => finite(v) ? `${currency ? `${currency} ` : ''}${signed(v, 2)}` : '—'
/** "no losses" when there is nothing to divide by; a dash when there are no trades at all. */
export const fmtPf = (pf, m) => {
  if (!m || !m.n) return '—'
  if (finite(pf)) return pf.toFixed(2)
  return m.losses === 0 ? 'no losses' : '—'
}
/** Profit factor in R: the same rule over the R-scored trades only. */
export const fmtPfR = m => {
  if (!m || !m.rScored) return '—'
  return finite(m.profitFactorR) ? m.profitFactorR.toFixed(2) : 'no losses'
}
export const fmtWhen = iso => {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return 'time unknown'
  return new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** The words the R strip's aria-label speaks: what the bars show, by count. */
export function stripLabel(rows) {
  const scored = rows.map(r => r.realised_rr).filter(finite)
  const up = scored.filter(v => v > 0).length, down = scored.filter(v => v < 0).length
  const flat = scored.length - up - down, unscored = rows.length - scored.length
  return `R of the last ${rows.length} trades, oldest to newest: ${up} above zero, ${down} below zero, ${flat} at zero, ${unscored} without a scored R. Bars clipped at plus or minus ${R_CLIP}R.`
}

/**
 * The card's timer: GET once on mount, then every minute, skipped while the
 * page is asleep (hidden, idle or paused — agent-api pageAsleep, the rule
 * every poll loop here follows; use-account-overview.js is the same shape).
 * A failed read reports its message; the caller keeps the last good report
 * and says it is old. Returns a stop function.
 */
export function startScoreboardPolling({ onReport, onError }, {
  get = agentGet, asleep = pageAsleep, configured = agentConfigured,
  timers = globalThis, target = typeof document === 'undefined' ? null : document,
  win = typeof window === 'undefined' ? null : window, everyMs = SCOREBOARD_POLL_MS,
} = {}) {
  let stopped = false, running = false
  const refresh = async () => {
    if (stopped || running || asleep() || !configured()) return
    running = true
    try {
      const r = await get(SCOREBOARD_PATH)
      if (stopped) return
      if (Array.isArray(r?.accounts)) onReport(r)
      else onError('The scoreboard answer had no accounts.')
    } catch (e) { if (!stopped) onError(e?.message || String(e)) }
    finally { running = false }
  }
  const kick = timers.setTimeout(refresh, 0), timer = timers.setInterval(refresh, everyMs)
  target?.addEventListener('visibilitychange', refresh)
  win?.addEventListener('agent-wake', refresh)
  return () => {
    stopped = true; timers.clearTimeout(kick); timers.clearInterval(timer)
    target?.removeEventListener('visibilitychange', refresh); win?.removeEventListener('agent-wake', refresh)
  }
}
