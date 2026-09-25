// ---------------------------------------------------------------------------
// src/lib/data-feed.js — the words the Data-feed card prints for measured
// figures (8,989-A row 11, WEB-9). Pure, so the rules are testable without a
// page: every figure carries its coverage, money stays in its own currency,
// and anything nobody measures is SAID to be unmeasured rather than drawn as
// a dash.
//
// The numbers come from the agent (GET /state/data-feed; the equity stop from
// /state/risk-full). Nothing here recomputes them. The card's daily stop is
// NOT read here: it is the account-overview `dailyStop` reading the account
// cards print (daily-stop-display.js), so the two can never disagree.
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

// ---------------------------------------------------------------------------
// WEB-9b (8,989-A row 11, second half): per-timeframe bar receipts and the
// broker-timestamped feed latency, from GET /state/data-feed `barReceipts` /
// `feedLatency` (agent/lib/feed-receipts.js). Times are printed in UTC so
// the text is the same on every screen and in every test.
// ---------------------------------------------------------------------------

/** The timeframes the card always names, whether or not a bar arrived. */
export const CARD_TIMEFRAMES = Object.freeze(['1m', '15m', '1h', '4h', '1d'])

const TF_LABEL = (tf) => (tf === '1d' ? '1D' : tf === '1w' ? '1W' : tf === '1mo' ? '1M' : tf)
// A missing time is "time unavailable", never 1970 (new Date(Number(null))).
const when = (msv) => (typeof msv === 'number' && Number.isFinite(msv) && msv > 0 ? new Date(msv) : null)
const utc = (msv) => {
  const d = when(msv)
  return d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'time unavailable'
}
const utcSec = (msv) => {
  const d = when(msv)
  return d ? `${d.toISOString().slice(11, 19)} UTC` : 'time unavailable'
}
const SOURCE_LABEL = {
  strategy_scan: 'strategy scan', pending_scan: 'pending-order scan', regime: 'regime read',
  fast_monitor_volume: 'fast-monitor volume read', daily_bar: "open positions' daily bar",
  last_close: 'last-close read', other: 'other reader (unnamed caller)',
}
const sourceLabel = (s) => SOURCE_LABEL[s] || s || 'unnamed reader'

/** A duration as the card prints it: "42 s", "3 min", "2.5 h", "4 d". */
export function formatAge(msv) {
  // Number(null) is 0: a missing age must never print as "0 s".
  const v = msv == null || msv === '' ? NaN : Number(msv)
  if (!Number.isFinite(v) || v < 0) return 'age unknown'
  if (v < 60_000) return `${Math.round(v / 1000)} s`
  if (v < 3_600_000) return `${Math.round(v / 60_000)} min`
  if (v < 86_400_000) return `${+(v / 3_600_000).toFixed(1)} h`
  return `${Math.round(v / 86_400_000)} d`
}

/**
 * One chip per timeframe: the named five plus any other timeframe the agent
 * received, shortest first. A chip carries the age of the LAST receipt from
 * any reader; its title lists every reader's own receipt, the newest bar's
 * open time and whether that bar was still forming when it arrived.
 *
 * `barReceipts` undefined/null: the report did not load or this agent does
 * not report receipts — the chips name the timeframe and say nothing else.
 *
 * @returns {Array<{key:string, label:string, received:boolean, text:string, title:string}>}
 */
