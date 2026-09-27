import { sameTicks } from './momentum-target-policy.js'

// A pending-fill origin alone is not authority. Only the write-ahead limit
// plan transferred from a FILLED entry ledger may use the partial manager.
function recordedLimitOwner(db, trade, accountId, positionId) {
  if (trade.origin !== 'bot_pending_fill' || !trade.intent_id) return false
  for (const name of ['momentum_limit_intents', 'momentum_target_intents']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return false
  }
  return !!db.prepare(`SELECT 1 FROM momentum_limit_intents m
    JOIN momentum_target_intents t ON t.account_id=m.account_id AND t.trade_id=m.trade_id AND t.risk_event_id=m.risk_event_id
    JOIN entry_intents i ON i.id=m.intent_id AND i.account_id=m.account_id AND i.risk_event_id=m.risk_event_id
    WHERE m.account_id=? AND m.trade_id=? AND m.intent_id=? AND m.risk_event_id=?
      AND t.state IN ('BOUND','ENROLLED') AND t.position_id=? AND i.state='FILLED'
      AND CAST(i.broker_position_id AS TEXT) IN (?,?)`).get(accountId, trade.id, trade.intent_id, trade.risk_event_id, positionId, positionId, `${positionId}.0`)
}

// Synchronous lifecycle proof immediately before a partial intent is claimed.
// Historical adoption and symbol-only matches never enroll a position.
// Prices written by different producers (the trade's fill-anchored entry, the
// book row, the monitor row) agree in ticks at the plan's digits, not bit for
// bit; without the digits no price can be compared, so nothing is owned.
export function readPartialOwnership(db, accountId, tradeId, positionId, digits) {
  const trade = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=? AND ctrader_position_id=?')
    .get(tradeId, accountId, positionId)
  if (!trade || trade.status !== 'open' || trade.label_strategy !== 'tsmom_long'
    || (trade.origin !== 'bot_market_dispatch' && !recordedLimitOwner(db, trade, accountId, positionId)) || !(trade.risk_event_id > 0)
    || !['BUY', 'SELL'].includes(trade.side)) return null
  const books = db.prepare('SELECT * FROM momentum_book WHERE trade_id=?').all(tradeId)
  const monitors = db.prepare('SELECT * FROM monitored_positions WHERE trade_id=? AND status=?').all(tradeId, 'active')
  if (books.length !== 1 || monitors.length !== 1) return null
  const book = books[0], monitor = monitors[0], side = trade.side === 'BUY' ? 'long' : 'short'
  if (book.account_id !== accountId || book.position_id !== positionId || book.status !== 'open'
    || book.symbol !== trade.symbol || book.side !== side || !sameTicks(book.entry_price, trade.entry_price, digits)
    || monitor.account_id !== accountId || monitor.symbol !== trade.symbol || monitor.side !== side
    || monitor.strategy !== 'tsmom_long' || monitor.paused !== 1 || monitor.guard_json != null
    || monitor.scaled_out || monitor.bank_partial_at != null || !sameTicks(monitor.entry_price, trade.entry_price, digits)
    || !Number.isFinite(monitor.initial_risk) || monitor.initial_risk <= 0) return null
  return { accountId, tradeId, positionId, entry: trade.entry_price, initialRisk: monitor.initial_risk,
    side: trade.side, status: 'open', owner: 'momentum_book', guardActive: false }
}

/** One ownership rule for the bind handover, the partial manager and the
 * rank exit: the same lifecycle, owned by the book with no guard, on the
 * plan's side, with the plan's entry and initial risk in ticks. */
export function ownershipMatchesPlan(o, { accountId, tradeId, positionId, plan }) {
  return o?.accountId === accountId && o.tradeId === tradeId && o.positionId === positionId
    && o.status === 'open' && o.owner === 'momentum_book' && o.guardActive === false
    && (o.side === 'BUY' || o.side === 'SELL') && o.side === plan?.side
    && sameTicks(o.entry, plan.entry, plan.digits) && sameTicks(o.initialRisk, plan.initialRisk, plan.digits)
}
