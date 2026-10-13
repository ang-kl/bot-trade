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
//   broker_position_before_first_partial
//                         the broker-confirmed volume a keeper/general partial
//                         read just before the first reduction on record
//   broker_position_first_seen
//                         the broker volume when the reconciler first saw the
//                         position, with no reduction on record

import { executedDeal, ownPositionDeal } from '../lib/position-deal-history.js'
import { openedVolumeOnRecord } from '../lib/deal-money.js'

export const FILLED_SOURCES = Object.freeze([
  'broker_opening_deals', 'broker_position_before_first_partial', 'broker_position_first_seen',
])
// Claude · № 14,343 13-Oct (Codex P2s on #1359; claude-builder). A closed row's
// closing deals are not a source: a history read can hold only the later
// closes of a position. And trades.volume is "the lots sent" only for an order
// this system sent; an adopted or external row's volume is the broker's.
export const SENT_ORIGINS = Object.freeze(['bot_market_dispatch', 'bot_pending_fill', 'manual_broker'])
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
  // Claude · № 14,344 13-Oct (Codex P2 round 2 on #1359; claude-builder): a
  // later complete deal read supersedes an earlier one (an opening deal added
  // since); every other source still needs a strictly better rank.
  const allowEqual = source === 'broker_opening_deals' ? 1 : 0
  // Claude · № 14,346 13-Oct (Codex P2 follow-up from #1359; claude-builder).
  // The broker-position fallbacks equal the fill only for a lifecycle that
  // began here: an adopted position may have been reduced before adoption
  // with nothing on record. Only the position's own deals stand for those.
  const needsSentOrigin = source === 'broker_opening_deals' ? 0 : 1
  return db.prepare(`UPDATE trades SET filled_volume = ?, filled_volume_source = ?
    WHERE account_id = ? AND ctrader_position_id IN (?, ?) AND (? IS NULL OR id = ?)
      AND status NOT IN ('rejected', 'cancelled')
      AND (? = 0 OR origin IN (${SENT_ORIGINS.map(o => `'${o}'`).join(', ')}))
      AND (${rankSql('filled_volume_source')} > ? OR (? = 1 AND ${rankSql('filled_volume_source')} = ?))`)
    .run(value, source, String(accountId), pid, `${pid}.0`, tradeId, tradeId, needsSentOrigin, rank, allowEqual, rank).changes
}

/**
 * The broker holds more than the position held before: an opening fill was
 * added. The recorded fill is no longer the whole of it, so it is cleared and
 * the position becomes a sweep candidate again (№ 14,344). Unknown until read,
 * never the old figure presented as current.
 */
export function clearFilledVolume(db, { accountId, positionId, tradeId = null }) {
  const pid = pidOf(positionId)
  if (!pid || accountId == null) return 0
  return db.prepare(`UPDATE trades SET filled_volume = NULL, filled_volume_source = NULL
    WHERE account_id = ? AND ctrader_position_id IN (?, ?) AND (? IS NULL OR id = ?) AND filled_volume_source IS NOT NULL`)
    .run(String(accountId), pid, `${pid}.0`, tradeId, tradeId).changes
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
  const own = response.deal.filter(d => ownPositionDeal(d, pid) && executedDeal(d))
  // Claude · № 14,345 13-Oct (Codex P2s round 3 on #1359; claude-builder). A
  // netted reversal keeps the position id: one deal closes the old leg and
  // opens the other (it fills more than it closes), or opening deals stand on
  // both sides. The sum of opening deals then mixes two legs; no fill is
  // derived from such a history (declined, never reconstructed).
  const side = d => (d.tradeSide === 1 || d.tradeSide === 'BUY' ? 'BUY' : d.tradeSide === 2 || d.tradeSide === 'SELL' ? 'SELL' : null)
  const opening = own.filter(d => !d.closePositionDetail)
  if (own.some(d => d.closePositionDetail && Number(d.filledVolume) !== Number(d.closePositionDetail.closedVolume))
    || new Set(opening.map(side)).size > 1) return { lots: null, reason: 'position_reversed' }
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
export function openedLotsFor({ filledVolume, filledSource, volume, reduced, origin }) {
  if (positiveLots(Number(filledVolume)) && FILLED_SOURCES.includes(filledSource)) {
    return { lots: Number(filledVolume), source: filledSource }
  }
  if (reduced) return { lots: null, source: 'unknown_after_partial' }
  if (!SENT_ORIGINS.includes(origin)) return { lots: null, source: 'unknown' }
  return positiveLots(Number(volume)) ? { lots: Number(volume), source: 'sent_order' } : { lots: null, source: 'unknown' }
}