export function timeframeChips(barReceipts, nowMs) {
  const rows = Array.isArray(barReceipts?.timeframes) ? barReceipts.timeframes : null
  const byTf = new Map((rows || []).map(r => [r.timeframe, r]))
  const keys = [...new Set([...CARD_TIMEFRAMES, ...byTf.keys()])]
  const dur = (tf) => byTf.get(tf)?.periodMs ?? ({ '1m': 6e4, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[tf] ?? Infinity)
  keys.sort((a, b) => dur(a) - dur(b) || a.localeCompare(b))
  return keys.map(tf => {
    const label = TF_LABEL(tf)
    const r = byTf.get(tf)
    if (!rows) return { key: tf, label, received: false, text: label, title: 'receipt time unavailable' }
    if (!r || r.lastReceivedAtMs == null) {
      const empty = r?.emptyResponses ? ` · ${r.emptyResponses} empty answer${r.emptyResponses === 1 ? '' : 's'} (no bars), last ${utc(r.lastEmptyAtMs)}` : ''
      return { key: tf, label, received: false, text: `${label} · none`, title: `no ${label} bar received since the agent started, ${utc(barReceipts.sinceMs)}${empty}` }
    }
    // The card's clock when it has one; otherwise the age the agent computed
    // (never `Number(null)`, which is 0 and would print a receipt as "now").
    // The agent's own age (agent clock, at the report) is a floor: a browser
    // clock running behind the agent's must not shrink a receipt to "0 s".
    const agentAge = typeof r.ageMs === 'number' && Number.isFinite(r.ageMs) ? r.ageMs : null
    const age = typeof nowMs === 'number' && Number.isFinite(nowMs)
      ? Math.max(agentAge ?? 0, nowMs - r.lastReceivedAtMs, 0)
      : agentAge
    const lines = (r.sources || []).map(s => {
      const forming = s.newestBarForming === true ? 'still forming at receipt' : s.newestBarForming === false ? 'already closed at receipt' : 'forming state not decidable'
      const prev = s.fromPreviousProcess ? ' · received before the last restart' : ''
      return `${sourceLabel(s.source)}: received ${utc(s.receivedAtMs)} via account ${s.accountId ?? 'unknown'} · newest bar opened ${utc(s.newestBarOpenMs)}, ${forming} · ${s.bars ?? '?'} bars${prev}`
    })
    return {
      key: tf, label, received: true,
      text: `${label} · ${formatAge(age)}${r.fromPreviousProcess ? ' (before restart)' : ''}`,
      title: [`${label} bars, agent receipt time (agent clock)`, ...lines].join('\n'),
    }
  })
}

/** The sentence under the chips: what a chip's time is, and since when. */
export function barReceiptsNote(feedReport) {
  if (!feedReport) return 'bar receipt times unavailable — the data-feed report did not load'
  const br = feedReport.barReceipts
  if (!br || !Array.isArray(br.timeframes)) return 'bar receipt times not reported by this agent'
  const got = br.timeframes.filter(r => r.lastReceivedAtMs != null).length
  return `Each chip is how long ago the agent last received that timeframe's bars from the broker (agent clock; hover for the reader, the newest bar and whether it was still forming). ${got} timeframe${got === 1 ? '' : 's'} received · recording since ${utc(br.sinceMs)}.`
}

/**
 * Market-feed latency: broker spot timestamp → agent receipt, per broker host.
 * Includes any clock offset between the broker and the agent, and says so.
 */
export function feedLatencyLine(feedLatency) {
  if (feedLatency === undefined) return 'market-feed latency unavailable — the data-feed report did not load'
  if (!feedLatency) return 'market-feed latency not reported by this agent'
  const win = `${Math.round((feedLatency.windowMs || 600_000) / 60_000)} min`
  const rangeS = Math.round((feedLatency.rangeMs || 60_000) / 1000)
  const hosts = feedLatency.byHost || []
  const n = (v) => Number(v) || 0
  // A host whose ring dropped events inside the window: its figures cover
  // only the span it kept, and the line says so instead of "last 10 min".
  const span = (h) => (h.truncated && typeof h.coversMs === 'number'
    ? ` in the last ${formatAge(h.coversMs)} only (older events in the ${win} window were not kept)`
    : '')
  // A stream that WAS open but gave no usable sample says what it gave —
  // "no stream was open" would hide a clock offset beyond the range.
  const openNoSamples = (h) => `${h.host} stream open, 0 latency samples: ${n(h.snapshotsSkipped)} snapshot${n(h.snapshotsSkipped) === 1 ? '' : 's'}, ${n(h.unstamped)} without a broker stamp, ${n(h.outOfRange)} beyond ±${rangeS} s${span(h)}`
  if (!hosts.some(h => h.events > 0)) {
    const lm = feedLatency.lastMeasured
    const last = lm?.byHost?.length
      ? ` · last measured ${utc(lm.atMs)}${lm.fromPreviousProcess ? ' (before the last restart)' : ''}: ${lm.byHost.map(h => `${h.host} p50 ${ms(h.p50Ms)} over ${h.events} events`).join('; ')}`
      : ''
    const why = hosts.length ? hosts.map(openNoSamples).join('; ') : 'no timestamped price stream was open'
    return `market-feed latency not measured in the last ${win} — ${why}${last}`
  }
  const parts = hosts.map(h => {
    if (!(h.events > 0)) return openNoSamples(h)
    const extra = [h.outOfRange ? `${h.outOfRange} beyond ±${rangeS} s not counted` : '',
      h.unstamped ? `${h.unstamped} without a broker stamp` : ''].filter(Boolean).join(', ')
    return `${h.host} p50 ${ms(h.p50Ms)} · p90 ${ms(h.p90Ms)} · max ${ms(h.maxMs)} over ${h.events} events${span(h)}${extra ? ` (${extra})` : ''}`
  })
  return `market-feed latency, broker spot timestamp → agent receipt, last ${win}: ${parts.join('; ')} · includes any broker/agent clock offset`
}

/**
 * A quote's receipt note: the AGENT's receipt time (it was labelled "broker
 * receipt", which it never was) and the broker's own event time when the
 * stream carried one.
 */
export function quoteReceiptNote(tick) {
  if (!tick?.receivedAtMs) return 'No quote received'
  const broker = Number.isSafeInteger(tick.brokerAtMs) && tick.brokerAtMs > 0
    ? `broker time ${utcSec(tick.brokerAtMs)}`
    : 'broker time not stamped'
  return `Agent receipt ${utcSec(tick.receivedAtMs)} · ${broker}`
}

/**
 * The DataFeed card's account-dependent props, each shown ONLY when its
 * response belongs to the account on screen.
 *
 * Switching account changes `acct` without remounting the page (see
 * use-lens-account.js), and the previous account's `feedReport` / `riskFull`
 * stay in state until the new load finishes both of its waits — the second
 * queues behind the performance-report reads. Checking scope only where the
 * response is STORED therefore let the old account's latency, fees, swap
 * and equity stop paint under the new account's heading. This is the check
 * at RENDER, so a mismatch reads as "did not load" / "unverified" instead of
 * another account's numbers.
 *
 * The daily stop is not among these: it comes from the account-overview row
 * of the account on screen (feedDailyStopView), the reading the account
 * cards use — one source, so no second daily-loss figure is carried here.
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
    allAccounts: scope === 'all',
    equityStopPct: effective?.equityStopPct ?? null,
    equityStopArmed: !error && effective ? effective.equityStopPct != null : null,
  }
}
