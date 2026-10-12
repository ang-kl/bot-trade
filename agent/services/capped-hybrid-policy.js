// Codex · №12,252 · 2026-10-08; codex-footprint: capped-hybrid-profit.
// Owner-selected POST-ENTRY exit: half at 2 price-R, existing TP ceiling.
// Entry qualification and every stop decision remain owned by their old paths.
import { familyOf } from './strategies.js'
import { applyManagedRules, managedExitApplies } from './managed-exit.js'
import { rulesForSymbol } from './asset-controllers.js'
import { sameTicks } from './momentum-target-policy.js'
import { readTickEntryProof } from './tick-entry-proof.js'
import { isManualHybridTrade, readManualHybridVerdict, MANUAL_HYBRID_REASONS } from './manual-hybrid-policy.js'

export const CAPPED_HYBRID_POLICY = 'capped_hybrid_2r_half_v1'
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0
const integer = n => Number.isSafeInteger(n) && n > 0
const id = n => /^[1-9]\d*$/.test(String(n)) ? String(n) : null
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

// W10 — Claude · № 13,390 12-Oct (owner's yes naming this file, 12-10 ~06:38
// SGT; docs/instruction-2026-10-12-decisions.md W10; claude-builder). The
// trigger (in R) and the fraction closed there are a STORED setting
// (`capped_hybrid_json`), defaulting to today's 2R and 50%, ranges validated
// (owner principle 9: no hardcoded policy). A plan CARRIES the values it was
// made with: the partial manager and the tick controller re-compute a stored
// plan from the plan itself and compare it exactly, so a later settings
// change never invalidates a plan already armed. At the defaults the plan is
// byte-identical to the pre-W10 plan (no new keys), so every plan armed
// before W10 still validates.
export const CAPPED_HYBRID_SETTINGS_KEY = 'capped_hybrid_json'
export const CAPPED_HYBRID_DEFAULTS = Object.freeze({ triggerR: 2, closeFraction: 0.5 })
export const CAPPED_HYBRID_RANGES = Object.freeze({ triggerR: Object.freeze([1, 5]), closeFraction: Object.freeze([0.1, 0.9]) })
const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** { ok, settings: {triggerR, closeFraction}, errors }. Missing fields take the defaults. */
export function validateCappedHybridSettings(raw) {
  const errors = []
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, settings: { ...CAPPED_HYBRID_DEFAULTS }, errors: ['not an object'] }
  const settings = { ...CAPPED_HYBRID_DEFAULTS }
  for (const k of Object.keys(CAPPED_HYBRID_DEFAULTS)) {
    if (raw[k] === undefined) continue
    if (!inRange(raw[k], CAPPED_HYBRID_RANGES[k])) errors.push(`${k} must be a number in [${CAPPED_HYBRID_RANGES[k].join(', ')}]`)
    else settings[k] = raw[k]
  }
  return errors.length ? { ok: false, settings: { ...CAPPED_HYBRID_DEFAULTS }, errors } : { ok: true, settings, errors }
}

/** The effective settings: the stored ones when valid, else the defaults with
 * the reason named (an unreadable store never becomes a different policy). */
export function loadCappedHybridSettings(db) {
  let row = null
  try { row = db.prepare('SELECT value FROM agent_state WHERE key = ?').get(CAPPED_HYBRID_SETTINGS_KEY) } catch { row = null }
  if (!row?.value) return { ...CAPPED_HYBRID_DEFAULTS, source: 'default', error: null }
  let raw
  try { raw = JSON.parse(row.value) } catch { return { ...CAPPED_HYBRID_DEFAULTS, source: 'default', error: 'stored setting is not JSON' } }
  const v = validateCappedHybridSettings(raw)
  return v.ok ? { ...v.settings, source: 'stored', error: null } : { ...CAPPED_HYBRID_DEFAULTS, source: 'default', error: v.errors.join('; ') }
}

