// Codex · №12,284 · 2026-10-08; codex-footprint: hybrid-history-boundary.
// A once-only read experiment. Durable claim precedes requests; no returned
// history enters enrolment, profit decisions or financial-history storage.
import { getState, setState } from '../db.js'
import { wsProbePositionHistoryBounds } from '../lib/ctrader-ws.js'

export async function diagnoseHybridHistory(db, { args, positionId, presentTimestamp, toTimestamp,
  read = wsProbePositionHistoryBounds, now = Date.now, log = line => console.info(line), budgetMs = 4500 }) {
  const accountId = String(args?.[4] ?? '')
  if (!/^[1-9]\d*$/.test(accountId) || !/^[1-9]\d*$/.test(String(positionId))
    || ![presentTimestamp, toTimestamp].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483646000)) return
  // Codex · №12,288 · 2026-10-08; codex-footprint: diagnostic-review-boundaries.
  // One experiment in total, at most one 3s read per ordinary pass. A pass
  // without enough time claims nothing. Each variant is durably claimed
  // before its request; restart never retries a possibly-sent variant.
  const key = 'hybrid_history_boundary_v1'
  if (!Number.isFinite(budgetMs) || budgetMs < 3000) return
  const saved = getState(db, key)
  const record = saved ? JSON.parse(saved) : { accountId, positionId: String(positionId), payloadType: 2179,
    startedAt: now(), presentTimestamp, original: { fromTimestamp: 0, toTimestamp },
    originalError: 'INCORRECT_BOUNDARIES', results: [], next: 0, state: 'ready' }
  if (record.accountId !== accountId || record.positionId !== String(positionId)
    || record.state !== 'ready' || !Number.isInteger(record.next) || record.next < 0 || record.next >= 4) return
  const variants = [
    ['present_end', { fromTimestamp: 0, toTimestamp: record.presentTimestamp }],
    ['omit_start', { toTimestamp: record.original.toTimestamp }],
    ['omit_end', { fromTimestamp: 0 }],
    ['omit_both', {}],
  ]
  const [variant, bounds] = variants[record.next]
  const item = { variant, bounds, startedAt: now() }
  record.state = 'probing'; record.next++
  record.pending = item
  setState(db, key, JSON.stringify(record)) // storage failure refuses read
  log(`[hybrid-history-boundary] ${JSON.stringify(record)}`)
  try {
    // Await the transport's bounded termination, not a Promise.race that
    // abandons a live queued request. This helper owns a direct socket.
    const response = await read(...args, positionId, bounds, 3000)
    item.result = response?.errorCode === 'INCORRECT_BOUNDARIES' ? 'INCORRECT_BOUNDARIES' : response?.errorCode ? 'read_failed' : 'response'
    item.accountMatches = String(response?.ctidTraderAccountId) === accountId
    item.hasMore = typeof response?.hasMore === 'boolean' ? response.hasMore : null
    item.dealCount = Array.isArray(response?.deal) ? response.deal.length : null
    item.foreignPositions = Array.isArray(response?.deal)
      ? response.deal.filter(d => String(d?.positionId) !== String(positionId)).length : null
  } catch (e) {
    // Fixed classification only: no remote descriptions or credentials.
    item.result = /INCORRECT_BOUNDARIES/.test(String(e?.message)) ? 'INCORRECT_BOUNDARIES'
      : /timeout|deadline/i.test(String(e?.message)) ? 'timeout' : 'read_failed'
  }
  item.finishedAt = now(); record.results.push(item)
  record.state = item.result === 'timeout' ? 'timeout' : record.next === 4 ? 'complete' : 'ready'
  delete record.pending
  record.finishedAt = now()
  setState(db, key, JSON.stringify(record))
  log(`[hybrid-history-boundary] ${JSON.stringify({ accountId, positionId: String(positionId), payloadType: 2179, ...item })}`)
  // Deliberately no broker response returned to the trading caller.
}
