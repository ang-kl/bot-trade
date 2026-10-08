// Codex · №12,252 · 2026-10-08; codex-footprint: capped-hybrid-profit.
// Owner-selected POST-ENTRY exit: half at 2 price-R, existing TP ceiling.
// Entry qualification and every stop decision remain owned by their old paths.
import { familyOf } from './strategies.js'
import { applyManagedRules, managedExitApplies } from './managed-exit.js'
import { rulesForSymbol } from './asset-controllers.js'
import { sameTicks } from './momentum-target-policy.js'

export const CAPPED_HYBRID_POLICY = 'capped_hybrid_2r_half_v1'
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0
const integer = n => Number.isSafeInteger(n) && n > 0
const id = n => /^[1-9]\d*$/.test(String(n)) ? String(n) : null
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

export function planCappedHybrid(input = {}) {
  const { side, entry, initialRisk, brokerTarget, volume, minVolume, stepVolume, digits, openingDealIds } = input
  const refuse = reason => ({ ok: false, policy: CAPPED_HYBRID_POLICY, reason })
  if (!['BUY', 'SELL'].includes(side) || ![entry, initialRisk, brokerTarget].every(positive)) return refuse('recorded_risk_required')
  if (!Number.isInteger(digits) || digits < 0 || digits > 5) return refuse('broker_precision_required')
  if (![volume, minVolume, stepVolume].every(integer) || volume % stepVolume !== 0) return refuse('broker_volume_invalid')
  const half = volume / 2
  // Exact half only: neither rounding to a token partial nor a full-close fallback.
  if (!integer(half) || half < minVolume || half % stepVolume !== 0) return refuse('half_and_runner_not_representable')
  if (!Array.isArray(openingDealIds) || !openingDealIds.length || openingDealIds.some(d => typeof d !== 'string' || !id(d))
    || new Set(openingDealIds).size !== openingDealIds.length) return refuse('opening_receipts_required')
  const dir = side === 'BUY' ? 1 : -1, scale = 10 ** digits
  const rawTrigger = entry + dir * 2 * initialRisk
  const trigger = (dir === 1 ? Math.ceil(rawTrigger * scale - 1e-7) : Math.floor(rawTrigger * scale + 1e-7)) / scale
  const originalStop = entry - dir * initialRisk
  if (!positive(originalStop) || !positive(trigger) || dir * (brokerTarget - trigger) <= 0) return refuse('existing_tp_caps_before_runner')
  return { ok: true, policy: CAPPED_HYBRID_POLICY, mode: 'partial_runner', side, entry, initialRisk, originalStop,
    trigger, brokerTarget, volume, closeVolume: half, runnerVolume: half, closePercentage: 50,
    minVolume, stepVolume, digits, openingDealIds: [...openingDealIds], rBasis: 'recorded_initial_price_risk',
    runner: 'existing_broker_sl_and_tp', profitability: 'unverified_after_costs' }
}

/** Only ordinary, proven bot fills with no competing discretionary owner.
 * Book plans, pending-entry transfers, guarded/manual/paused rows and existing
 * takes retain their own policy. Re-evaluated immediately before each claim. */
export function readCappedHybridOwner(db, accountId, tradeId, positionId, digits) {
  const t = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=? AND ctrader_position_id=?')
    .get(tradeId, accountId, positionId)
  if (!t || t.status !== 'open' || t.origin !== 'bot_market_dispatch' || !(t.risk_event_id > 0)
    || !t.intent_id || !['BUY', 'SELL'].includes(t.side)
    || !['trend', 'breakout', 'momentum'].includes(familyOf(t.strategy)) || t.label_strategy !== t.strategy) return null
  const a = db.prepare('SELECT * FROM accounts WHERE account_id=?').get(accountId)
  if (!a || !['active', 'manage_only'].includes(a.mode) || !managedExitApplies(db, accountId)) return null
  const i = db.prepare('SELECT * FROM entry_intents WHERE id=? AND account_id=?').get(t.intent_id, accountId)
  if (!i || i.state !== 'FILLED' || id(i.broker_position_id) !== positionId || i.side !== t.side || i.symbol !== t.symbol
    || !id(i.symbol_id) || !(i.risk_event_id > 0) || i.risk_event_id !== t.risk_event_id
    || i.environment !== (a.is_live ? 'live' : 'demo') || !id(i.broker_order_id)) return null
  const monitors = db.prepare("SELECT * FROM monitored_positions WHERE trade_id=? AND status='active'").all(tradeId)
  if (monitors.length !== 1) return null
  const m = monitors[0]
  if (m.account_id !== accountId || m.symbol !== t.symbol || m.strategy !== t.strategy || m.source !== 'autopilot'
    || m.paused !== 0 || m.guard_json != null || m.scaled_out || m.bank_partial_at != null
    || m.side !== (t.side === 'BUY' ? 'long' : 'short') || !positive(m.initial_risk)
    || !sameTicks(m.entry_price, t.entry_price, digits)) return null
  if (db.prepare('SELECT 1 FROM momentum_book WHERE trade_id=? LIMIT 1').get(tradeId)) return null
  if (db.prepare("SELECT 1 FROM position_events WHERE trade_id=? AND kind IN ('scale_out','lot_trimmed','authority_override','position_reversed') LIMIT 1").get(tradeId)) return null
  for (const name of ['momentum_target_intents', 'momentum_limit_intents']) {
    if (table(db, name) && db.prepare(`SELECT 1 FROM ${name} WHERE trade_id=? LIMIT 1`).get(tradeId)) return null
  }
  const rules = applyManagedRules(db, accountId, rulesForSymbol(db, t.symbol), { strategy: t.strategy, tradeId })
  if (rules.bankTriggerR !== 0 || rules.partialTriggerR !== Infinity) return null
  return { accountId, tradeId, positionId, entry: t.entry_price, initialRisk: m.initial_risk, side: t.side,
    status: 'open', owner: 'managed_capped_hybrid', guardActive: false, symbol: t.symbol, strategy: t.strategy,
    symbolId: id(i.symbol_id), entryOrderId: id(i.broker_order_id), intentId: t.intent_id, monitoredId: m.id,
    host: a.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com' }
}
