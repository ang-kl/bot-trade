// A complete response is necessary but not sufficient: a retained suffix of
// old history must not become the whole position's realised P&L.
const integer = value => /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value))
const positive = value => integer(value) && Number(value) > 0

export function verifiedPositionHistory(response, { accountId, positionId, now }) {
  if (!response || String(response.ctidTraderAccountId) !== String(accountId) || response.error || response.errorCode
    || response.hasMore !== false || (response.deal != null && !Array.isArray(response.deal))) {
    throw new Error('position history incomplete or account mismatch')
  }
  const deals = response.deal ?? [], ids = new Set(), symbols = new Set()
  if (deals.length > 500) throw new Error('position history exceeds bounded response')
  let opened = 0, closed = 0
  const ordered = [...deals].sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp)
    || Number(a.dealId) - Number(b.dealId))
  for (const d of ordered) {
    if (!positive(d.dealId) || ids.has(String(d.dealId)) || String(d.positionId) !== String(positionId)
      || !positive(d.symbolId) || !integer(d.executionTimestamp) || Number(d.executionTimestamp) < 0 || Number(d.executionTimestamp) > now
      || ![2, 3].includes(d.dealStatus) || !positive(d.filledVolume)
      || !Number.isFinite(d.executionPrice) || d.executionPrice <= 0) throw new Error('position deal evidence invalid')
    ids.add(String(d.dealId)); symbols.add(String(d.symbolId))
    const c = d.closePositionDetail
    if (c) {
      if (!Number.isInteger(c.moneyDigits) || c.moneyDigits < 0 || c.moneyDigits > 10
        || ![c.grossProfit, c.swap, c.commission].every(integer) || !positive(c.closedVolume)
        || Number(c.closedVolume) !== Number(d.filledVolume)
        || !integer(c.pnlConversionFee ?? 0) || Number(c.pnlConversionFee ?? 0) !== 0) {
        throw new Error('position closing money or volume unsupported')
      }
      closed += Number(c.closedVolume)
      if (closed > opened) throw new Error('position opening history incomplete')
    } else opened += Number(d.filledVolume)
    if (!Number.isSafeInteger(opened) || !Number.isSafeInteger(closed)) throw new Error('position volume overflow')
  }
  if (deals.length && (symbols.size !== 1 || opened === 0 || closed !== opened)) throw new Error('position lifecycle incomplete')
  return { deals, complete: true, pages: 1 }
}
