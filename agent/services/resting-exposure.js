import { labelIntentId } from '../lib/trade-labels.js'

const has = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

// One entry order, one slot. Broker snapshots use underlying units; pending
// rows use lots. Never collapse two orders merely because their symbol agrees.
// An adopted fill replaces its reservation only with exact ledger linkage.
export function restingExposure(db, accountId) {
  const acct = accountId == null ? null : String(accountId)
  const pending = has(db, 'pending_orders') ? db.prepare("SELECT * FROM pending_orders WHERE status='working' AND (account_id=? OR ? IS NULL)").all(acct, acct) : []
  const broker = has(db, 'broker_orders') ? db.prepare("SELECT * FROM broker_orders WHERE status='working' AND (account_id=? OR ? IS NULL)").all(acct, acct) : []
  if (!pending.length && !broker.length) return []
  const plans = has(db, 'momentum_limit_intents') ? db.prepare(`SELECT m.* FROM momentum_limit_intents m
    JOIN pending_orders p ON p.id=m.pending_id AND p.status='working'
    WHERE m.account_id=? OR ? IS NULL`).all(acct, acct) : []
  const byIntent = new Map(plans.map(p => [p.intent_id, p]))
  const hasLedger = has(db, 'entry_intents')
  const byId = hasLedger ? db.prepare('SELECT * FROM entry_intents WHERE id=? AND account_id=?') : null
  const byOrder = hasLedger ? db.prepare('SELECT * FROM entry_intents WHERE broker_order_id=? AND account_id=? LIMIT 1') : null
  const adopted = has(db, 'monitored_positions') ? db.prepare(`SELECT t.account_id,t.ctrader_position_id FROM trades t
    JOIN monitored_positions mp ON mp.trade_id=t.id AND mp.status='active'
    WHERE t.status='open' AND (t.account_id=? OR ? IS NULL)`).all(acct, acct) : []
  const held = new Set(adopted.map(t => `${t.account_id}|${String(t.ctrader_position_id).replace(/\.0+$/, '')}`))
  const out = new Map()
  const add = (row, source) => {
    const orderKey = row.order_id == null ? null : `${row.account_id}|${row.order_id}`
    const id = row.intent_id || labelIntentId(row.label || '')
    const intent = (id ? byId?.get(id, row.account_id) : null)
      || (row.order_id != null ? byOrder?.get(String(row.order_id), row.account_id) : null)
    if (intent?.state === 'FILLED' && held.has(`${intent.account_id}|${String(intent.broker_position_id).replace(/\.0+$/, '')}`)) return
    const key = orderKey || (intent ? `intent:${intent.id}` : `pending:${row.id}`)
    const plan = byIntent.get(intent?.id || row.intent_id)
    const existing = out.get(key)
    out.set(key, { symbol: row.symbol, side: source === 'pending' ? (row.dir < 0 ? 'SELL' : 'BUY') : row.side,
      volume: Number(row.volume), entry: Number(source === 'pending' ? row.level : row.limit_price ?? row.stop_price),
      volumeKind: source === 'pending' ? 'lots' : 'units', accountId: row.account_id, orderId: row.order_id,
      intentId: intent?.id ?? row.intent_id ?? null, source,
      reservedMarginUsd: plan?.reserved_margin_usd ?? existing?.reservedMarginUsd ?? null })
  }
  for (const row of pending) add(row, 'pending')
  for (const row of broker) add(row, 'broker')
  return [...out.values()]
}
