// ---------------------------------------------------------------------------
// agent/services/calendar-coverage.js — V3 K1: GET /state/calendar-coverage.
//
// Per registered account: is its OWN broker calendar evidence there, for
// which demand, and what does it say? Built from the same demand the
// collector and the watchdog export use (watchdog-calendar-refresh.js
// watchdogCalendarDemand), the watchdog contract exactly as cpp-verify gets
// it (watchdog-contract.js nodeWatchdogContract: its export, its size, its
// shared calendars) and the stored broker observations (market-calendar.js).
// Read-only: it makes no broker
// call and writes nothing — it runs on the read-only report worker
// (performance-populations.js kind 'calendar-coverage'), never on the event
// loop that runs protection, because it reads every demanded calendar.
//
// The one consumer `calendarsComplete` never had (V3 review: set, never read)
// is this read. What it shows, per account:
//   - the account's own symbol map: present / missing / unreadable, builtAt,
//     age and size. A missing map is shown as missing, never as healthy: the
//     account then has no scope identities at all;
//   - the demand by tier (feed, position, legacy, scope) and the names its
//     own map could not resolve;
//   - OPEN / CLOSED / UNKNOWN over its demanded identities, with the UNKNOWN
//     reasons as a histogram (holiday_bounds_omitted and
//     holiday_bounds_invalid are distinct since K1), and the oldest
//     observation;
//   - watchlist symbols that are NOT demanded, named as such (the demand is
//     bounded to scan, feed and held symbols; a 260-symbol list is not);
//   - how often the name-keyed symbol_hours gate — the one entries use today
//     (loop.js market-hours check) — disagrees with the account's calendar at
//     this instant (revision-3:216; the evidence for owner question O3);
//   - broker holidays in the next 14 days on its demanded identities, bounded
//     or not, each with how its bounds were sent.
// Plus the collector's last receipt AND its last persisted skip, and the size
// of what the watchdog export carries.
//
// V3 K2: beside each account's map, the daily map refresher's view of it
// (account-symbol-maps.js): whether the map is proven to be the account's own
// list, whether it is due and why, whether it must wait (backoff or the daily
// read cap) and the last attempt's outcome — so a map that never arrives is
// shown with the reason, not only as "missing".
//
// Owner principle 1: the host comes from registeredCalendarAccounts (routing
// only); no rule here differs by account environment.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { marketIdentityKey } from '../lib/market-identity.js'
import { readMarketCalendar, storedHolidays } from './market-calendar.js'
import { watchdogCalendarDemand, registeredCalendarAccounts, DEMAND_TIERS, CALENDAR_REFRESH_SKIP_KEY, CALENDAR_DEMAND_MAX_IDENTITIES } from './watchdog-calendar-refresh.js'
import { CALENDAR_EXPORT_MAX_BYTES } from './scanner-work.js'
import { nodeWatchdogContract, CONTRACT_MAX_BYTES } from './watchdog-contract.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import { readWatchlist, hasOwnWatchlist } from './watchlists.js'
import { accountSymbolMapRefreshView } from './account-symbol-maps.js'

const DAY = 86400_000
export const COVERAGE_HOLIDAY_DAYS = 14
const MAX_ACCOUNTS = 64, MAX_HOLIDAY_GROUPS = 32, MAX_EXAMPLES = 10, MAX_NOT_DEMANDED = 50
const read = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const ageOf = (at, now) => { const t = Date.parse(at); return Number.isFinite(t) ? now - t : null }

function symbolMapOf(db, accountId, now) {
  const raw = getState(db, accountSymbolMapKey(accountId))
  if (raw == null) return { status: 'missing', builtAt: null, ageMs: null, size: 0, map: null }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || typeof parsed.map !== 'object' || parsed.map == null || Array.isArray(parsed.map)) return { status: 'unreadable', builtAt: null, ageMs: null, size: 0, map: null }
  const builtAt = typeof parsed.builtAt === 'string' ? parsed.builtAt : null
  return { status: 'present', builtAt, ageMs: builtAt ? ageOf(builtAt, now) : null, size: Object.keys(parsed.map).length, map: parsed.map }
}

