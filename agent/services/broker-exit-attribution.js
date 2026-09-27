// Read-only broker evidence collection. No execution, protection or money writes.
const identity = v => (typeof v === 'string' || Number.isSafeInteger(v)) && /^[1-9]\d*$/.test(String(v ?? ''))
const price = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const same = (a, b) => a != null && b != null && String(a) === String(b)
export const LEGACY_BOOK_STOP = 'momentum_book: broker-side stop fill (3×ATR trail)'
export function replaceableCloseReason(reason) {
  return reason == null || reason === LEGACY_BOOK_STOP
    || /^(closed at the broker|broker close recorded - former trailing-stop|market close filled at the broker|broker SL\/TP close filled)/.test(reason)
    || (/^(take profit hit|stop loss hit|stopped beyond the SL)/.test(reason)
      && /(reclassified from the broker exit price|broker SL\/TP order filled)/.test(reason))
}

export function classifyClosingOrder(response, expected) {
  const o = response?.order
  if (!same(response?.ctidTraderAccountId, expected.accountId)
    || !same(o?.orderId, expected.orderId) || !same(o?.positionId, expected.positionId)
    || o.closingOrder !== true || Number(o.orderStatus) !== 2) return { ok: false, reason: 'order_identity_or_fill_unproved' }
  const d = Array.isArray(response.deal) ? response.deal.find(d => same(d?.dealId, expected.dealId)) : null
  if (!d?.closePositionDetail || Number(d.dealStatus) !== 2 || !(Number(d.filledVolume) > 0)
    || !same(d.orderId, o.orderId) || !same(d.positionId, o.positionId)
    || !same(d.symbolId, expected.symbolId) || !same(o.tradeData?.symbolId, d.symbolId)
    || !same(d.tradeSide, expected.tradeSide) || !same(o.tradeData?.tradeSide, d.tradeSide)
    || !same(d.filledVolume, expected.filledVolume)
    || !same(d.closePositionDetail.closedVolume, d.filledVolume)
    || !price(d.executionPrice) || d.executionPrice !== expected.executionPrice
    || d.executionTimestamp !== expected.executionTimestamp
    || !price(d.closePositionDetail.entryPrice) || d.closePositionDetail.entryPrice !== expected.entryPrice) {
    return { ok: false, reason: 'closing_deal_mismatch' }
  }
  const base = { ok: true, cause: 'broker_close', confidence: 'order_confirmed_cause_unknown',
    reason: 'closed at the broker - filled closing order verified; exit cause not established' }
  if (Number(o.orderType) === 1) return { ...base, cause: 'market', confidence: 'order_confirmed_initiator_unknown',
    reason: 'market close filled at the broker - initiating actor or rule not verified' }
  if (Number(o.orderType) !== 4) return base
  const long = Number(d.tradeSide) === 2
  if (![1, 2].includes(Number(d.tradeSide))) return { ok: false, reason: 'closing_side_invalid' }
  const sl = o.stopPrice, tp = o.limitPrice, exit = d.executionPrice
  if (!price(sl) || !price(tp) || (long ? tp <= sl : tp >= sl)) return { ...base,
    reason: 'broker SL/TP close filled - bracket legs missing or ambiguous' }
  const hitTp = long ? exit >= tp : exit <= tp
  const hitSl = long ? exit <= sl : exit >= sl
  if (hitTp === hitSl) return { ...base, reason: 'broker SL/TP close filled - trigger leg ambiguous from fill and bracket' }
  return { ...base, cause: hitTp ? 'take_profit' : 'stop_loss', confidence: 'leg_inferred_from_broker_bracket',
    reason: hitTp
      ? 'take profit hit - broker SL/TP order filled; TP leg inferred from its bracket and fill'
      : 'stop loss hit - broker SL/TP order filled; SL leg inferred from its bracket and fill' }
}

