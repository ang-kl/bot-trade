import { getState, setState, ACCOUNT_HISTORY_SUMMARY_EXPRS } from '../db.js'
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

// V3 B3 (P5d-1). The summary covers the whole requested window, never the
// page. Paging at 2,000 rows used to decide it: a busy account's 24 h window
// held more than one page, so it reported a coverage gap that was really this
// defect, and a 7-day window (at least 10,080 points) could never complete.
// Buckets are aligned to UTC multiples of their width; at most this many.
export const MAX_HISTORY_BUCKETS = 400
const BUCKET_WIDTHS = [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440].map(m => m * 60_000)
export function historyBucketMs(from, to) {
  return BUCKET_WIDTHS.find(w => Math.ceil((to - Math.floor(from / w) * w) / w) <= MAX_HISTORY_BUCKETS) ?? BUCKET_WIDTHS.at(-1)
}

// One ordered pass over the narrow summary index (db.js). The valued rule is
// the one the page used: equity present, currency present, no error.
export const HISTORY_SUMMARY_SQL = `SELECT id, received_ms, host, ${ACCOUNT_HISTORY_SUMMARY_EXPRS.join(', ')}
  FROM account_history INDEXED BY idx_account_history_summary
  WHERE account_id = ? AND received_ms >= ? AND received_ms < ? ORDER BY received_ms, id`
function aggregateWindow(db, accountId, from, to) {
  const bucketMs = historyBucketMs(from, to), start = Math.floor(from / bucketMs) * bucketMs
  const buckets = []
  for (let at = start; at < to; at += bucketMs) buckets.push({ from: Math.max(at, from), to: Math.min(at + bucketMs, to),
    observations: 0, equityObservations: 0, currency: null, host: null, mixedUnits: false, first: null, last: null, min: null, max: null })
  const rows = db.prepare(HISTORY_SUMMARY_SQL).raw()
  let observations = 0, latestObservationAt = null, first = null, last = null, sameUnits = true, peak = -Infinity, drawdown = 0
  const times = [], equities = []
  for (const [, at, host, currency, equity, error] of rows.iterate(String(accountId), from, to)) {
    observations++; latestObservationAt = at
    const b = buckets[Math.floor((at - start) / bucketMs)]
    b.observations++
    if (equity == null || !currency || error) continue
    if (!b.equityObservations) { b.currency = currency; b.host = host; b.first = { at, equity }; b.min = equity; b.max = equity }
    else if (b.currency !== currency || b.host !== host) b.mixedUnits = true
    b.equityObservations++; b.last = { at, equity }; b.min = Math.min(b.min, equity); b.max = Math.max(b.max, equity)
    first ??= { at, equity, currency, host }
    if (currency !== first.currency || host !== first.host) sameUnits = false
    last = { at, equity }
    peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity)
    times.push(at); equities.push(equity)
  }
  // A bucket holding two currencies or hosts has no single equity range.
  for (const b of buckets) if (b.mixedUnits) Object.assign(b, { currency: null, host: null, first: null, last: null, min: null, max: null })
  return { bucketMs, buckets, observations, latestObservationAt, first, last, sameUnits, drawdown, times, equities }
}

// Cashflow sums per bucket over (lo, hi], the bucket clipped to the comparable
// equity span, so the buckets partition exactly the span the full-window
// coverage reads. An uncovered bucket is a gap (null), never a zero.
function bucketCashflows(db, accountId, w) {
  const { first, last } = w, key = [String(accountId), first.host, first.currency]
  const windows = db.prepare(`SELECT from_ms, to_ms FROM account_cashflow_windows WHERE account_id = ? AND host = ? AND currency = ?
    AND to_ms >= ? AND from_ms <= ? ORDER BY from_ms`).all(...key, first.at, last.at)
  const merged = []
  for (const x of windows) {
    const tail = merged.at(-1)
    if (tail && x.from_ms <= tail[1]) tail[1] = Math.max(tail[1], x.to_ms)
    else merged.push([x.from_ms, x.to_ms])
  }
  const events = db.prepare(`SELECT at_ms, kind, delta FROM account_cashflows WHERE account_id = ? AND host = ? AND currency = ?
    AND at_ms > ? AND at_ms <= ?`).all(...key, first.at, last.at)
  for (const b of w.buckets) {
    const lo = Math.max(b.from, first.at), hi = Math.min(b.to, last.at)
    if (hi <= lo) { b.cashflows = null; continue }
    const inside = events.filter(e => e.at_ms > lo && e.at_ms <= hi)
    const covered = merged.some(([a, z]) => a <= lo && z >= hi)
    const unclassified = inside.filter(e => e.kind === 'unclassified').length
    const sum = kind => inside.filter(e => e.kind === kind).reduce((n, e) => n + e.delta, 0)
    b.cashflows = { from: lo, to: hi, covered, events: covered ? inside.length : null, unclassified: covered ? unclassified : null,
      external: covered && !unclassified ? sum('external') : null, adjustments: covered ? sum('adjustment') : null }
  }
}

