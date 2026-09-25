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

/** How far before the broker-day anchor a bar may start and still be today's (see dailyBarAge). */
export const BAR_BOUNDARY_TOLERANCE_MS = 2 * HOUR_MS

/**
 * Where a retained daily bar sits against the CURRENT broker day.
 *
 * `brokerDayOpenMs` is the agent's FX-day anchor (17:00 New York, the gate's
 * own), passed in rather than derived here: a browser reimplementation of a
 * DST-aware anchor drifts twice a year.
 *
 * BOUNDARY TOLERANCE. The row-11 evidence (D1 bars at 21:00Z against a
 * 21:00Z open) only shows the broker's bar boundary agreeing with the anchor
 * during US daylight time. If the broker's D1 bars stay at 21:00Z after US
 * DST ends (the anchor moves to 22:00Z), an exact `t >= open` would call
 * every forming bar "previous broker day". A daily bar can only start on a
 * day boundary, so a bar starting within BAR_BOUNDARY_TOLERANCE_MS before the
 * anchor is not a previous day's bar (that starts ~24 h before). Nor is it
 * proven current: for the hour between the two boundaries the broker's day
 * and the gate's day disagree. It is reported as UNVERIFIED with the offset
 * named (`anchorOffsetHours`) — never "previous broker day", never a
 * confident "current". Re-read one `day.t` after US DST ends (01-11) to
 * settle which boundary the broker uses.
 *
 * @returns {{status:'current'|'earlier'|'unverified', ageHours:number|null, days:number|null, anchorOffsetHours?:number}}
 */
export function dailyBarAge(barStartMs, brokerDayOpenMs, nowMs) {
  const t = Number(barStartMs)
  const open = Number(brokerDayOpenMs)
  const now = Number(nowMs)
  if (!Number.isFinite(t) || t <= 0) return { status: 'unverified', ageHours: null, days: null }
  const ageHours = Number.isFinite(now) ? Math.max(0, Math.round((now - t) / HOUR_MS)) : null
  if (!Number.isFinite(open) || open <= 0) return { status: 'unverified', ageHours, days: null }
  if (t >= open) return { status: 'current', ageHours, days: 0 }
  if (open - t <= BAR_BOUNDARY_TOLERANCE_MS) {
    return { status: 'unverified', ageHours, days: null, anchorOffsetHours: +((open - t) / HOUR_MS).toFixed(2) }
  }
  // Whole broker days between the bar's start and today's open (≥ 1).
  return { status: 'earlier', ageHours, days: Math.max(1, Math.round((open - t) / DAY_MS)) }
}

/** One label for a bar's age against the current broker day. */
export function dailyBarNote(age) {
  if (!age) return 'broker day unverified'
  if (age.status === 'unverified') {
    return age.anchorOffsetHours
      ? `broker day unverified — bar boundary ${age.anchorOffsetHours} h before the gate's 17:00 New York day open`
      : 'broker day unverified'
  }
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

// Which guard in `dailyLossVerdict` (agent/services/risk.js) raised the
// block. Only `daily_loss_limit_hit` is the daily cap itself; the other two
// block through the same verdict but are different facts, and printing them
// on the cap line as a bare "entries blocked now" would read as the cap.
const BLOCK_WORDS = {
  daily_loss_limit_hit: 'entries blocked now: the daily loss limit is hit',
  campaign_stop: 'entries blocked now by the campaign stop (not the daily cap)',
  unknown_daily_pnl: "entries blocked now: today's P&L is unresolved (not the daily cap)",
}
const blockedSuffix = (enforced) => {
  if (!enforced?.blocked) return ''
  const g = enforced.guard
  return ` · ${BLOCK_WORDS[g] || (g ? `entries blocked now by ${g}` : 'entries blocked now (guard not reported)')}`
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
  const text = `daily loss limit ${money(enforced.capUsd)} USD/day enforced — ${why}${pctPart}${left}${blockedSuffix(enforced)}`
  const ccy = typeof depositCurrency === 'string' ? depositCurrency.toUpperCase() : null
  const note = ccy && ccy !== 'USD'
    ? `This account deposits in ${ccy}; the gate's figure is USD-named and is not converted.`
    : null
  return { text, note }
}

/**
 * The DataFeed card's account-dependent props, each shown ONLY when its
 * response belongs to the account on screen.
 *
 * Switching account changes `acct` without remounting the page (see
 * use-lens-account.js), and the previous account's `feedReport` / `riskFull`
 * stay in state until the new load finishes both of its waits — the second
 * queues behind the performance-report reads. Checking scope only where the
 * response is STORED therefore let the old account's latency, fees, swap,
 * deposit currency and equity stop paint under the new account's heading.
 * This is the check at RENDER, so a mismatch reads as "did not load" /
 * "unverified" instead of another account's numbers.
 *
 * @param {{acct: string, feedReport?: object|null, riskFull?: object|null, error?: string}} s
 */
export function dataFeedCardScope({ acct, feedReport = null, riskFull = null, error = '' } = {}) {
  const scope = acct == null ? null : String(acct)
  const mine = (id) => scope != null && id != null && String(id) === scope
  // risk-full answers for the account it was asked about (`risk.scopedTo`).
  const rf = riskFull && mine(riskFull.risk?.scopedTo) ? riskFull : null
  const effective = rf?.risk?.effective ?? null
  return {
    feedReport: feedReport && !feedReport.error && mine(feedReport.accountId) ? feedReport : null,
    dailyCap: mine(riskFull?.dailyCapEnforced?.accountId) ? riskFull.dailyCapEnforced : null,
    allAccounts: scope === 'all',
    depositCurrency: rf?.account?.depositCurrency ?? null,
    equityStopPct: effective?.equityStopPct ?? null,
    equityStopArmed: !error && effective ? effective.equityStopPct != null : null,
  }
}
