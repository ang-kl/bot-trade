import { getState, setState } from '../db.js'
import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { blockerReport, ENTRY_STOP_KINDS } from './blocker-report.js'
import { watchdogCalendarDemand } from './watchdog-calendar-refresh.js'
import { marketIdentityKey } from '../lib/market-identity.js'
import { tickEntryReceipts } from './tick-entry-work.js'

export function recordScannerWork(db, { creds, scopeAccounts, symbolMap, result, completedAt, nextDue, cadenceMs = nextDue - completedAt }) {
  let previous; try { previous = JSON.parse(getState(db, 'legacy_scanner_work_json') || 'null') } catch { /* no prior receipt */ }
  const scanned = [...new Set(result.scans.map(r => r.symbol))]
  const symbols = [...new Set(result.expectedSymbols || scanned)]
  const sameFeed = previous?.accountId === String(creds.accountId) && previous?.host === creds.host
  const prior = new Map((sameFeed ? previous.instruments : []).map(i => [i.symbol, i]))
  const rotationMs = Math.max(10000, cadenceMs) * Math.max(1, Number(result.rotationRuns) || Math.ceil(symbols.length / Math.max(1, scanned.length)))
  const receipt = { accountId: String(creds.accountId), host: creds.host, completedAt, nextDue,
    scopeAccounts: scopeAccounts.map(String).slice(0, 64),
    complete: creds.ready === true && !result.deadlineHit && !result.errors.length && symbols.length <= 512 && scopeAccounts.length <= 64,
    coverage: result.coverage, errors: result.errors.length,
    instruments: symbols.slice(0, 512).map(symbol => {
      const candidate = prior.get(symbol), old = candidate?.symbolId === String(symbolMap[symbol.toUpperCase()] || '') ? candidate : null
      const done = creds.ready === true && scanned.includes(symbol) && !result.errors.some(e => e.startsWith(`${symbol}:`))
      const at = done ? completedAt : old?.lastCompletedAt ?? null, registeredAt = old?.registeredAt ?? completedAt
      return { symbol, symbolId: String(symbolMap[symbol.toUpperCase()] || ''), lastCompletedAt: at, registeredAt,
        nextDue: (at ?? registeredAt) + rotationMs }
    }) }
  setState(db, 'legacy_scanner_work_json', JSON.stringify(receipt))
  return receipt
}

