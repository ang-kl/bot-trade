// Apply the book's existing stop rule against fresh broker protection, then
// read it back. Missing TP remains an incident but cannot disable a safer SL.
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
    const p = await readPosition(creds, positionId)
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
  const sent = await amend(creds, { positionId, stopLoss, takeProfit: before.takeProfit })
  if (sent?.error || sent?.rawError || sent?.alreadyClosed || sent?.ok === false) throw new Error(`book protection amendment refused: ${sent.error || sent.rawError || 'position unavailable'}`)
  const after = await read()
  if (!atLeastAsTight(after.stopLoss)) throw new Error('book stop not confirmed by broker read-back')
  if (before.takeProfit != null && after.takeProfit == null) throw new Error('broker target missing after book stop amendment')
  return { protection: { ...after, verified: true, confirmation: 'amend_readback' }, unchanged: false }
}
