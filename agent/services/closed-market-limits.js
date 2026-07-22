// ---------------------------------------------------------------------------
// agent/services/closed-market-limits.js — resting LIMIT orders for setups
// that fire while the symbol's market is CLOSED (weekend FX/metals, off-hours
// stocks/indices) or on a slow higher timeframe.
//
// Owner decision (Option A + on by default): when a signal is deferred for a
// closed market, place a REAL broker limit order at the setup's entry — locked
// in, visible on the desk, filling automatically the instant price trades
// there — INSTEAD of the invisible internal re-fire queue. One order per
// symbol, carrying the setup's SL/TP, expiring so a stale idea never sits
// forever. The limit order is the single source of the fill (no double-fill).
//
// Every order goes through the SAME risk gate as a market order (sizing, R:R,
// exposure, daily-loss), so a closed-market limit can never bypass risk. The
// label is autopilot-sourced, so when it fills the reconciler adopts the
// position and the normal monitor manages it.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { encodeLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { tradePrice } from './alert-format.js'
import { getActiveSessions } from '../lib/sessions.js'
import { expiryMsFor } from './pending-signals.js'

export const DEFAULT_CLOSED_MARKET_LIMITS = {
  on: true, // owner: on by default — closed-market setups get locked in
}

export function loadClosedMarketLimitsConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'closed_market_limits_json') || 'null')
    return { ...DEFAULT_CLOSED_MARKET_LIMITS, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_CLOSED_MARKET_LIMITS }
  }
}

/**
 * Build the cTrader LIMIT order payload. Pure/testable — the price is snapped
 * to the symbol's digits (raw levels carry float noise the broker rejects) and
 * SL/TP ride as relative point distances, same as the market-order path.
 */
export function buildLimitPayload({ accountId, symbolId, side, volume, entry, sl, tp, digits, expiresAtMs, label, relativePoints }) {
  const slDistance = sl != null && entry != null ? Math.abs(entry - sl) : null
  const tpDistance = tp != null && entry != null ? Math.abs(tp - entry) : null
  return {
    ctidTraderAccountId: parseInt(accountId),
    symbolId: parseInt(symbolId),
    orderType: 'LIMIT',
    tradeSide: side,
    volume,
    limitPrice: tradePrice(entry, digits),
    ...(slDistance ? { relativeStopLoss: relativePoints(slDistance, digits) } : {}),
    ...(tpDistance ? { relativeTakeProfit: relativePoints(tpDistance, digits) } : {}),
    expirationTimestamp: expiresAtMs,
    label,
    comment: 'pending-closed',
  }
}

/**
 * Retire stale closed-market-limit rows independently of a fresh signal ever
 * recurring on that symbol (owner: "pending order lapse more than a day" —
 * traced to a real gap). Before this, a `pending-closed` row's ONLY exit was
 * placeClosedMarketLimit() re-running for that EXACT symbol and finding its
 * own expiry passed; pending-orders.js's fib sweep explicitly excludes these
 * rows (see its comment), and the general reconciler's syncBrokerOrders()
 * only updates the separate broker_orders table, never writes back to
 * pending_orders. So a row whose order was rejected, cancelled, or expired at
 * the broker — or whose placeOrder call never even returned an order_id —
 * could sit "working" forever if that symbol just didn't signal again.
 *
 * broker_orders is the authoritative live-broker snapshot (refreshed every
 * reconcile, regardless of which module placed the order), so this is a pure
 * DB-only reconciliation against it — no network call of its own.
 *
 * @returns {{ stillWorking:number, filled:number, expired:number }}
 */
export function reconcileStaleClosedMarketLimits(db, { nowMs = Date.now() } = {}) {
  const rows = db.prepare(
    `SELECT * FROM pending_orders WHERE status = 'working' AND note = 'pending-closed'`
  ).all()

  let stillWorking = 0, filled = 0, expired = 0
  const markFilled = db.prepare(`UPDATE pending_orders SET status = 'filled', note = ? WHERE id = ?`)
  const markExpired = db.prepare(`UPDATE pending_orders SET status = 'expired', note = ? WHERE id = ?`)

  for (const row of rows) {
    if (row.order_id) {
      const broker = db.prepare(`SELECT status FROM broker_orders WHERE order_id = ?`).get(String(row.order_id))
      if (broker?.status === 'working') { stillWorking++; continue } // genuinely still resting — leave it
      // Left the broker's book (filled, rejected, cancelled, or expired
      // there) — best-effort check for an adopted trade on the same symbol
      // opened since this order was placed; otherwise it never filled.
      const adopted = db.prepare(
        `SELECT id FROM trades WHERE symbol = ? AND opened_at >= ? ORDER BY opened_at ASC LIMIT 1`
      ).get(row.symbol, row.placed_at || '1970-01-01')
      if (adopted) {
        markFilled.run('pending-closed: adopted as trade', row.id)
        filled++
      } else {
        markExpired.run('pending-closed: gone at broker, no fill adopted', row.id)
        expired++
      }
      continue
    }
    // Never got an order_id back at all (placeOrder response gap, or the
    // call itself never truly succeeded) — only give up once its OWN
    // expiry has passed; too early to judge otherwise.
    if (row.expires_at && new Date(row.expires_at).getTime() < nowMs) {
      markExpired.run('pending-closed: no broker order_id and expiry passed', row.id)
      expired++
    } else {
      stillWorking++
    }
  }
  return { stillWorking, filled, expired }
}

/**
 * Place (or refresh) a resting limit order for a signal deferred because its
 * market is closed. Returns a small status object; never throws.
 *
 * @param {object} creds - { host, clientId, clientSecret, accessToken, accountId }
 * @param {object} synth - the signal (entry/sl/tp1/tp2/strategy/timeframe/…)
 */
