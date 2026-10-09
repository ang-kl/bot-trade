// Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
// Bounded profit-only enrolment. The authority and existing partial plan are
// committed together; entry attribution, historical risk and SL/TP stay intact.
import { wsReconcile, wsSymbolsByIds, wsGetPositionDeals, wsGetOrderDetails } from '../lib/ctrader-ws.js'
import { getState, setState } from '../db.js'
import { partialPositionEvidence } from './momentum-broker-evidence.js'
import { sameTicks, stopHeld } from './momentum-target-policy.js'
import { planCappedHybrid } from './capped-hybrid-policy.js'
import { registerPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { manualOpeningOrderId, manualOpeningProof } from './manual-hybrid-evidence.js'
import { MANUAL_HYBRID_CONFIG, isManualHybridTrade, readManualHybridCandidate,
  ensureManualHybridSchema, readManualHybridVerdict } from './manual-hybrid-policy.js'

const CURSOR = 'manual_hybrid_enrol_cursor'
const MAX_ROWS = 128
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const id = value => (typeof value === 'number' && integer(value))
  || (typeof value === 'string' && /^[1-9]\d*$/.test(value)) ? String(value) : null
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const sameCandidate = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)
const refusal = reason => Object.assign(Error(reason), { refusal: reason })

export async function enrolManualHybrids(db, { credsFor, now = Date.now, transports = {},
  budgetMs = 12_000, maxCandidates = 8 } = {}) {
  const out = { examined: 0, enrolled: [], deferred: [], errors: [] }
  const started = now()
  const budget = typeof budgetMs === 'number' && Number.isFinite(budgetMs) ? Math.max(0, Math.min(12_000, budgetMs)) : 0
  const maxReads = Number.isInteger(maxCandidates) ? Math.max(0, Math.min(8, maxCandidates)) : 0
  const accounts = MANUAL_HYBRID_CONFIG.accounts
  if (!accounts.length || !['trades', 'monitored_positions', 'accounts'].every(name => table(db, name))) return out
  const placeholders = accounts.map(() => '?').join(',')
  const cursor = Number(getState(db, CURSOR)) || 0
  const where = `status='open' AND account_id IN (${placeholders})
    AND origin IN ('manual_broker','reconciler_adopted') AND source IN ('manual','external')`
  const rows = db.prepare(`SELECT * FROM trades WHERE ${where} AND id>? ORDER BY id LIMIT ?`)
    .all(...accounts, cursor, MAX_ROWS)
  if (rows.length < MAX_ROWS) rows.push(...db.prepare(`SELECT * FROM trades WHERE ${where} AND id<=? ORDER BY id LIMIT ?`)
    .all(...accounts, cursor, MAX_ROWS - rows.length))
  const currentTrade = db.prepare('SELECT * FROM trades WHERE id=? AND account_id=? AND ctrader_position_id=?')
  const remaining = () => budget - (now() - started)
  const bounded = async fn => {
    if (!(remaining() > 0)) throw refusal('enrolment_budget')
    const timeout = Math.max(1, Math.min(4000, remaining()))
    let timer
    try {
      return await Promise.race([Promise.resolve().then(() => fn(timeout)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(refusal('manual_enrolment_read_deadline')), timeout)
      })])
    } finally { clearTimeout(timer) }
  }

  for (const t of rows) {
    if (!isManualHybridTrade(t)) continue
    if (table(db, 'momentum_partial_plans') && readPartialPlan(db, t.account_id, t.id)) continue
    const positionId = id(t.ctrader_position_id)
    const defer = (reason, volumeInputs) => out.deferred.push({ accountId: t.account_id, tradeId: t.id,
      positionId, reason, ...(volumeInputs ? { volumeInputs } : {}) })
    if (!(remaining() > 0) || out.examined >= maxReads) { defer('enrolment_budget'); continue }
    const first = readManualHybridCandidate(db, t, positionId, 5)
    if (!first.candidate) { defer(first.reason || 'manual_candidate_unverified'); setState(db, CURSOR, String(t.id)); continue }
    let candidate = first.candidate
    const refresh = digits => {
      const trade = currentTrade.get(t.id, t.account_id, positionId)
      const next = trade && readManualHybridCandidate(db, trade, positionId, digits).candidate
      if (!sameCandidate(candidate, next)) throw refusal('ownership_changed')
      return next
    }
    out.examined++
    setState(db, CURSOR, String(t.id))
    try {
      const creds = credsFor(t.account_id)
      if (!creds?.ready || String(creds.accountId) !== candidate.accountId || creds.host !== candidate.host) {
        defer('own_credentials_unavailable'); continue
      }
      const args = [creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId]
      const metadata = await bounded(timeout => (transports.symbols || wsSymbolsByIds)(...args, [candidate.symbolId], timeout))
      refresh(5)
      if (metadata?.error != null || metadata?.errorCode != null || id(metadata?.ctidTraderAccountId) !== candidate.accountId) {
        defer('symbol_account_unverified'); continue
      }
      const symbols = Array.isArray(metadata.symbol) ? metadata.symbol.filter(s => id(s?.symbolId) === candidate.symbolId) : []
      if (symbols.length !== 1) { defer('symbol_metadata_unverified'); continue }
      const meta = symbols[0], digits = meta.digits, metadataReceivedAtMs = now()
      if (!Number.isInteger(digits) || digits < 0 || digits > 5) { defer('broker_precision_required'); continue }
      candidate = refresh(digits)
      const identity = { host: candidate.host, accountId: candidate.accountId, symbolId: candidate.symbolId }
      const raw = await bounded(timeout => (transports.reconcile || wsReconcile)(...args, timeout, 0))
      refresh(digits)
      const bp = !raw?.error && !raw?.errorCode && partialPositionEvidence(raw, { identity, positionId, nowMs: now() })
      if (!bp || bp.side !== candidate.side || !sameTicks(bp.entry, candidate.entry, digits)) {
        defer('broker_position_unverified'); continue
      }
      // No arbitrary history window: the position's complete deal response
      // identifies its opening order. The upper bound is this reader's clock.
      const history = await bounded(timeout => (transports.deals || wsGetPositionDeals)(...args, positionId, now(), timeout))
      refresh(digits)
      const context = { identity, positionId, side: bp.side, entry: bp.entry, volume: bp.volume, digits, nowMs: now() }
      const orderId = manualOpeningOrderId(history, context)
      if (!orderId) {
        defer(manualOpeningProof(history, null, context).reason || 'manual_opening_order_unverified'); continue
      }
      const orderDetails = await bounded(timeout => (transports.orderDetails || wsGetOrderDetails)(...args, orderId, timeout))
      refresh(digits)
      const proved = manualOpeningProof(history, orderDetails, { ...context, nowMs: now() })
      if (!proved.ok) { defer(proved.reason); continue }
      // Preserve the actual metadata precision beside the raw order proof.
      // Future readers must use these digits, never a new caller's substitute.
      const proof = { ...proved, digits }
      const plan = planCappedHybrid({ side: proof.side, entry: proof.entry, initialRisk: proof.initialRisk,
        brokerTarget: bp.takeProfit, volume: bp.volume, minVolume: meta.minVolume, stepVolume: meta.stepVolume,
        digits, openingDealIds: proof.openingDealIds })
      if (!plan.ok) {
        const observed = value => typeof value === 'number' && Number.isFinite(value) ? value : null
        defer(plan.reason, { source: 'ordinary_enrolment_reads', units: 'ctrader_protocol_volume',
          ...identity, positionId, side: bp.side, metadataReceivedAtMs, reconcileReceivedAtMs: bp.observedAtMs,
          volume: bp.volume, halfVolume: bp.volume / 2, minVolume: observed(meta.minVolume), stepVolume: observed(meta.stepVolume),
          minVolumeValid: integer(meta.minVolume), stepVolumeValid: integer(meta.stepVolume) })
        continue
      }
      if (!stopHeld(plan.side, bp.stopLoss, plan.originalStop, digits)) { defer('broker_protection_unverified'); continue }
      if (!(remaining() > 0)) { defer('enrolment_budget'); continue }
      db.transaction(() => {
        refresh(digits)
        if (table(db, 'momentum_partial_plans') && readPartialPlan(db, t.account_id, t.id)) throw refusal('existing_partial_plan')
        ensureManualHybridSchema(db)
        if (db.prepare('SELECT 1 FROM manual_hybrid_authority WHERE account_id=? AND trade_id=?').get(t.account_id, t.id)) {
          throw refusal('manual_authority_already_recorded')
        }
        db.prepare(`INSERT INTO manual_hybrid_authority
          (account_id,trade_id,position_id,authority_version,monitor_id,proof_json,created_at) VALUES(?,?,?,?,?,?,?)`)
          .run(candidate.accountId, candidate.tradeId, positionId, MANUAL_HYBRID_CONFIG.version,
            candidate.monitoredId, JSON.stringify(proof), now())
        const trade = currentTrade.get(t.id, t.account_id, positionId)
        const owner = readManualHybridVerdict(db, trade, positionId, digits).owner
        if (!owner || owner.accountId !== candidate.accountId || owner.tradeId !== candidate.tradeId
          || owner.positionId !== positionId || owner.symbolId !== candidate.symbolId || owner.host !== candidate.host
          || owner.side !== proof.side || owner.entryOrderId !== proof.entryOrderId
          || !sameTicks(owner.entry, proof.entry, digits) || owner.initialRisk !== proof.initialRisk) {
          throw refusal('manual_authority_unverified')
        }
        registerPartialPlan(db, { accountId: candidate.accountId, tradeId: candidate.tradeId, positionId, identity, plan,
          evidenceId: `manual-hybrid:${candidate.accountId}:${positionId}:${proof.entryOrderId}` })
      }).immediate()
      out.enrolled.push({ accountId: candidate.accountId, tradeId: candidate.tradeId, positionId,
        trigger: plan.trigger, closeVolume: plan.closeVolume, runnerVolume: plan.runnerVolume, brokerTarget: plan.brokerTarget })
    } catch (error) {
      if (error?.refusal) defer(error.refusal)
      else out.errors.push({ accountId: t.account_id, tradeId: t.id, reason: String(error?.message || error).slice(0, 200) })
    }
  }
  return out
}
