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
import { tradePrice } from './alert-format.js'
import { encodeLabel, parseLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { getActiveSessions } from '../lib/sessions.js'

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
  const positionId = pos?.positionId != null ? String(pos.positionId) : null
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
  let working = db.prepare(`SELECT * FROM pending_orders WHERE status = 'working'`).all()

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

  // 5. NEW SETUPS — one working order per symbol, hard cap.
  const symbolsWithWorking = new Set(stillWorking.map(r => r.symbol))
  const riskCfg = risk.loadRiskConfig(db)

  for (const { symbol, timeframe, signal } of setups) {
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
    const proposal = {
      symbol,
      side,
      entry: signal.entry,
      sl: signal.sl,
      tp1: signal.tp1,
      requestedVolume: riskCfg.minLotSize || 0.01,
      strategy: 'fib_618_fade',
      conviction: signal.conviction ?? null,
      timeframe,
    }
    const riskResult = risk.evaluateTrade(db, proposal, riskCfg)
    risk.persistRiskEvent(db, proposal, riskResult)
    if (!riskResult.approved) {
      summary.skipped.push(`${symbol}: risk veto — ${riskResult.veto_reason}`)
      continue
    }
    const volLots = riskResult.adjusted_volume ?? proposal.requestedVolume

    let priceDigits = 5
    let sized
    try {
      const meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      priceDigits = meta.digits ?? 5
      sized = sizing.lotsToVolume(volLots, meta)
      if (sized.belowMin) {
        const reason = `below_min_volume: ${volLots} lots (${sized.volume}) < broker minimum ${meta.minVolume}`
        risk.persistRiskEvent(db, proposal, { approved: false, veto_reason: reason })
        summary.skipped.push(`${symbol}: ${reason}`)
        continue
      }
    } catch (err) {
      risk.persistRiskEvent(db, proposal, { approved: false, veto_reason: `sizing_failed: ${err.message}` })
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
      ...(slDistance ? { relativeStopLoss: Math.round(slDistance * POINTS) } : {}),
      ...(tpDistance ? { relativeTakeProfit: Math.round(tpDistance * POINTS) } : {}),
      expirationTimestamp: expiresAtMs,
      label,
      comment: 'pending-fib',
    }

    try {
      const execEvent = await exec.placeOrder(creds, orderPayload)
      const orderId = execEvent?.order?.orderId ?? execEvent?.orderId ?? null
      db.prepare(`
        INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?)
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
      )
      notify(`⏳ pending PLACED: ${symbol} ${timeframe} — limit @ ${orderPayload.limitPrice}, SL ${signal.sl}, TP ${signal.tp1}`)
      symbolsWithWorking.add(symbol)
      summary.placed++
      risk.persistRiskEvent(db, proposal, {
        approved: true,
        veto_reason: null,
        checks: { pending_order_placed: true, orderId, limitPrice: signal.entry, expiresAt: new Date(expiresAtMs).toISOString() },
      })
      log(`${symbol} ${timeframe}: LIMIT ${side} placed @ ${signal.entry} orderId=${orderId}`)
    } catch (err) {
      risk.persistRiskEvent(db, proposal, { approved: false, veto_reason: `pending_order_failed: ${err.message}` })
      summary.skipped.push(`${symbol}: place failed — ${err.message}`)
      log(`${symbol}: LIMIT placement FAILED — ${err.message}`)
    }
  }

  summary.summary = `placed=${summary.placed} cancelled=${summary.cancelled} filled=${summary.filled} expired=${summary.expired}${summary.skipped.length ? ` skipped=${summary.skipped.length}` : ''}`
  return summary
}