export function accountHistory(db, accountId, { from, to = Date.now(), limit = 2000, before = null } = {}) {
  if (!idOk(accountId) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to
    || to - from > ACCOUNT_HISTORY_RETENTION_DAYS * DAY || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000
    || (before != null && (!Number.isSafeInteger(before) || before < 1))) throw new RangeError('invalid history window or page')
  // The page: raw observations for the table, newest first, `limit` at a time.
  const rows = db.prepare(`SELECT id, observation_json FROM account_history WHERE account_id = ?
    AND received_ms >= ? AND received_ms < ? ${before != null ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(String(accountId), from, to, ...(before != null ? [before] : []), limit + 1)
  const hasMore = rows.length > limit
  const points = rows.slice(0, limit).map(r => ({ ...JSON.parse(r.observation_json), rowId: r.id }))
    .sort((a, b) => a.receivedAt - b.receivedAt || a.rowId - b.rowId)
  // The summary: every retained observation in [from, to), whatever the page.
  const w = aggregateWindow(db, accountId, from, to)
  const { first, last, sameUnits } = w
  const comparable = first != null && sameUnits && first.at < last.at
  const coverage = comparable ? cashflowCoverage(db, { accountId, host: first.host, currency: first.currency,
    from: first.at, to: last.at }) : { complete: false, reason: 'comparable_equity_unavailable', externalNet: null }
  if (comparable) bucketCashflows(db, accountId, w)
  else for (const b of w.buckets) b.cashflows = null
  const change = comparable ? last.equity - first.equity : null
  // Collection can trail the latest observation by one bounded polling round.
  // Show a proven, dated subset separately; never relabel the whole window.
  let reconciledSpan = null, collection = null
  if (comparable && !coverage.complete && coverage.coveredThrough != null) {
    const end = w.times.findLastIndex(at => at <= coverage.coveredThrough)
    if (end >= 0 && w.times[end] > first.at) {
      const covered = cashflowCoverage(db, { accountId, host: first.host, currency: first.currency, from: first.at, to: w.times[end] })
      if (covered.complete) reconciledSpan = { from: first.at, to: w.times[end], currency: first.currency,
        equityChange: w.equities[end] - first.equity, externalNet: covered.externalNet,
        externalFlowAdjustedChange: w.equities[end] - first.equity - covered.externalNet,
        pendingObservations: w.times.length - end - 1 }
    }
  }
  try {
    const status = JSON.parse(getState(db, `acct:${accountId}:cashflow_collection_json`) || 'null')
    if (status?.accountId === String(accountId)) collection = status
  } catch { /* no collector evidence */ }
  return { accountId: String(accountId), from, to, points, hasMore,
    recording: brokerReadObservationStatus(),
    latestObservationAt: w.latestObservationAt,
    latestEquityAt: last?.at ?? null,
    nextBefore: hasMore ? Math.min(...points.map(p => p.rowId)) : null,
    retentionDays: ACCOUNT_HISTORY_RETENTION_DAYS, sampling: 'latest observation per source per minute; no interpolation',
    summaryScope: 'full_window', summaryComplete: true,
    summaryObservations: w.observations, summaryEquityObservations: w.times.length,
    currency: first && sameUnits ? first.currency : null,
    equityChange: change, cashflows: coverage, cashflowCollection: collection, reconciledSpan,
    observationSpan: comparable ? { from: first.at, to: last.at } : null,
    externalFlowAdjustedChange: coverage.complete && change != null ? change - coverage.externalNet : null,
    sampledDrawdown: comparable ? w.drawdown : null,
    drawdownBasis: 'unadjusted observed equity; includes cashflows; not exact intraminute drawdown',
    bucketMs: w.bucketMs, buckets: w.buckets,
    bucketBasis: 'UTC-aligned buckets over the whole window; first, last, min and max of comparable equity; cashflows over the bucket clipped to the comparable equity span; a bucket with no observation is a gap, not a zero',
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
