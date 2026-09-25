// A complete response is necessary but not sufficient: a retained suffix of
// old history must not become the whole position's realised P&L.
const integer = value => /^-?\d+$/.test(String(value)) && Number.isSafeInteger(Number(value))
const positive = value => integer(value) && Number(value) > 0

// V3 I1. Two kinds of refusal, told apart by `code`. A response that never
// arrived, carried a broker error, or answered for another account or with a
// partial page says nothing about the position: no code, not an attempt.
// A response that DID arrive complete for this account and cannot be settled
// (invalid deals, unsupported money, a lifecycle that does not balance) says
// the same thing on every pass until something changes at the broker: that is
// an attempt at the row, and the caller bounds it (old-position-pnl.js).
export const POSITION_HISTORY_REFUSED = 'POSITION_HISTORY_REFUSED'
const refused = message => Object.assign(new Error(message), { code: POSITION_HISTORY_REFUSED })

export function verifiedPositionHistory(response, { accountId, positionId, now }) {
  if (!response || String(response.ctidTraderAccountId) !== String(accountId) || response.error || response.errorCode
    || response.hasMore !== false || (response.deal != null && !Array.isArray(response.deal))) {
    throw new Error('position history incomplete or account mismatch')
  }
  const deals = response.deal ?? [], ids = new Set(), symbols = new Set()
  if (deals.length > 500) throw refused('position history exceeds bounded response')
  let opened = 0, closed = 0
  const ordered = [...deals].sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp)
    || Number(a.dealId) - Number(b.dealId))
  for (const d of ordered) {
    if (!positive(d.dealId) || ids.has(String(d.dealId)) || String(d.positionId) !== String(positionId)
      || !positive(d.symbolId) || !integer(d.executionTimestamp) || Number(d.executionTimestamp) < 0 || Number(d.executionTimestamp) > now
      || ![2, 3].includes(d.dealStatus) || !positive(d.filledVolume)
      || !Number.isFinite(d.executionPrice) || d.executionPrice <= 0) throw refused('position deal evidence invalid')
    ids.add(String(d.dealId)); symbols.add(String(d.symbolId))
    const c = d.closePositionDetail
    if (c) {
      if (!Number.isInteger(c.moneyDigits) || c.moneyDigits < 0 || c.moneyDigits > 10
        || ![c.grossProfit, c.swap ?? 0, c.commission ?? 0].every(integer) || !positive(c.closedVolume)
        || Number(c.closedVolume) !== Number(d.filledVolume)
        || !integer(c.pnlConversionFee ?? 0) || Number(c.pnlConversionFee ?? 0) !== 0) {
        throw refused('position closing money or volume unsupported')
      }
      closed += Number(c.closedVolume)
      if (closed > opened) throw refused('position opening history incomplete')
    } else opened += Number(d.filledVolume)
    if (!Number.isSafeInteger(opened) || !Number.isSafeInteger(closed)) throw refused('position volume overflow')
  }
  if (deals.length && (symbols.size !== 1 || opened === 0)) throw refused('position lifecycle incomplete')
  // More volume opened than closed: the broker still holds (part of) the
  // position. That is broker evidence, not the absence of it, so it carries
  // its own wording and flag; a caller must never file it as "no broker
  // evidence" (V3 I1 checker N3).
  if (deals.length && closed !== opened) {
    throw Object.assign(refused(`broker shows position still open: opened volume ${opened}, closed volume ${closed}`), { openAtBroker: true })
  }
  return { deals, complete: true, pages: 1 }
}