// The UTC dates of the holiday window: yesterday (a holiday's own zone can
// still be on it) through COVERAGE_HOLIDAY_DAYS ahead.
function windowDates(now) {
  const start = Math.floor(now / DAY) * DAY - DAY
  return Array.from({ length: COVERAGE_HOLIDAY_DAYS + 2 }, (_, i) => new Date(start + i * DAY).toISOString().slice(0, 10))
}

// V3 K2: the refresher's view of this account's map, beside K1's symbolMap.
// When the map was built is symbolMap.builtAt (the measured value, whichever
// path wrote it); lastAttemptAt/lastResult are the refresher's own attempts.
function refreshOf(r) {
  if (!r) return null
  return { ownList: r.map?.ownList === true, due: r.due, dueReason: r.dueReason, blocked: r.blocked, notBefore: r.notBefore,
    lastAttemptAt: r.lastAttemptAt, lastResult: r.lastResult, lastError: r.lastError,
    consecutiveFailures: r.consecutiveFailures, readsToday: r.readsToday }
}

function blankAccount(account, map, refresh) {
  return {
    accountId: account.accountId, host: account.host,
    symbolMap: { status: map.status, builtAt: map.builtAt, ageMs: map.ageMs, size: map.size },
    symbolMapRefresh: refreshOf(refresh),
    demand: { total: 0, byTier: Object.fromEntries(DEMAND_TIERS.map(t => [t, 0])), missingMap: false, unresolvedNames: 0 },
    status: { OPEN: 0, CLOSED: 0, UNKNOWN: 0 }, unknownReasons: {}, oldestObservedAt: null,
    demandedCoverage: 'missing',
    watchlist: null,
    gateDisagreements: { compared: 0, disagree: 0, bySource: {}, examples: [] },
    holidays: [],
  }
}

