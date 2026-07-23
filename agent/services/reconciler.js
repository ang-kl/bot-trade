import { isOurs, parseLabel } from '../lib/trade-labels.js'
import { getState, closeTradeRow } from '../db.js'
import { contractSize } from '../lib/contracts.js'

// cTrader `tradeData.volume` is in units × 100. The whole risk/keeper stack
// treats `trades.volume` as LOTS (bot-placed rows store lots; the keeper does
// lots × meta.lotSize to scale out; the risk margin gate feeds it to
// notionalUsd, which multiplies by contractSize). Storing raw broker units in
// that column made an adopted FX position's notional ~100,000× too large — a
// ~$700M phantom "used margin" that vetoed every new trade with
// `insufficient_margin` and corrupted the keeper's scale-out maths. Convert to
// lots: lots = (volume / 100) / unitsPerLot, unitsPerLot = contractSize(symbol)
// (100k for FX, 1 for indices/crypto). Returns null when volume is absent.
export function brokerVolumeToLots(bp, symbol) {
  const units = bp?.tradeData?.volume ? bp.tradeData.volume / 100 : null
  if (units == null) return null
  const perLot = contractSize(symbol) || 1
  return perLot > 0 ? units / perLot : units
}

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
            mp.broker_volume_units, mp.broker_sl, mp.broker_tp, mp.trade_id,
            t.ctrader_position_id, t.volume AS tradeVolume
     FROM monitored_positions mp
     LEFT JOIN trades t ON t.id = mp.trade_id
     WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL`
  ).all()

  const knownIds = new Set(knownRows.map(r => String(r.ctrader_position_id)))
  const knownById = new Map(knownRows.map(r => [String(r.ctrader_position_id), r]))
  const brokerIds = new Set()

  const newExternal = []
  const manualChanges = []
  const relinked = []

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

      // SELF-HEAL the legacy units-in-lots-column bug: earlier adoptions wrote
      // broker UNITS into trades.volume (a lots column), so the aggregate margin
      // gate read a ~100,000× notional and vetoed all new trades. Using live
      // broker truth, rewrite trades.volume to the correct LOTS. Precise trigger
      // — only when the stored value equals the raw broker UNITS (the exact bug
      // signature) and that differs from the true lots (i.e. contractSize > 1),
      // or when it's missing. A correctly-sized lots row is never touched.
      const healUnits = bp?.tradeData?.volume ? bp.tradeData.volume / 100 : null
      const healLots = brokerVolumeToLots(bp, row.symbol)
      if (row.trade_id && healLots != null && healLots > 0 && healUnits != null) {
        const cur = Number(row.tradeVolume)
        const looksLikeUnits = cur > 0 && Math.abs(cur - healUnits) <= Math.max(1e-9, healUnits * 0.01)
        const needsHeal = (!(cur > 0) || looksLikeUnits) && Math.abs(cur - healLots) > healLots * 0.01
        if (needsHeal) {
          db.prepare(`UPDATE trades SET volume = ? WHERE id = ?`).run(healLots, row.trade_id)
        }
      }
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
    const symbolName = bp.symbolName || `ID:${bp.tradeData?.symbolId || '?'}`
    // Store LOTS (not raw broker units) so the risk/keeper stack reads it right.
    const volume = brokerVolumeToLots(bp, symbolName)
    const initialRisk = (entry && sl) ? Math.abs(entry - sl) : null

    // DUPLICATE-ADOPTION GUARD: we only reach here because no ACTIVE monitored
    // row maps to this posId — but a trade for it may STILL exist 'open' with a
    // merely-inactive monitored row (a manage cycle marked it closed while the
    // broker position lived on). Inserting a fresh trade every reconcile is what
    // ballooned openTrades (85→155 while the bot was stopped). If an open trade
    // for this posId already exists, RE-LINK its management instead of spawning
    // a second row.
    const existingOpen = db.prepare(
      `SELECT id FROM trades WHERE ctrader_position_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`
    ).get(posId)
    if (existingOpen) {
      // reaching this branch at all means `trades` still says 'open' but no
      // ACTIVE monitored_positions row maps to this broker position — the
      // trade and its management have desynced. Two shapes, both worth
      // surfacing (this used to happen silently, fixed only by a log line):
      //   · a row exists but isn't 'active' — something closed it locally
      //     while the broker kept the position open (e.g. the LLM-monitor
      //     EXIT-without-broker-close bug, fixed 2026-07-22) — re-activate it.
      //   · no row exists at all — the bot's fill never got one written
      //     (exec response lacked a positionId) — create it fresh.
      const mp = db.prepare(
        `SELECT id, status FROM monitored_positions WHERE trade_id = ? ORDER BY (status='active') DESC, id DESC LIMIT 1`
      ).get(existingOpen.id)
      const desyncKind = mp ? 'reactivated_closed_row' : 'created_missing_row'
      if (mp) {
        db.prepare(`UPDATE monitored_positions SET status='active' WHERE id = ?`).run(mp.id)
      } else {
        db.prepare(`
          INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp,
            thesis, initial_risk, source, strategy, label_raw, account_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(symbolName, existingOpen.id, side, entry, sl, tp, thesis, initialRisk,
          adoptedSource, parsed.strategy || null, label || null, getState(db, 'ctrader_account_id'))
      }
      relinked.push({ symbol: symbolName, positionId: posId, tradeId: existingOpen.id, desyncKind })
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          'RECONCILE_DESYNC', '/reconcile',
          JSON.stringify({
            symbol: symbolName, positionId: posId, tradeId: existingOpen.id, kind: desyncKind,
            detail: desyncKind === 'reactivated_closed_row'
              ? 'monitored_positions row was closed locally while the broker position was still open — re-activated to match broker truth'
              : 'trade was open with no monitored_positions row at all (fill never got one written) — created fresh',
          }).slice(0, 2000)
        )
      } catch { /* audit best-effort */ }
      continue
    }

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
      // ctrader_position_id, not a single trade id — could match more than one
      // 'open' row (the dedup sweep further down handles that garbage case).
      const openIds = db.prepare(
        `SELECT id FROM trades WHERE ctrader_position_id = ? AND status = 'open'`
      ).all(String(row.ctrader_position_id))
      for (const { id } of openIds) {
        closeTradeRow(db, id, { closeReason: 'closed at the broker (manual close or broker-side SL/TP fill) — not closed by the bot' })
      }
      closedDetected.push({ symbol: row.symbol, positionId: row.ctrader_position_id, source: row.source })
    }
  }

  // ORPHAN SWEEP — the loop above only reaches trades linked to an ACTIVE
  // monitored_positions row. A trade left status='open' whose monitored row was
  // already closed (or never written) is invisible to it and lingers 'open'
  // forever. Live health showed 85 'open' trades vs 14 monitored positions —
  // ~71 phantom opens poisoning exposure caps, the duplicate-symbol veto, and
  // daily-loss math. Close any open trade whose broker position id is provably
  // NOT among the live broker positions. Trades still awaiting a fill
  // (ctrader_position_id IS NULL) are left untouched — they have no position to
  // be gone. Scoped to ids absent from brokerIds, so a live position is never
  // touched.
  // DEDUP existing garbage: prior re-adoption may have left several 'open'
  // trades sharing one broker positionId. Keep the newest per posId, close the
  // rest — the orphan sweep can't (their posId is still live at the broker).
  const dupsClosed = []
  try {
    const dups = db.prepare(
      `SELECT id, symbol, ctrader_position_id FROM trades
        WHERE status = 'open' AND ctrader_position_id IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id) FROM trades
             WHERE status = 'open' AND ctrader_position_id IS NOT NULL
             GROUP BY ctrader_position_id
          )`
    ).all()
    const closeDupMon = db.prepare(`UPDATE monitored_positions SET status='closed' WHERE trade_id = ? AND status='active'`)
    // Duplicates are marked REJECTED, not closed: a 'closed' dup row with
    // net_pnl NULL gets the SAME broker P&L stamped onto it by pnl-backfill
    // (it matches by ctrader_position_id), so one real loss was counted once
    // per duplicate row — the owner saw 4 identical USDIDR lesson cards,
    // -$487.76 each, reading as a ~$2k loss that never happened. 'rejected'
    // rows are excluded from every closed-trade stat and from backfill.
    const rejectDup = db.prepare(
      `UPDATE trades SET status='rejected', closed_at = datetime('now'),
              close_reason = 'duplicate reconcile adoption — superseded by the newest row for this position'
        WHERE id = ? AND status = 'open'`
    )
    const tx = db.transaction(() => {
      for (const d of dups) {
        rejectDup.run(d.id)
        closeDupMon.run(d.id)
        dupsClosed.push(d)
      }
    })
    tx()
  } catch { /* dedup best-effort */ }

  // REPAIR historical duplicate-P&L garbage (idempotent): before the
  // 'rejected' change above, duplicate rows ended up status='closed' and
  // pnl-backfill stamped each with the SAME broker P&L — one real loss
  // counted N times in Performance. Any group of closed trades sharing one
  // ctrader_position_id with identical net_pnl keeps its ORIGINAL row (the
  // real adoption, MIN(id)) and rejects the rest, deleting their duplicate
  // postmortem/lesson cards. Partial closes are safe: the bot stamps those
  // on a single row, never as multiple rows per position id.
  const dupPnlRepaired = []
  try {
    const badRows = db.prepare(
      `SELECT t.id, t.symbol, t.ctrader_position_id FROM trades t
        WHERE t.status = 'closed' AND t.ctrader_position_id IS NOT NULL AND t.net_pnl IS NOT NULL
          AND t.id NOT IN (
            SELECT MIN(id) FROM trades
             WHERE status = 'closed' AND ctrader_position_id IS NOT NULL AND net_pnl IS NOT NULL
             GROUP BY ctrader_position_id, net_pnl
          )
          AND EXISTS (
            SELECT 1 FROM trades o
             WHERE o.ctrader_position_id = t.ctrader_position_id
               AND o.net_pnl = t.net_pnl AND o.status = 'closed' AND o.id < t.id
          )`
    ).all()
    const rejectRepair = db.prepare(
      `UPDATE trades SET status='rejected',
              close_reason = COALESCE(close_reason, '') || ' | repaired: duplicate row double-counting one broker P&L'
        WHERE id = ?`
    )
    const dropPm = db.prepare(`DELETE FROM trade_postmortems WHERE trade_id = ?`)
    const tx2 = db.transaction(() => {
      for (const r of badRows) {
        rejectRepair.run(r.id)
        try { dropPm.run(r.id) } catch { /* postmortems table may not exist yet */ }
        dupPnlRepaired.push(r)
      }
    })
    tx2()
    if (dupPnlRepaired.length > 0) {
      console.log(`[reconciler] repaired ${dupPnlRepaired.length} duplicate-P&L trade row(s): ${dupPnlRepaired.map(r => `${r.symbol}#${r.ctrader_position_id}`).join(', ')}`)
    }
  } catch { /* repair best-effort */ }

  const orphansClosed = []
  const openWithPosId = db.prepare(
    `SELECT id, symbol, ctrader_position_id FROM trades
      WHERE status = 'open' AND ctrader_position_id IS NOT NULL`
  ).all()
  const closeOrphanMon = db.prepare(
    `UPDATE monitored_positions SET status = 'closed' WHERE trade_id = ? AND status = 'active'`
  )
  for (const t of openWithPosId) {
    if (brokerIds.has(String(t.ctrader_position_id))) continue // still live at the broker
    closeTradeRow(db, t.id, { closeReason: 'stale reconcile: position not open at the broker (orphaned open row, never reconciled)' })
    closeOrphanMon.run(t.id)
    orphansClosed.push({ tradeId: t.id, symbol: t.symbol, positionId: t.ctrader_position_id })
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

  // Durable ledger of the broker's resting entry orders. These fill regardless
  // of the bot's scan/autotrade switches (owner: "even if ... OFF, these
  // pending orders will execute"), so record each one and its lifecycle
  // (working → gone) so a fill is tracked and the history survives a restart.
  const ordersGone = syncBrokerOrders(db, pendingOrders)

  return { newExternal, closedDetected, manualChanges, pendingOrders, orphansClosed, ordersGone, relinked, dupsClosed }
}

/**
 * Upsert the current resting entry orders into the broker_orders ledger and
 * mark any previously-working order that's no longer present as 'gone' (it
 * either filled or was cancelled — deal history distinguishes, but either way
 * it's no longer resting). Returns the ids that transitioned working → gone
 * this pass, so the caller can log/act on likely fills. Best-effort: a DB hiccup
 * never blocks reconciliation.
 */
export function syncBrokerOrders(db, pendingOrders = []) {
  try {
    const upsert = db.prepare(
      `INSERT INTO broker_orders
         (order_id, symbol, side, order_type, volume, limit_price, stop_price, sl, tp, label, is_bot, status, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', datetime('now'))
       ON CONFLICT(order_id) DO UPDATE SET
         symbol=excluded.symbol, side=excluded.side, order_type=excluded.order_type,
         volume=excluded.volume, limit_price=excluded.limit_price, stop_price=excluded.stop_price,
         sl=excluded.sl, tp=excluded.tp, label=excluded.label, is_bot=excluded.is_bot,
         status='working', last_seen=datetime('now'), gone_at=NULL`
    )
    const presentIds = []
    const tx = db.transaction(() => {
      for (const o of pendingOrders) {
        const id = String(o.orderId ?? '')
        if (!id) continue
        presentIds.push(id)
        upsert.run(
          id, o.symbolName || null, o.side || null, o.orderType || null,
          o.volume ?? o.volumeUnits ?? null, o.limitPrice ?? null, o.stopPrice ?? null,
          o.sl ?? null, o.tp ?? null, o.label || null, isOurs(o.label) ? 1 : 0,
        )
      }
    })
    tx()

    // Anything still 'working' but not in this snapshot has left the book.
    const wasWorking = db.prepare(`SELECT order_id FROM broker_orders WHERE status = 'working'`).all().map(r => String(r.order_id))
    const presentSet = new Set(presentIds)
    const gone = wasWorking.filter(id => !presentSet.has(id))
    if (gone.length) {
      const mark = db.prepare(`UPDATE broker_orders SET status='gone', gone_at=datetime('now') WHERE order_id = ? AND status='working'`)
      const tx2 = db.transaction(() => { for (const id of gone) mark.run(id) })
      tx2()
    }
    return gone
  } catch {
    return []
  }
}
