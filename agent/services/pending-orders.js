// ---------------------------------------------------------------------------
// agent/services/pending-orders.js — resting LIMIT orders at the fib 61.8%
// level, armed strictly per instrument×timeframe. The entire module is inert
// unless loop.js sees pending_mode_enabled === 'true' AND this function finds
// cells in pending_matrix_json — an empty matrix short-circuits before any
// broker call. Every placement, cancel, and veto lands in risk_events so the
// audit trail matches the market-order path.
//
// Dependency injection (deps.exec / deps.scan / deps.risk / deps.sizing)
// exists so the full lifecycle is testable against fakes; production callers
// pass nothing and get the real modules.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { readTradableUnion } from './watchlists.js'
import { tradePrice } from './alert-format.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { getActiveSessions } from '../lib/sessions.js'
import { normPosId } from '../lib/pos-id.js'

// cTrader relative SL/TP distances are in fixed 10^-5 points for every
// symbol — same constant loop.js uses for the market-order path.
const POINTS = 100000
const DEFAULT_EXPIRY_MINUTES = 24 * 60

// Fill-adoption marker. Appended as an EXTRA pipe segment to the structured
// label (parseLabel reads only the first 7 segments; isOurs stays true) —
// RECONCILE_RES positions carry tradeData.label but NOT the order comment,
// so the label is the only channel that survives order→position.
const PENDING_MARKER = 'pending-fib'
// cTrader hard label cap; trade-labels.js MAX_LABEL_LEN (90) + marker fits.
const BROKER_LABEL_MAX = 100

function log(...args) {
  console.log('[pending]', ...args)
}

async function defaultDeps(deps) {
  return {
    exec: deps.exec ?? await import('../lib/exec-engine.js'),
    scan: deps.scan ?? (await import('./fib-strategy.js')).scanPendingSetups,
    risk: deps.risk ?? await import('./risk.js'),
    sizing: deps.sizing ?? await import('../lib/lot-sizing.js'),
  }
}

// Broker position/order payloads nest most fields under tradeData; older
// fixtures and the cpp sidecar flatten them. Read both shapes.
function posField(p, key) {
  return p?.tradeData?.[key] ?? p?.[key]
}

/**
 * Mirror of loop.js's persistTrade transaction (trades + monitored_positions
 * in one atomic write) for a pending order that FILLED at the broker while
 * we weren't looking. Column set intentionally identical to loop.js so every
 * downstream analytics query treats these fills as first-class bot trades.
 */
function persistFilledTrade(db, row, pos) {
  const side = row.dir < 0 ? 'SELL' : 'BUY'
  const executionPrice = pos?.price ?? row.level
  const positionId = normPosId(pos?.positionId)
  const initialRisk = (executionPrice != null && row.sl != null)
    ? Math.abs(executionPrice - row.sl)
    : null
  const parsedLabel = parseLabel(posField(pos, 'label') || encodeLabel({
    source: 'autopilot',
    version: LABEL_VERSION,
    strategy: 'fib_618_fade',
    session: getActiveSessions()[0]?.label || 'Off',
    timeframe: row.timeframe || null,
  }))

  const persistTrade = db.transaction(() => {
    const tradeInsert = db.prepare(`
      INSERT INTO trades (
        symbol, side, entry_price, sl_price, tp_price, volume, opened_at,
        status, ctrader_position_id, analysis_id, strategy, conviction,
        label_raw, source, label_version, label_strategy, label_conviction,
        label_session, label_timeframe, label_regime
      ) VALUES (
        ?, ?, ?, ?, ?, ?, datetime('now'),
        'open', ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      row.symbol, side, executionPrice, row.sl ?? null, row.tp ?? null, row.volume ?? null,
      positionId, null, 'fib_618_fade', null,
      parsedLabel.raw, parsedLabel.source, parsedLabel.version,
      parsedLabel.strategy, parsedLabel.conviction, parsedLabel.session,
      parsedLabel.timeframe, parsedLabel.regime,
    )
    const tradeId = tradeInsert.lastInsertRowid

    db.prepare(`
      INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, invalidation_trigger, time_cap_at, strategy, source, label_raw, account_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      row.symbol,
      tradeId,
      side === 'BUY' ? 'long' : 'short',
      executionPrice,
      row.sl ?? null,
      row.tp ?? null,
      `Pending fib 61.8% limit filled at broker (order ${row.order_id})`,
      initialRisk,
      null,
      row.expires_at || null,
      'fib_618_fade',
      parsedLabel.source,
      parsedLabel.raw,
      getState(db, 'ctrader_account_id'),
    )

    return tradeId
  })

  return persistTrade()
}