/** The coverage report. Pure reads; pass `now` for a deterministic build. */
export function buildCalendarCoverage(db, { now = Date.now() } = {}) {
  const registered = [...registeredCalendarAccounts(db).values()].slice(0, MAX_ACCOUNTS)
  const demand = watchdogCalendarDemand(db, now)
  // The export as the verifier receives it: the same contract build, not a
  // re-derivation that could disagree with it.
  const contract = nodeWatchdogContract(db, { now })
  const storedKeys = new Set(db.prepare("SELECT key FROM agent_state WHERE key LIKE 'market_calendar:v1:%'").all().map(r => r.key))
  const maps = new Map(registered.map(a => [a.accountId, symbolMapOf(db, a.accountId, now)]))
  const mapRefresh = accountSymbolMapRefreshView(db, { now })
  const refreshById = new Map(mapRefresh.accounts.map(r => [r.accountId, r]))
  const byAccount = new Map(registered.map(a => [a.accountId, blankAccount(a, maps.get(a.accountId), refreshById.get(a.accountId))]))
  const reverse = new Map() // accountId → symbolId → name (feed-tier names)
  const nameOf = (accountId, symbolId) => {
    if (!reverse.has(accountId)) {
      const map = maps.get(accountId)?.map
      reverse.set(accountId, map ? new Map(Object.entries(map).map(([name, id]) => [String(id), name])) : new Map())
    }
    return reverse.get(accountId).get(String(symbolId)) ?? null
  }
  const dates = windowDates(now), dateSet = new Set(dates)
  const groups = new Map() // accountId → key → group
  const versions = new Set()

  for (const identity of demand.identities) {
    const key = marketIdentityKey(identity), detail = demand.detail.get(key) ?? { tier: null, symbol: null }
    const a = byAccount.get(identity.accountId)
    if (!a) continue
    a.demand.total++
    if (detail.tier) a.demand.byTier[detail.tier]++
    const evidence = readMarketCalendar(db, identity, { nowMs: now })
    const status = evidence.marketStatus === 'OPEN' ? 'OPEN' : evidence.marketStatus === 'CLOSED' ? 'CLOSED' : 'UNKNOWN'
    a.status[status]++
    if (status === 'UNKNOWN') { const r = evidence.reason ?? 'unknown'; a.unknownReasons[r] = (a.unknownReasons[r] || 0) + 1 }
    else versions.add(evidence.version)
    if (evidence.observedAt && (a.oldestObservedAt == null || evidence.observedAt < a.oldestObservedAt)) a.oldestObservedAt = evidence.observedAt
    const name = detail.symbol ?? nameOf(identity.accountId, identity.symbolId)
    // The entry gate's reading of the same instant, by symbol NAME.
    if (status !== 'UNKNOWN' && name) {
      const gate = isSymbolOpenCached(db, name, new Date(now))
      a.gateDisagreements.compared++
      if (Boolean(gate.open) !== (status === 'OPEN')) {
        a.gateDisagreements.disagree++
        a.gateDisagreements.bySource[gate.source] = (a.gateDisagreements.bySource[gate.source] || 0) + 1
        if (a.gateDisagreements.examples.length < MAX_EXAMPLES) a.gateDisagreements.examples.push({
          symbol: name, symbolId: identity.symbolId, accountCalendar: status, calendarReason: evidence.reason ?? null,
          symbolHours: gate.open ? 'OPEN' : 'CLOSED', symbolHoursSource: gate.source })
      }
    }
    const stored = storedHolidays(db, identity)
    for (const h of stored?.holidays ?? []) {
      if (!h.dateIso) continue
      const date = h.isRecurring === true ? dates.find(d => d.slice(5) === h.dateIso.slice(5)) : dateSet.has(h.dateIso) ? h.dateIso : null
      if (!date) continue
      if (!groups.has(a.accountId)) groups.set(a.accountId, new Map())
      const g = groups.get(a.accountId)
      const gk = JSON.stringify([date, h.name, h.scheduleTimeZone, h.reason, h.startSecond ?? null, h.endSecond ?? null])
      if (!g.has(gk)) g.set(gk, { dateIso: date, name: h.name, scheduleTimeZone: h.scheduleTimeZone, isRecurring: h.isRecurring,
        bounds: h.reason ?? 'explicit', ...('startSecond' in h ? { startSecond: h.startSecond } : {}), ...('endSecond' in h ? { endSecond: h.endSecond } : {}),
        identities: 0, symbols: [] })
      const row = g.get(gk); row.identities++
      if (row.symbols.length < 5) row.symbols.push(name ?? identity.symbolId)
    }
  }

  for (const [accountId, u] of demand.unresolved) {
    const a = byAccount.get(accountId); if (!a) continue
    a.demand.missingMap = u.missingMap; a.demand.unresolvedNames = u.unresolvedNames
  }
  for (const a of byAccount.values()) {
    const map = maps.get(a.accountId)
    // Watchlist symbols: demanded, not demanded, or not resolvable at all.
    const own = hasOwnWatchlist(db, a.accountId)
    const symbols = [...new Set(readWatchlist(db, a.accountId).filter(i => i.enabled !== false && i.symbol).map(i => i.symbol))]
    const w = { source: own ? 'own' : 'inherited', total: symbols.length, demanded: 0, notDemanded: 0, notDemandedWithStoredCalendar: 0, noSymbolId: 0, notDemandedSymbols: [] }
    for (const s of symbols) {
      const symbolId = map?.map?.[s]
      const key = symbolId == null ? null : marketIdentityKey({ accountId: a.accountId, host: a.host, symbolId })
      if (!key) { w.noSymbolId++; continue }
      if (demand.detail.has(key)) { w.demanded++; continue }
      w.notDemanded++
      if (storedKeys.has(`market_calendar:v1:${key}`)) w.notDemandedWithStoredCalendar++
      if (w.notDemandedSymbols.length < MAX_NOT_DEMANDED) w.notDemandedSymbols.push(s)
    }
    a.watchlist = w
    a.holidays = [...(groups.get(a.accountId)?.values() ?? [])]
      .sort((x, y) => x.dateIso.localeCompare(y.dateIso) || String(x.name).localeCompare(String(y.name))).slice(0, MAX_HOLIDAY_GROUPS)
    const known = a.status.OPEN + a.status.CLOSED
    a.demandedCoverage = map.status !== 'present' || a.demand.total === 0 || known === 0 ? 'missing'
      : a.status.UNKNOWN > 0 || a.demand.unresolvedNames > 0 || !demand.complete ? 'partial' : 'complete'
  }

  const calendars = Array.isArray(contract.calendars) ? contract.calendars : []
  const exportedKeys = new Set(calendars.filter(c => c.calendar).map(c => marketIdentityKey(c.identity)))
  const feedKeys = [...demand.detail].filter(([, d]) => d.tier === 'feed').map(([k]) => k)
  const receipt = read(db, 'watchdog_calendar_refresh_json'), skip = read(db, CALENDAR_REFRESH_SKIP_KEY)
  const receiptAt = Date.parse(receipt?.at), skipAt = Date.parse(skip?.at)
  return {
    schemaVersion: 1, observedAtMs: now, source: 'node_records', brokerCalls: 0,
    demand: { total: demand.identities.length, max: CALENDAR_DEMAND_MAX_IDENTITIES, complete: demand.complete, byTier: demand.byTier },
    export: {
      entries: calendars.length, withCalendar: exportedKeys.size, bytes: Buffer.byteLength(JSON.stringify(calendars)),
      maxBytes: CALENDAR_EXPORT_MAX_BYTES, calendarsComplete: contract.calendarsComplete === true, demandComplete: contract.demandComplete === true,
      exportComplete: contract.exportComplete === true,
      feed: { demanded: feedKeys.length, exportedWithCalendar: feedKeys.filter(k => exportedKeys.has(k)).length },
      workItemsSharingAnExportedCalendar: (contract.work ?? []).filter(w => w.calendarIn === 'calendars').length,
      contractBytes: Buffer.byteLength(JSON.stringify(contract)), contractMaxBytes: CONTRACT_MAX_BYTES,
      workComplete: contract.workComplete === true, contractReason: contract.reason ?? null,
      knownVersions: versions.size,
    },
    symbolMapRefresher: {
      at: mapRefresh.at, ageMs: mapRefresh.ageMs, pass: mapRefresh.pass, passEveryMs: mapRefresh.passEveryMs,
      refreshAgeMs: mapRefresh.refreshAgeMs, maxReadsPerAccountDay: mapRefresh.maxReadsPerAccountDay,
      due: mapRefresh.accounts.filter(r => r.due).length, waiting: mapRefresh.accounts.filter(r => r.due && r.blocked).length,
    },
    collector: {
      receipt: receipt ? { ...receipt, ageMs: ageOf(receipt.at, now) } : null,
      lastSkip: skip ? { ...skip, ageMs: ageOf(skip.at, now) } : null,
      latest: Number.isFinite(skipAt) && (!Number.isFinite(receiptAt) || skipAt > receiptAt) ? 'skip' : Number.isFinite(receiptAt) ? 'receipt' : null,
    },
    holidayWindow: { from: dates[0], to: dates.at(-1), basis: 'UTC calendar date of the broker holidayDate; recurring rows by month-day' },
    accounts: [...byAccount.values()],
    limitations: [
      'Advisory evidence only: entries still use the name-keyed symbol_hours gate; gateDisagreements measures that gate against the account calendar at this instant.',
      'demandedCoverage covers the demanded identities only; watchlist symbols outside the demand are listed as notDemanded, never counted as covered.',
      'A bound the broker did not send is reported as omitted; no replacement boundary is invented.',
      'A present map (symbolMap.status present) with symbolMapRefresh.ownList false is not proven to be the account\'s own symbol list (written before V3 K2); it is re-read once, and until then its ids are shown as stored. A missing or unreadable map also reads ownList false; symbolMap.status says which.',
      'symbolMapRefresh.blocked names why a due map is not read yet: token_refused (the broker token was refused for this account; no read until that clears), daily_cap or backoff (until notBefore).',
    ],
  }
}
