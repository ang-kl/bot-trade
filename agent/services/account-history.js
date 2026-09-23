import { getState, setState } from '../db.js'
import { brokerReadObservationStatus } from '../lib/broker-read-observer.js'

export const ACCOUNT_HISTORY_RETENTION_DAYS = 90
const DAY = 86400_000
const hostOk = h => ['demo.ctraderapi.com', 'live.ctraderapi.com'].includes(h)
const idOk = id => /^[1-9]\d*$/.test(String(id))
const finite = n => typeof n === 'number' && Number.isFinite(n) ? n : null

// Bounded observations of existing reads, not a new broker polling schedule.
// One latest point per account/host/source/minute; never refresh its source age.
export function recordAccountHistory(db, input) {
  const { accountId, host, source, receivedAt } = input
  if (!idOk(accountId) || !hostOk(host) || !Number.isSafeInteger(receivedAt)
    || !['broker_trader', 'broker_snapshot', 'nightly_equity', 'broker_reconcile', 'broker_equity'].includes(source)) return false
  const currency = /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : null
  const point = { accountId: String(accountId), host, source, receivedAt, currency,
    sourceTimestamp: null, balance: finite(input.balance), equity: finite(input.equity),
    openPnl: finite(input.openPnl), balanceReceivedAt: Object.hasOwn(input, 'balanceReceivedAt') ? input.balanceReceivedAt : receivedAt,
    pnlReceivedAt: input.pnlReceivedAt ?? null,
    equitySource: input.equitySource ?? null,
    openPositions: Number.isSafeInteger(input.openPositions) ? input.openPositions : null,
    exposure: Array.isArray(input.exposure) ? input.exposure.slice(0, 256) : null,
    exposureComplete: Array.isArray(input.exposure) ? input.exposureComplete !== false && input.exposure.length <= 256 : false,
    protection: input.protection ?? null, error: input.error ?? null }
  const json = JSON.stringify(point)
  if (json.length > 64_000) return false
  db.prepare(`INSERT INTO account_history (account_id, host, source, bucket_ms, received_ms, observation_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, host, source, bucket_ms) DO UPDATE SET
    received_ms = excluded.received_ms, observation_json = excluded.observation_json
    WHERE excluded.received_ms > account_history.received_ms`)
    .run(String(accountId), host, source, Math.floor(receivedAt / 60_000) * 60_000, receivedAt, json)
  // Prune only these new observation tables, once a day, using the process
  // clock rather than an arbitrary broker timestamp. Existing ledgers stay put.
  const now = Date.now(), last = Number(getState(db, 'account_history_pruned_ms'))
  if (!Number.isFinite(last) || last <= 0 || now - last >= DAY) {
    db.transaction(() => {
      db.prepare('DELETE FROM account_history WHERE received_ms < ?').run(now - ACCOUNT_HISTORY_RETENTION_DAYS * DAY)
      db.prepare('DELETE FROM account_cashflow_windows WHERE to_ms < ?').run(now - ACCOUNT_HISTORY_RETENTION_DAYS * DAY)
      setState(db, 'account_history_pruned_ms', String(now))
    })()
  }
  return true
}

export function cashflowCoverage(db, { accountId, host, currency, from, to }) {
  if (!currency || !hostOk(host) || !idOk(accountId) || !(to >= from)) return { complete: false, reason: 'identity_or_currency_unknown', externalNet: null }
  const windows = db.prepare(`SELECT from_ms, to_ms FROM account_cashflow_windows
    WHERE account_id = ? AND host = ? AND currency = ? AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms`)
    .all(String(accountId), host, currency, from, to)
  let through = from
  for (const w of windows) { if (w.from_ms > through) break; through = Math.max(through, w.to_ms) }
  const coveredThrough = through > from ? Math.min(through, to) : null
  if (through < to || !windows.length) return { complete: false, reason: 'cashflow_coverage_gap', externalNet: null, coveredThrough }
  const rows = db.prepare(`SELECT kind, delta FROM account_cashflows WHERE account_id = ? AND host = ?
    AND currency = ? AND at_ms > ? AND at_ms <= ?`).all(String(accountId), host, currency, from, to)
  const unknown = rows.filter(r => r.kind === 'unclassified').length
  return { complete: !unknown, reason: unknown ? 'cashflow_classification_unknown' : null,
    externalNet: unknown ? null : rows.filter(r => r.kind === 'external').reduce((n, r) => n + r.delta, 0), coveredThrough,
    otherAdjustments: rows.filter(r => r.kind === 'adjustment').reduce((n, r) => n + r.delta, 0), events: rows.length }
}

