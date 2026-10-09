// Codex · №12,252 · 2026-10-08; codex-footprint: capped-hybrid-profit.
// Bounded enrolment after fill, never an entry writer or an SL/TP amendment.
import { wsReconcile, wsSymbolsByIds, wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { partialPositionEvidence } from './momentum-broker-evidence.js'
import { sameTicks, stopHeld } from './momentum-target-policy.js'
import { registerPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { planCappedHybrid, readCappedHybridOwner, readCappedHybridVerdict } from './capped-hybrid-policy.js'
import { getState, setState } from '../db.js'
import { enrolManualHybrids } from './manual-hybrid-enrolment.js'

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
      // Codex · №12,260 · 2026-10-08; codex-footprint: capped-hybrid-review.
      // A FILLED entry may consist of several partially filled executions.
      // The complete owned order/position total below remains mandatory.
      || ![2, 3, 'FILLED', 'PARTIALLY_FILLED'].includes(d.dealStatus) || !integer(d.filledVolume)
      || !integer(d.volume) || d.filledVolume > d.volume || !(typeof d.executionPrice === 'number' && d.executionPrice > 0)
      || (d.tradeSide === 1 || d.tradeSide === 'BUY' ? 'BUY' : d.tradeSide === 2 || d.tradeSide === 'SELL' ? 'SELL' : null) !== owner.side) return null
    total += d.filledVolume; weighted += d.filledVolume * d.executionPrice; ids.push(id(d.dealId))
  }
  return integer(total) && total === held && new Set(ids).size === ids.length
    && sameTicks(weighted / total, owner.entry, digits) ? ids : null
}

