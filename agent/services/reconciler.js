import { isOurs, parseLabel } from '../lib/trade-labels.js'
import { getState } from '../db.js'

/**
 * Reconcile the agent's local DB against live broker positions/orders.
 *
 * - Detects externally-placed positions and imports them (source='external')
 * - Detects positions closed at the broker and marks them locally
 * - Detects MANUAL CHANGES to tracked positions (owner tampering in the
 *   cTrader app: reversed side, changed volume, hand-moved SL/TP) — alerts
 *   and adopts the broker truth so the monitor manages reality
 * - Stores pending orders snapshot for the frontend
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array} brokerPositions — from RECONCILE_RES, enriched with symbolName
 * @param {Array} brokerOrders — pending limit/stop orders from RECONCILE_RES
 * @param {(key: string, value: string) => void} setState
 * @returns {{ newExternal: Array, closedDetected: Array, manualChanges: Array, pendingOrders: Array }}
 */
export function reconcilePositions(db, brokerPositions, brokerOrders, setState) {
  const knownRows = db.prepare(
    `SELECT mp.id, mp.symbol, mp.source, mp.side, mp.entry_price, mp.current_sl, mp.current_tp,
            mp.broker_volume_units, mp.broker_sl, mp.broker_tp, t.ctrader_position_id
     FROM monitored_positions mp
     LEFT JOIN trades t ON t.id = mp.trade_id
     WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL`
  ).all()

  const knownIds = new Set(knownRows.map(r => String(r.ctrader_position_id)))
  const knownById = new Map(knownRows.map(r => [String(r.ctrader_position_id), r]))
  const brokerIds = new Set()

  const newExternal = []
  const manualChanges = []

  // Price-scale-aware "did it really change" — null↔value counts as a change.
  const differs = (a, b) => {
    if (a == null && b == null) return false
    if (a == null || b == null) return true
    return Math.abs(Number(a) - Number(b)) > Math.max(1e-9, Math.abs(Number(b)) * 1e-6)
  }

  for (const bp of brokerPositions) {
    const posId = String(bp.tradeData?.positionId ?? bp.positionId ?? '')
    if (!posId) continue
    brokerIds.add(posId)

    if (knownIds.has(posId)) {
      // -----------------------------------------------------------------
      // TAMPER WATCH — the position is OURS and still open; compare the
      // broker's live shape against what we last saw / what we manage.
      // Bot-initiated changes don't trip this: bot amends update
      // current_sl/current_tp first (so the broker matches us), and bot
      // partial closes NULL the broker_volume_units baseline before the
      // next reconcile.
      // -----------------------------------------------------------------
      const row = knownById.get(posId)
      const bSide = (bp.tradeData?.tradeSide === 'BUY' || bp.tradeData?.tradeSide === 1) ? 'long' : 'short'
      const bVol = bp.tradeData?.volume ? bp.tradeData.volume / 100 : null
      const bSl = bp.stopLoss ?? null
      const bTp = bp.takeProfit ?? null
      const bPrice = bp.price ?? bp.tradeData?.openPrice ?? null
      const updates = {}

      if (row.side && bSide !== row.side) {
        manualChanges.push({ kind: 'reversed', symbol: row.symbol, positionId: posId, from: row.side, to: bSide })
        updates.side = bSide
        updates.entry_price = bPrice ?? row.entry_price
        updates.current_sl = bSl
        updates.current_tp = bTp
        updates.thesis_note = `MANUAL REVERSAL detected at broker (${row.side}→${bSide}) — monitor now manages the new direction on technicals`
      }
      if (row.broker_volume_units != null && bVol != null && differs(bVol, row.broker_volume_units)) {
        manualChanges.push({ kind: 'volume', symbol: row.symbol, positionId: posId, from: row.broker_volume_units, to: bVol })
      }
      if (!updates.side) { // side flip already adopts SL/TP wholesale
        if (row.broker_sl != null && differs(bSl, row.broker_sl) && differs(bSl, row.current_sl)) {
          manualChanges.push({ kind: 'sl_moved', symbol: row.symbol, positionId: posId, from: row.broker_sl, to: bSl })
          updates.current_sl = bSl
        }
        if (row.broker_tp != null && differs(bTp, row.broker_tp) && differs(bTp, row.current_tp)) {
          manualChanges.push({ kind: 'tp_moved', symbol: row.symbol, positionId: posId, from: row.broker_tp, to: bTp })
          updates.current_tp = bTp
        }
      }

      db.prepare(
        `UPDATE monitored_positions SET
           side = COALESCE(?, side),
           entry_price = COALESCE(?, entry_price),
           current_sl = CASE WHEN ? = 1 THEN ? ELSE current_sl END,
           current_tp = CASE WHEN ? = 1 THEN ? ELSE current_tp END,
           thesis = CASE WHEN ? IS NOT NULL THEN (COALESCE(thesis, '') || ' | ' || ?) ELSE thesis END,
           broker_volume_units = ?, broker_sl = ?, broker_tp = ?
         WHERE id = ?`
      ).run(
        updates.side ?? null,
        updates.entry_price ?? null,
        'current_sl' in updates ? 1 : 0, updates.current_sl ?? null,
        'current_tp' in updates ? 1 : 0, updates.current_tp ?? null,
        updates.thesis_note ?? null, updates.thesis_note ?? null,
        bVol, bSl, bTp,
        row.id,
      )
      continue
    }

    // A broker position with no local active row is ADOPTED so the bot's
    // view matches the broker (owner saw 4 at the broker, 1 shown). Two
    // kinds:
    //  · ours-labelled but untracked → a bot fill whose local row was never
    //    written (the exec response lacked a positionId). Adopt as a BOT
    //    position (source from the label) and MANAGE it — previously this
    //    was `continue`, so those fills stayed invisible forever.
    //  · foreign label → a manual/external position: import observe-only.
    const label = bp.tradeData?.label || bp.label || ''
    const ours = isOurs(label)
    const parsed = parseLabel(label)
    const adoptedSource = ours ? (parsed.source || 'autopilot') : 'external'
    const thesis = ours
      ? `Adopted bot position — label ${adoptedSource}${parsed.strategy ? `/${parsed.strategy}` : ''} (reconciled; local row was missing)`
      : 'External position — reconciliation import'

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
          ctrader_position_id, source, label_raw, label_strategy, status)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'open')
      `).run(symbolName, side === 'long' ? 'BUY' : 'SELL', entry, sl, tp, volume, posId,
        adoptedSource, label || null, parsed.strategy || null)
      const tradeId = tradeInsert.lastInsertRowid

      db.prepare(`
        INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
          thesis, initial_risk, source, strategy, label_raw, account_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(symbolName, tradeId, side, entry, sl, tp, thesis, initialRisk,
        adoptedSource, parsed.strategy || null, label || null, getState(db, 'ctrader_account_id'))

      return tradeId
    })()

    newExternal.push({ symbol: symbolName, side, entry, positionId: posId, adopted: ours, source: adoptedSource, tradeId: inserted })
  }

  const closedDetected = []
  for (const row of knownRows) {
    if (!brokerIds.has(String(row.ctrader_position_id))) {
      db.prepare(`UPDATE monitored_positions SET status = 'closed' WHERE id = ?`).run(row.id)
      // Say WHO closed it, or at least who didn't: a close the bot performs
      // stamps its own close_reason via markTradeClosed before reconcile
      // ever sees the position gone; a close detected HERE happened at the
      // broker (manual close in cTrader, or a broker-side SL/TP fill).
      // Owner hit the blank version live: a manual DOW.US short closed in
      // under 5 minutes and the ledger had nothing to say beyond the exit
      // price ("it didn't say what happen").
      db.prepare(
        `UPDATE trades SET status = 'closed', closed_at = datetime('now'),
           close_reason = COALESCE(close_reason, 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot')
         WHERE ctrader_position_id = ? AND status = 'open'`
      ).run(String(row.ctrader_position_id))
      closedDetected.push({ symbol: row.symbol, positionId: row.ctrader_position_id, source: row.source })
    }
  }

  // Human-readable snapshot: the raw broker order carries NUMERIC enums
  // (tradeSide 1/2, orderType 2=LIMIT) and RELATIVE SL/TP distances in
  // 1/100000-price units — the UI showed "? … 2 @ 1.15477" (owner: "so
  // bare"). Decode everything here so every reader gets honest fields.
  const SIDE_STR = (v) => (v === 1 || v === 'BUY') ? 'BUY' : (v === 2 || v === 'SELL') ? 'SELL' : null
  const TYPE_STR = (v) => ({ 1: 'MARKET', 2: 'LIMIT', 3: 'STOP', 4: 'STOP_LIMIT', 5: 'MARKET_RANGE' })[v] || (typeof v === 'string' ? v : 'ORDER')
  // Closing orders (closingOrder flag / bound positionId) are a live
  // position's extra TP/SL levels, not standalone pending entries — cTrader
  // stores the app's TP2/TP3 this way. Keep only true entry orders here.
  const pendingOrders = (brokerOrders || [])
    .filter(o => !(o.closingOrder === true || Number(o.positionId) > 0))
    .map(o => {
      const side = SIDE_STR(o.tradeData?.tradeSide)
      const px = o.limitPrice ?? o.stopPrice ?? null
      const dir = side === 'SELL' ? -1 : 1
      const relSl = Number(o.relativeStopLoss)
      const relTp = Number(o.relativeTakeProfit)
      const round5 = (v) => Math.round(v * 100000) / 100000
      return {
        orderId: o.orderId ?? o.tradeData?.orderId,
        symbolName: o.symbolName || `ID:${o.tradeData?.symbolId || '?'}`,
        side,
        orderType: TYPE_STR(o.orderType),
        limitPrice: o.limitPrice ?? null,
        stopPrice: o.stopPrice ?? null,
        // The app places SL/TP on pending orders as RELATIVE distances;
        // absolute fields win when present.
        sl: o.stopLoss ?? (px != null && Number.isFinite(relSl) && relSl > 0 ? round5(px - dir * relSl / 100000) : null),
        tp: o.takeProfit ?? (px != null && Number.isFinite(relTp) && relTp > 0 ? round5(px + dir * relTp / 100000) : null),
        volumeUnits: o.tradeData?.volume ? o.tradeData.volume / 100 : null,
        volume: o.tradeData?.volume ? o.tradeData.volume / 100 : null, // legacy readers
        expiresAt: o.expirationTimestamp ? new Date(Number(o.expirationTimestamp)).toISOString() : null,
        updatedAt: o.utcLastUpdateTimestamp ? new Date(Number(o.utcLastUpdateTimestamp)).toISOString() : null,
        label: o.tradeData?.label || '',
        bot: String(o.tradeData?.label || '').includes('pending-fib'),
      }
    })

  setState('broker_pending_orders_json', JSON.stringify(pendingOrders))
  setState('last_reconcile_at', new Date().toISOString())

  return { newExternal, closedDetected, manualChanges, pendingOrders }
}
