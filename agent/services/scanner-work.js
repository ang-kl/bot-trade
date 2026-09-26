import { getState, setState } from '../db.js'
import { getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar, contractCalendar } from '../lib/calendar-intervals.js'
import { blockerReport, ENTRY_STOP_KINDS } from './blocker-report.js'
import { watchdogCalendarDemand } from './watchdog-calendar-refresh.js'
import { marketIdentityKey } from '../lib/market-identity.js'
import { tickEntryReceipts } from './tick-entry-work.js'
import { SCANNER_PROFILE_LIMIT } from '../lib/scanner-bounds.js'

/**
 * Liveness of Node's scanner observation collector (V3 CV-1), for cpp-verify.
 *
 * cpp-scan-timeframe lists only work that is DUE: an idle cell has no
 * deadline (Node's rotation and one-bar cache made a per-bar deadline pass
 * cpp-verify's grace with nothing wrong). So nothing native notices when
 * Node's bridge worker dies or stops polling — this item does. The collector
 * records each round (at most once a second) in `scanner_bridge_poll_json`;
 * its next round is due COLLECTOR_DUE_MS later (the bridge rebuilds a failed
 * worker after 30 s, checked every 60 s, so 120 s is a real stop).
 *
 * Emitted only while the bridge's own gate is open (scanner-feed.js
 * approvedProfiles: the flag, a file database, 1..SCANNER_PROFILE_LIMIT
 * registered profiles), so an unconfigured bridge is not reported as stalled.
 * A round recorded before this process started is not evidence for it: the
 * deadline runs from the later of the two. Role 'collector' is cpp-verify's
 * calendar-free liveness role (a stall there is a warning, not urgent).
 */
export const COLLECTOR_DUE_MS = 120_000
export function scannerCollectorWork(db, now, { env = process.env, startedAtMs = now - Math.round(process.uptime() * 1000) } = {}) {
  if (env.SCANNER_BRIDGE_ENABLED !== '1' || !db.name || db.name === ':memory:') return []
  let profiles, round
  try { profiles = JSON.parse(getState(db, 'scanner_mirror_profiles_json') || 'null') } catch { profiles = null }
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > SCANNER_PROFILE_LIMIT) return []
  try { round = JSON.parse(getState(db, 'scanner_bridge_poll_json') || 'null') } catch { round = null }
  const readAt = Number.isSafeInteger(round?.readAtMs) && round.readAtMs > 0 && round.readAtMs <= now ? round.readAtMs : null
  const current = readAt != null && readAt >= startedAtMs
  // lastError rides every later record, so only a recent one is named.
  const recentError = round?.lastError && now - round.lastError.atMs < COLLECTOR_DUE_MS ? round.lastError.error : null
  const blocker = !current ? 'no_collector_round_since_process_start'
    : round.error || recentError || (round.tickBacklog ? 'tick_comparison_backlog' : null)
  return [{ id: 'scanner-bridge:collector', role: 'collector', lastCompletedAtMs: current ? readAt : null,
    nextDueMs: Math.max(current ? readAt : 0, startedAtMs) + COLLECTOR_DUE_MS, blocker,
    durationMs: current && Number.isFinite(round.durationMs) ? round.durationMs : null,
    reason: 'scanner_observation_collector_round', orderAuthority: false }]
}

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

export const CALENDAR_EXPORT_MAX_BYTES = 96 * 1024

/**
 * The calendars Node exports to cpp-verify (watchdog_state.cpp:162-166 copies
 * `calendars[i].calendar` onto every work item of every service whose
 * (accountId, host, symbolId) matches `calendars[i].identity`).
 *
 * V3 K1: the demand arrives tier-ordered (feed, position, legacy, scope), so
 * gateway-feed calendars — the only ones cpp-exec's quote_flow work can get —
 * lead the 96 KiB bound; the retained cache follows as before. Each entry is
 * the contract projection (contractCalendar: the fields the verifier reads),
 * and nodeWatchdogContract carries each identity's calendar ONCE: a work item
 * whose identity is exported here does not repeat it.
 *
 * `calendarsComplete` keeps its meaning (every demanded and retained identity
 * exported within the bounds); `demandComplete` is the demand's own
 * completeness and `exportComplete` the export's own (calendarsComplete is
 * exactly both), reported apart so a truncated export and a missing account
 * map are not the same fact.
 *
 * V3 K1c: why the retained cache stays in the verdict, and what shows it.
 * Measured 26-09: every demanded calendar exported (136 of 136, the 111 feed
 * ones included) while calendarsComplete read false, because the 96 KiB
 * bound cut the retained tail. Read against the services, that false is not
 * a formality: a retained, non-demanded calendar CAN land on a work item.
 * cpp-scan-tick's rows carry no calendar of their own (the gateway mirror
 * batch has none, scanner_mirror.cpp:62-65; the row copies it,
 * cpp-scan-tick scanner.cpp:129/207), and status() lists every registered
 * stream, stale ones included (scanner.cpp:199-212; evicted only when the
 * 512-stream table is full, scanner.cpp:64-72). The demand's feed tier holds
 * only each gateway's CURRENT subscription under its CURRENT feed account, and
 * skips a dormant or absent gateway without calling the demand incomplete
 * (watchdog-calendar-refresh.js:90-99). A stream the gateway no longer feeds
 * therefore keeps a row whose only calendar source is this export's retained
 * part — and with it the verifier reads OPEN and raises the urgent stale-quote
 * incident (watchdog_state.cpp:217), without it UNKNOWN and a warning
 * (watchdog_state.cpp:200-201). cpp-exec's quote_flow rows (calendar null,
 * watchdog_contract.cpp:24) are in the same position for a symbol added
 * between two gateway health reads. Node's own items do not need it: each
 * carries its own calendar unless its identity is exported with one
 * (watchdog-contract.js shareCalendars). So the verdict is unchanged, and
 * `calendarExport` says which part was cut: `demanded` (the demand, in the
 * order above) and `retained` (the non-demanded cache rows read), each with
 * total / exported / withCalendar / cut; `retained.totalIsLowerBound` when
 * the cache holds more rows than the 512 read. Counted inside the one pass
 * below, no second read of any calendar.
 */
