// Read-only operational evidence for Controllers. No network calls or switches.
import { getState } from '../db.js'
import { tickReadinessFor, RECORDER_STATUS_MAX_AGE_MS } from './tick-readiness.js'
import { lastProtectionAudit } from './naked-position-guard.js'
import { tokenRefusedAccounts } from '../lib/token-refused.js'
import { intentCounts } from './entry-ledger.js'
import { independentProtectionView } from './independent-protection.js'
import { effectivePhases } from './account-phases.js'
import { scannerMirrorStatus } from './scanner-candidates.js'

const read = (db, key) => {
  try { return JSON.parse(getState(db, key) || 'null') } catch { return null }
}
const fresh = (at, nowMs, maxAgeMs = 360_000) => {
  const age = nowMs - Date.parse(at || '')
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs
}

export function controllerRuntimeView(db, { nowMs = Date.now() } = {}) {
  const sides = [
    { key: 'cpp_exec_demo', label: 'Demo', service: 'cpp-exec' },
    { key: 'cpp_exec', label: 'Live', service: 'cpp-acct' },
  ].map(side => {
    const health = read(db, `${side.key}_health_json`)
    const tick = read(db, `${side.key}_tick_json`)
    const healthFresh = fresh(health?.at, nowMs)
    const tickFresh = fresh(tick?.at, nowMs, RECORDER_STATUS_MAX_AGE_MS)
    const status = tick?.status
    const feed = health?.spotFeed
    return {
      ...side, healthAt: health?.at ?? null, tickAt: tick?.at ?? null,
      healthFresh, tickFresh,
      connected: healthFresh ? health?.connected ?? null : null,
      feedConnected: healthFresh ? feed?.connected ?? null : null,
      lastTickAt: feed?.lastTickAtMs > 0 ? new Date(feed.lastTickAtMs).toISOString() : null,
      tickCount: healthFresh ? feed?.tickCount ?? null : null,
      tickBlock: !tickFresh ? 'unverified' : status?.enabled === false ? 'unavailable' : status?.enabled === true ? 'available' : 'unverified',
      recorder: !tickFresh ? 'unverified' : status?.state ?? (status?.enabled === false ? 'disabled' : 'unverified'),
      shadow: tickFresh && status?.enabled === false ? false : tickFresh ? status?.strategy?.shadow ?? null : null,
      entryAccounts: tickFresh ? status?.entry?.accounts ?? null : null,
      trail: healthFresh ? health?.trail ?? null : null,
      reason: !tickFresh ? 'Tick status absent or older than ten minutes'
        : status?.enabled === false ? 'Set TICK_SPOOL_PATH on this service to construct the tick workers; restart approval required' : status?.reason ?? null,
    }
  })
  const refused = tokenRefusedAccounts(db)
  const rows = db.prepare('SELECT account_id, is_live, enabled FROM accounts ORDER BY is_live, account_id').all()
  const accounts = rows.map(row => {
    const id = String(row.account_id)
    const tick = tickReadinessFor(db, id, { now: new Date(nowMs) })
    const audit = read(db, `acct:${id}:protection_audit_last_json`)
    const protection = lastProtectionAudit(db, { accountId: id, nowMs, expectedSec: 60, staleFactor: 3 })
    if (refused.has(id)) {
      protection.ok = false
      protection.lastAttemptOk = false
      protection.summary = 'Broker token refused; protection cannot be verified. Reconnect cTrader and authorise this account.'
    }
    return {
      accountId: id, environment: row.is_live ? 'live' : 'demo', enabled: !!row.enabled,
      entryMode: tick.effectiveEntryMode, shadowReady: tick.shadowReady,
      phases: effectivePhases(db, id),
      entryReady: tick.ready, tradingBlockers: tick.tradingBlockers,
      shadowBlockers: tick.shadowBlockers,
      brokerAccess: refused.has(id) ? 'TOKEN_REFUSED' : 'NOT_REFUSED',
      entryCounts: intentCounts(db, id),
      protection,
      independentProtection: independentProtectionView(db, id, nowMs),
      missingTargets: audit?.missingTargets ?? null,
    }
  })
  return { at: new Date(nowMs).toISOString(), sides, accounts,
    scannerComparison: scannerMirrorStatus(db, { now: nowMs }),
    watchdog: read(db, 'independent_watchdog_json'),
    monitor: read(db, 'fast_monitor_pass_json'),
    managementWork: read(db, 'fast_monitor_position_work_json'),
    process: {
      phase: getState(db, 'loop_phase') || 'unknown',
      lastScanAt: getState(db, 'last_scan_at') || null,
      phaseLag: read(db, 'loop_phase_lag_json'),
      profiles: read(db, 'loop_cpu_profile_json'),
    },
    cadence: { entries: 'Quote events or the account’s scheduled strategy scan',
      volume: 'Tick momentum uses price, spread and volatility; no traded-volume confirmation' },
  }
}
