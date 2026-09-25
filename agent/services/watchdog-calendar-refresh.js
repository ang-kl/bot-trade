// Observation only: bounded account-specific symbol reads for existing work.
import { getState, setState } from '../db.js'
import { credsForRegisteredAccount, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { readMarketCalendar, recordMarketCalendar } from './market-calendar.js'
import { disarmReason } from '../lib/env-disarm.js'
import { tickEntryReceipts } from './tick-entry-work.js'

const read = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) < 360_000
const MAX_IDENTITIES = 512, BATCH = 25
export const CALENDAR_DEMAND_MAX_IDENTITIES = MAX_IDENTITIES
// Collector skips are kept apart from the receipt, which only a completed
// batch may write (the receipt of the last real batch must stay as it was).
export const CALENDAR_REFRESH_SKIP_KEY = 'watchdog_calendar_refresh_skip_json'

/**
 * Routing only (owner principle 1): each registered account and its own
 * broker host. The one place calendar code reads the environment column; the
 * demand, the coverage read (calendar-coverage.js) and every identity check
 * share it, so no second copy of the host choice can drift.
 */
export function registeredCalendarAccounts(db) {
  return new Map(db.prepare('SELECT account_id,is_live FROM accounts').all().map(a => [String(a.account_id),
    { accountId: String(a.account_id), host: a.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com' }]))
}

/** Demand tiers, in the order they meet the 512-identity cap (V3 K1). */
export const DEMAND_TIERS = Object.freeze(['feed', 'position', 'legacy', 'scope'])

/**
 * The calendar identities the watchdog needs, tier by tier (V3 K1). The
 * 512-identity cap is applied in the order of the add() calls, so the tier
 * order IS the priority:
 *   1 feed      — each gateway's subscribed spot feed (cpp-exec's quote_flow
 *                 work reads its calendar only from Node's export);
 *   2 position  — EVERY active held position, paused and external included:
 *                 calendar evidence is read-only, and who manages a position
 *                 does not change its market hours;
 *   3 legacy    — the bar scan's instruments on its feed account;
 *   4 scope     — each scope account's OWN identity for each bar-scan name
 *                 (resolved through that account's own symbol map, never the
 *                 feed account's ids), then each tick account's own identity
 *                 for each carried tick name. Both symbol-major, so the cap
 *                 truncates across accounts instead of starving the last.
 * A name missing from an account's own map, a missing map, a foreign host or
 * a refused identity is missing coverage (complete false), never an empty
 * demand. `detail` (key → {tier, symbol}) and `unresolved` (per account) feed
 * the coverage read; `identities` stays clean identity objects.
 */
export function watchdogCalendarDemand(db, now) {
  const accounts = registeredCalendarAccounts(db)
  const wanted = new Map(), maps = new Map(), detail = new Map(), unresolved = new Map(); let complete = true
  const byTier = Object.fromEntries(DEMAND_TIERS.map(t => [t, 0]))
  const miss = (accountId, why) => {
    complete = false
    if (!accounts.has(accountId)) return
    const u = unresolved.get(accountId) ?? { missingMap: false, unresolvedNames: 0 }
    if (why === 'map') u.missingMap = true; else u.unresolvedNames++
    unresolved.set(accountId, u)
  }
  const mapOf = accountId => {
    if (!maps.has(accountId)) maps.set(accountId, getAccountSymbolMap(db, accountId)?.map ?? null)
    return maps.get(accountId)
  }
  const add = (input, tier, symbol = null) => {
    const id = marketIdentity(input), account = accounts.get(id?.accountId)
    if (!id || !account || id.host !== account.host) { complete = false; return }
    const key = marketIdentityKey(id)
    if (wanted.has(key)) return
    if (wanted.size >= MAX_IDENTITIES) { complete = false; return }
    wanted.set(key, id); detail.set(key, { tier, symbol: symbol == null ? null : String(symbol).toUpperCase() }); byTier[tier]++
  }
  // An account's own identity for a symbol NAME, or a recorded miss.
  const own = (accountId, name, tier) => {
    const account = accounts.get(accountId)
    if (!account) { complete = false; return }
    const map = mapOf(accountId)
    if (!map) { miss(accountId, 'map'); return }
    const symbolId = map[String(name).toUpperCase()]
    if (symbolId == null) { miss(accountId, 'name'); return }
    add({ accountId, host: account.host, symbolId }, tier, name)
  }
  // 1 — gateway feeds.
  for (const [key, host] of [['cpp_exec_demo', 'demo.ctraderapi.com'], ['cpp_exec', 'live.ctraderapi.com']]) {
    const health = read(db, `${key}_health_json`)
    if (!health || health.dormant === true) continue
    if (!fresh(health.at, now) || health.ok !== true) { complete = false; continue }
    const tick = health.tick
    if (!Array.isArray(tick?.subscribed)) {
      // An active feed with absent/redacted identity is missing coverage,
      // never evidence of an empty subscription list.
      if (health.spotFeed || tick?.enabled === true) complete = false
      continue
    }
    for (const symbolId of tick.subscribed.slice(0, 512)) add({ host, accountId: tick.feedAccountId, symbolId }, 'feed')
    if (tick.subscribed.length > 512) complete = false
  }
  // 2 — every active held position.
  const positions = db.prepare("SELECT account_id,symbol FROM monitored_positions WHERE status='active' ORDER BY account_id,id LIMIT 513").all()
  if (positions.length > 512) complete = false
  for (const p of positions.slice(0, 512)) {
    if (p.account_id == null || p.symbol == null) { complete = false; continue }
    own(String(p.account_id), p.symbol, 'position')
  }
  // 3 — the bar scan's own instruments on its feed account.
  const scan = read(db, 'legacy_scanner_work_json')
  const scanFresh = Number.isFinite(scan?.completedAt) && now >= scan.completedAt && now - scan.completedAt < 360_000 && Array.isArray(scan.instruments)
  if (scanFresh) {
    for (const i of scan.instruments.slice(0, 512)) add({ ...scan, symbolId: i.symbolId }, 'legacy', i.symbol)
    if (scan.instruments.length > 512) complete = false
  }
  // 4 — scope. At the cap the rest is left unread, not walked: this runs on
  // the main thread every refresh, and 64 accounts × 512 names would each be
  // resolved only to be refused. Unread pairs are missing coverage.
  scope: {
    if (scanFresh && Array.isArray(scan.scopeAccounts)) {
      const ids = scan.scopeAccounts.slice(0, 64).map(String)
      for (const i of scan.instruments.slice(0, 512)) {
        for (const accountId of ids) {
          if (wanted.size >= MAX_IDENTITIES) { complete = false; break scope }
          own(accountId, i.symbol, 'scope')
        }
      }
    }
    // V3 C4 (WP-B B2e): a tick account's entry_activity is judged on its OWN
    // (account, symbolId) calendar, so each fresh tick permit receipt demands it.
    for (const receipt of tickEntryReceipts(db, now)) {
      const ids = receipt.accounts.map(a => String(a?.accountId))
      for (const name of receipt.symbols) {
        for (const accountId of ids) {
          if (wanted.size >= MAX_IDENTITIES) { complete = false; break scope }
          own(accountId, name, 'scope')
        }
      }
    }
  }
  return { identities: [...wanted.values()], complete, byTier, detail, unresolved }
}

export function createWatchdogCalendarRefresh(db, deps = {}) {
  const clock = deps.now ?? Date.now, credentials = deps.credentials ?? (id => credsForRegisteredAccount(db, id))
  const fetchSymbols = deps.fetchSymbols ?? (async (c, ids) => {
    const { wsGetSymbolById } = await import('../lib/ctrader-ws.js')
    return wsGetSymbolById(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, ids, 2000)
  })
  let running = false, cursor = 0
  const attempted = new Map()
  // V3 K1: a skipped pass used to leave no trace, so an observer outage
  // silently stopped calendar coverage while the last receipt looked current.
  // The skip is persisted apart from the receipt (failure never breaks a pass).
  const skip = (reason, now) => {
    try {
      const previous = read(db, CALENDAR_REFRESH_SKIP_KEY)
      const at = new Date(now).toISOString()
      setState(db, CALENDAR_REFRESH_SKIP_KEY, JSON.stringify({ at, skipped: reason,
        since: previous?.skipped === reason && previous?.since ? previous.since : at }))
    } catch { /* observation bookkeeping only */ }
    return { skipped: reason }
  }
  return async function refresh() {
    if (disarmReason(deps.env)) return skip('environment_disarmed', clock())
    if (running) return skip('in_flight', clock())
    const now = clock(), observer = read(db, 'independent_watchdog_json')
    if (!fresh(observer?.readAt, now) || observer?.status?.enabled !== true) return skip('observation_disabled_or_stale', now)
    running = true
    try {
      const demand = watchdogCalendarDemand(db, now), active = new Set(demand.identities.map(marketIdentityKey))
      for (const key of attempted.keys()) if (!active.has(key)) attempted.delete(key)
      const due = demand.identities.filter(id => {
        const key = marketIdentityKey(id), previous = attempted.get(key)
        if (previous != null && now - previous < 300_000) return false
        const calendar = readMarketCalendar(db, id, { nowMs: now })
        return calendar.open == null || calendar.ageMs >= 12 * 3600_000
      })
      const accounts = [...new Set(due.map(id => id.accountId))].sort()
      const out = { at: new Date(now).toISOString(), demand: demand.identities.length, complete: demand.complete, requested: 0, recorded: 0, unknown: 0, errors: [] }
      if (accounts.length) {
        const accountId = accounts[cursor++ % accounts.length]
        // Never-attempted work leads; then oldest attempts. A short cooldown
        // must not keep recycling the first failing pages of a large account.
        const batch = due.filter(id => id.accountId === accountId)
          .sort((a, b) => (attempted.get(marketIdentityKey(a)) ?? -1) - (attempted.get(marketIdentityKey(b)) ?? -1))
          .slice(0, BATCH)
        for (const id of batch) attempted.set(marketIdentityKey(id), now)
        out.accountId = accountId
        const c = credentials(accountId)
        if (!c?.ready || String(c.accountId) !== accountId || c.host !== batch[0].host) out.errors.push('account_credentials_unavailable')
        else {
          out.requested = batch.length
          try {
            const response = await fetchSymbols(c, batch.map(id => Number(id.symbolId)))
            if (response?.ctidTraderAccountId != null && String(response.ctidTraderAccountId) !== accountId) throw new Error('account_identity_mismatch')
            if (!Array.isArray(response?.symbol)) throw new Error('symbol_response_missing')
            for (const id of batch) {
              const symbols = response.symbol.filter(s => String(s.symbolId) === id.symbolId)
              if (symbols.length !== 1) { out.errors.push(`symbol_response_missing_or_duplicate:${id.symbolId}`); continue }
              const result = recordMarketCalendar(db, id, symbols[0], { nowMs: clock() })
              if (result.recorded) out.recorded++
              if (result.reason) { out.unknown++; out.errors.push(`${id.symbolId}:${result.reason}`) }
            }
          } catch { out.errors.push('broker_calendar_read_failed') }
        }
      }
      setState(db, 'watchdog_calendar_refresh_json', JSON.stringify(out))
      return out
    } finally { running = false }
  }
}

export function startWatchdogCalendarRefresh(db, deps = {}) {
  if (disarmReason(deps.env)) return () => {}
  const refresh = createWatchdogCalendarRefresh(db, deps)
  const timer = (deps.setInterval ?? setInterval)(() => { refresh().catch(() => {}) }, 60_000)
  timer.unref?.()
  return () => (deps.clearInterval ?? clearInterval)(timer)
}
