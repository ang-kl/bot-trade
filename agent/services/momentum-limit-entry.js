import { resolveSymbolId } from '../lib/ctrader-creds.js'
import { lotsToVolume, relativePoints } from '../lib/lot-sizing.js'
import { encodeLabel, convictionBucket, LABEL_VERSION } from '../lib/trade-labels.js'
import { entryMarketGate, resolveEntryMarketGate } from './entry-hours.js'
import { loadClosedMarketLimitsConfig, buildLimitPayload } from './closed-market-limits.js'
import { momentumPlanApplies } from './momentum-entry-switch.js'
import { readEntryReference, readEntryEvidence, preGatePlan, finalPlan, loadMomentumCostSchedule } from './momentum-entry-producer.js'
import { recordMomentumLimit } from './momentum-entry-contract.js'

// T4 option (a), OD-15. This path is only for an OPEN market's HTF entry.
// Closed markets, unlisted accounts and other producers retain their fences.
// Neither cap values nor the existing volatility sizing policy change here.
export async function placeMomentumLimit(db, creds, symbol, synth, opts = {}) {
  const now = opts.clock ?? Date.now
  const accountId = String(creds.accountId), producerId = opts.producerId
  const risk = opts.risk ?? await import('./risk.js')
  const exec = opts.exec ?? await import('../lib/exec-engine.js')
  const refuse = (reason, proposal = null) => {
    if (proposal) risk.persistPostApprovalVeto(db, proposal, `momentum_limit_refused: ${reason}`)
    return { placed: false, skipped: 'momentum_limit_refused', reason }
  }
  if (!momentumPlanApplies(producerId, { accountId, ...(opts.loadSwitch ? { load: opts.loadSwitch } : {}) })) return refuse('account_or_producer_not_enabled')
  if (!loadClosedMarketLimitsConfig(db).on) return refuse('off')
  if (opts.reason !== 'htf') return refuse('open_market_htf_only')
  if (!creds.entryLedger?.reserve) return refuse('entry_ledger_required')
  const market = opts.marketGate ?? ((final = false) => final
    ? entryMarketGate(db, { accountId, symbol, nowMs: now() })
    : resolveEntryMarketGate(db, { accountId, symbol }))
  const gate = await market()
  if (gate?.open !== true || gate.unknown) return refuse('momentum_closed_or_unknown_market')
  if (!Number.isFinite(opts.expiresAtMs) || opts.expiresAtMs <= now()) return refuse('expiry_required')
  const side = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
  const working = () => db.prepare(`SELECT order_id FROM pending_orders WHERE account_id=? AND symbol=? AND status='working'`).get(accountId, symbol)
  if (working()) return { skipped: 'already_working', orderId: working().order_id }
  let pendingId = null, intentId = null, proposal = null
  try {
    const resolved = await (opts.resolveSymbolId ?? resolveSymbolId)(db, creds, symbol)
    if (!resolved.id) return refuse(resolved.reason || 'symbol_unknown')
    const reference = await readEntryReference({ creds, symbolId: resolved.id, transports: opts.transports })
    if (!reference.ok) return refuse(reference.reason)
    const evidence = () => readEntryEvidence({ creds, symbolId: resolved.id, reference, transports: opts.transports, now })
    const requiredRr = risk.effectiveRrFloor(db, accountId, synth.strategy)
    const schedule = opts.schedule ?? loadMomentumCostSchedule()
    const args = { symbol, side, limitEntry: Number(synth.entry), stopDistance: Math.abs(Number(synth.entry) - Number(synth.sl)),
      requiredRr, relativePoints, schedule, ...(opts.medianNights ? { medianNights: opts.medianNights } : {}) }
    const pre = preGatePlan(db, { ...args, evidence: await evidence() })
    if (!pre.ok) return refuse(pre.reason)
    proposal = { symbol, side, accountId, entry: pre.entry, sl: pre.stop, tp1: pre.trigger, tp2: pre.runnerTarget,
      strategy: synth.strategy, timeframe: synth.timeframe, conviction: synth.overall_conviction ?? null,
      direction_reason: synth.direction_reason ?? null, requestedVolume: opts.requestedVolume ?? null,
      sizing: synth.sizing ?? null, sizedVolume: synth.sizedVolume ?? null, source: 'momentum_htf_limit' }
    const config = risk.loadRiskConfig(db, accountId)
    const preliminary = risk.evaluateTrade(db, proposal, config)
    if (!preliminary.approved) {
      risk.persistRiskEvent(db, proposal, preliminary)
      return refuse(preliminary.veto_reason)
    }
    if (preliminary.target_override) return refuse('target_override_incompatible', proposal)
    if (preliminary.stop_override?.sl != null) args.stopDistance = Math.abs(pre.entry - preliminary.stop_override.sl)
    const fresh = await evidence()
    if (!fresh.ok) return refuse(fresh.reason, proposal)
    const sized = lotsToVolume(preliminary.adjusted_volume, fresh.symbolMeta)
    if (sized.belowMin || sized.aboveMax) return refuse('volume_outside_broker_bounds', proposal)
    const final = finalPlan(db, { ...args, evidence: fresh, volume: sized.volume, nowMs: now() })
    if (!final.ok) return refuse(final.reason, proposal)
    const p = final.plan
    proposal = { ...proposal, entry: p.entry, sl: p.originalStop, tp1: p.trigger, tp2: p.brokerTarget }
    const rate = risk.marginRateFor(config, symbol)
    const leverage = risk.getAccountLeverage(db, config, accountId)
    const notionalUsd = p.entry * (p.volume / 100) * fresh.conversion.quoteUsdRate
    const reservedMarginUsd = notionalUsd * (rate > 0 ? rate : 1 / leverage)
    if (!Number.isFinite(reservedMarginUsd) || reservedMarginUsd <= 0) return refuse('account_margin_evidence_required', proposal)
    const label = encodeLabel({ source: 'preopen', version: LABEL_VERSION, strategy: synth.strategy,
      conviction: convictionBucket(synth.overall_conviction), session: 'Off', timeframe: synth.timeframe, regime: null })
    const payload = { ...buildLimitPayload({ accountId, symbolId: resolved.id, side, volume: p.volume,
      entry: p.entry, sl: p.originalStop, tp: p.brokerTarget, digits: p.digits,
      expiresAtMs: opts.expiresAtMs, label, relativePoints, riskCfg: config }), symbolName: symbol }
    const ledger = creds.entryLedger
    const placeCreds = { ...creds, entryLedger: { ...ledger, reserve: o => db.transaction(() => {
      // No await between this final gate and the durable reservation. A second
      // concurrent placement therefore sees the first one's slots and margin.
      const currentMarket = market(true)
      if (currentMarket?.open !== true || currentMarket.unknown) throw Error('market_no_longer_open')
      if (opts.expiresAtMs <= now()) throw Error('expiry_passed')
      if (working()) throw Error('already_working')
      const maxTotal = Math.max(1, Number(process.env.PENDING_MAX_TOTAL || 20))
      if (db.prepare("SELECT count(*) n FROM pending_orders WHERE status='working'").get().n >= maxTotal) throw Error('pending_cap')
      const currentConfig = risk.loadRiskConfig(db, accountId)
      if (risk.marginRateFor(currentConfig, symbol) !== rate || risk.getAccountLeverage(db, currentConfig, accountId) !== leverage) throw Error('margin_policy_changed_before_reservation')
      const current = risk.evaluateTrade(db, proposal, currentConfig)
      if (!current.approved) throw Error(current.veto_reason)
      if (current.target_override || (current.stop_override?.sl != null && current.stop_override.sl !== p.originalStop)
        || lotsToVolume(current.adjusted_volume, fresh.symbolMeta).volume !== p.volume
        || risk.effectiveRrFloor(db, accountId, synth.strategy) !== requiredRr) throw Error('risk_changed_before_reservation')
      // Own broker lot size and currency conversion must also fit the gate's
      // admitted margin. Unknown margin is not a zero-dollar reservation.
      const admittedMargin = current.checks?.margin_required_usd
      if (!Number.isFinite(admittedMargin) || reservedMarginUsd > admittedMargin + 0.01) throw Error('owned_margin_exceeds_approval')
      const riskEventId = risk.persistRiskEvent(db, proposal, current)
      const reservation = ledger.reserve({ ...o, riskEventId })
      if (!reservation?.ok) return reservation
      intentId = reservation.intentId
      const insert = db.prepare(`INSERT INTO pending_orders(symbol,timeframe,dir,level,sl,tp,volume,expires_at,status,note,strategy,risk_event_id,account_id,intent_id)
        VALUES(?,?,?,?,?,?,?,?,'working','pending-closed',?,?,?,?)`).run(symbol, synth.timeframe ?? null,
        side === 'BUY' ? 1 : -1, p.entry, p.originalStop, p.brokerTarget, final.lots,
        new Date(opts.expiresAtMs).toISOString(), synth.strategy, riskEventId, accountId, intentId)
      pendingId = Number(insert.lastInsertRowid)
      recordMomentumLimit(db, { accountId, intentId, pendingId, proposal: final.proposal, reservedMarginUsd,
        marginEvidence: { currency: 'USD', notionalUsd, rate, leverage, symbolMeta: fresh.symbolMeta, conversion: fresh.conversion }, nowMs: now() })
      return reservation
    }).immediate() } }
    const answer = await exec.placeOrder(placeCreds, payload)
    if (!pendingId) throw Error('entry_transport_did_not_reserve')
    const outcome = db.prepare('SELECT state FROM entry_intents WHERE id=? AND account_id=?').get(intentId, accountId)?.state
    if (!['ACCEPTED', 'FILLED'].includes(outcome)) throw Error(`entry_outcome_${outcome || 'unknown'}`)
    const orderId = answer?.order?.orderId ?? answer?.orderId ?? null
    db.prepare('UPDATE pending_orders SET order_id=? WHERE id=? AND account_id=?').run(orderId == null ? null : String(orderId), pendingId, accountId)
    try {
      const { recordSubmitted } = await import('./opportunity-disposition.js')
      const row = db.prepare('SELECT risk_event_id FROM pending_orders WHERE id=?').get(pendingId)
      recordSubmitted(db, row.risk_event_id)
    } catch { /* the durable reservation and broker outcome remain authoritative */ }
    return { placed: true, orderId, limitPrice: p.entry, expiresAt: new Date(opts.expiresAtMs).toISOString(), reason: 'htf', intentId }
  } catch (error) {
    // Only a proven unsent/rejected intent releases capacity. A timeout or an
    // accepted order without an id retains its reservation across restarts.
    const state = intentId ? db.prepare('SELECT state FROM entry_intents WHERE id=? AND account_id=?').get(intentId, accountId)?.state : null
    if (pendingId && ['REJECTED', 'RELEASED', 'EXPIRED'].includes(state)) {
      db.prepare("UPDATE pending_orders SET status='cancelled',note=? WHERE id=? AND account_id=?")
        .run(`momentum limit: ${state}`, pendingId, accountId)
    }
    return refuse(error.message, proposal)
  }
}
