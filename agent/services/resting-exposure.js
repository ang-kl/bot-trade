import { labelIntentId } from '../lib/trade-labels.js'

const has = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const positionKey = (account, position) => `${account}|${String(position).replace(/\.0+$/, '')}`
export function isFullMomentumLimitFill(trade, intent, plan) {
  if (!trade || !intent || !plan || trade.symbol !== intent.symbol || trade.side !== intent.side
    || String(trade.account_id) !== String(intent.account_id)
    || plan.intent_id !== intent.id || String(plan.account_id) !== String(intent.account_id)
    || !intent.broker_position_id || trade.ctrader_position_id == null
    || positionKey(trade.account_id, trade.ctrader_position_id) !== positionKey(intent.account_id, intent.broker_position_id)) return false
  let proposal
  try { proposal = JSON.parse(plan.proposal_json) } catch { return false }
  const lotSize = proposal?.evidence?.symbolMeta?.lotSize, expected = proposal?.plan?.volume
  if (!Number.isSafeInteger(lotSize) || lotSize <= 0 || !Number.isSafeInteger(expected) || expected <= 0
    || expected !== intent.volume || !(trade.volume > 0)) return false
  const units = trade.volume * lotSize
  return Math.round(units) === expected && Math.abs(units - expected) <= expected * 1e-12
}

// One entry order, one slot. Broker snapshots use underlying units; pending
// rows use lots. Never collapse two orders merely because their symbol agrees.
// An adopted fill replaces its reservation only with exact ledger linkage and
// full volume proof. ORDER_PARTIAL_FILL also makes the ledger FILLED.
export function restingExposure(db, accountId) {
  const acct = accountId == null ? null : String(accountId)
  const pending = has(db, 'pending_orders') ? db.prepare("SELECT * FROM pending_orders WHERE status='working' AND (account_id=? OR ? IS NULL)").all(acct, acct) : []
  const broker = has(db, 'broker_orders') ? db.prepare("SELECT * FROM broker_orders WHERE status='working' AND (account_id=? OR ? IS NULL)").all(acct, acct) : []
  if (!pending.length && !broker.length) return []
  const planByIntent = has(db, 'momentum_limit_intents')
    ? db.prepare('SELECT * FROM momentum_limit_intents WHERE intent_id=? AND account_id=?') : null
  const hasLedger = has(db, 'entry_intents')
  const byId = hasLedger ? db.prepare('SELECT * FROM entry_intents WHERE id=? AND account_id=?') : null
  const byOrder = hasLedger ? db.prepare('SELECT * FROM entry_intents WHERE broker_order_id=? AND account_id=? LIMIT 1') : null
  const adopted = has(db, 'monitored_positions') ? db.prepare(`SELECT t.account_id,t.ctrader_position_id,t.symbol,t.side,t.volume FROM trades t
    JOIN monitored_positions mp ON mp.trade_id=t.id AND mp.account_id=t.account_id AND mp.status='active'
    WHERE t.status='open' AND (t.account_id=? OR ? IS NULL)`).all(acct, acct) : []
  const held = new Map()
  for (const trade of adopted) {
    const key = positionKey(trade.account_id, trade.ctrader_position_id)
    held.set(key, held.has(key) ? null : trade)
  }
  const out = new Map()
  const add = (row, source) => {
    const side = source === 'pending' ? (row.dir < 0 ? 'SELL' : 'BUY') : row.side
    const id = row.intent_id || labelIntentId(row.label || '')
    const matches = i => i && i.symbol === row.symbol && i.side === side
      && (row.order_id == null || String(i.broker_order_id) === String(row.order_id))
    const tagged = id ? byId?.get(id, row.account_id) : null
    const ordered = !matches(tagged) && row.order_id != null ? byOrder?.get(String(row.order_id), row.account_id) : null
    const intent = matches(tagged) ? tagged : matches(ordered) ? ordered : null
    const plan = intent ? planByIntent?.get(intent.id, row.account_id) : null
    if (intent?.state === 'FILLED' && isFullMomentumLimitFill(held.get(positionKey(intent.account_id, intent.broker_position_id)), intent, plan)) return
    // The reply can be lost after the ledger learnt the order id, leaving the
    // pending row id-less. Use that exact ledger id to meet the broker row;
    // two distinct broker ids must still consume two slots.
    const orderId = row.order_id ?? intent?.broker_order_id ?? null
    const key = orderId != null ? `${row.account_id}|${orderId}` : (intent ? `intent:${intent.id}` : `pending:${row.id}`)
    const existing = out.get(key)
    out.set(key, { symbol: row.symbol, side,
      volume: Number(row.volume), entry: Number(source === 'pending' ? row.level : row.limit_price ?? row.stop_price),
      volumeKind: source === 'pending' ? 'lots' : 'units', accountId: row.account_id, orderId,
      intentId: intent?.id ?? row.intent_id ?? null, source,
      reservedMarginUsd: plan?.reserved_margin_usd ?? existing?.reservedMarginUsd ?? null })
  }
  for (const row of pending) add(row, 'pending')
  for (const row of broker) add(row, 'broker')
  return [...out.values()]
}