export function watchdogCalendars(db, now, { lead = null } = {}) {
  // Active work leads. A daily universe refresh can retain thousands of
  // calendars; alphabetic LIMIT must not crowd out a held position/feed.
  const demand = watchdogCalendarDemand(db, now)
  // Within the bound: gateway feeds (no other carrier), then the identities
  // Node's own work items reference (`lead`: exported, they are not repeated
  // on the item), then the rest of the demand in tier order.
  const tierOf = key => demand.detail.get(key)?.tier
  const ranked = demand.identities.map((id, i) => {
    const key = marketIdentityKey(id)
    return { key, id, rank: tierOf(key) === 'feed' ? 0 : lead?.has(key) ? 1 : 2, i }
  }).sort((a, b) => a.rank - b.rank || a.i - b.i)
  const identities = new Map(ranked.map(r => [r.key, r.id]))
  // The demand is the first `demanded` entries of `identities` (a Map keeps
  // insertion order); every key appended below is a retained one.
  const demanded = identities.size, retainedKeys = new Set()
  let malformed = 0
  const rows = db.prepare("SELECT value FROM agent_state WHERE key LIKE 'market_calendar:v1:%' ORDER BY key LIMIT 513").all()
  // exportComplete: the export itself (retained cache read, projection, the
  // byte bound) apart from the demand, so a cut export stays visible while a
  // missing account map keeps calendarsComplete false.
  let exportComplete = rows.length <= 512
  for (const row of rows) {
    try {
      const identity = JSON.parse(row.value)?.latest?.identity, key = marketIdentityKey(identity)
      if (!key) { exportComplete = false; malformed++; continue }
      if (!identities.has(key) && !retainedKeys.has(key)) {
        retainedKeys.add(key)
        if (identities.size < 512) identities.set(key, identity)
        else exportComplete = false
      }
    } catch { exportComplete = false; malformed++ /* malformed cache is not calendar evidence */ }
  }
  // The bound is on the serialised array: brackets and separators count.
  const calendars = []; let size = 2
  const parts = { demanded: { exported: 0, withCalendar: 0 }, retained: { exported: 0, withCalendar: 0 } }
  for (const identity of identities.values()) {
    const evidence = readMarketCalendar(db, identity, { nowMs: now })
    let calendar = null, reason = evidence.reason
    // One calendar the projection cannot express is that calendar's unknown,
    // never a thrown contract (cpp-verify would raise node:work_evidence).
    try { calendar = contractCalendar(projectCalendar(evidence, now), now) } catch { calendar = null; reason = 'calendar_projection_failed'; exportComplete = false }
    const entry = { identity, calendar, reason }; size += Buffer.byteLength(JSON.stringify(entry)) + (calendars.length ? 1 : 0)
    if (size > CALENDAR_EXPORT_MAX_BYTES) { exportComplete = false; break }
    const part = calendars.length < demanded ? parts.demanded : parts.retained
    calendars.push(entry)
    part.exported++; if (calendar) part.withCalendar++
  }
  const count = (total, { exported, withCalendar }) => ({ total, exported, withCalendar, cut: total - exported })
  return { calendars, calendarsComplete: demand.complete && exportComplete, exportComplete, demandComplete: demand.complete,
    calendarExport: { demanded: count(demanded, parts.demanded),
      retained: { ...count(retainedKeys.size, parts.retained), totalIsLowerBound: rows.length > 512, malformed } } }
}
