// Observation only: bounded account-specific symbol reads for existing work.
import { getState, setState } from '../db.js'
import { credsForRegisteredAccount, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { readMarketCalendar, recordMarketCalendar } from './market-calendar.js'
import { disarmReason } from '../lib/env-disarm.js'

const read = (db, key) => { try { return JSON.parse(getState(db, key) || 'null') } catch { return null } }
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) < 360_000
const MAX_IDENTITIES = 512, BATCH = 25
export function watchdogCalendarDemand(db, now) {
  const accounts = new Map(db.prepare('SELECT account_id,is_live FROM accounts').all().map(a => [String(a.account_id), a]))
  const wanted = new Map(), maps = new Map(); let complete = true
  const add = input => {
    const id = marketIdentity(input), account = accounts.get(id?.accountId)
    if (!id || !account || id.host !== (account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com')) { complete = false; return }
    const key = marketIdentityKey(id)
    if (wanted.has(key)) return
    if (wanted.size >= MAX_IDENTITIES) { complete = false; return }
    wanted.set(key, id)
  }
  const positions = db.prepare("SELECT account_id,symbol FROM monitored_positions WHERE status='active' AND paused IS NOT 1 AND source IS NOT 'external' ORDER BY account_id,id LIMIT 513").all()
  if (positions.length > 512) complete = false
  for (const p of positions.slice(0, 512)) {
    const accountId = String(p.account_id), account = accounts.get(accountId)
    if (!maps.has(accountId)) maps.set(accountId, getAccountSymbolMap(db, accountId)?.map)
    add({ accountId, host: account?.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', symbolId: maps.get(accountId)?.[p.symbol.toUpperCase()] })
  }
  const scan = read(db, 'legacy_scanner_work_json')
  if (Number.isFinite(scan?.completedAt) && now >= scan.completedAt && now - scan.completedAt < 360_000 && Array.isArray(scan.instruments)) {
    for (const i of scan.instruments.slice(0, 512)) add({ ...scan, symbolId: i.symbolId })
    if (scan.instruments.length > 512) complete = false
  }
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
    for (const symbolId of tick.subscribed.slice(0, 512)) add({ host, accountId: tick.feedAccountId, symbolId })
    if (tick.subscribed.length > 512) complete = false
  }
  return { identities: [...wanted.values()], complete }
}

export function createWatchdogCalendarRefresh(db, deps = {}) {
  const clock = deps.now ?? Date.now, credentials = deps.credentials ?? (id => credsForRegisteredAccount(db, id))
  const fetchSymbols = deps.fetchSymbols ?? (async (c, ids) => {
    const { wsGetSymbolById } = await import('../lib/ctrader-ws.js')
    return wsGetSymbolById(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, ids, 2000)
  })
  let running = false, cursor = 0
  const attempted = new Map()
  return async function refresh() {
    if (disarmReason(deps.env)) return { skipped: 'environment_disarmed' }
    if (running) return { skipped: 'in_flight' }
    const now = clock(), observer = read(db, 'independent_watchdog_json')
    if (!fresh(observer?.readAt, now) || observer?.status?.enabled !== true) return { skipped: 'observation_disabled_or_stale' }
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
