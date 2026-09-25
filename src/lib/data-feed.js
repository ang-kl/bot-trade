// ---------------------------------------------------------------------------
// src/lib/data-feed.js — the words the Data-feed card prints for measured
// figures (8,989-A row 11, WEB-9). Pure, so the rules are testable without a
// page: every figure carries its coverage, money stays in its own currency,
// and anything nobody measures is SAID to be unmeasured rather than drawn as
// a dash.
//
// The numbers come from the agent (GET /state/data-feed and
// /state/risk-full → dailyCapEnforced). Nothing here recomputes them.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const money = (v) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const ms = (v) => `${Math.round(Number(v)).toLocaleString('en-US')} ms`

/**
 * Where a retained daily bar sits against the CURRENT broker day.
 *
 * `brokerDayOpenMs` is the agent's FX-day anchor (17:00 New York, the gate's
 * own), passed in rather than derived here: a browser reimplementation of a
 * DST-aware anchor drifts twice a year.
 *
 * @returns {{status:'current'|'earlier'|'unverified', ageHours:number|null, days:number|null}}
 */
export function dailyBarAge(barStartMs, brokerDayOpenMs, nowMs) {
  const t = Number(barStartMs)
  const open = Number(brokerDayOpenMs)
  const now = Number(nowMs)
  if (!Number.isFinite(t) || t <= 0) return { status: 'unverified', ageHours: null, days: null }
  const ageHours = Number.isFinite(now) ? Math.max(0, Math.round((now - t) / HOUR_MS)) : null
  if (!Number.isFinite(open) || open <= 0) return { status: 'unverified', ageHours, days: null }
  if (t >= open) return { status: 'current', ageHours, days: 0 }
  // Whole broker days between the bar's start and today's open (≥ 1).
  return { status: 'earlier', ageHours, days: Math.max(1, Math.round((open - t) / DAY_MS)) }
}

/** One label for a bar's age against the current broker day. */
export function dailyBarNote(age) {
  if (!age || age.status === 'unverified') return 'broker day unverified'
  if (age.status === 'current') return 'current broker day'
  return `${age.days === 1 ? 'previous broker day' : `${age.days} broker days back`}${age.ageHours != null ? `, started ${age.ageHours} h ago` : ''} — not today's forming bar`
}

/**
 * Summary line for the retained daily bars of the scoped open positions.
 * @param {Array<{day?: {t?: number}}>|null} positions
 */
export function dailyBarsSummary(positions, brokerDayOpenMs, nowMs) {
  if (!Array.isArray(positions)) return 'Feed freshness unavailable'
  const bars = positions.filter(p => p?.day)
  if (!bars.length) return 'No retained daily bars for scoped open positions'
  const ages = bars.map(p => dailyBarAge(p.day.t, brokerDayOpenMs, nowMs))
  const earlier = ages.filter(a => a.status === 'earlier').length
  const unverified = ages.filter(a => a.status === 'unverified').length
  const parts = [`${bars.length} retained daily bar${bars.length === 1 ? '' : 's'} for scoped open positions`]
  if (earlier) parts.push(`${earlier} from an earlier broker day`)
  if (unverified) parts.push(`${unverified} with the day unverified`)
  return parts.join(' · ')
}

/** Entry latency with its coverage, or the reason there is none. */
export function latencyLine(latency) {
  if (!latency) return 'entry latency unavailable — the data-feed report did not load'
  const { measured = 0, of = 0 } = latency
  if (!of) return 'entry latency: no recorded closes in this scope'
  if (!measured) return `entry latency not measured on any of the latest ${of} closes`
  return `entry latency p50 ${ms(latency.p50Ms)} · p90 ${ms(latency.p90Ms)} · measured on ${measured} of ${of} closes (submit → execution event)`
}

/**
 * Commission and swap lines, one per deposit currency — never a cross-currency
 * total. The unverified bucket is named as such.
 */
export function costLines(execution) {
  if (!execution) return ['fees and swap unavailable — the data-feed report did not load']
  const closes = execution.window?.closes ?? 0
  if (!closes) return ['fees and swap: no recorded closes in this scope']
  return (execution.costs || []).map(b => {
    const ccy = b.currency ?? 'currency unverified'
    const com = b.commissionKnown ? `commission ${money(b.commission)} (${b.commissionKnown}/${b.closes} recorded)` : `commission not recorded on ${b.closes} closes`
    const swp = b.swapKnown ? `swap ${money(b.swap)} (${b.swapKnown}/${b.closes} recorded)` : `swap not recorded on ${b.closes} closes`
    return `${ccy} · ${com} · ${swp}`
  })
}

/** The fast monitor's quote sources over its last 10 minutes, with the record's age. */
export function quoteFreshnessLine(quotes) {
  if (!quotes) return 'quote freshness unavailable — the data-feed report did not load'
  if (quotes.status === 'unavailable') return `quote freshness not recorded (${quotes.reason || 'no record'})`
  const age = quotes.ageMs == null ? 'record undated' : `record ${Math.round(quotes.ageMs / 1000).toLocaleString('en-US')} s old`
  const w = quotes.window10m
  if (!w) return `quote freshness: no priced pass in the last 10 min · ${age}`
  return `quotes, last 10 min (${w.passes} priced passes): sidecar ${w.fromSidecar ?? '—'} · broker ${w.fromBroker ?? '—'} (stale ${w.stale ?? '—'}) · ${age}`
}

const BINDING_WORDS = {
  pct: 'the % of balance binds',
  usd: 'the flat USD cap binds',
  both: 'the % and the flat USD cap are equal',
  floor: 'the USD floor binds (the % figure is below it)',
}

/**
 * The daily-loss line from the GATE's figure (risk-full `dailyCapEnforced`).
 *
 * @param {object|null|undefined} enforced
 * @param {{allAccounts?: boolean, depositCurrency?: string|null}} [ctx]
 * @returns {{text: string, note: string|null}}
 */
export function dailyCapLine(enforced, { allAccounts = false, depositCurrency = null } = {}) {
  if (allAccounts) return { text: 'daily loss limit per account — select one account to see the cap its gate enforces', note: null }
  if (!enforced || enforced.status !== 'computed') {
    return { text: 'daily loss limit unavailable', note: enforced?.reason ? `gate figure not read: ${enforced.reason}` : 'the agent did not report the gate\'s figure' }
  }
  if (enforced.uncapped || enforced.capUsd == null) {
    return { text: 'daily loss limit: none in force — the gate enforces no daily cap on this account', note: null }
  }
  const pctPart = enforced.binding === 'pct' && enforced.pct != null ? ` (${+(enforced.pct * 100).toFixed(2)}% of ${money(enforced.gateBalanceUsd)})` : ''
  const why = BINDING_WORDS[enforced.binding] || 'binding rule unreported'
  const left = enforced.remainingUsd != null ? ` · ${money(enforced.remainingUsd)} left today` : ''
  const text = `daily loss limit ${money(enforced.capUsd)} USD/day enforced — ${why}${pctPart}${left}${enforced.blocked ? ' · entries blocked now' : ''}`
  const ccy = typeof depositCurrency === 'string' ? depositCurrency.toUpperCase() : null
  const note = ccy && ccy !== 'USD'
    ? `This account deposits in ${ccy}; the gate's figure is USD-named and is not converted.`
    : null
  return { text, note }
}
