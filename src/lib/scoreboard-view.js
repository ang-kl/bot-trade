// scoreboard-view.js — the Scoreboard card's formatters and its poll timer.
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// Kept apart from src/components/Scoreboard.jsx so that file exports only
// components (react-refresh). Display only: nothing here computes a figure the
// server did not send; it formats, labels and schedules the read.
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'
import { accountLabel, accountNumbers } from './scope-label.js'

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

/**
 * Claude · № 12,990 10-Oct (owner: "where are the account details like Live ·
 * 1251247 · 42993489 · SGD and the leverage and how many trade"): the account
 * line in the owner's own words. The Live/Demo word and the numbers come from
 * the app's one account-label helper (scope-label.js), so every page names an
 * account the same way. Display only.
 */
export function accountTitle(a) {
  const row = { isLive: a?.isLive, traderLogin: a?.login, accountId: a?.accountId }
  const side = a?.isLive == null ? null : (accountLabel(row) || '').split(' ')[0]
  const numbers = accountNumbers(row) || a?.label || String(a?.accountId ?? '')
  return [side, ...numbers.split(' · '), a?.currency || 'currency unverified'].filter(Boolean).join(' · ')
}

/** "1:200 · 3 open · 0 closed today · 249 closed" — what the dashboard holds for this account. */
export function accountFacts(a) {
  const parts = []
  if (finite(a?.leverage)) parts.push(`1:${Math.round(a.leverage)}`)
  if (Number.isInteger(a?.openNow)) parts.push(`${a.openNow} open`)
  if (Number.isInteger(a?.closedToday)) parts.push(`${a.closedToday} closed today`)
  const total = Number.isInteger(a?.closedTotal) ? a.closedTotal : a?.closedN
  if (Number.isInteger(total)) parts.push(`${total} closed`)
  if (a?.mode && a.mode !== 'active') parts.push(String(a.mode).replace(/_/g, ' '))
  return parts.join(' · ')
}

// Claude · № 13,024 10-Oct (owner after № 13,017: "scoreboard doesn;t show
// current balance, float, SL/TP. Is there a record in the storage of Bot-trade
// the daily balance of account recorded so that we can check pattern").
// Formatters for the balance cell, the open positions and the nightly line.
// The figures are the server's: the account-overview reading the Performance
// page already polls, and the scoreboard report's `nightly` block.

/** An amount with no sign, grouped: "SGD 3,062.38". */
export const fmtAmount = (v, currency) => finite(v)
  ? `${currency ? `${currency} ` : ''}${v < 0 ? MINUS : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : '—'
/** A broker price as sent, without float noise: 1.2801400000000001 → "1.28014". */
export const fmtPrice = v => finite(v) ? String(Number(v.toPrecision(10))) : '—'
export const fmtLots = v => finite(v) ? String(Number(v.toPrecision(6))) : '—'

// Claude · № 13,029 10-Oct (owner: "write your day's balance right at the New
// York regular market close (4:00 PM ET)"): each day's row is named in New
// York time, so a row read at the bell reads "Fri, Oct 09, 4:00 PM ET" in
// every browser, and the weekday is the trading day it closes.
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' })
/** "Fri, Oct 09, 4:00 PM ET" — the weekday is what a pattern is read by. */
export const fmtNight = iso => {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return 'time unknown'
  return `${ET.format(new Date(t))} ET`
}

/**
 * Where a stop sits against the entry, in words: a BUY's stop above its entry
 * (a SELL's below) is on the profit side. A comparison of two server figures,
 * not a new figure. null when either is missing or the side is unknown.
 */
export function stopSide(p) {
  if (!finite(p?.sl) || !finite(p?.entry)) return null
  const side = String(p.side || '').toUpperCase()
  if (side !== 'BUY' && side !== 'SELL') return null
  if (p.sl === p.entry) return 'at entry'
  return (side === 'BUY') === (p.sl > p.entry) ? 'in profit' : null
}

/** The balance cell's lines from one account-overview row (or its absence). */
export function balanceView(live, loaded) {
  if (!live) return { value: loaded ? '—' : '…', sub: loaded ? 'no broker reading for this account' : 'reading the broker cache' }
  const ccy = live.currency
  if (!finite(live.balance)) return { value: '—', sub: 'no fresh broker balance' }
  const sub = finite(live.openPnl)
    ? `float ${fmtMoney(live.openPnl, ccy)} · equity ${fmtAmount(live.equity, ccy)}`
    : 'float not read yet'
  return { value: fmtAmount(live.balance, ccy), sub }
}

/** The words under one night's balance change: whether deposits were checked. */
export function flowWords(n) {
  if (!n || n.balanceChange == null || !n.flows) return ''
  if (n.flows.status === 'read') return finite(n.flows.external) && n.flows.external !== 0
    ? `incl. deposits/withdrawals ${fmtMoney(n.flows.external, null)}` : 'no deposit or withdrawal'
  if (n.flows.status === 'unclassified') return 'a broker entry is unclassified'
  return 'deposits not checked'
}

const nightsWord = n => `${n} day${n === 1 ? '' : 's'}`
/** The nightly line's aria-label: what it shows, by count. */
export function nightlyLabel(rec) {
  const pts = (rec?.nights || []).filter(n => finite(n.balance))
  if (!pts.length) return 'No daily balance recorded in this account\'s currency.'
  return `Daily balance, ${pts.length} reading${pts.length === 1 ? '' : 's'}, ${fmtAmount(pts[0].balance, rec.currency)} to ${fmtAmount(pts.at(-1).balance, rec.currency)}: `
    + `up on ${nightsWord(rec.up)}, down on ${nightsWord(rec.down)}, unchanged on ${nightsWord(rec.flat)}.`
}