export async function placeClosedMarketLimit(db, creds, symbol, synth, opts = {}) {
  const cfg = loadClosedMarketLimitsConfig(db)
  if (!cfg.on) return { skipped: 'off' }
  if (synth?.entry == null) return { skipped: 'no_entry' }

  const risk = opts.risk ?? await import('./risk.js')
  const sizing = opts.sizing ?? await import('../lib/lot-sizing.js')
  const exec = opts.exec ?? await import('../lib/exec-engine.js')
  const notify = opts.notify ?? (() => {})
  const nowMs = opts.now ?? Date.now()

  // Retire our own working rows whose broker expiry has passed, so idempotency
  // below doesn't wrongly treat an expired order as still resting.
  db.prepare(
    `UPDATE pending_orders SET status = 'expired'
     WHERE note = 'pending-closed' AND status = 'working'
       AND expires_at IS NOT NULL AND expires_at < ?`
  ).run(new Date(nowMs).toISOString())

  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
  const symbolMapJson = getState(db, 'symbol_id_map')
  const symbolMap = symbolMapJson ? JSON.parse(symbolMapJson) : {}
  const symbolId = symbolMap[symbol.toUpperCase()]
  if (!symbolId) return { skipped: 'symbol_unknown' }

  // Idempotency FIRST (before any WS call): if a limit already rests at
  // essentially this entry, leave it — this runs every loop while the market
  // is closed and must not cancel/replace (and re-pay sizing) each cycle.
  const working = db.prepare(
    `SELECT order_id, level FROM pending_orders WHERE symbol = ? AND status = 'working' AND note = 'pending-closed'`
  ).all(symbol)
  const tol = Math.abs(synth.entry) * 1e-4
  const alreadyResting = working.find(r => r.level != null && Math.abs(r.level - synth.entry) <= tol)
  if (alreadyResting) return { skipped: 'already_working', orderId: alreadyResting.order_id }

  // SAME risk gate as a market order — a resting limit can't bypass risk.
  const proposal = {
    symbol, side,
    entry: synth.entry ?? null, sl: synth.sl ?? null,
    tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
    requestedVolume: opts.requestedVolume ?? null,
    strategy: synth.strategy || null,
    conviction: synth.overall_conviction ?? null,
    source: 'closed_market_limit',
  }
  const riskCfg = risk.loadRiskConfig(db)
  const riskResult = risk.evaluateTrade(db, proposal, riskCfg)
  risk.persistRiskEvent(db, proposal, riskResult)
  if (!riskResult.approved) return { skipped: 'risk_veto', reason: riskResult.veto_reason }

  const volLots = riskResult.adjusted_volume
  let sized, digits = 5
  try {
    const meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
    digits = meta.digits ?? 5
    sized = sizing.lotsToVolume(volLots, meta)
    if (sized.belowMin) {
      risk.persistRiskEvent(db, proposal, { approved: false, veto_reason: `below_min_volume: ${volLots} lots` })
      return { skipped: 'below_min_volume' }
    }
  } catch (err) {
    return { skipped: 'sizing_failed', reason: err.message }
  }

  // The level moved (fresher zone) — cancel the stale working order(s) for this
  // symbol before resting a new one, so there's never more than one.
  for (const row of working) {
    if (row.order_id == null) continue
    try { await exec.cancelOrder(creds, { orderId: row.order_id }) } catch { /* already gone */ }
    db.prepare(`UPDATE pending_orders SET status = 'cancelled' WHERE order_id = ?`).run(row.order_id)
  }

  const label = encodeLabel({
    source: 'autopilot',
    version: LABEL_VERSION,
    strategy: synth.strategy || 'other',
    conviction: convictionBucket(synth.overall_conviction),
    session: getActiveSessions()[0]?.label || 'Off',
    timeframe: synth.timeframe || null,
    regime: null,
  })
  const expiresAtMs = nowMs + expiryMsFor(synth.timeframe)
  const payload = buildLimitPayload({
    accountId: creds.accountId, symbolId, side, volume: sized.volume,
    entry: synth.entry, sl: synth.sl, tp: synth.tp1, digits, expiresAtMs, label,
    relativePoints: sizing.relativePoints ?? ((d, dg) => Math.round(d * Math.pow(10, dg))),
  })

  try {
    const ev = await exec.placeOrder(creds, payload)
    const orderId = ev?.order?.orderId ?? ev?.orderId ?? null
    db.prepare(`
      INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', 'pending-closed', ?)
    `).run(
      symbol, synth.timeframe || null, orderId != null ? String(orderId) : null,
      side === 'BUY' ? 1 : -1, synth.entry ?? null, synth.sl ?? null, synth.tp1 ?? null,
      volLots, new Date(expiresAtMs).toISOString(), synth.strategy || null
    )
    risk.persistRiskEvent(db, proposal, {
      approved: true, veto_reason: null,
      checks: { closed_market_limit_placed: true, orderId, limitPrice: payload.limitPrice, expiresAt: new Date(expiresAtMs).toISOString() },
    })
    notify(`⏳ Closed-market LIMIT placed: ${symbol} ${synth.timeframe || ''} ${side} @ ${payload.limitPrice}, SL ${synth.sl}, TP ${synth.tp1} — fills at open`)
    return { placed: true, orderId, limitPrice: payload.limitPrice, expiresAt: new Date(expiresAtMs).toISOString() }
  } catch (err) {
    risk.persistRiskEvent(db, proposal, { approved: false, veto_reason: `closed_market_limit_failed: ${err.message}` })
    return { skipped: 'place_failed', reason: err.message }
  }
}
