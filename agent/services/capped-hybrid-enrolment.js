// Codex · №12,252 · 2026-10-08; codex-footprint: capped-hybrid-profit.
// Bounded enrolment after fill, never an entry writer or an SL/TP amendment.
import { wsReconcile, wsSymbolsByIds, wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { partialPositionEvidence } from './momentum-broker-evidence.js'
import { sameTicks, stopHeld } from './momentum-target-policy.js'
import { registerPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { planCappedHybrid, readCappedHybridOwner } from './capped-hybrid-policy.js'
import { getState, setState } from '../db.js'

const integer = n => Number.isSafeInteger(n) && n > 0
const id = n => /^[1-9]\d*$/.test(String(n)) ? String(n) : null
const table = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

// A complete position-deal read must prove all held units are opening fills,
// not the residue of a manual/earlier partial. Requested volume is never used.
export function openingReceipts(raw, owner, held, digits) {
  if (id(raw?.ctidTraderAccountId) !== owner.accountId || raw.hasMore !== false || raw.error || raw.errorCode
    || !Array.isArray(raw.deal)) return null
  const deals = raw.deal.filter(d => id(d.positionId) === owner.positionId)
  if (!deals.length || deals.some(d => d.closePositionDetail != null)) return null
  let total = 0, weighted = 0
  const ids = []
  for (const d of deals) {
    if (!id(d.dealId) || id(d.orderId) !== owner.entryOrderId || id(d.symbolId) !== owner.symbolId
      || ![2, 'FILLED'].includes(d.dealStatus) || !integer(d.filledVolume)
      || !integer(d.volume) || d.filledVolume > d.volume || !(typeof d.executionPrice === 'number' && d.executionPrice > 0)
      || (d.tradeSide === 1 || d.tradeSide === 'BUY' ? 'BUY' : d.tradeSide === 2 || d.tradeSide === 'SELL' ? 'SELL' : null) !== owner.side) return null
    total += d.filledVolume; weighted += d.filledVolume * d.executionPrice; ids.push(id(d.dealId))
  }
  return integer(total) && total === held && new Set(ids).size === ids.length
    && sameTicks(weighted / total, owner.entry, digits) ? ids : null
}

export async function enrolCappedHybrids(db, { credsFor, now = Date.now, transports = {}, budgetMs = 12_000, maxCandidates = 8 } = {}) {
  const out = { examined: 0, enrolled: [], deferred: [], errors: [] }, started = now()
  // Old lightweight fixtures / unavailable schema are not new runtime facts.
  if (!['trades', 'monitored_positions', 'entry_intents', 'accounts'].every(n => table(db, n))) return out
  let candidates = db.prepare(`SELECT t.id,t.account_id,t.ctrader_position_id FROM trades t
    JOIN monitored_positions m ON m.trade_id=t.id
    WHERE t.status='open' AND t.origin='bot_market_dispatch' AND m.status='active' AND m.paused=0
      AND m.guard_json IS NULL AND m.scaled_out=0 AND m.bank_partial_at IS NULL
    ORDER BY t.id`).all()
  const cursor = Number(getState(db, 'capped_hybrid_enrol_cursor')) || 0
  candidates = [...candidates.filter(t => t.id > cursor), ...candidates.filter(t => t.id <= cursor)]
  const bounded = async fn => {
    let timer
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('hybrid enrolment read deadline')), Math.min(5000, Math.max(1, budgetMs - (now() - started))))
    })]) } finally { clearTimeout(timer) }
  }
  for (const t of candidates) {
    if (table(db, 'momentum_partial_plans') && readPartialPlan(db, t.account_id, t.id)) continue
    // Five digits is only a preliminary ownership comparison, never broker
    // precision for a plan. The exact broker precision is required below.
    let owner = readCappedHybridOwner(db, t.account_id, t.id, String(t.ctrader_position_id), 5)
    if (!owner) continue
    if (out.examined >= maxCandidates || now() - started >= budgetMs) { out.deferred.push({ tradeId: t.id, reason: 'enrolment_budget' }); continue }
    out.examined++
    // A persistently unavailable first position must not starve other accounts.
    setState(db, 'capped_hybrid_enrol_cursor', String(t.id))
    const refuse = reason => out.deferred.push({ tradeId: t.id, accountId: t.account_id, reason })
    try {
      const c = credsFor(t.account_id)
      if (!c?.ready || String(c.accountId) !== owner.accountId || c.host !== owner.host) { refuse('own_credentials_unavailable'); continue }
      const args = [c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId]
      const metadata = await bounded(() => (transports.symbols || wsSymbolsByIds)(...args, [owner.symbolId], 4000))
      if (id(metadata?.ctidTraderAccountId) !== owner.accountId) { refuse('symbol_account_unverified'); continue }
      const symbols = (metadata.symbol || []).filter(s => id(s.symbolId) === owner.symbolId)
      if (symbols.length !== 1) { refuse('symbol_metadata_unverified'); continue }
      const meta = symbols[0], digits = meta.digits
      if (!Number.isInteger(digits) || digits < 0 || digits > 5) { refuse('broker_precision_required'); continue }
      owner = readCappedHybridOwner(db, t.account_id, t.id, String(t.ctrader_position_id), digits)
      if (!owner) { refuse('ownership_changed'); continue }
      const identity = { host: owner.host, accountId: owner.accountId, symbolId: owner.symbolId }
      const context = { identity, positionId: owner.positionId, nowMs: now() }
      const raw = await bounded(() => (transports.reconcile || wsReconcile)(...args, 4000, 0))
      const bp = partialPositionEvidence(raw, { ...context, nowMs: now() })
      if (!bp || bp.side !== owner.side || !sameTicks(bp.entry, owner.entry, digits)) { refuse('broker_position_unverified'); continue }
      const history = await bounded(() => (transports.deals || wsGetPositionDeals)(...args, owner.positionId, now() + 2000, 4000))
      const openingDealIds = openingReceipts(history, owner, bp.volume, digits)
      const plan = planCappedHybrid({ side: owner.side, entry: owner.entry, initialRisk: owner.initialRisk,
        brokerTarget: bp.takeProfit, volume: bp.volume, minVolume: meta.minVolume, stepVolume: meta.stepVolume, digits, openingDealIds })
      if (!plan.ok) { refuse(plan.reason); continue }
      if (!stopHeld(plan.side, bp.stopLoss, plan.originalStop, digits)) { refuse('broker_protection_unverified'); continue }
      const latest = readCappedHybridOwner(db, t.account_id, t.id, owner.positionId, digits)
      if (JSON.stringify(latest) !== JSON.stringify(owner)) { refuse('ownership_changed'); continue }
      // Durable immutable policy on the existing mounted database before any
      // close. The ordinary manager re-reads position/quote/owner before send.
      registerPartialPlan(db, { accountId: owner.accountId, tradeId: t.id, positionId: owner.positionId, identity, plan,
        evidenceId: `capped-hybrid:${owner.intentId}:${openingDealIds.join(',')}` })
      out.enrolled.push({ accountId: owner.accountId, tradeId: t.id, positionId: owner.positionId, trigger: plan.trigger,
        closeVolume: plan.closeVolume, runnerVolume: plan.runnerVolume, brokerTarget: plan.brokerTarget })
    } catch (e) { out.errors.push({ tradeId: t.id, reason: String(e?.message || e).slice(0, 200) }) }
  }
  return out
}