export async function enrolCappedHybrids(db, { credsFor, now = Date.now, transports = {}, budgetMs = 12_000, maxCandidates = 8 } = {}) {
  // Codex · №12,559 · 2026-10-09; codex-footprint: hybrid-exclusion-verdicts.
  // Explanations cannot grant ownership. Keep the action query/order/budget;
  // inspect its excluded open rows separately, after the existing broker work.
  const cap = 128
  const out = { examined: 0, enrolled: [], deferred: [], errors: [], excluded: [], delegated: [],
    excludedTruncated: false, delegatedTruncated: false, excludedOmitted: 0, delegatedOmitted: 0 }, started = now()
  const record = (kind, t, reason, detail = {}) => {
    if (out[kind].length >= cap) { out[`${kind}Truncated`] = true; out[`${kind}Omitted`]++; return }
    out[kind].push({ accountId: t.account_id, tradeId: t.id, positionId: String(t.ctrader_position_id ?? ''),
      stage: kind === 'delegated' ? 'existing_plan' : 'ownership', observedAtMs: now(), reason, ...detail })
  }
  const existingPlan = t => {
    const held = table(db, 'momentum_partial_plans') && readPartialPlan(db, t.account_id, t.id)
    if (held) record('delegated', t, 'existing_partial_plan', { planState: held.state })
    return held
  }
  // Old lightweight fixtures / unavailable schema are not new runtime facts.
  if (!['trades', 'monitored_positions', 'entry_intents', 'accounts'].every(n => table(db, n))) {
    out.unavailableReason = 'schema_unavailable'; return out
  }
  let candidates = db.prepare(`SELECT t.id,t.account_id,t.ctrader_position_id FROM trades t
    JOIN monitored_positions m ON m.trade_id=t.id
    WHERE t.status='open' AND t.origin='bot_market_dispatch' AND m.status='active' AND m.paused=0
      AND m.guard_json IS NULL AND m.scaled_out=0 AND m.bank_partial_at IS NULL
    ORDER BY t.id`).all()
  const selected = new Set(candidates.map(t => t.id))
  const cursor = Number(getState(db, 'capped_hybrid_enrol_cursor')) || 0
  candidates = [...candidates.filter(t => t.id > cursor), ...candidates.filter(t => t.id <= cursor)]
  const bounded = async fn => {
    let timer
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('hybrid enrolment read deadline')), Math.min(5000, Math.max(1, budgetMs - (now() - started))))
    })]) } finally { clearTimeout(timer) }
  }
  for (const t of candidates) {
    if (existingPlan(t)) continue
    // Five digits is only a preliminary ownership comparison, never broker
    // precision for a plan. The exact broker precision is required below.
    const verdict = readCappedHybridVerdict(db, t.account_id, t.id, String(t.ctrader_position_id), 5)
    let owner = verdict.owner
    if (!owner) { record('excluded', t, verdict.reason, { monitorId: verdict.monitorId }); continue }
    if (out.examined >= maxCandidates || now() - started >= budgetMs) { out.deferred.push({ tradeId: t.id, reason: 'enrolment_budget' }); continue }
    out.examined++
    // A persistently unavailable first position must not starve other accounts.
    setState(db, 'capped_hybrid_enrol_cursor', String(t.id))
    const refuse = (reason, volumeInputs) => out.deferred.push({ tradeId: t.id, accountId: t.account_id, reason,
      ...(volumeInputs ? { volumeInputs } : {}) })
    try {
      const c = credsFor(t.account_id)
      if (!c?.ready || String(c.accountId) !== owner.accountId || c.host !== owner.host) { refuse('own_credentials_unavailable'); continue }
      const args = [c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId]
      const metadata = await bounded(() => (transports.symbols || wsSymbolsByIds)(...args, [owner.symbolId], 4000))
      if (id(metadata?.ctidTraderAccountId) !== owner.accountId) { refuse('symbol_account_unverified'); continue }
      const symbols = (metadata.symbol || []).filter(s => id(s.symbolId) === owner.symbolId)
      if (symbols.length !== 1) { refuse('symbol_metadata_unverified'); continue }
      const meta = symbols[0], digits = meta.digits, metadataReceivedAtMs = now()
      if (!Number.isInteger(digits) || digits < 0 || digits > 5) { refuse('broker_precision_required'); continue }
      owner = readCappedHybridOwner(db, t.account_id, t.id, String(t.ctrader_position_id), digits)
      if (!owner) { refuse('ownership_changed'); continue }
      const identity = { host: owner.host, accountId: owner.accountId, symbolId: owner.symbolId }
      const context = { identity, positionId: owner.positionId, nowMs: now() }
      const raw = await bounded(() => (transports.reconcile || wsReconcile)(...args, 4000, 0))
      const bp = partialPositionEvidence(raw, { ...context, nowMs: now() })
      if (!bp || bp.side !== owner.side || !sameTicks(bp.entry, owner.entry, digits)) { refuse('broker_position_unverified'); continue }
      // Claude · № 12,280 08-Oct (A·1; ordered "all three" after № 12,279; claude-builder).
      // The deal read's upper bound is the enrolment's own clock, never ahead of
      // it: measured 08-10 from 13:48Z, the live gateway's broker answered the
      // `now + 2 s` bound with INCORRECT_BOUNDARIES on every pass for trade 1771
      // (0003.HK on …3489), and the controller read failing for the hour. The
      // opening deal this read is after is minutes to days old; no skew is needed.
      const history = await bounded(() => (transports.deals || wsGetPositionDeals)(...args, owner.positionId, now(), 4000))
      const openingDealIds = openingReceipts(history, owner, bp.volume, digits)
      const plan = planCappedHybrid({ side: owner.side, entry: owner.entry, initialRisk: owner.initialRisk,
        brokerTarget: bp.takeProfit, volume: bp.volume, minVolume: meta.minVolume, stepVolume: meta.stepVolume, digits, openingDealIds })
      // Codex · №12,435 · 2026-10-09; codex-footprint: owned-hybrid-refusal-inputs.
      // Observation only, persisted by the existing pass writer. These are the
      // exact inputs already read for this account, not sizing recommendations.
      // Malformed metadata remains invalid; never coerce it or log arbitrary values.
      if (!plan.ok) {
        const observedNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : null
        refuse(plan.reason, { source: 'ordinary_enrolment_reads', units: 'ctrader_protocol_volume',
          host: owner.host, accountId: owner.accountId, positionId: owner.positionId, symbolId: owner.symbolId,
          side: owner.side, metadataReceivedAtMs, reconcileReceivedAtMs: bp.observedAtMs,
          volume: bp.volume, halfVolume: bp.volume / 2,
          minVolume: observedNumber(meta.minVolume), stepVolume: observedNumber(meta.stepVolume),
          minVolumeValid: integer(meta.minVolume), stepVolumeValid: integer(meta.stepVolume) })
        continue
      }
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
  // Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
  // Share the existing read budget; human fills retain their original records.
  const manual = await enrolManualHybrids(db, { credsFor, now, transports,
    budgetMs: Math.max(0, budgetMs - (now() - started)), maxCandidates: Math.max(0, maxCandidates - out.examined) })
  out.examined += manual.examined
  for (const kind of ['enrolled', 'deferred', 'errors']) out[kind].push(...manual[kind])
  try {
    const observed = db.prepare("SELECT id,account_id,ctrader_position_id FROM trades WHERE status='open' ORDER BY id LIMIT ?").all(cap + 1)
    out.coverage = { limit: cap, openTradesSampled: Math.min(observed.length, cap), openTradesTruncated: observed.length > cap }
    for (const t of observed.slice(0, cap)) {
      if (selected.has(t.id) || existingPlan(t)) continue
      const v = readCappedHybridVerdict(db, t.account_id, t.id, String(t.ctrader_position_id), 5)
      record('excluded', t, v.reason || 'candidate_not_selected', { monitorId: v.monitorId })
    }
  } catch { out.diagnosticError = 'diagnostic_read_failed' }
  return out
}
