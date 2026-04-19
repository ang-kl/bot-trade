import { isOurs } from '../lib/trade-labels.js'

/**
 * Reconcile the agent's local DB against live broker positions/orders.
 *
 * - Detects externally-placed positions and imports them (source='external')
 * - Detects positions closed at the broker and marks them locally
 * - Stores pending orders snapshot for the frontend
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array} brokerPositions — from RECONCILE_RES, enriched with symbolName
 * @param {Array} brokerOrders — pending limit/stop orders from RECONCILE_RES
 * @param {(key: string, value: string) => void} setState
 * @returns {{ newExternal: Array, closedDetected: Array, pendingOrders: Array }}
 */
export function reconcilePositions(db, brokerPositions, brokerOrders, setState) {
  const knownRows = db.prepare(
    `SELECT mp.id, mp.symbol, mp.source, t.ctrader_position_id
     FROM monitored_positions mp
     LEFT JOIN trades t ON t.id = mp.trade_id
     WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL`
  ).all()

  const knownIds = new Set(knownRows.map(r => String(r.ctrader_position_id)))
  const brokerIds = new Set()

  const newExternal = []

  for (const bp of brokerPositions) {
    const posId = String(bp.tradeData?.positionId ?? bp.positionId ?? '')
    if (!posId) continue
    brokerIds.add(posId)

    if (knownIds.has(posId)) continue

    const label = bp.tradeData?.label || bp.label || ''
    if (isOurs(label)) continue

    const side = bp.tradeData?.tradeSide === 'BUY' || bp.tradeData?.tradeSide === 1 ? 'long' : 'short'
    const entry = bp.tradeData?.openPrice ?? bp.price ?? null
    const sl = bp.stopLoss ?? null
    const tp = bp.takeProfit ?? null
    const volume = bp.tradeData?.volume ? bp.tradeData.volume / 100 : null
    const symbolName = bp.symbolName || `ID:${bp.tradeData?.symbolId || '?'}`
    const initialRisk = (entry && sl) ? Math.abs(entry - sl) : null

    const inserted = db.transaction(() => {
      const tradeInsert = db.prepare(`
        INSERT INTO trades (symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
          ctrader_position_id, source, status)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, 'external', 'open')
      `).run(symbolName, side === 'long' ? 'BUY' : 'SELL', entry, sl, tp, volume, posId)
      const tradeId = tradeInsert.lastInsertRowid

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
          thesis, initial_risk, source, label_raw, status)
        VALUES (?, ?, ?, ?, ?, ?, 'External position — reconciliation import', ?, 'external', ?, 'active')
      `).run(symbolName, tradeId, side, entry, sl, tp, initialRisk, label || null)

      return tradeId
    })()

    newExternal.push({ symbol: symbolName, side, entry, positionId: posId, tradeId: inserted })
  }

  const closedDetected = []
  for (const row of knownRows) {
    if (!brokerIds.has(String(row.ctrader_position_id))) {
      db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE id = ?`).run(row.id)
      db.prepare(
        `UPDATE trades SET status = 'closed', closed_at = datetime('now') WHERE ctrader_position_id = ? AND status = 'open'`
      ).run(String(row.ctrader_position_id))
      closedDetected.push({ symbol: row.symbol, positionId: row.ctrader_position_id, source: row.source })
    }
  }

  const pendingOrders = (brokerOrders || []).map(o => ({
    orderId: o.orderId ?? o.tradeData?.orderId,
    symbolName: o.symbolName || `ID:${o.tradeData?.symbolId || '?'}`,
    side: o.tradeData?.tradeSide,
    orderType: o.orderType,
    limitPrice: o.limitPrice ?? null,
    stopPrice: o.stopPrice ?? null,
    volume: o.tradeData?.volume ? o.tradeData.volume / 100 : null,
    label: o.tradeData?.label || '',
  }))

  setState('broker_pending_orders_json', JSON.stringify(pendingOrders))
  setState('last_reconcile_at', new Date().toISOString())

  return { newExternal, closedDetected, pendingOrders }
}
