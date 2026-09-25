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

// A deal that executed, in either form the broker's JSON may carry the enum:
// FILLED (2) or PARTIALLY_FILLED (3), as a number or by name (the other
// readers accept both: entry-ledger.js DEAL_STATUS_OK). Accepting only the
// numbers would defer EVERY position if the name ever arrived (B1 checker N3).
const EXECUTED_DEAL_STATUS = new Set([2, 3, 'FILLED', 'PARTIALLY_FILLED'])
export const executedDeal = d => EXECUTED_DEAL_STATUS.has(typeof d?.dealStatus === 'string' ? d.dealStatus.toUpperCase() : d?.dealStatus)

/** Two ledger/broker times closer than this are the same moment (clock skew, the reconciler's pass). */
export const FALSE_CLOSE_TOLERANCE_MS = 120_000

// V3 B1 (P5b-1): money needs one whole, unique broker lifecycle. The opening
// and closing volume walk of ONE position over the deals given, shared by the
// strict position reader below and the 14-day window path in pnl-backfill.js.
// A window that holds only the tail of a position (its opening deal fell
// before the window, or a partial close did) must not become the position's
// realised money: probe-p5bd case 2 wrote 50 against a lifetime of 150.
//
// Pure. Deals of other positions are ignored; a deal whose dealStatus is not
// FILLED or PARTIALLY_FILLED (number or name) did not execute and moves no
// volume.
// Opening deals count `filledVolume`, closing deals `closePositionDetail.
// closedVolume`; a missing or non-integer volume proves nothing and the walk
// is unbalanced. `finalCloseMs` is the closing deal at which closed volume
// reaches opened volume: the end of the lifecycle, which the false-close rule
// compares a recorded close against (a partial close earlier in the life is
// not the end — checker correction on PR-1(d)).
//
// `conversionFee` is the lifecycle's summed pnlConversionFee in account
// currency (each deal at its own moneyDigits): EXCLUDED from realised money by
// the one convention every path uses, and returned so its size is measured,
// not Not Verifiable (B1 checker, owner question). null when any closing deal
// carries a fee that cannot be read.
export function lifecycleBalance(deals, positionId) {
  const pid = String(positionId)
  const own = (Array.isArray(deals) ? deals : [])
    .filter(d => d && String(d.positionId) === pid && executedDeal(d))
    .sort((a, b) => Number(a.executionTimestamp) - Number(b.executionTimestamp) || Number(a.dealId) - Number(b.dealId))
  let opened = 0, closed = 0, finalCloseMs = null, reason = null, fee = 0
  for (const d of own) {
    if (finalCloseMs != null) { reason = 'deals after the lifecycle closed'; break }
    const c = d.closePositionDetail
    const volume = c ? c.closedVolume : d.filledVolume
    if (!positive(volume)) { reason = c ? 'closing volume unknown' : 'opening volume unknown'; break }
    if (c) {
      closed += Number(volume)
      if (closed > opened) { reason = 'opening not among the deals'; break }
      if (closed === opened) finalCloseMs = Number(d.executionTimestamp)
      const f = c.pnlConversionFee ?? 0
      fee = fee != null && integer(f) && Number.isInteger(c.moneyDigits) && c.moneyDigits >= 0 && c.moneyDigits <= 10
        ? fee + Number(f) / 10 ** c.moneyDigits : null
    } else opened += Number(volume)
    if (!Number.isSafeInteger(opened) || !Number.isSafeInteger(closed)) { reason = 'volume overflow'; break }
  }
  const balanced = reason == null && opened > 0 && closed === opened && Number.isFinite(finalCloseMs)
  if (!balanced && reason == null) reason = opened === 0 ? 'opening not among the deals' : 'position not closed within the deals'
  return { opened, closed, hasOpening: opened > 0, balanced, finalCloseMs: balanced ? finalCloseMs : null, reason: balanced ? null : reason,
    conversionFee: fee == null ? null : Math.round(fee * 100) / 100 }
}

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
      || !executedDeal(d) || !positive(d.filledVolume)
      || !Number.isFinite(d.executionPrice) || d.executionPrice <= 0) throw refused('position deal evidence invalid')
    ids.add(String(d.dealId)); symbols.add(String(d.symbolId))
    const c = d.closePositionDetail
    if (c) {
      // pnlConversionFee: ONE treatment on every path (V3 B1). Realised money
      // is gross + swap + commission — what the window path, the loop's close
      // and cTrader's history net have always recorded — and the fee is not
      // part of it. The fee must still be an integer, or the deal is not
      // evidence; a nonzero fee no longer refuses a whole lifecycle that the
      // window path would have settled (AVY/GEV on SGD account 42993489).
      if (!Number.isInteger(c.moneyDigits) || c.moneyDigits < 0 || c.moneyDigits > 10
        || ![c.grossProfit, c.swap ?? 0, c.commission ?? 0].every(integer) || !positive(c.closedVolume)
        || Number(c.closedVolume) !== Number(d.filledVolume)
        || !integer(c.pnlConversionFee ?? 0)) {
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
  return { deals, complete: true, pages: 1, lifecycle: lifecycleBalance(ordered, positionId) }
}