export function accountHistory(db, accountId, { from, to = Date.now(), limit = 2000, before = null } = {}) {
  if (!idOk(accountId) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to
    || to - from > ACCOUNT_HISTORY_RETENTION_DAYS * DAY || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000
    || (before != null && (!Number.isSafeInteger(before) || before < 1))) throw new RangeError('invalid history window or page')
  const rows = db.prepare(`SELECT id, observation_json FROM account_history WHERE account_id = ?
    AND received_ms >= ? AND received_ms < ? ${before != null ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(String(accountId), from, to, ...(before != null ? [before] : []), limit + 1)
  const hasMore = rows.length > limit
  const points = rows.slice(0, limit).map(r => ({ ...JSON.parse(r.observation_json), rowId: r.id }))
    .sort((a, b) => a.receivedAt - b.receivedAt || a.rowId - b.rowId)
  const valued = points.filter(p => p.equity != null && p.currency && !p.error)
  const first = valued[0], last = valued.at(-1)
  const sameUnits = first && last && valued.every(p => p.currency === first.currency && p.host === first.host)
  const comparable = sameUnits && first.receivedAt < last.receivedAt
  const coverage = comparable ? cashflowCoverage(db, { accountId, host: first.host, currency: first.currency,
    from: first.receivedAt, to: last.receivedAt }) : { complete: false, reason: 'comparable_equity_unavailable', externalNet: null }
  const change = comparable ? last.equity - first.equity : null
  // Collection can trail the latest observation by one bounded polling round.
  // Show a proven, dated subset separately; never relabel the whole window.
  let reconciledSpan = null, collection = null
  if (comparable && !hasMore && before == null && !coverage.complete && coverage.coveredThrough != null) {
    const end = valued.findLast(p => p.receivedAt <= coverage.coveredThrough)
    if (end && end.receivedAt > first.receivedAt) {
      const covered = cashflowCoverage(db, { accountId, host: first.host, currency: first.currency, from: first.receivedAt, to: end.receivedAt })
      if (covered.complete) reconciledSpan = { from: first.receivedAt, to: end.receivedAt, currency: first.currency,
        equityChange: end.equity - first.equity, externalNet: covered.externalNet,
        externalFlowAdjustedChange: end.equity - first.equity - covered.externalNet,
        pendingObservations: valued.filter(p => p.receivedAt > end.receivedAt).length }
    }
  }
  try {
    const status = JSON.parse(getState(db, `acct:${accountId}:cashflow_collection_json`) || 'null')
    if (status?.accountId === String(accountId)) collection = status
  } catch { /* no collector evidence */ }
  let peak = -Infinity, sampledDrawdown = null
  if (comparable && !hasMore && before == null) {
    sampledDrawdown = 0
    for (const p of valued) { peak = Math.max(peak, p.equity); sampledDrawdown = Math.max(sampledDrawdown, peak - p.equity) }
  }
  return { accountId: String(accountId), from, to, points, hasMore,
    recording: brokerReadObservationStatus(),
    latestObservationAt: points.at(-1)?.receivedAt ?? null,
    latestEquityAt: last?.receivedAt ?? null,
    nextBefore: hasMore ? Math.min(...points.map(p => p.rowId)) : null,
    retentionDays: ACCOUNT_HISTORY_RETENTION_DAYS, sampling: 'latest observation per source per minute; no interpolation',
    summaryComplete: !hasMore && before == null, currency: sameUnits ? first.currency : null,
    equityChange: change, cashflows: coverage, cashflowCollection: collection, reconciledSpan,
    observationSpan: comparable ? { from: first.receivedAt, to: last.receivedAt } : null,
    externalFlowAdjustedChange: !hasMore && before == null && coverage.complete && change != null ? change - coverage.externalNet : null,
    sampledDrawdown, drawdownBasis: 'unadjusted observed equity; includes cashflows; not exact intraminute drawdown',
    note: 'External-flow-adjusted equity change is not a time-weighted return or closed-trade P&L. Gaps and missing currencies remain unknown.' }
}

/** Broker snapshot source; monetary fields already use deposit currency. */
export function captureSnapshotHistory(db, a, fetchedAt) {
  if (a.error) return false
  const completePnl = Array.isArray(a.positions) && a.positions.every(p => p.pnlSource === 'broker' && finite(p.netPnl) != null)
  const openPnl = completePnl ? a.positions.reduce((n, p) => n + p.netPnl, 0) : null
  const balance = finite(a.health?.balance)
  return recordAccountHistory(db, { accountId: a.accountId, host: a.host, source: 'broker_snapshot',
    receivedAt: Date.parse(fetchedAt), currency: a.currency,
    balance, equity: balance != null && openPnl != null ? balance + openPnl : null, openPnl,
    balanceReceivedAt: a.balanceReceivedAt ? Date.parse(a.balanceReceivedAt) : null,
    pnlReceivedAt: a.pnlReceivedAt ? Date.parse(a.pnlReceivedAt) : null,
    equitySource: 'balance_plus_broker_pnl', openPositions: a.positions?.length ?? null,
    exposure: a.positions?.map(p => ({ positionId: p.positionId, symbolId: p.symbolId, symbol: p.symbol, volume: p.rawVolume, side: p.side })),
    protection: { source: 'broker_snapshot', observedAt: fetchedAt,
      missingSL: a.positions?.filter(p => !(p.sl > 0)).length ?? null,
      missingTP: a.positions?.filter(p => !(p.tp > 0)).length ?? null } })
}
