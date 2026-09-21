import { getState, setState } from '../db.js'

const keyFor = accountId => `acct:${accountId ?? 'unknown'}:protection_repair_failures_json`

// Broker refusals describe an invalid request, not a failed connection. Do not
// turn the same invalid protection price into an automatic five-minute retry.
export function protectionFailure(error, { retryableUnknown = true } = {}) {
  const message = String(error?.message ?? error?.error ?? error ?? 'protection amendment failed')
  let body = error
  try { body = JSON.parse(message) } catch { /* transport errors are plain text */ }
  const code = body?.errorCode ?? body?.code ?? error?.errorCode ?? null
  const permanent = ['TRADING_BAD_STOPS', 'TRADING_BAD_VOLUME', 'POSITION_NOT_FOUND', 'POSITION_CLOSED'].includes(code)
  return { ok: false, retryable: !permanent && retryableUnknown, code, error: message,
    resolution: code === 'TRADING_BAD_STOPS' ? 'protection_price_decision_required'
      : permanent || !retryableUnknown ? 'broker_state_review_required' : 'retry_after_backoff' }
}

export function repairFailures(db, accountId) {
  try {
    const value = JSON.parse(getState(db, keyFor(accountId)) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function recordRepairFailure(db, accountId, finding, tp, failure, nowMs = Date.now()) {
  const map = repairFailures(db, accountId)
  const id = String(finding.positionId)
  map[id] = { positionId: id, accountId: String(accountId ?? ''), symbol: finding.symbol,
    attemptedTarget: tp, ...failure, firstAt: map[id]?.firstAt ?? new Date(nowMs).toISOString(),
    at: new Date(nowMs).toISOString() }
  try { setState(db, keyFor(accountId), JSON.stringify(map)) } catch { /* audit still reports missing TP */ }
}

export function sameRefusedTarget(failure, tp) {
  return failure?.retryable === false && ['TRADING_BAD_STOPS', 'TRADING_BAD_VOLUME'].includes(failure.code)
    && Number(failure.attemptedTarget) === Number(tp)
}

// Clear only on a successful broker audit which actually saw a target (or the
// position's closure). A successful send alone is not proof of protection.
export function retainUnresolvedRepairs(db, accountId, targetlessIds) {
  const map = repairFailures(db, accountId)
  const live = new Set(targetlessIds.map(String))
  for (const id of Object.keys(map)) if (!live.has(id)) delete map[id]
  try { setState(db, keyFor(accountId), JSON.stringify(map)) } catch { /* best effort */ }
  return map
}