export function planCappedHybrid(input = {}) {
  const { side, entry, initialRisk, brokerTarget, volume, minVolume, stepVolume, digits, openingDealIds } = input
  const refuse = reason => ({ ok: false, policy: CAPPED_HYBRID_POLICY, reason })
  // W10: the plan's own values, or the defaults for a pre-W10 plan or input.
  const triggerR = input.triggerR ?? CAPPED_HYBRID_DEFAULTS.triggerR
  const closeFraction = input.closeFraction ?? CAPPED_HYBRID_DEFAULTS.closeFraction
  if (!inRange(triggerR, CAPPED_HYBRID_RANGES.triggerR) || !inRange(closeFraction, CAPPED_HYBRID_RANGES.closeFraction)) return refuse('hybrid_settings_invalid')
  if (!['BUY', 'SELL'].includes(side) || ![entry, initialRisk, brokerTarget].every(positive)) return refuse('recorded_risk_required')
  if (!Number.isInteger(digits) || digits < 0 || digits > 5) return refuse('broker_precision_required')
  if (![volume, minVolume, stepVolume].every(integer) || volume % stepVolume !== 0) return refuse('broker_volume_invalid')
  // Exact parts only: neither rounding to a token partial nor a full-close
  // fallback. At 0.5 this is the exact half, as before W10. The tolerance is
  // float error on the product (a few ulps), not a share of the volume: at
  // 1e8 units a relative 1e-9 would round 10000000.05 to 10000000 (Codex P2
  // on #1327; Claude · № 13,467 12-Oct; claude-builder).
  const exact = volume * closeFraction, closeVolume = Math.round(exact), runnerVolume = volume - closeVolume
  if (Math.abs(exact - closeVolume) > 4 * Number.EPSILON * Math.max(1, Math.abs(exact)) || !integer(closeVolume) || closeVolume < minVolume || closeVolume % stepVolume !== 0
    || !integer(runnerVolume) || runnerVolume < minVolume || runnerVolume % stepVolume !== 0) return refuse('half_and_runner_not_representable')
  if (!Array.isArray(openingDealIds) || !openingDealIds.length || openingDealIds.some(d => typeof d !== 'string' || !id(d))
    || new Set(openingDealIds).size !== openingDealIds.length) return refuse('opening_receipts_required')
  const dir = side === 'BUY' ? 1 : -1, scale = 10 ** digits
  const rawTrigger = entry + dir * triggerR * initialRisk
  const trigger = (dir === 1 ? Math.ceil(rawTrigger * scale - 1e-7) : Math.floor(rawTrigger * scale + 1e-7)) / scale
  const originalStop = entry - dir * initialRisk
  if (!positive(originalStop) || !positive(trigger) || dir * (trigger - entry) <= 0
    || dir * (brokerTarget - trigger) <= 0) return refuse('existing_tp_caps_before_runner')
  const atDefaults = triggerR === CAPPED_HYBRID_DEFAULTS.triggerR && closeFraction === CAPPED_HYBRID_DEFAULTS.closeFraction
  return { ok: true, policy: CAPPED_HYBRID_POLICY, mode: 'partial_runner', side, entry, initialRisk, originalStop,
    trigger, brokerTarget, volume, closeVolume, runnerVolume, closePercentage: Math.round(closeFraction * 1e8) / 1e6,
    minVolume, stepVolume, digits, openingDealIds: [...openingDealIds], rBasis: 'recorded_initial_price_risk',
    runner: 'existing_broker_sl_and_tp', profitability: 'unverified_after_costs',
    // W10: a plan made off the defaults says so, and carries what it was made with.
    ...(atDefaults ? {} : { triggerR, closeFraction }) }
}

/** Only ordinary, proven bot fills with no competing discretionary owner.
 * Book plans, pending-entry transfers, guarded/manual/paused rows and existing
 * takes retain their own policy. Re-evaluated immediately before each claim. */