/**
 * One pass of the pending-order lifecycle. Called from loop.js each cycle
 * (only when the mode is armed); always resolves — callers rely on the
 * loop-side try/catch for anything that still escapes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{host,clientId,clientSecret,accessToken,accountId}} creds
 * @param {Record<string, number>} symbolMap  SYMBOL → broker symbolId
 * @param {object} [deps]  test injection: { exec, scan, risk, sizing }
 */
export async function managePendingOrders(db, creds, symbolMap, deps = {}) {
  // Optional owner notification hook (Telegram while travelling) — must
  // never throw into the trading path.
  const notify = (text) => { try { deps.notify?.(text) } catch { /* best effort */ } }
  const { exec, scan, risk, sizing } = await defaultDeps(deps)

  let matrix = null
  try { matrix = JSON.parse(getState(db, 'pending_matrix_json') || 'null') } catch { matrix = null }
  if (!matrix || typeof matrix !== 'object' || Object.keys(matrix).length === 0) {
    return { skipped: 'no matrix' }
  }

  const summary = { placed: 0, cancelled: 0, filled: 0, expired: 0, skipped: [] }

  // 2. RECONCILE — broker truth for both resting orders and open positions.
  const rec = await exec.reconcile(creds)
  const brokerOrders = rec?.order || []
  const brokerPositions = rec?.position || []
  const brokerOrderIds = new Set(brokerOrders.map(o => String(o.orderId)))

  const updateStatus = db.prepare(`UPDATE pending_orders SET status = ?, note = ? WHERE id = ?`)
  // Exclude closed-market limits (note 'pending-closed') — they share this
  // table but are reconciled by the general reconciler (autopilot-label
  // adoption), never by this fib-specific pass. Everything else (fib rows,
  // legacy null-note rows) is handled here exactly as before.
  let working = db.prepare(`SELECT * FROM pending_orders WHERE status = 'working' AND (note IS NULL OR note != 'pending-closed')`).all()

  // Positions already persisted as trades must never be adopted twice — a
  // second stale row on the same symbol (pre-restart leftovers, expiry racing
  // a fill) would otherwise double-book the same broker position.
  const adoptedIds = new Set(
    db.prepare(`SELECT ctrader_position_id AS pid FROM trades WHERE ctrader_position_id IS NOT NULL`)
      .all().map(r => String(r.pid)),
  )

  // 3. SYNC — a working row whose order vanished from the broker either
  // FILLED (a PENDING_MARKER position on the same symbol/side now exists) or
  // is GONE (expired/cancelled server-side). The marker lives in the LABEL
  // because RECONCILE_RES positions expose tradeData.label but not the order
  // comment; matching also requires side and not-already-adopted so owner
  // manual trades and earlier fills can never be ingested.
  for (const row of working) {
    if (row.order_id && brokerOrderIds.has(String(row.order_id))) continue
    const symbolId = symbolMap[row.symbol]
    const pos = brokerPositions.find(p => {
      const label = String(posField(p, 'label') || posField(p, 'comment') || '')
      const sid = posField(p, 'symbolId')
      const bSide = posField(p, 'tradeSide')
      // Some reconcile payloads omit tradeSide entirely — only reject on a
      // KNOWN opposite side; the marker+symbol+unadopted gates still hold.
      const sideMatch = bSide == null ||
        (row.dir >= 0 ? (bSide === 'BUY' || bSide === 1) : (bSide === 'SELL' || bSide === 2))
      return label.includes(PENDING_MARKER) &&
        symbolId != null && Number(sid) === Number(symbolId) &&
        sideMatch &&
        p.positionId != null && !adoptedIds.has(String(p.positionId))
    })
    if (pos) {
      persistFilledTrade(db, row, pos)
      adoptedIds.add(String(pos.positionId))
      updateStatus.run('filled', `filled: position ${pos.positionId}`, row.id)
      notify(`✅ pending FILLED: ${row.symbol} ${row.timeframe} @ level ${row.level} — now a live position (${pos.positionId})`)
      summary.filled++
      log(`${row.symbol} ${row.timeframe}: order ${row.order_id} filled → position ${pos.positionId}`)
    } else {
      updateStatus.run('expired', 'gone at broker (expired or cancelled remotely)', row.id)
      notify(`⌛ pending expired: ${row.symbol} ${row.timeframe}`)
      summary.expired++
      log(`${row.symbol} ${row.timeframe}: order ${row.order_id} gone at broker → expired`)
    }
  }
  working = working.filter(r => r.order_id && brokerOrderIds.has(String(r.order_id)))

  // Single scan pass feeds both invalidation (lastClose) and new setups.
  const scanRes = await scan(creds, symbolMap, matrix)
  const setups = Array.isArray(scanRes) ? scanRes : (scanRes?.setups || [])
  const lastClose = (!Array.isArray(scanRes) && scanRes?.lastClose) || {}

  // 4. INVALIDATION — a CLOSED bar beyond the row's SL means the level the
  // resting order was priced off no longer exists; cancel before it can
  // fill into an already-invalidated thesis.
  const stillWorking = []
  for (const row of working) {
    const close = lastClose[row.symbol]
    const breached = close != null && row.sl != null &&
      (row.dir >= 0 ? close < row.sl : close > row.sl)
    if (!breached) { stillWorking.push(row); continue }
    try {
      await exec.cancelOrder(creds, { orderId: row.order_id })
      updateStatus.run('cancelled', 'invalidated', row.id)
      notify(`❎ pending cancelled (setup invalidated): ${row.symbol} ${row.timeframe}`)
      summary.cancelled++
      risk.persistRiskEvent(
        db,
        { symbol: row.symbol, side: row.dir >= 0 ? 'BUY' : 'SELL', entry: row.level, sl: row.sl, strategy: 'fib_618_fade' },
        { approved: false, veto_reason: `pending_invalidated: close ${close} beyond SL ${row.sl} — order ${row.order_id} cancelled` },
      )
      log(`${row.symbol} ${row.timeframe}: invalidated (close ${close} vs SL ${row.sl}) — cancelled ${row.order_id}`)
    } catch (err) {
      // Leave the row working; next reconcile pass settles the truth.
      log(`${row.symbol}: cancel FAILED for ${row.order_id} — ${err.message}`)
      stillWorking.push(row)
    }
  }

  // 4b. PAUSE DISPOSITION (A3) — what happens to this account's resting ENTRY
  // orders now that it is no longer entering. Runs AFTER the level-breach
  // invalidation above, so a breached row is already gone and is not counted
  // twice. Protective SL/TP orders are untouched: this pass only ever sees
  // rows from pending_orders, the bot's own resting-entry ledger.
  const dispositionActions = []
  try {
    const { planPendingDisposition } = await import('./pause-disposition.js')
    const { enabledStrategies } = await import('./strategies.js')
    let armedKeys = null
    try { armedKeys = enabledStrategies(db, getState).map(x => x.key) } catch { armedKeys = null }
    const planned = planPendingDisposition(db, {
      accountId: creds?.accountId,
      rows: stillWorking,
      armedStrategies: armedKeys,
    })
    summary.disposition = planned.disposition
    for (const act of planned.actions) {
      if (act.action !== 'cancel') continue
      try {
        if (act.orderId) await exec.cancelOrder(creds, { orderId: act.orderId })
        updateStatus.run('cancelled', `pause:${act.signal}`, act.id)
        summary.cancelled++
        dispositionActions.push(act)
        // Written down, per the plan: tomorrow "why didn't that trigger?" has
        // an answer naming the signal and the price it was resting at.
        try {
          const { recordDecision } = await import('./decision-log.js')
          recordDecision(db, {
            accountId: creds?.accountId ?? null,
            symbol: act.symbol,
            timeframe: null,
            strategy: null,
            stage: 'pause_disposition',
            decision: 'skip',
            reason: `${act.signal}: ${act.reason}`,
            detail: { orderId: act.orderId, level: act.level, deadlineAt: act.deadlineAt, deadlineSource: act.deadlineSource },
          })
        } catch { /* provenance must never block trading */ }
        notify(`⏸ pending cancelled on pause (${act.signal}): ${act.symbol} @ ${act.level ?? '—'}`)
        log(`${act.symbol}: pause disposition ${planned.disposition} → cancelled ${act.orderId} (${act.signal})`)
      } catch (err) {
        // Leave it working; the next pass settles it. A failed cancel must
        // never be recorded as a cancel.
        log(`${act.symbol}: pause cancel FAILED for ${act.orderId} — ${err.message}`)
      }
    }
  } catch (err) {
    log(`pause disposition pass skipped — ${err.message}`)
  }
  const cancelledByPause = new Set(dispositionActions.map(a => a.id))
  const afterDisposition = stillWorking.filter(r => !cancelledByPause.has(r.id))

  // 5. NEW SETUPS — one working order per symbol, hard cap, plus a TOTAL
  // resting-order cap across BOTH bot placement paths (this one and the
  // closed-market limits) — 82 resting orders helped drive a margin call
  // (owner-approved build 2, 2026-07-27). Every resting order is potential
  // exposure the moment it fills; the cap bounds worst-case fill exposure.
  // A3: every disposition agrees that a paused account creates NOTHING new —
  // only the fate of its existing orders differs. Checked before any sizing or
  // risk work, so a paused account costs nothing per cycle.
  {
    const { mayArmPending } = await import('./pause-disposition.js')
    const arm = mayArmPending(db, creds?.accountId)
    if (!arm.ok) {
      summary.skipped.push(arm.reason)
      return summary
    }
  }

  const symbolsWithWorking = new Set(afterDisposition.map(r => r.symbol))
  const riskCfg = risk.loadRiskConfig(db)
  const maxTotal = Math.max(1, Number(process.env.PENDING_MAX_TOTAL || 20))
  let totalWorking = db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working'`).get()?.n || 0

  for (const { symbol, timeframe, signal } of setups) {
    if (totalWorking >= maxTotal) {
      summary.skipped.push(`${symbol}: pending cap — ${totalWorking}/${maxTotal} resting orders already working`)
      continue
    }
    if (symbolsWithWorking.has(symbol)) {
      summary.skipped.push(`${symbol}: working order exists`)
      continue
    }
    const symbolId = symbolMap[symbol]
    if (!symbolId) {
      summary.skipped.push(`${symbol}: symbolId unknown`)
      continue
    }

    const side = signal.bias === 'short' ? 'SELL' : 'BUY'
    // Dynamic sizing: a resting order sizes exactly like a market order —
    // pure risk-based (uncapped) unless the watchlist pins a per-symbol
    // Max lots. The old hardcoded requestedVolume=minLotSize acted as a CAP
    // in the sizing rule, baking every pending order to 0.01 (owner: "why
    // is my lot still baked 0.01 … where is the dynamic sizing?").
    let wlCap = null
    try {
      const item = readTradableUnion(db).find(w => w.symbol === String(symbol).toUpperCase())
      const mv = Number(item?.maxVolume)
      if (Number.isFinite(mv) && mv > 0) wlCap = mv
    } catch { /* no watchlist cap */ }
    const proposal = {
      symbol,
      side,
      entry: signal.entry,
      sl: signal.sl,
      tp1: signal.tp1,
      requestedVolume: wlCap,
      strategy: 'fib_618_fade',
      conviction: signal.conviction ?? null,
      timeframe,
      source: 'pending',
    }
    const riskResult = risk.evaluateTrade(db, proposal, riskCfg)
    const riskEventId = risk.persistRiskEvent(db, proposal, riskResult) // §70.9 lineage
    if (!riskResult.approved) {
      summary.skipped.push(`${symbol}: risk veto — ${riskResult.veto_reason}`)
      continue
    }
    const volLots = riskResult.adjusted_volume ?? proposal.requestedVolume ?? riskCfg.minLotSize ?? 0.01

    let priceDigits = 5
    let sized
    try {
      const meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      priceDigits = meta.digits ?? 5
      sized = sizing.lotsToVolume(volLots, meta)
      if (sized.belowMin) {
        const reason = `below_min_volume: ${volLots} lots (${sized.volume}) < broker minimum ${meta.minVolume}`
        risk.persistPostApprovalVeto(db, proposal, reason)
        summary.skipped.push(`${symbol}: ${reason}`)
        continue
      }
    } catch (err) {
      risk.persistPostApprovalVeto(db, proposal, `sizing_failed: ${err.message}`)
      summary.skipped.push(`${symbol}: sizing failed — ${err.message}`)
      continue
    }

    const slDistance = signal.sl != null && signal.entry != null ? Math.abs(signal.entry - signal.sl) : null
    const tpDistance = signal.tp1 != null && signal.entry != null ? Math.abs(signal.tp1 - signal.entry) : null
    const expiryMinutes = Number.isFinite(signal.time_cap_minutes) && signal.time_cap_minutes > 0
      ? signal.time_cap_minutes
      : DEFAULT_EXPIRY_MINUTES
    const expiresAtMs = Date.now() + expiryMinutes * 60_000

    const baseLabel = encodeLabel({
      source: 'autopilot',
      version: LABEL_VERSION,
      strategy: 'fib_618_fade',
      conviction: convictionBucket(signal.conviction),
      session: getActiveSessions()[0]?.label || 'Off',
      timeframe: timeframe || null,
      regime: null,
    })
    // Marker MUST survive truncation — it is the only fill-adoption key.
    const label = baseLabel.length + 1 + PENDING_MARKER.length <= BROKER_LABEL_MAX
      ? `${baseLabel}|${PENDING_MARKER}`
      : `${baseLabel.slice(0, BROKER_LABEL_MAX - PENDING_MARKER.length - 1)}|${PENDING_MARKER}`

    const orderPayload = {
      ctidTraderAccountId: parseInt(creds.accountId),
      symbolId: parseInt(symbolId),
      orderType: 'LIMIT',
      tradeSide: side,
      volume: sized.volume,
      // Raw fib levels carry float noise (1.33383162…) — the broker rejects
      // prices beyond the symbol's precision (owner hit INVALID_REQUEST live).
      // Owner rule: friendly rounding (2-3dp, indices to tens) capped by the
      // broker's own digits — never rejected, never falsely precise.
      limitPrice: tradePrice(signal.entry, priceDigits),
      // Snapped to the symbol's digits, same as limitPrice above — raw
      // 1/100000 rounding is finer than 2-3 digit symbols allow and the
      // broker rejects it. Fallback keeps old behaviour for injected test
      // sizing mocks that don't provide relativePoints.
      ...(slDistance ? { relativeStopLoss: (sizing.relativePoints ?? ((d) => Math.round(d * POINTS)))(slDistance, priceDigits) } : {}),
      ...(tpDistance ? { relativeTakeProfit: (sizing.relativePoints ?? ((d) => Math.round(d * POINTS)))(tpDistance, priceDigits) } : {}),
      ...(await import('../lib/order-protection.js')).stopTriggerField(riskCfg),
      expirationTimestamp: expiresAtMs,
      label,
      comment: 'pending-fib',
    }

    try {
      const execEvent = await exec.placeOrder(creds, orderPayload)
      const orderId = execEvent?.order?.orderId ?? execEvent?.orderId ?? null
      db.prepare(`
        INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, risk_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)
      `).run(
        symbol,
        timeframe || null,
        orderId != null ? String(orderId) : null,
        side === 'BUY' ? 1 : -1,
        signal.entry ?? null,
        signal.sl ?? null,
        signal.tp1 ?? null,
        volLots,
        new Date(expiresAtMs).toISOString(),
        'pending-fib',
        riskEventId ?? null,
      )
      notify(`⏳ pending PLACED: ${symbol} ${timeframe} — limit @ ${orderPayload.limitPrice}, SL ${signal.sl}, TP ${signal.tp1}`)
      symbolsWithWorking.add(symbol)
      summary.placed++
      totalWorking++
      risk.persistRiskEvent(db, proposal, {
        approved: true,
        veto_reason: null,
        checks: { pending_order_placed: true, orderId, limitPrice: signal.entry, expiresAt: new Date(expiresAtMs).toISOString() },
      })
      log(`${symbol} ${timeframe}: LIMIT ${side} placed @ ${signal.entry} orderId=${orderId}`)
    } catch (err) {
      risk.persistPostApprovalVeto(db, proposal, `pending_order_failed: ${err.message}`)
      summary.skipped.push(`${symbol}: place failed — ${err.message}`)
      log(`${symbol}: LIMIT placement FAILED — ${err.message}`)
    }
  }

  summary.summary = `placed=${summary.placed} cancelled=${summary.cancelled} filled=${summary.filled} expired=${summary.expired}${summary.skipped.length ? ` skipped=${summary.skipped.length}` : ''}`
  return summary
}