const clip = (value, n) => { const t = String(value); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/**
 * The no_orders notice's blocker line (cpp-verify watchdog.cpp reads
 * `blocker` as a STRING; `firstRecordedBlocker` is an object and printed
 * empty). The dominant recorded entry stop since the session opened, with the
 * latest one; a tick item leads with its own feeder outcome.
 */
export function entryActivityBlocker(blockers, tickPass = null) {
  const dominant = blockers?.byStage?.[0], latest = blockers?.latestEntryStop
  const stops = ENTRY_STOP_KINDS.reduce((n, k) => n + (blockers?.summary?.[k]?.records || 0), 0)
  // V3 WEB-1: an account report no longer carries the roster-wide stops (they
  // were charged to the selected account); they are named after the
  // account's own, so "no stop on this account" never hides a roster stop.
  const roster = blockers?.rosterWide, rosterTop = roster?.byStage?.find(s => ENTRY_STOP_KINDS.includes(s.kind))
  const rosterLine = rosterTop && !roster.includedInTotals
    ? `; roster-wide (every account): ${rosterTop.stage} ×${rosterTop.records} of ${roster.entryStops}` : ''
  const base = (!blockers ? 'blocker_report_unavailable' : dominant
    ? `${dominant.stage} ×${dominant.records} of ${stops} entry stops since session open; latest ${latest?.stage ?? dominant.stage}: ${latest?.reason ?? 'reason unrecorded'}`
    : 'no_recorded_entry_stop_since_session_open') + rosterLine
  if (!tickPass) return clip(base, 240)
  const tick = tickPass.paused ? `tick permits paused: ${tickPass.paused}`
    : tickPass.firstRefusal ? `tick permits ${tickPass.permits}, first refusal: ${tickPass.firstRefusal}`
      : `tick permits ${tickPass.permits}`
  return clip(`${tick}; ${base}`, 240)
}

function barReceipt(db, now) {
  let r; try { r = JSON.parse(getState(db, 'legacy_scanner_work_json') || 'null') } catch { return null }
  if (!r || !Number.isSafeInteger(r.completedAt) || !Number.isSafeInteger(r.nextDue) || r.completedAt > now
    || !Array.isArray(r.instruments) || r.instruments.length > 512 || !Array.isArray(r.scopeAccounts) || r.scopeAccounts.length > 64) return null
  return r
}

/**
 * Completed-work evidence for the watchdog. Read-only (it runs in the reserved
 * watchdog worker on a read-only connection).
 *
 * V3 C4 (WP-B B2d): entry_activity has two evidence sources — the bar scan
 * receipt (instruments × scope accounts) and each fresh tick permit receipt
 * (carried symbols × tick accounts). One item per (account, broker session):
 * the NEWEST COMPLETE source whose pass finished after the session opened
 * judges it; only when no source qualifies does the newest one speak (and
 * then it reports activityComplete false, never an observed zero). The bar
 * `scanner` items are emitted first, so tick lookups can never push them past
 * the shared 2048 lookup bound.
 */
export function scannerWork(db, accounts, now) {
  const r = barReceipt(db, now)
  const work = [], maps = new Map()
  let lookups = 0
  const capacity = () => { work.push({ id: 'legacy-inventory-capacity', inventoryComplete: false }); return work }
  const sources = []
  if (r) {
    for (const instrument of r.instruments) {
      if (work.length >= 2048 || ++lookups > 2048) return capacity()
      const feed = { provider: 'ctrader', accountId: r.accountId, host: r.host, symbolId: instrument.symbolId }
      let calendar = null; try { calendar = projectCalendar(readMarketCalendar(db, feed, { nowMs: now }), now) } catch { /* unknown calendar */ }
      work.push({ ...feed, id: `legacy-scan:${r.accountId}:${instrument.symbolId}`, role: 'scanner',
        calendar, lastCompletedAtMs: instrument.lastCompletedAt, nextDueMs: instrument.nextDue,
        outcome: r.complete ? 'batch_evaluated' : 'partial_or_failed_batch', coverage: r.coverage, errors: r.errors })
    }
    sources.push({ basis: 'bar', completedAt: r.completedAt, nextDue: r.nextDue, complete: r.complete === true, receipt: r,
      pairs: r.instruments.flatMap(i => r.scopeAccounts.map(accountId => [i.symbol, String(accountId), null])) })
  }
  for (const t of tickEntryReceipts(db, now)) {
    const byAccount = t.accounts.map(a => [String(a?.accountId), a])
    sources.push({ basis: 'tick', completedAt: t.completedAt, nextDue: t.nextDue, complete: t.complete === true, receipt: t,
      pairs: t.symbols.flatMap(symbol => byAccount.map(([accountId, a]) => [symbol, accountId, a])) })
  }
  // Newest first; a stable sort keeps the bar receipt ahead of a tick one on a tie.
  sources.sort((a, b) => b.completedAt - a.completedAt)
  const chosen = new Map()
  for (const source of sources) {
    for (const [symbol, accountId, tickAccount] of source.pairs) {
      if (work.length >= 2048 || ++lookups > 2048) return capacity()
      const account = accounts.get(accountId); if (!account) continue
      let symbolId; try {
        if (!maps.has(accountId)) maps.set(accountId, getAccountSymbolMap(db, accountId)?.map || {})
        symbolId = maps.get(accountId)[String(symbol).toUpperCase()]
      } catch { continue }
      if (!symbolId) continue
      const identity = { provider: 'ctrader', accountId, host: account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', symbolId: String(symbolId) }
      const c = projectCalendar(readMarketCalendar(db, identity, { nowMs: now }), now)
      if (!c?.sessionOpenedAtMs || now - c.sessionOpenedAtMs > 90 * 86400_000) continue
      const key = `${accountId}:${c.sessionId}`
      const qualifies = source.complete && source.completedAt >= c.sessionOpenedAtMs
      const prior = chosen.get(key)
      if (!prior || (!prior.qualifies && qualifies)) chosen.set(key, { source, identity, calendar: c, qualifies, tickAccount })
    }
  }
  for (const [key, { source, identity, calendar: c, tickAccount }] of chosen) {
    if (work.length >= 2048) return capacity()
    const accountId = identity.accountId
    const from = c.sessionOpenedAtMs, bounds = [new Date(from).toISOString(), new Date(now + 1).toISOString()]
    const counts = {}
    // These overlapping sources are evidence of activity, not summed into
    // a false order count. Only an observed zero is exported as zero.
    for (const [name, table, at, extra] of [
      ['intents', 'entry_intents', 'created_at', "AND state IN ('DISPATCHING','SENT','UNKNOWN','ACCEPTED','FILLED')"],
      ['fills', 'trades', 'opened_at', ''],
      ['dispatches', 'decision_log', 'created_at', "AND stage='dispatch' AND decision='proceed'"],
    ]) counts[name] = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE account_id=? ${extra}
      AND julianday(${at})>=julianday(?) AND julianday(${at})<julianday(?)`).get(accountId, ...bounds).n
    const ambiguous = db.prepare(`SELECT COUNT(*) n FROM trades WHERE (account_id IS NULL OR julianday(opened_at) IS NULL)
      AND (julianday(opened_at) IS NULL OR (julianday(opened_at)>=julianday(?) AND julianday(opened_at)<julianday(?)))`).get(...bounds).n
    // The blocker is context for the notice, not evidence of activity: a
    // failed read names itself instead of failing the whole contract (which
    // cpp-verify would turn into an urgent node:work_evidence incident).
    let blockers = null
    try { blockers = blockerReport(db, { accountId, from, to: now + 1, now, limit: 1 }) } catch { blockers = null }
    const complete = source.complete && source.completedAt >= from && !ambiguous
    const tick = source.basis === 'tick'
    const tickPass = tick ? { side: source.receipt.side, permits: tickAccount?.permits ?? 0, paused: tickAccount?.paused ?? null, firstRefusal: tickAccount?.firstRefusal ?? null } : null
    work.push({ ...identity, id: `entry-activity:${key}`, role: 'entry_activity', basis: source.basis, calendar: c,
      sessionOpenedAtMs: from, sessionId: c.sessionId, lastCompletedAtMs: source.completedAt, nextDueMs: source.nextDue,
      activityComplete: complete, ordersSinceOpen: complete && Object.values(counts).every(n => n === 0) ? 0 : null,
      hasRecordedOrder: Object.values(counts).some(n => n > 0),
      orderEvidence: counts, unattributedOrUndatedFills: ambiguous, scanCoverage: tick ? null : source.receipt.coverage,
      blockerCounts: blockers?.summary ?? null, firstRecordedBlocker: blockers?.latestEntryStop?.firstBlocker ?? null,
      blocker: entryActivityBlocker(blockers, tickPass),
      ...(tick ? { tickPass } : {}),
      reason: tick ? 'retained_account_activity_after_completed_tick_permit_pass' : 'retained_account_activity_after_completed_scan_batch',
      scopeNote: 'Zero means no recorded dispatch, unresolved/accepted intent or fill since this broker session opened. Sources overlap; counts are not added. Scan coverage names the completed batch, not the entire watchlist.' })
  }
  return work
}

export function watchdogCalendars(db, now) {
  // Active work leads. A daily universe refresh can retain thousands of
  // calendars; alphabetic LIMIT must not crowd out a held position/feed.
  const demand = watchdogCalendarDemand(db, now)
  const identities = new Map(demand.identities.map(id => [marketIdentityKey(id), id]))
  const rows = db.prepare("SELECT value FROM agent_state WHERE key LIKE 'market_calendar:v1:%' ORDER BY key LIMIT 513").all()
  let complete = demand.complete && rows.length <= 512
  for (const row of rows) {
    try {
      const identity = JSON.parse(row.value)?.latest?.identity, key = marketIdentityKey(identity)
      if (!key) { complete = false; continue }
      if (!identities.has(key)) {
        if (identities.size < 512) identities.set(key, identity)
        else complete = false
      }
    } catch { complete = false /* malformed cache is not calendar evidence */ }
  }
  const calendars = []; let size = 0
  for (const identity of identities.values()) {
    const evidence = readMarketCalendar(db, identity, { nowMs: now })
    const calendar = projectCalendar(evidence, now)
    const entry = { identity, calendar, reason: evidence.reason }; size += Buffer.byteLength(JSON.stringify(entry))
    if (size > 96 * 1024) { complete = false; break }
    calendars.push(entry)
  }
  return { calendars, calendarsComplete: complete }
}