// Codex · №12,559 · 2026-10-09; codex-footprint: hybrid-exclusion-verdicts.
// The action reader and diagnostic reader share every predicate. A refusal
// describes the stored classification, never how the human entered a trade.
export const HYBRID_OWNER_REASONS = Object.freeze([
  ...MANUAL_HYBRID_REASONS,
  'trade_identity_unverified', 'trade_not_open', 'trade_origin_not_bot', 'trade_risk_link_missing',
  'trade_intent_link_missing', 'trade_side_invalid', 'account_missing', 'account_mode_excluded',
  'managed_exit_disabled', 'tick_entry_proof_missing', 'strategy_not_momentum', 'strategy_label_mismatch',
  'entry_intent_missing', 'entry_not_filled', 'entry_identity_conflict', 'entry_symbol_unverified',
  'entry_risk_conflict', 'entry_host_conflict', 'entry_order_missing', 'active_monitor_missing',
  'active_monitor_ambiguous', 'monitor_identity_conflict', 'monitor_external', 'monitor_not_autopilot',
  'monitor_paused', 'monitor_guarded', 'monitor_already_scaled', 'monitor_bank_owned',
  'monitor_side_conflict', 'initial_risk_missing', 'monitor_entry_conflict', 'momentum_book_owned',
  'prior_position_override', 'competing_profit_intent', 'competing_profit_policy',
])
export function readCappedHybridOwner(db, accountId, tradeId, positionId, digits) {
  return readCappedHybridVerdict(db, accountId, tradeId, positionId, digits).owner
}
export function readCappedHybridVerdict(db, accountId, tradeId, positionId, digits) {
  let monitorId = null
  const refuse = reason => ({ owner: null, reason, monitorId })
  const t = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=? AND ctrader_position_id=?')
    .get(tradeId, accountId, positionId)
  if (!t) return refuse('trade_identity_unverified')
  if (t.status !== 'open') return refuse('trade_not_open')
  // Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
  // Separate profit contract; the bot entry predicates below remain intact.
  if (isManualHybridTrade(t)) return readManualHybridVerdict(db, t, positionId, digits)
  if (t.origin !== 'bot_market_dispatch') return refuse('trade_origin_not_bot')
  if (!(t.risk_event_id > 0)) return refuse('trade_risk_link_missing')
  if (!t.intent_id) return refuse('trade_intent_link_missing')
  if (!['BUY', 'SELL'].includes(t.side)) return refuse('trade_side_invalid')
  const a = db.prepare('SELECT * FROM accounts WHERE account_id=?').get(accountId)
  if (!a) return refuse('account_missing')
  if (!['active', 'manage_only'].includes(a.mode)) return refuse('account_mode_excluded')
  if (!managedExitApplies(db, accountId)) return refuse('managed_exit_disabled')
  const i = db.prepare('SELECT * FROM entry_intents WHERE id=? AND account_id=?').get(t.intent_id, accountId)
  // Codex · №12,519 · 2026-10-09; codex-footprint: six-strategy-lifecycle.
  // Native tick labels name a profile and intent, not a bar-registry strategy.
  // Admit that one producer only through its owned immutable entry receipt.
  // Never invent a label stamp or derive its original R from today's tighter SL.
  const tick = t.strategy === 'tick_momentum_breakout' ? readTickEntryProof(db, t, i) : null
  if (t.strategy === 'tick_momentum_breakout') {
    if (!tick) return refuse('tick_entry_proof_missing')
  } else {
    if (!['trend', 'breakout', 'momentum'].includes(familyOf(t.strategy))) return refuse('strategy_not_momentum')
    if (t.label_strategy !== t.strategy) return refuse('strategy_label_mismatch')
  }
  if (!i) return refuse('entry_intent_missing')
  if (i.state !== 'FILLED') return refuse('entry_not_filled')
  if (id(i.broker_position_id) !== positionId || i.side !== t.side || i.symbol !== t.symbol) return refuse('entry_identity_conflict')
  if (!id(i.symbol_id)) return refuse('entry_symbol_unverified')
  if (!(i.risk_event_id > 0) || i.risk_event_id !== t.risk_event_id) return refuse('entry_risk_conflict')
  if (i.environment !== (a.is_live ? 'live' : 'demo')) return refuse('entry_host_conflict')
  if (!(tick?.entryOrderId || id(i.broker_order_id))) return refuse('entry_order_missing')
  const monitors = db.prepare("SELECT * FROM monitored_positions WHERE trade_id=? AND status='active'").all(tradeId)
  if (!monitors.length) return refuse('active_monitor_missing')
  if (monitors.length !== 1) return refuse('active_monitor_ambiguous')
  const m = monitors[0]
  monitorId = m.id
  if (m.account_id !== accountId || m.symbol !== t.symbol || m.strategy !== t.strategy) return refuse('monitor_identity_conflict')
  if (m.source === 'external') return refuse('monitor_external')
  if (m.source !== 'autopilot') return refuse('monitor_not_autopilot')
  if (m.paused !== 0) return refuse('monitor_paused')
  if (m.guard_json != null) return refuse('monitor_guarded')
  if (m.scaled_out) return refuse('monitor_already_scaled')
  if (m.bank_partial_at != null) return refuse('monitor_bank_owned')
  if (m.side !== (t.side === 'BUY' ? 'long' : 'short')) return refuse('monitor_side_conflict')
  if (!positive(tick?.initialRisk ?? m.initial_risk)) return refuse('initial_risk_missing')
  if (!sameTicks(m.entry_price, t.entry_price, digits)) return refuse('monitor_entry_conflict')
  if (db.prepare('SELECT 1 FROM momentum_book WHERE trade_id=? LIMIT 1').get(tradeId)) return refuse('momentum_book_owned')
  if (db.prepare("SELECT 1 FROM position_events WHERE trade_id=? AND kind IN ('scale_out','lot_trimmed','authority_override','position_reversed') LIMIT 1").get(tradeId)) return refuse('prior_position_override')
  for (const name of ['momentum_target_intents', 'momentum_limit_intents']) {
    if (table(db, name) && db.prepare(`SELECT 1 FROM ${name} WHERE trade_id=? LIMIT 1`).get(tradeId)) return refuse('competing_profit_intent')
  }
  const rules = applyManagedRules(db, accountId, rulesForSymbol(db, t.symbol), { strategy: t.strategy, tradeId })
  if (rules.bankTriggerR !== 0 || rules.partialTriggerR !== Infinity) return refuse('competing_profit_policy')
  const owner = { accountId, tradeId, positionId, entry: t.entry_price, initialRisk: tick?.initialRisk ?? m.initial_risk, side: t.side,
    status: 'open', owner: 'managed_capped_hybrid', guardActive: false, symbol: t.symbol, strategy: t.strategy,
    symbolId: id(i.symbol_id), entryOrderId: tick?.entryOrderId || id(i.broker_order_id), intentId: t.intent_id, monitoredId: m.id,
    host: a.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com' }
  return { owner, reason: null, monitorId }
}