/**
 * Owner-triggered broker cleanup: cancel BOT-placed resting orders the local
 * ledger no longer recognises. The pre-volume DB wipes left the broker
 * holding duplicated 'pending-fib' limit orders (owner saw 21 resting vs 9
 * armed combos) that no pending_orders row tracks — nothing would ever
 * cancel or adopt them.
 *
 * Safety rules, in order:
 * - ONLY orders whose label/comment carries PENDING_MARKER are candidates —
 *   the owner's own manual cTrader orders are untouchable by construction.
 * - An order referenced by a local status='working' row is KEPT (that is
 *   the live, managed set).
 * - Everything else bot-marked is cancelled, one by one; per-order failures
 *   are reported, never thrown.
 *
 * @returns {{brokerOrders:number, botMarked:number, kept:number,
 *            manual:number, cancelled:Array, failures:Array}}
 */
export async function reconcileBrokerPendingOrders(db, creds, deps = {}) {
  const { exec } = await defaultDeps(deps)
  // The loop's reconcile phase already holds this cycle's broker order
  // snapshot — passing it via deps.brokerOrders skips a second reconcile
  // round-trip (each one is a fresh WS connection).
  const brokerOrders = deps.brokerOrders ?? ((await exec.reconcile(creds))?.order || [])

  const known = new Set(
    db.prepare(`SELECT order_id FROM pending_orders WHERE status = 'working' AND order_id IS NOT NULL`)
      .all().map(r => String(r.order_id)),
  )

  // Both bot markers, not just pending-fib: closed-market limits rest with
  // 'pending-closed' and were previously miscounted as the owner's MANUAL
  // orders here — so their orphans/duplicates were never cleaned by anything
  // (owner-approved build 2, 2026-07-27: "i see duplication", 82 resting).
  const BOT_MARKERS = [PENDING_MARKER, 'pending-closed']
  const isBotOrder = (label) => BOT_MARKERS.some(m => label.includes(m))

  const out = { brokerOrders: brokerOrders.length, botMarked: 0, kept: 0, manual: 0, cancelled: [], failures: [] }
  const markCancelled = db.prepare(`UPDATE pending_orders SET status = 'cancelled' WHERE order_id = ?`)
  const cancelOne = async (orderId, why, symbolId) => {
    try {
      await exec.cancelOrder(creds, { orderId })
      if (orderId != null) markCancelled.run(String(orderId))
      out.cancelled.push({ orderId: orderId != null ? String(orderId) : null, symbolId: symbolId ?? null, why })
      log(`broker cleanup: cancelled pending order ${orderId} (${why})`)
    } catch (err) {
      out.failures.push({ orderId: orderId != null ? String(orderId) : null, error: err.message })
      log(`broker cleanup: cancel FAILED for ${orderId} — ${err.message}`)
    }
  }

  const kept = []
  for (const o of brokerOrders) {
    const orderId = o?.orderId ?? posField(o, 'orderId')
    const label = String(posField(o, 'label') || posField(o, 'comment') || o?.comment || '')
    if (!isBotOrder(label)) { out.manual++; continue }
    out.botMarked++
    if (orderId != null && known.has(String(orderId))) { out.kept++; kept.push(o); continue }
    await cancelOne(orderId, 'not in local ledger', posField(o, 'symbolId'))
  }

  // DUPLICATE COLLAPSE among the ledger-known survivors: two bot orders on
  // the same symbol+side whose entry prices sit within 0.01% of each other
  // are one intended order placed twice (the desync signature of a hung
  // pending phase re-placing after its ledger write was abandoned). Keep the
  // newest, cancel the rest — the local rows of the cancelled ones flip to
  // 'cancelled' so the ledger re-syncs instead of re-desyncing.
  const groups = new Map()
  for (const o of kept) {
    const sid = posField(o, 'symbolId') ?? '?'
    const side = posField(o, 'tradeSide') ?? '?'
    const key = `${sid}|${side}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(o)
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const price = (o) => Number(o?.limitPrice ?? o?.stopPrice ?? NaN)
    const ts = (o) => Number(o?.utcLastUpdateTimestamp ?? 0)
    const sorted = [...list].sort((a, b) => ts(b) - ts(a)) // newest first
    const survivors = []
    for (const o of sorted) {
      const p = price(o)
      const dup = Number.isFinite(p) && survivors.some(s => {
        const sp = price(s)
        return Number.isFinite(sp) && Math.abs(sp - p) <= Math.abs(sp) * 1e-4
      })
      if (!dup) { survivors.push(o); continue }
      out.kept--
      await cancelOne(o?.orderId ?? posField(o, 'orderId'), 'duplicate of a newer resting order', posField(o, 'symbolId'))
    }
  }
  return out
}
