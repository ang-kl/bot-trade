// Claude · № 14,292 13-Oct (owner: NASA-3 "yes", naming keeper-close-receipts.js
// and general-partial-execution.js; filled-lots source "Both"; Opened lots "Sent
// lots, labelled"; claude-builder).
//
// THE FILLED OPENING QUANTITY, KEPT APART FROM THE CURRENT ONE. trades.volume
// serves two meanings: the lots sent, then the residual once a keeper or
// general partial rewrites it (docs/nasa-baseline-2026-10-13.md B2). The
// filled quantity is recorded here in its own column, from broker evidence
// only, each value naming its source. An unknown fill stays NULL; it is never
// taken from the order request.
//
// Sources, best first. A better source replaces a worse one; never the reverse.
//   broker_opening_deals  the position's own deal list (complete, hasMore false):
//                         the sum of its executed opening deals' filledVolume
//   broker_closing_deals  a closed row: the sum of its closing deals' lots
//   broker_position_before_first_partial
//                         the broker-confirmed volume a keeper/general partial
//                         read just before the first reduction on record
//   broker_position_first_seen
//                         the broker volume when the reconciler first saw the
//                         position, with no reduction on record

import { executedDeal, ownPositionDeal } from '../lib/position-deal-history.js'
import { openedVolumeOnRecord } from '../lib/deal-money.js'

export const FILLED_SOURCES = Object.freeze([
  'broker_opening_deals', 'broker_closing_deals', 'broker_position_before_first_partial', 'broker_position_first_seen',
])
const rankSql = col => `CASE ${col} ${FILLED_SOURCES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE ${FILLED_SOURCES.length} END`
const positiveLots = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const pidOf = v => (/^[1-9]\d*(\.0+)?$/.test(String(v ?? '')) ? String(v).replace(/\.0+$/, '') : null)

/**
 * Record the filled lots of one account's position. Only a better (or first)
 * source writes; rejected/cancelled rows are never touched. Returns rows written.
 */
export function stampFilledVolume(db, { accountId, positionId, tradeId = null, lots, source }) {
  const pid = pidOf(positionId), rank = FILLED_SOURCES.indexOf(source)
  if (!pid || accountId == null || rank < 0 || !positiveLots(lots)) return 0
  const value = Math.round(lots * 1e8) / 1e8
  return db.prepare(`UPDATE trades SET filled_volume = ?, filled_volume_source = ?
    WHERE account_id = ? AND ctrader_position_id IN (?, ?) AND (? IS NULL OR id = ?)
      AND status NOT IN ('rejected', 'cancelled')
      AND ${rankSql('filled_volume_source')} > ?`)
    .run(value, source, String(accountId), pid, `${pid}.0`, tradeId, tradeId, rank).changes
}

/**
 * The filled opening lots in one position's complete deal answer, or null with
 * the reason. Every opening deal must be this position's, executed, with a
 * positive integer filledVolume; the answer must say hasMore false.
 */
export function openingDealsFilledLots(response, positionId, lotSize) {
  const pid = pidOf(positionId)
  if (!pid || response?.hasMore !== false || !Array.isArray(response?.deal)) return { lots: null, reason: 'history_incomplete' }
  if (!(Number.isSafeInteger(Number(lotSize)) && Number(lotSize) > 0)) return { lots: null, reason: 'lot_size_unknown' }
  const opening = response.deal.filter(d => ownPositionDeal(d, pid) && executedDeal(d) && !d.closePositionDetail)
  if (!opening.length) return { lots: null, reason: 'opening_not_retained' }
  let total = 0
  for (const d of opening) {
    const v = Number(d.filledVolume)
    if (!(typeof d.filledVolume === 'number' || /^\d+$/.test(String(d.filledVolume))) || !Number.isSafeInteger(v) || v <= 0) {
      return { lots: null, reason: 'opening_volume_unverified' }
    }
    total += v
  }
  return { lots: total / Number(lotSize), reason: null }
}

/** No partial close or reduction on record for this position (deal-money's rule). */
export function noReductionOnRecord(db, { accountId, positionId, tradeId = null, monitoredId = null }) {
  return openedVolumeOnRecord(db, { accountId, positionId, tradeId, monitoredId, heldVolume: 1 }) === 1
}

/**
 * Opened lots for a reader: the recorded fill, else the lots sent while no
 * reduction is on record (labelled), else unknown. Never the residual.
 */
export function openedLotsFor({ filledVolume, filledSource, volume, reduced }) {
  if (positiveLots(Number(filledVolume)) && FILLED_SOURCES.includes(filledSource)) {
    return { lots: Number(filledVolume), source: filledSource }
  }
  if (reduced) return { lots: null, source: 'unknown_after_partial' }
  return positiveLots(Number(volume)) ? { lots: Number(volume), source: 'sent_order' } : { lots: null, source: 'unknown' }
}
