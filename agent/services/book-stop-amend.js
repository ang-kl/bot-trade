// Apply the book's existing stop rule against fresh broker protection, then
// read it back. Missing TP remains an incident but cannot disable a safer SL.
import { recordAmend, classifyAmendResult, classifyAmendError, errorCodeOf } from './protection-latency.js'

export const BOOK_PROTECTION_MAX_READ_MS = 5000

export function freshBookProtection(p, nowMs = Date.now()) {
  return p?.verified === true && p.source === 'broker_reconcile'
    && Number.isFinite(p.readStartedAtMs) && Number.isFinite(p.checkedAtMs)
    && Number.isFinite(p.readDurationMs) && p.readDurationMs >= 0
    && p.readDurationMs <= BOOK_PROTECTION_MAX_READ_MS
    && p.checkedAtMs >= p.readStartedAtMs && nowMs >= p.checkedAtMs
    && nowMs - p.readStartedAtMs <= BOOK_PROTECTION_MAX_READ_MS
}

export async function amendBookStop(creds, { positionId, stopLoss, side }, {
  readPosition, amend, clock = () => performance.now(), now = Date.now,
}) {
  const short = side === 'short'
  if (!['long', 'short'].includes(side) || !Number.isFinite(stopLoss) || stopLoss <= 0) throw new Error('invalid book stop intent')
  const read = async () => {
    const began = clock(), readStartedAtMs = now()
    let timer, p
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('book protection read deadline exceeded')), BOOK_PROTECTION_MAX_READ_MS)
    })
    try {
      // Includes pool queueing and authentication, not just time on the wire.
      // A late READ may finish, but cannot resume this failed operation or amend.
      p = await Promise.race([Promise.resolve().then(() => readPosition(creds, positionId)), deadline])
    } finally { clearTimeout(timer) }
    const readDurationMs = clock() - began, checkedAtMs = now()
    if (!Number.isFinite(readDurationMs) || readDurationMs < 0 || readDurationMs > BOOK_PROTECTION_MAX_READ_MS
      || checkedAtMs < readStartedAtMs || checkedAtMs - readStartedAtMs > BOOK_PROTECTION_MAX_READ_MS) {
      throw new Error('book protection read exceeded freshness limit')
    }
    if (!p || String(p.positionId) !== String(positionId)) throw new Error('book protection: position absent or identity mismatch')
    const brokerSide = p.tradeData?.tradeSide
    if ((short && ![2, 'SELL'].includes(brokerSide)) || (!short && ![1, 'BUY'].includes(brokerSide))) throw new Error('book protection: broker direction mismatch')
    for (const key of ['stopLoss', 'takeProfit']) {
      if (p[key] != null && (!Number.isFinite(Number(p[key])) || Number(p[key]) < 0)) throw new Error(`book protection: malformed ${key}`)
    }
    return { stopLoss: Number(p.stopLoss) > 0 ? Number(p.stopLoss) : null,
      takeProfit: Number(p.takeProfit) > 0 ? Number(p.takeProfit) : null,
      source: 'broker_reconcile', readStartedAtMs, checkedAtMs, readDurationMs }
  }
  const before = await read()
  const atLeastAsTight = sl => sl > 0 && (short ? sl <= stopLoss : sl >= stopLoss)
  if (atLeastAsTight(before.stopLoss)) return { protection: { ...before, verified: true, confirmation: 'already_tighter_snapshot' }, unchanged: true }
  // V3 M5: the amend's round trip, and the read-back above timed again as the
  // broker's confirmation (sent → a fresh read holding the stop). Recorded,
  // never acted on: the checks below are unchanged.
  const meta = { path: 'book_stop', source: 'momentum_book', accountId: creds?.accountId, positionId }
  const sentAtMs = now(), began = clock()
  let sent
  try {
    sent = await amend(creds, { positionId, stopLoss, takeProfit: before.takeProfit })
  } catch (err) {
    recordAmend({ ...meta, sentAtMs, ackAtMs: now(), ms: clock() - began, outcome: classifyAmendError(err), errorCode: errorCodeOf(err?.message) })
    throw err
  }
  const answered = { ...meta, sentAtMs, ackAtMs: now(), ms: clock() - began, outcome: classifyAmendResult(sent),
    errorCode: errorCodeOf(sent?.error, sent?.rawError, sent?.reason) }
  if (sent?.error || sent?.rawError || sent?.alreadyClosed || sent?.ok === false) {
    recordAmend(answered)
    throw new Error(`book protection amendment refused: ${sent.error || sent.rawError || 'position unavailable'}`)
  }
  let after
  try { after = await read() } catch (err) {
    recordAmend({ ...answered, confirm: 'readback_failed' })
    throw err
  }
  recordAmend({ ...answered, confirm: atLeastAsTight(after.stopLoss) ? 'readback_confirmed' : 'readback_mismatch',
    confirmMs: after.checkedAtMs - sentAtMs, readbackMs: after.readDurationMs })
  if (!atLeastAsTight(after.stopLoss)) throw new Error('book stop not confirmed by broker read-back')
  if (before.takeProfit != null && after.takeProfit == null) throw new Error('broker target missing after book stop amendment')
  return { protection: { ...after, verified: true, confirmation: 'amend_readback' }, unchanged: false }
}
