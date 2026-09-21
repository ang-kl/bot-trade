// Apply the book's existing stop rule against fresh broker protection, then
// read it back. Missing TP remains an incident but cannot disable a safer SL.
export async function amendBookStop(creds, { positionId, stopLoss, side }, { readPosition, amend }) {
  const short = side === 'short'
  if (!['long', 'short'].includes(side) || !Number.isFinite(stopLoss) || stopLoss <= 0) throw new Error('invalid book stop intent')
  const read = async () => {
    const p = await readPosition(creds, positionId)
    if (!p || String(p.positionId) !== String(positionId)) throw new Error('book protection: position absent or identity mismatch')
    const brokerSide = p.tradeData?.tradeSide
    if ((short && ![2, 'SELL'].includes(brokerSide)) || (!short && ![1, 'BUY'].includes(brokerSide))) throw new Error('book protection: broker direction mismatch')
    for (const key of ['stopLoss', 'takeProfit']) {
      if (p[key] != null && (!Number.isFinite(Number(p[key])) || Number(p[key]) < 0)) throw new Error(`book protection: malformed ${key}`)
    }
    return { stopLoss: Number(p.stopLoss) > 0 ? Number(p.stopLoss) : null,
      takeProfit: Number(p.takeProfit) > 0 ? Number(p.takeProfit) : null }
  }
  const before = await read()
  const atLeastAsTight = sl => sl > 0 && (short ? sl <= stopLoss : sl >= stopLoss)
  if (atLeastAsTight(before.stopLoss)) return { protection: { ...before, verified: true }, unchanged: true }
  const sent = await amend(creds, { positionId, stopLoss, takeProfit: before.takeProfit })
  if (sent?.error || sent?.rawError || sent?.alreadyClosed || sent?.ok === false) throw new Error(`book protection amendment refused: ${sent.error || sent.rawError || 'position unavailable'}`)
  const after = await read()
  if (!atLeastAsTight(after.stopLoss)) throw new Error('book stop not confirmed by broker read-back')
  if (before.takeProfit != null && after.takeProfit == null) throw new Error('broker target missing after book stop amendment')
  return { protection: { ...after, verified: true }, unchanged: false }
}
