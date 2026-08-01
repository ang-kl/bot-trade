// Set/replace the broker-native SL and/or TP on ONE open position — the one
// piece of logic behind both POST /actions/position-protect and the Telegram
// "Set TP" inline button (owner 01-08: the targetless alert should carry a
// one-tap fix, not just instructions to go run a curl).
//
// Extracted from routes/actions.js verbatim so the two entry points cannot
// drift: same amend call, same book update, same position_events trail.
import { recordPositionEvent } from './position-events.js'

/**
 * @param {object} db     better-sqlite3 handle
 * @param {object} creds  getCtraderCreds(db) result (caller checks .ready)
 * @param {{positionId: string|number, sl?: number, tp?: number, source?: string}} args
 * @param {{amend?: Function}} deps  injectable for tests
 * @returns {{ok: true, positionId, sl: number|null, tp: number|null}}
 * @throws on broker refusal — callers translate to their own surface
 */
export async function protectPosition(db, creds, { positionId, sl, tp, source = 'manual' }, deps = {}) {
  if (!positionId) throw new Error('positionId is required')
  const amend = deps.amend ?? (await import('../lib/exec-engine.js')).amendPosition
  const args = { positionId: parseInt(positionId) }
  if (Number(sl) > 0) args.stopLoss = Number(sl)
  if (Number(tp) > 0) args.takeProfit = Number(tp)
  if (args.stopLoss == null && args.takeProfit == null) {
    throw new Error('sl or tp (absolute price) is required')
  }
  const before = db.prepare(
    `SELECT mp.id, mp.trade_id, mp.account_id, mp.symbol, mp.current_sl, mp.current_tp
       FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
      WHERE t.ctrader_position_id = ? AND mp.status = 'active'`
  ).get(String(positionId)) || null
  await amend(creds, args)
  db.prepare(
    "UPDATE monitored_positions SET current_sl = COALESCE(?, current_sl), current_tp = COALESCE(?, current_tp) WHERE trade_id IN (SELECT id FROM trades WHERE ctrader_position_id = ?) AND status = 'active'"
  ).run(args.stopLoss ?? null, args.takeProfit ?? null, String(positionId))
  if (before && args.stopLoss != null) {
    recordPositionEvent(db, {
      accountId: before.account_id, positionId, tradeId: before.trade_id, symbol: before.symbol,
      kind: 'sl_moved', fromValue: before.current_sl, toValue: args.stopLoss, source,
    })
  }
  if (before && args.takeProfit != null) {
    recordPositionEvent(db, {
      accountId: before.account_id, positionId, tradeId: before.trade_id, symbol: before.symbol,
      kind: 'tp_moved', fromValue: before.current_tp, toValue: args.takeProfit, source,
    })
  }
  return { ok: true, positionId, sl: args.stopLoss ?? null, tp: args.takeProfit ?? null }
}
