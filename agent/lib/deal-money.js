// agent/lib/deal-money.js — the money ONE closing deal carries, and whether a
// full close may write it on its own row (V3 B1, P5b-1).
//
// WHY THIS EXISTS. The bot's full close (loop.js FULL_EXIT) stamped
//   net = (grossProfit − |commission| − |swap|) / 100
// from the one deal it had just executed. Three things were wrong with that:
//   - it assumed two money digits (moneyDigits is on the deal, per account);
//   - it turned a POSITIVE swap (a credit) into a cost;
//   - it recorded only the FINAL deal. A position that had been partly closed
//     before — by the bot's PARTIAL_EXIT, the momentum partial manager, the
//     keeper, or by hand in cTrader — lost every earlier closing deal's money,
//     and the backfill never overwrites a value that is already set.
// Demonstrated on #714 NZDUSD (…0058): local 2.91 against three broker deals
// 100.27 + 99.53 + 2.91 = 202.71.
//
// THE RULE. A full close writes its deal's money only when that deal closes
// the WHOLE lifecycle: its closed volume equals the position's opened volume.
// Anything less — or an opened volume the caller cannot account for — writes
// NULL, and the P&L backfill records the lifecycle total from the broker's
// deal history (pnl-backfill.js, which needs the opening deal and balanced
// volumes). Decided by VOLUME, not by a `scale_out` event: the momentum
// partial manager writes no position event (momentum-partial-broker.js) and
// manual partials in cTrader write none either (checker blocker on PR-1(e)).
//
// Kept in agent/lib so the decision is tested on behaviour, not with a source
// pin on loop.js (failure mode #2).

const integer = v => v != null && /^-?\d+$/.test(String(v)) && Number.isSafeInteger(Number(v))
const positiveInt = v => integer(v) && Number(v) > 0

/**
 * Signed money of one closing deal, scaled by its own moneyDigits:
 * `{ gross, swap, commission, net }` with net = gross + swap + commission, or
 * null when the deal does not carry enough to say.
 *
 * Signs are the broker's: a negative swap or commission is a cost, a positive
 * swap is a credit and is ADDED. A zero swap or commission omitted from the
 * message is zero (protobuf JSON drops default values); a missing or
 * non-integer grossProfit, or a missing moneyDigits, is null — a guessed
 * scale is invented money. pnlConversionFee is not part of net, the one
 * treatment every path uses (position-deal-history.js).
 */
export function closeDealMoney(cpd) {
  if (!cpd || typeof cpd !== 'object') return null
  const digits = cpd.moneyDigits
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) return null
  if (!integer(cpd.grossProfit)) return null
  if (cpd.swap != null && !integer(cpd.swap)) return null
  if (cpd.commission != null && !integer(cpd.commission)) return null
  const g = Number(cpd.grossProfit), s = Number(cpd.swap ?? 0), c = Number(cpd.commission ?? 0)
  const scale = 10 ** digits
  return { gross: g / scale, swap: s / scale, commission: c / scale, net: (g + s + c) / scale }
}

/**
 * May a full close write its own deal's money? Returns `{ money, reason }`:
 * `money` is closeDealMoney(...) when the deal's closed volume equals
 * `openedVolume` (both positive integers in broker volume units), otherwise
 * null with the reason. Null is always safe — the backfill fills a NULL from
 * the whole broker lifecycle — while a partial figure, once written, is never
 * corrected by anything.
 */
export function fullCloseMoney(deal, { openedVolume } = {}) {
  const cpd = deal?.closePositionDetail
  const money = closeDealMoney(cpd)
  if (!money) return { money: null, reason: 'closing deal money missing or unreadable' }
  if (!positiveInt(cpd.closedVolume)) return { money: null, reason: 'closing deal volume unknown' }
  if (!positiveInt(openedVolume)) return { money: null, reason: 'position opened volume unknown' }
  const closed = Number(cpd.closedVolume), opened = Number(openedVolume)
  if (closed < opened) return { money: null, reason: `partial lifecycle: this deal closed ${closed} of ${opened} opened; the backfill records the whole` }
  if (closed > opened) return { money: null, reason: `closed volume ${closed} exceeds the opened volume ${opened} on record` }
  return { money, reason: null }
}

/**
 * The position's opened volume as the ledger can account for it at a full
 * close: the volume the broker held just before the close (`heldVolume`, from
 * the broker snapshot) when NO earlier partial close is on record, otherwise
 * null — a partial happened and the whole lifecycle is the backfill's to
 * record.
 *
 * Evidence read, per writer of a partial close:
 *   - position_events `scale_out` (loop.js PARTIAL_EXIT, the profit keeper,
 *     the trade guard). Its `to_value` is NOT one unit across writers (the
 *     trade guard records lots, the others broker units), so it is read as
 *     "a partial happened", never summed;
 *   - momentum_partial_plans past ARMED (the P0 partial manager: SENDING,
 *     AMBIGUOUS, RECEIVED, CONFIRMED) — a partial may have executed;
 *   - monitored_positions.scaled_out = 1 (the keeper and the trade guard).
 * A partial made by hand in cTrader leaves none of these, and neither the
 * snapshot nor the closing deal carries the opened volume: that close still
 * writes its one deal. The residual gap is named in the PR, not hidden.
 * Never throws: an unreadable table is an unknown (null), not "no partial".
 */
export function openedVolumeOnRecord(db, { accountId, positionId, tradeId = null, monitoredId = null, heldVolume }) {
  if (!positiveInt(heldVolume)) return null
  try {
    // Two lookups, each on its own index (idx_position_events_trade,
    // idx_position_events_pos): this runs on the close path.
    const byTrade = tradeId == null ? null : db.prepare(`SELECT 1 FROM position_events WHERE trade_id = ? AND kind = 'scale_out' LIMIT 1`).get(tradeId)
    const byPosition = db.prepare(`SELECT 1 FROM position_events WHERE position_id = ? AND account_id = ? AND kind = 'scale_out' LIMIT 1`)
      .get(String(positionId), String(accountId))
    if (byTrade || byPosition) return null
  } catch { return null }
  try {
    const plan = db.prepare(`SELECT 1 FROM momentum_partial_plans WHERE account_id = ? AND position_id = ? AND state <> 'ARMED' LIMIT 1`)
      .get(String(accountId), String(positionId))
    if (plan) return null
  } catch (e) {
    // The partial manager creates its table lazily; absent means no plan.
    if (!/no such table/i.test(String(e?.message))) return null
  }
  if (monitoredId != null) {
    try {
      const mp = db.prepare('SELECT scaled_out FROM monitored_positions WHERE id = ?').get(monitoredId)
      if (Number(mp?.scaled_out) === 1) return null
    } catch { return null }
  }
  return Number(heldVolume)
}