/** Queue only complete, filled closing receipts. Rejected attempts are not fills. */
export function captureCloseDeals(db, accountId, deals, now = Date.now()) {
  if (!identity(accountId) || !Array.isArray(deals)) return 0
  const put = db.prepare(`INSERT OR IGNORE INTO broker_close_attribution
    (account_id, deal_id, position_id, order_id, execution_at, expected_json, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  let count = 0
  for (const d of deals) {
    const c = d?.closePositionDetail
    if (!c || Number(d.dealStatus) !== 2 || !Number.isSafeInteger(Number(d.filledVolume)) || !(Number(d.filledVolume) > 0)
      || ![d.dealId, d.positionId, d.orderId, d.symbolId].every(identity)
      || ![1, 2].includes(Number(d.tradeSide)) || !price(d.executionPrice) || !price(c.entryPrice)
      || !Number.isSafeInteger(d.executionTimestamp) || !same(d.filledVolume, c.closedVolume)) continue
    const expected = { accountId: String(accountId), dealId: String(d.dealId), positionId: String(d.positionId),
      orderId: String(d.orderId), symbolId: String(d.symbolId), tradeSide: Number(d.tradeSide),
      filledVolume: Number(d.filledVolume), executionPrice: d.executionPrice,
      executionTimestamp: d.executionTimestamp, entryPrice: c.entryPrice }
    count += put.run(String(accountId), String(d.dealId), String(d.positionId), String(d.orderId),
      d.executionTimestamp, JSON.stringify(expected), now).changes
  }
  return count
}

/** At most one account-owned order read, inside the caller's existing deadline. */
export async function collectCloseAttribution(db, { accountId, getOrderDetails, now = Date.now(), isCurrent = () => true } = {}) {
  if (!identity(accountId) || typeof getOrderDetails !== 'function' || !isCurrent()) return { state: 'not_due' }
  const row = db.prepare(`SELECT e.* FROM broker_close_attribution e
    WHERE e.account_id = ? AND e.state = 'pending' AND e.next_attempt_at <= ?
      AND EXISTS (SELECT 1 FROM trades t WHERE t.account_id = e.account_id
        AND t.ctrader_position_id = e.position_id AND t.status = 'closed')
    ORDER BY e.execution_at DESC LIMIT 1`).get(String(accountId), now)
  if (!row) return { state: 'no_candidate' }
  // Persist pacing before the read. Timeout or restart cannot create a retry storm.
  db.prepare(`UPDATE broker_close_attribution SET next_attempt_at = ?, attempts = attempts + 1
    WHERE account_id = ? AND deal_id = ?`).run(now + 300_000, row.account_id, row.deal_id)
  try {
    const response = await getOrderDetails(row.order_id)
    if (!isCurrent()) return { state: 'deadline_elapsed' }
    const verdict = classifyClosingOrder(response, JSON.parse(row.expected_json))
    if (!verdict.ok) {
      db.prepare('UPDATE broker_close_attribution SET error = ? WHERE account_id = ? AND deal_id = ?')
        .run(verdict.reason, row.account_id, row.deal_id)
      return { state: 'unverified', reason: verdict.reason }
    }
    const o = response.order
    const evidence = { accountId: row.account_id, dealId: row.deal_id, orderId: row.order_id,
      positionId: row.position_id, orderType: o.orderType, orderStatus: o.orderStatus,
      stopPrice: o.stopPrice ?? null, limitPrice: o.limitPrice ?? null, ...verdict }
    db.prepare(`UPDATE broker_close_attribution SET state = 'verified', cause = ?, reason = ?, confidence = ?,
      evidence_json = ?, verified_at = ?, error = NULL WHERE account_id = ? AND deal_id = ?`)
      .run(verdict.cause, verdict.reason, verdict.confidence, JSON.stringify(evidence), now, row.account_id, row.deal_id)
    return { state: 'verified', cause: verdict.cause, dealId: row.deal_id }
  } catch (error) {
    if (isCurrent()) db.prepare('UPDATE broker_close_attribution SET error = ? WHERE account_id = ? AND deal_id = ?')
      .run(String(error?.message ?? error).slice(0, 200), row.account_id, row.deal_id)
    return { state: 'read_failed' }
  }
}

/** A closing receipt cannot overrule another account or a later closing deal. */
export function brokerCloseReason(db, { accountId, positionId, tradeId } = {}) {
  if (accountId == null || positionId == null || tradeId == null) return null
  const t = db.prepare(`SELECT * FROM trades WHERE id = ? AND account_id = ? AND ctrader_position_id = ?
    AND status = 'closed'`).get(tradeId, String(accountId), String(positionId))
  if (!t || !price(t.exit_price) || !price(t.entry_price)) return null
  const rows = db.prepare(`SELECT e.reason, e.expected_json FROM broker_close_attribution e
    JOIN broker_deals d ON d.deal_id = e.deal_id AND d.account_id = e.account_id AND d.position_id = e.position_id
    WHERE e.account_id = ? AND e.position_id = ? AND e.state = 'verified' AND d.matched_trade_id = ?
      AND julianday(d.closed_at) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM broker_deals newer WHERE newer.account_id = d.account_id
        AND newer.position_id = d.position_id AND newer.deal_id != d.deal_id
        AND (julianday(newer.closed_at) IS NULL OR julianday(newer.closed_at) >= julianday(d.closed_at)))
    ORDER BY e.execution_at DESC LIMIT 2`).all(String(accountId), String(positionId), tradeId)
  if (rows.length !== 1) return null
  const expected = JSON.parse(rows[0].expected_json)
  if (Math.abs(t.exit_price - expected.executionPrice) > Math.abs(t.exit_price) * 1e-9
    || Math.abs(t.entry_price - expected.entryPrice) > Math.abs(t.entry_price) * 1e-9) return null
  return rows[0].reason
}
