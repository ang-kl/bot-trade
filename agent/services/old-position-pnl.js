import { getState, setState } from '../db.js'
import { normPosId } from '../lib/pos-id.js'
import { backfillClosedPnl } from './pnl-backfill.js'

// One old, attributed, not-written-off position per account pass. The durable
// pacing cursor also records failures, but a failed read is not an exhausted
// trade attempt. This consumes the caller's existing deadline and WS lock.
export async function recoverOldPositionPnl(db, creds, { now, isCurrent, getPositionDeals }) {
  const accountId = String(creds.accountId), key = `position_pnl_recovery:${accountId}`
  let prior = {}
  try { prior = JSON.parse(getState(db, key) || '{}') } catch { /* no valid cursor */ }
  const attempts = Object.fromEntries(Object.entries(prior.attempts || {})
    .filter(([, at]) => Number.isSafeInteger(at) && at <= now && now - at < 900_000).slice(-128))
  if (Number.isSafeInteger(prior.lastReadAt) && prior.lastReadAt <= now && now - prior.lastReadAt < 30_000) return { state: 'paced' }
  const candidates = db.prepare(`SELECT id, ctrader_position_id FROM trades WHERE account_id = ?
    AND status = 'closed' AND net_pnl IS NULL AND COALESCE(pnl_unresolvable, 0) = 0
    AND (julianday(opened_at) IS NULL OR julianday(opened_at) < julianday(?) OR julianday(opened_at) > julianday(?))
    ORDER BY (id <= ?), id LIMIT 128`)
    .all(accountId, new Date(now - 14 * 86400_000).toISOString(), new Date(now).toISOString(),
      Number.isSafeInteger(prior.lastTradeId) ? prior.lastTradeId : 0)
  const candidate = candidates.find(row => {
    const id = normPosId(row.ctrader_position_id)
    return /^[1-9]\d*$/.test(id || '') && Number.isSafeInteger(Number(id)) && !attempts[id]
  })
  if (!candidate) return { state: candidates.length ? 'paced' : 'no_old_gap' }
  if (!isCurrent()) return { state: 'deadline' }
  const positionId = normPosId(candidate.ctrader_position_id)
  const state = { lastReadAt: now, lastTradeId: candidate.id, positionId, attempts: { ...attempts, [positionId]: now }, state: 'collecting' }
  setState(db, key, JSON.stringify(state))
  try {
    const result = await backfillClosedPnl(db, creds, { accountId, positionId, strictAccount: true, now, isCurrent, getPositionDeals })
    const out = { positionId, state: result.backfilled ? 'recovered' : 'no_matching_close', result }
    setState(db, key, JSON.stringify({ ...state, ...out, completedAt: Date.now() }))
    return out
  } catch (error) {
    const out = { positionId, state: 'failed', reason: error.message }
    setState(db, key, JSON.stringify({ ...state, ...out, completedAt: Date.now() }))
    return out
  }
}
