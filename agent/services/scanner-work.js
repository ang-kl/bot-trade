import { getState, setState } from '../db.js'
import { readMarketCalendar } from './market-calendar.js'
import { projectCalendar } from '../lib/calendar-intervals.js'
import { blockerReport } from './blocker-report.js'

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

export function scannerWork(db, accounts, now) {
  let r; try { r = JSON.parse(getState(db, 'legacy_scanner_work_json') || 'null') } catch { return [] }
  if (!r || !Number.isSafeInteger(r.completedAt) || !Number.isSafeInteger(r.nextDue) || r.completedAt > now
    || !Array.isArray(r.instruments) || r.instruments.length > 512 || !Array.isArray(r.scopeAccounts) || r.scopeAccounts.length > 64) return []
  const work = [], sessions = new Set(), maps = new Map()
  let lookups = 0
  for (const instrument of r.instruments) {
    if (work.length >= 2048 || ++lookups > 2048) { work.push({ id: 'legacy-inventory-capacity', inventoryComplete: false }); return work }
    const feed = { provider: 'ctrader', accountId: r.accountId, host: r.host, symbolId: instrument.symbolId }
    let calendar = null; try { calendar = projectCalendar(readMarketCalendar(db, feed, { nowMs: now }), now) } catch { /* unknown calendar */ }
    work.push({ ...feed, id: `legacy-scan:${r.accountId}:${instrument.symbolId}`, role: 'scanner',
      calendar, lastCompletedAtMs: instrument.lastCompletedAt, nextDueMs: instrument.nextDue,
      outcome: r.complete ? 'batch_evaluated' : 'partial_or_failed_batch', coverage: r.coverage, errors: r.errors })
    for (const accountId of r.scopeAccounts) {
      if (work.length >= 2048 || ++lookups > 2048) { work.push({ id: 'legacy-inventory-capacity', inventoryComplete: false }); return work }
      const account = accounts.get(accountId); if (!account) continue
      let symbolId; try {
        if (!maps.has(accountId)) maps.set(accountId, JSON.parse(getState(db, `symbol_id_map:${accountId}`) || '{}'))
        symbolId = maps.get(accountId)[instrument.symbol.toUpperCase()]
      } catch { continue }
      if (!symbolId) continue
      const identity = { provider: 'ctrader', accountId, host: account.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', symbolId: String(symbolId) }
      const c = projectCalendar(readMarketCalendar(db, identity, { nowMs: now }), now)
      if (!c?.sessionOpenedAtMs || now - c.sessionOpenedAtMs > 90 * 86400_000) continue
      const key = `${accountId}:${c.sessionId}`; if (sessions.has(key)) continue
      sessions.add(key)
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
      const blockers = blockerReport(db, { accountId, from, to: now + 1, now, limit: 1 })
      const complete = r.complete && r.completedAt >= from && !ambiguous
      work.push({ ...identity, id: `entry-activity:${key}`, role: 'entry_activity', calendar: c,
        sessionOpenedAtMs: from, sessionId: c.sessionId, lastCompletedAtMs: r.completedAt, nextDueMs: r.nextDue,
        activityComplete: complete, ordersSinceOpen: complete && Object.values(counts).every(n => n === 0) ? 0 : null,
        hasRecordedOrder: Object.values(counts).some(n => n > 0),
        orderEvidence: counts, unattributedOrUndatedFills: ambiguous, scanCoverage: r.coverage,
        blockerCounts: blockers.summary, firstRecordedBlocker: blockers.latestEntryStop?.firstBlocker ?? null,
        reason: 'retained_account_activity_after_completed_scan_batch',
        scopeNote: 'Zero means no recorded dispatch, unresolved/accepted intent or fill since this broker session opened. Sources overlap; counts are not added. Scan coverage names the completed batch, not the entire watchlist.' })
    }
  }
  return work
}

export function watchdogCalendars(db, now) {
  const rows = db.prepare("SELECT value FROM agent_state WHERE key LIKE 'market_calendar:v1:%' ORDER BY key LIMIT 513").all()
  const calendars = []; let size = 0, complete = rows.length <= 512
  for (const row of rows.slice(0, 512)) {
    try {
      const identity = JSON.parse(row.value)?.latest?.identity
      if (!identity) continue
      const calendar = projectCalendar(readMarketCalendar(db, identity, { nowMs: now }), now)
      const entry = { identity, calendar }; size += Buffer.byteLength(JSON.stringify(entry))
      if (size > 96 * 1024) { complete = false; break }
      calendars.push(entry)
    } catch { complete = false }
  }
  return { calendars, calendarsComplete: complete }
}
