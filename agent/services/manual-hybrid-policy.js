// Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
// Profit-only authority; no manual trade relabelling or monitor-risk rewrite.
import { readFileSync } from 'node:fs'
import { getState } from '../db.js'
import { credsForRegisteredAccount, getAccountSymbolMap } from '../lib/ctrader-creds.js'
import { managedExitApplies, applyManagedRules } from './managed-exit.js'
import { rulesForSymbol } from './asset-controllers.js'
import { sameTicks } from './momentum-target-policy.js'
import { manualOpeningProof } from './manual-hybrid-evidence.js'

const config = JSON.parse(readFileSync(new URL('../config/manual-hybrid.json', import.meta.url), 'utf8'))
export const MANUAL_HYBRID_CONFIG = Object.freeze({ ...config, accounts: Object.freeze([...config.accounts]) })
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const id = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : null
export const MANUAL_HYBRID_REASONS = Object.freeze([
  'manual_account_not_authorised', 'manual_trade_origin_unverified', 'manual_keeper_disabled',
  'manual_keeper_opt_out', 'manual_symbol_map_unverified', 'manual_opening_proof_required',
  'manual_opening_proof_conflict', 'manual_authority_conflict', 'manual_monitor_source_conflict',
])
export function isManualHybridTrade(t) {
  return ['manual_broker', 'reconciler_adopted'].includes(t?.origin) && ['manual', 'external'].includes(t?.source)
}
export function ensureManualHybridSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS manual_hybrid_authority (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, position_id TEXT NOT NULL,
    authority_version TEXT NOT NULL, monitor_id INTEGER NOT NULL, proof_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(account_id,trade_id))`)
}
export function readManualHybridCandidate(db, t, positionId, digits) {
  let monitorId = null
  const refuse = reason => ({ candidate: null, reason, monitorId })
  if (!t || !id(positionId) || String(t.ctrader_position_id) !== positionId || !id(t.account_id)) return refuse('trade_identity_unverified')
  if (!MANUAL_HYBRID_CONFIG.accounts.includes(t.account_id)) return refuse('manual_account_not_authorised')
  if (!isManualHybridTrade(t)) return refuse('manual_trade_origin_unverified')
  if (t.status !== 'open') return refuse('trade_not_open')
  if (!['BUY', 'SELL'].includes(t.side)) return refuse('trade_side_invalid')
  const account = db.prepare('SELECT * FROM accounts WHERE account_id=?').get(t.account_id)
  if (!account) return refuse('account_missing')
  if (!['active', 'manage_only'].includes(account.mode)) return refuse('account_mode_excluded')
  if (!managedExitApplies(db, t.account_id)) return refuse('managed_exit_disabled')
  let keeper = {}
  try { keeper = JSON.parse(getState(db, 'profit_keeper_json') || '{}') || {} } catch { return refuse('manual_keeper_disabled') }
  if (keeper.on != null && keeper.on !== true) return refuse('manual_keeper_disabled')
  const monitors = db.prepare("SELECT * FROM monitored_positions WHERE trade_id=? AND status='active'").all(t.id)
  if (!monitors.length) return refuse('active_monitor_missing')
  if (monitors.length !== 1) return refuse('active_monitor_ambiguous')
  const m = monitors[0]; monitorId = m.id
  if (m.account_id !== t.account_id || m.symbol !== t.symbol || m.strategy !== t.strategy) return refuse('monitor_identity_conflict')
  if (!['manual', 'external'].includes(m.source)) return refuse('manual_monitor_source_conflict')
  if (m.paused !== 0) return refuse('monitor_paused')
  if (m.guard_json != null) return refuse('monitor_guarded')
  if (m.keeper_opt_out) return refuse('manual_keeper_opt_out')
  if (m.scaled_out) return refuse('monitor_already_scaled')
  if (m.bank_partial_at != null) return refuse('monitor_bank_owned')
  if (m.side !== (t.side === 'BUY' ? 'long' : 'short')) return refuse('monitor_side_conflict')
  if (!sameTicks(m.entry_price, t.entry_price, digits)) return refuse('monitor_entry_conflict')
  if (db.prepare('SELECT 1 FROM momentum_book WHERE trade_id=? LIMIT 1').get(t.id)) return refuse('momentum_book_owned')
  if (db.prepare("SELECT 1 FROM position_events WHERE trade_id=? AND kind IN ('scale_out','lot_trimmed','authority_override','position_reversed') LIMIT 1").get(t.id)) return refuse('prior_position_override')
  for (const name of ['momentum_target_intents', 'momentum_limit_intents']) {
    if (table(db, name) && db.prepare(`SELECT 1 FROM ${name} WHERE trade_id=? LIMIT 1`).get(t.id)) return refuse('competing_profit_intent')
  }
  const rules = applyManagedRules(db, t.account_id, rulesForSymbol(db, t.symbol), { strategy: t.strategy, tradeId: t.id })
  if (rules.bankTriggerR !== 0 || rules.partialTriggerR !== Infinity) return refuse('competing_profit_policy')
  const ownMap = getAccountSymbolMap(db, t.account_id), symbolId = id(ownMap?.map?.[t.symbol])
  if (!symbolId) return refuse('manual_symbol_map_unverified')
  const host = credsForRegisteredAccount(db, t.account_id)?.host
  if (!host) return refuse('entry_host_conflict')
  return { candidate: { accountId: t.account_id, tradeId: t.id, positionId, entry: t.entry_price,
    side: t.side, symbol: t.symbol, strategy: t.strategy, symbolId, host, monitoredId: m.id }, reason: null, monitorId }
}
export function readManualHybridVerdict(db, t, positionId, digits) {
  const current = readManualHybridCandidate(db, t, positionId, digits)
  const refuse = reason => ({ owner: null, reason, monitorId: current.monitorId })
  if (!current.candidate) return refuse(current.reason)
  if (!table(db, 'manual_hybrid_authority')) return refuse('manual_opening_proof_required')
  const row = db.prepare('SELECT * FROM manual_hybrid_authority WHERE account_id=? AND trade_id=?').get(t.account_id, t.id)
  if (!row) return refuse('manual_opening_proof_required')
  if (row.authority_version !== MANUAL_HYBRID_CONFIG.version || row.monitor_id !== current.monitorId
    || row.position_id !== positionId) return refuse('manual_authority_conflict')
  let proof
  try { proof = JSON.parse(row.proof_json) } catch { return refuse('manual_opening_proof_conflict') }
  const c = current.candidate
  if (proof.digits !== digits || proof.identity?.host !== c.host || proof.identity?.accountId !== c.accountId
    || proof.identity?.symbolId !== c.symbolId || proof.positionId !== positionId || proof.side !== c.side
    || !sameTicks(proof.entry, c.entry, digits)) return refuse('manual_opening_proof_conflict')
  const checked = manualOpeningProof(proof.raw?.history, proof.raw?.orderDetails, {
    identity: proof.identity, positionId, side: c.side, entry: proof.entry, volume: proof.volume, digits, nowMs: proof.observedAtMs,
  })
  if (!checked.ok || JSON.stringify({ ...checked, digits }) !== JSON.stringify(proof)) return refuse('manual_opening_proof_conflict')
  return { owner: { ...c, initialRisk: checked.initialRisk, status: 'open', owner: 'managed_capped_hybrid',
    guardActive: false, entryOrderId: checked.entryOrderId, intentId: null }, reason: null, monitorId: current.monitorId }
}
