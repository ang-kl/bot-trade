// ---------------------------------------------------------------------------
// agent/services/momentum-entry-producer.js — V3 T4 (P0-3): a momentum market
// entry carries the partial-TP1 plan.
//
// WHAT RUNS, AND WHEN. Nothing here runs unless config/momentum-entries.json
// says `"market": true` (momentum-entry-switch.js), which it does not: the
// owner has not answered OD-1. autoTrade (loop.js) asks the switch for the
// calling producer and, only when it is on for a momentum producer:
//
//   1. refuses a momentum entry into a CLOSED market by name
//      (MOMENTUM_CLOSED_MARKET_REFUSAL; OD-1(b): no pre-order is rested);
//   2. refuses a momentum entry that would REST as an HTF limit by name
//      (MOMENTUM_RESTING_LIMIT_REFUSAL; resting momentum limits carry no plan
//      until P0-4, and wait for OD-15);
//   3. before the risk gate, reads the account's own broker evidence and
//      shows the gate the plan's prices (preGatePlan): the entry at the live
//      quote, the stop exactly as relativePoints will send it, TP1 at the
//      partial trigger and TP2 at the runner target;
//   4. after sizing, re-reads fresh evidence with the quote last and builds
//      the plan with the integer broker volume (finalPlan). The trades row is
//      INSERTed with the plan's entry, stop and broker target, and
//      recordMomentumEntry runs in the same transaction;
//   5. after the send, marks the intent AWAITING_BIND with the broker's
//      position and tries to bind it from a live position read
//      (bindMomentumFill). A bind that cannot be proven now stays
//      AWAITING_BIND: the book takes the position (its broker stop and runner
//      target are already on it) and the partial pass binds it later
//      (bindAwaitingMomentumEntries). Deferred binding is the owner's H-P0-5
//      "yes" (OD-3): two atomic steps, not one.
//
// WHAT IT NEVER DOES. It changes no risk limit, cap, threshold or TP1 rule.
// It never waives the mandatory broker-native target (the order it builds
// always carries one). It never rests an order. Swap follows the owner's OD-3
// answer: the broker's own nightly rate for this account and symbol, times
// the book's median holding nights, triple-swap aware, and a positive swap
// never lowers the reserve.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { marketIdentity } from '../lib/market-identity.js'
import { modelMomentumCost } from './momentum-target-cost.js'
import { momentumTargetPrices, offPriceGrid } from './momentum-target-policy.js'
import { prepareMomentumTargetProposal } from './momentum-target-proposal.js'
import { freshBrokerStamp, partialPositionEvidence } from './momentum-broker-evidence.js'
import { readMomentumEntry, markMomentumAwaitingBind, bindMomentumEntry, enrollMomentumBook } from './momentum-entry-contract.js'
import { TICK_SHADOW_SIM_FILE } from '../lib/tick-cost-schedule.js'

export const MOMENTUM_CLOSED_MARKET_REFUSAL = 'momentum_closed_market_entry'
export const MOMENTUM_RESTING_LIMIT_REFUSAL = 'momentum_resting_limit_held'
export const MOMENTUM_PLAN_REFUSAL = 'momentum_plan_refused'
export const EVIDENCE_MAX_AGE_MS = 5000

/** The named refusal for a momentum entry into a closed market (OD-1(b)). */
export function closedMarketMomentumRefusal({ symbol, producerId, marketReason = null }) {
  return `${MOMENTUM_CLOSED_MARKET_REFUSAL}: ${symbol} market closed${marketReason ? ` (${marketReason})` : ''} — a ${producerId} entry is not rested for the next open (owner OD-1(b): closed-market momentum limits stay off until PO-M1–M3 and an explicit order)`
}

/** The named refusal for a momentum entry that would rest as an HTF limit. */
export function restingMomentumRefusal({ symbol, producerId, timeframe = null }) {
  return `${MOMENTUM_RESTING_LIMIT_REFUSAL}: ${symbol}${timeframe ? ` ${timeframe}` : ''} would rest as a limit — a resting ${producerId} entry carries no partial-TP1 plan yet (P0-4) and waits for the owner's OD-15 (resting orders count toward the caps)`
}

const finite = n => typeof n === 'number' && Number.isFinite(n)
const idOf = v => (typeof v === 'string' && /^[1-9]\d*$/.test(v)) || (Number.isSafeInteger(v) && v > 0) ? String(v) : null

// ---------------------------------------------------------------------------
// Swap (OD-3: broker rate × median nights)
// ---------------------------------------------------------------------------
// ProtoOASwapCalculationType. The proto default is PIPS, and ProtoJSON omits a
// field at its default, so an absent type reads as PIPS (inference from the
// proto definition, recorded on every plan as `typeAssumed`).
const SWAP_TYPES = { 0: 'PIPS', PIPS: 'PIPS', 1: 'PERCENTAGE', PERCENTAGE: 'PERCENTAGE', 2: 'POINTS', POINTS: 'POINTS' }

/** The carry reserve in price units per unit of volume. The broker's nightly
 * rate for the side, times nights: the median nights plus two more for every
 * triple-swap day that holding can span (ceil(nights / 7), conservative). A
 * positive rate is a credit and never lowers the reserve. PERCENTAGE is an
 * annual rate on the price over 360 days (the larger of the two conventions).
 * Pure. */
export function swapCarryReserve({ side, swapLong, swapShort, swapCalculationType, pipPosition, digits, price, medianNights }) {
  const fail = reason => ({ ok: false, reason })
  const rate = side === 'BUY' ? swapLong : side === 'SELL' ? swapShort : undefined
  if (!finite(rate)) return fail('swap_rate_unavailable')
  const typeAssumed = swapCalculationType == null
  const type = typeAssumed ? 'PIPS' : SWAP_TYPES[swapCalculationType]
  if (!type) return fail('swap_calculation_type_unknown')
  if (!Number.isSafeInteger(medianNights) || medianNights < 0) return fail('swap_nights_unavailable')
  const charge = Math.max(0, -rate)
  let perNight
  if (type === 'PIPS') {
    if (!Number.isInteger(pipPosition) || pipPosition < 0 || pipPosition > 10) return fail('swap_pip_size_unavailable')
    perNight = charge * 10 ** -pipPosition
  } else if (type === 'POINTS') {
    if (!Number.isInteger(digits) || digits < 0 || digits > 10) return fail('swap_point_size_unavailable')
    perNight = charge * 10 ** -digits
  } else {
    if (!finite(price) || !(price > 0)) return fail('swap_price_unavailable')
    perNight = price * charge / 100 / 360
  }
  const tripleExtra = medianNights > 0 ? 2 * Math.ceil(medianNights / 7) : 0
  const nights = medianNights + tripleExtra
  const reserve = Math.ceil(perNight * nights * 1e10) / 1e10
  if (!finite(reserve) || reserve < 0) return fail('swap_reserve_unbounded')
  return { ok: true, carryingCostReservePrice: reserve,
    basis: { type, typeAssumed, rate, chargePerNight: perNight, medianNights, tripleExtra, nights, credit: rate > 0 } }
}

/** The book's median holding, in whole nights, over every closed book row on
 * every account (the upper median: the longer of the two middle holdings). */
export function medianBookHoldingNights(db) {
  let rows = []
  try {
    rows = db.prepare(`SELECT entered_at, exited_at FROM momentum_book WHERE status = 'closed' AND exited_at IS NOT NULL`).all()
  } catch { return null }
  const nights = rows.map(r => {
    const a = Date.parse(r.entered_at), b = Date.parse(r.exited_at)
    return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.ceil((b - a) / 86_400_000) : null
  }).filter(n => n != null).sort((x, y) => x - y)
  if (!nights.length) return null
  return { nights: nights[Math.floor(nights.length / 2)], n: nights.length }
}

// ---------------------------------------------------------------------------
// Evidence, read from this account's own broker session
// ---------------------------------------------------------------------------
async function defaultTransports() {
  const ws = await import('../lib/ctrader-ws.js')
  const { readMomentumTimedQuote } = await import('./momentum-timed-quote.js')
  return {
    symbolsList: (c) => ws.wsGetSymbolsList(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, 30_000, { perAccount: true }),
    assets: (c) => ws.wsGetAssets(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId),
    symbolsById: (c, ids) => ws.wsSymbolsByIds(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, ids),
    quote: (c, symbolId, opts) => readMomentumTimedQuote(c, symbolId, opts),
    reconcile: (c) => ws.wsReconcile(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, 8000, 0),
  }
}

/** Which asset quotes this symbol, and which of the account's symbols
 * converts it to USD. Reference data from the account's own lists. */
export async function readEntryReference({ creds, symbolId, transports }) {
  const t = transports || await defaultTransports()
  const [list, assets] = await Promise.all([t.symbolsList(creds), t.assets(creds)])
  const names = new Map((assets?.asset || []).map(a => [String(a.assetId), String(a.name || a.displayName || '')]))
  const light = (list?.symbol || []).find(s => String(s.symbolId) === String(symbolId))
  const quoteAsset = light?.quoteAssetId != null ? names.get(String(light.quoteAssetId)) || null : null
  if (!quoteAsset) return { ok: false, reason: 'quote_asset_unknown' }
  if (quoteAsset === 'USD') return { ok: true, quoteAsset, conversion: null }
  const usd = [...names].find(([, n]) => n === 'USD')?.[0] ?? null
  const q = String(light.quoteAssetId)
  const pairs = (list?.symbol || []).filter(s => s.enabled !== false && usd != null)
  const direct = pairs.find(s => String(s.baseAssetId) === q && String(s.quoteAssetId) === usd)
  const inverse = pairs.find(s => String(s.baseAssetId) === usd && String(s.quoteAssetId) === q)
  const conv = direct || inverse
  if (!conv) return { ok: false, reason: 'quote_currency_conversion_required' }
  return { ok: true, quoteAsset, conversion: { symbolId: String(conv.symbolId), invert: !direct } }
}

function quoteFrom(raw, identity, nowMs) {
  if (!raw || idOf(raw.ctidTraderAccountId) !== identity.accountId || idOf(raw.symbolId) !== identity.symbolId
    || !freshBrokerStamp(raw.timestamp, { nowMs, maxAgeMs: EVIDENCE_MAX_AGE_MS })
    || !Number.isSafeInteger(raw.bid) || !Number.isSafeInteger(raw.ask) || raw.bid <= 0 || raw.ask < raw.bid) return null
  return { ...identity, bid: raw.bid / 100000, ask: raw.ask / 100000, observedAtMs: raw.timestamp, receivedAtMs: nowMs, source: 'broker_spot' }
}

/** Fresh evidence, fetched in order with the quote LAST: the symbol (meta
 * and swap) and the conversion quote first, the traded quote at the end, so
 * the quote is the youngest input when the intent is recorded. */
export async function readEntryEvidence({ creds, symbolId, reference, transports, now = Date.now }) {
  const t = transports || await defaultTransports()
  const identity = marketIdentity({ host: creds?.host, accountId: creds?.accountId, symbolId })
  if (!identity) return { ok: false, reason: 'identity_required' }
  const t0 = now()
  const sym = await t.symbolsById(creds, [symbolId])
  const s = (sym?.symbol || []).find(x => String(x.symbolId) === identity.symbolId)
  const metaAt = now()
  const lotSize = Number(s?.lotSize), minVolume = Number(s?.minVolume), stepVolume = Number(s?.stepVolume)
  if (!s || !Number.isSafeInteger(lotSize) || !Number.isSafeInteger(minVolume) || !Number.isSafeInteger(stepVolume)
    || !Number.isInteger(s.digits)) return { ok: false, reason: 'fresh_owned_symbol_required' }
  const symbolMeta = { ...identity, quoteAsset: reference.quoteAsset, lotSize, minVolume, stepVolume, digits: s.digits,
    pipPosition: Number.isInteger(s.pipPosition) ? s.pipPosition : null, receivedAtMs: metaAt, source: 'broker_symbol' }
  const swap = { swapLong: s.swapLong, swapShort: s.swapShort, swapCalculationType: s.swapCalculationType ?? null, swapRollover3Days: s.swapRollover3Days ?? null }
  let conversion
  if (!reference.conversion) conversion = { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' }
  else {
    const cid = marketIdentity({ ...identity, symbolId: reference.conversion.symbolId })
    const cq = quoteFrom(await t.quote(creds, reference.conversion.symbolId, { now, maxAgeMs: EVIDENCE_MAX_AGE_MS }), cid, now())
    if (!cq) return { ok: false, reason: 'quote_currency_conversion_required' }
    const mid = (cq.bid + cq.ask) / 2
    conversion = { ...cid, quoteAsset: reference.quoteAsset, quoteUsdRate: reference.conversion.invert ? 1 / mid : mid,
      source: 'broker_spot_conversion', observedAtMs: cq.observedAtMs, receivedAtMs: cq.receivedAtMs }
  }
  const quote = quoteFrom(await t.quote(creds, identity.symbolId, { now, maxAgeMs: EVIDENCE_MAX_AGE_MS }), identity, now())
  if (!quote) return { ok: false, reason: 'fresh_owned_quote_required' }
  return { ok: true, identity, symbolMeta, conversion, quote, swap, latencyMs: now() - t0 }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------
/** The stop exactly as the order will send it: relativePoints rounds the
 * approved distance to whole ticks, and the broker places it that far from
 * the fill. Built from the entry's ticks, so it is on the grid. */
export function gridStop({ side, entry, stopDistance, digits, relativePoints }) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 5 || !finite(entry) || !(entry > 0)
    || !finite(stopDistance) || !(stopDistance > 0) || offPriceGrid(entry, digits)) return null
  const points = relativePoints(stopDistance, digits)
  const ticks = points / 10 ** (5 - digits)
  if (!Number.isSafeInteger(ticks) || ticks <= 0) return null
  const entryTicks = Math.round(entry * 10 ** digits)
  const stopTicks = side === 'BUY' ? entryTicks - ticks : entryTicks + ticks
  return stopTicks > 0 ? { stop: stopTicks / 10 ** digits, ticks, points } : null
}

export function loadMomentumCostSchedule(file = TICK_SHADOW_SIM_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function carryFor(db, { side, evidence, entry, medianNights }) {
  const median = medianNights ?? medianBookHoldingNights(db)
  if (!median) return { ok: false, reason: 'swap_median_nights_unavailable' }
  const carry = swapCarryReserve({ side, ...evidence.swap, pipPosition: evidence.symbolMeta.pipPosition,
    digits: evidence.symbolMeta.digits, price: entry, medianNights: median.nights })
  return carry.ok ? { ...carry, basis: { ...carry.basis, closedBookRows: median.n } } : carry
}

/** Step 3: the prices the risk gate is shown. No volume yet, so no mode. */
export function preGatePlan(db, { symbol, side, stopDistance, requiredRr, evidence, relativePoints, schedule, medianNights = null }) {
  const refuse = reason => ({ ok: false, reason })
  if (!evidence?.ok) return refuse(evidence?.reason || 'evidence_required')
  const entry = side === 'BUY' ? evidence.quote.ask : evidence.quote.bid
  const g = gridStop({ side, entry, stopDistance, digits: evidence.symbolMeta.digits, relativePoints })
  if (!g) return refuse(evidence.symbolMeta.digits > 5 ? 'relative_bracket_precision_unsupported' : 'stop_not_expressible')
  const carry = carryFor(db, { side, evidence, entry, medianNights })
  if (!carry.ok) return refuse(carry.reason)
  const cost = modelMomentumCost({ symbol, side, entry, initialRisk: Math.abs(entry - g.stop), requiredRr,
    spread: evidence.quote.ask - evidence.quote.bid, quoteUsdRate: evidence.conversion.quoteUsdRate,
    lotSize: evidence.symbolMeta.lotSize, minVolume: evidence.symbolMeta.minVolume, digits: evidence.symbolMeta.digits,
    carryingCostReservePrice: carry.carryingCostReservePrice }, schedule)
  if (!cost.ok) return refuse(cost.reason)
  const prices = momentumTargetPrices({ side, entry, originalStop: g.stop, requiredRr,
    costReservePrice: cost.costReservePrice, digits: evidence.symbolMeta.digits })
  if (!prices.ok) return refuse(prices.reason)
  return { ok: true, entry, stop: g.stop, trigger: prices.trigger, runnerTarget: prices.runnerTarget, carry }
}

/** Step 4: the plan, with the integer broker volume and fresh evidence. The
 * stop keeps the approved distance in whole ticks from the fresh entry, so
 * the risk the gate sized on is the risk the plan carries. */
export function finalPlan(db, { symbol, side, stopDistance, requiredRr, volume, evidence, relativePoints, schedule, medianNights = null, nowMs }) {
  const refuse = reason => ({ ok: false, reason })
  if (!evidence?.ok) return refuse(evidence?.reason || 'evidence_required')
  const meta = evidence.symbolMeta
  const entry = side === 'BUY' ? evidence.quote.ask : evidence.quote.bid
  const g = gridStop({ side, entry, stopDistance, digits: meta.digits, relativePoints })
  if (!g) return refuse(meta.digits > 5 ? 'relative_bracket_precision_unsupported' : 'stop_not_expressible')
  const carry = carryFor(db, { side, evidence, entry, medianNights })
  if (!carry.ok) return refuse(carry.reason)
  const proposal = prepareMomentumTargetProposal({ identity: evidence.identity, symbol, side, entry, originalStop: g.stop,
    volume, requiredRr, nowMs, maxAgeMs: EVIDENCE_MAX_AGE_MS, carryingCostReservePrice: carry.carryingCostReservePrice,
    quote: evidence.quote, symbolMeta: meta, conversion: evidence.conversion }, schedule)
  if (!proposal.ok) return refuse(proposal.reason)
  const p = proposal.plan
  // Carried beside the hashed evidence, never inside it: how the carry was
  // reached and how long the evidence took to read.
  const full = { ...proposal, carry: carry.basis, evidenceLatencyMs: evidence.latencyMs ?? null }
  return { ok: true, proposal: full, plan: p, lots: p.volume / meta.lotSize,
    relativeStopLoss: relativePoints(Math.abs(p.entry - p.originalStop), meta.digits),
    relativeTakeProfit: relativePoints(Math.abs(p.brokerTarget - p.entry), meta.digits) }
}

// ---------------------------------------------------------------------------
// The fill: deferred binding (OD-3 / H-P0-5 "yes")
// ---------------------------------------------------------------------------
/** Mark the intent AWAITING_BIND with the broker's position, then try to
 * bind it from live position reads (bounded). Returns { bound, intent,
 * reason }: a bind that is not proven now stays AWAITING_BIND for the
 * partial pass. Never throws for a bind refusal. */
export async function bindMomentumFill(db, { accountId, tradeId, positionId, creds, symbolId, transports, now = Date.now,
  attempts = 3, delayMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  markMomentumAwaitingBind(db, { accountId, tradeId, positionId })
  const t = transports || await defaultTransports()
  const identity = marketIdentity({ host: creds?.host, accountId: creds?.accountId, symbolId })
  let reason = 'position_not_read'
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs)
    try {
      const raw = await t.reconcile(creds)
      const nowMs = now()
      const position = partialPositionEvidence(raw, { identity, positionId: String(positionId), nowMs })
      if (!position) { reason = 'position_without_bracket_evidence'; continue }
      const intent = bindMomentumEntry(db, { accountId, tradeId, position, nowMs })
      return { bound: true, intent, reason: null }
    } catch (error) { reason = String(error?.message || error) }
  }
  return { bound: false, intent: readMomentumEntry(db, accountId, tradeId), reason }
}

/** The partial pass's half of deferred binding: every AWAITING_BIND intent
 * whose book row is open is read, bound and enrolled in one transaction.
 * Makes no broker call when no intent awaits. */
// When each awaiting intent was last read, so a fill that cannot bind (a
// multi-deal average, F8) is re-read at most once a minute, not every loop.
const lastDeferredRead = new Map()

export async function bindAwaitingMomentumEntries(db, { credsFor, transports, now = Date.now, minIntervalMs = 60_000 } = {}) {
  const out = []
  let waiting = []
  try {
    waiting = db.prepare(`SELECT i.account_id, i.trade_id, i.position_id, i.proposal_json FROM momentum_target_intents i
      JOIN momentum_book b ON b.trade_id = i.trade_id AND b.account_id = i.account_id AND b.status = 'open'
      WHERE i.state = 'AWAITING_BIND'`).all()
  } catch { return out }
  if (!waiting.length) return out
  const t = transports || await defaultTransports()
  for (const w of waiting) {
    const key = `${w.account_id}|${w.trade_id}`, at = now()
    if (Number.isFinite(lastDeferredRead.get(key)) && at - lastDeferredRead.get(key) < minIntervalMs) {
      out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: false, reason: 'read_within_interval' }); continue
    }
    lastDeferredRead.set(key, at)
    let proposal = null
    try { proposal = JSON.parse(w.proposal_json) } catch { /* reported below */ }
    const creds = credsFor ? credsFor(w.account_id) : null
    if (!creds?.ready || String(creds.accountId) !== w.account_id) { out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: false, reason: 'no_credentials' }); continue }
    const identity = marketIdentity(proposal?.identity)
    if (!identity || identity.host !== creds.host) { out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: false, reason: 'identity_mismatch' }); continue }
    try {
      const raw = await t.reconcile(creds)
      const nowMs = now()
      const position = partialPositionEvidence(raw, { identity, positionId: w.position_id, nowMs })
      if (!position) { out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: false, reason: 'position_without_bracket_evidence' }); continue }
      const mode = db.transaction(() => {
        bindMomentumEntry(db, { accountId: w.account_id, tradeId: w.trade_id, position, nowMs })
        return enrollMomentumBook(db, { accountId: w.account_id, tradeId: w.trade_id, positionId: w.position_id })
      })()
      out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: true, mode })
    } catch (error) {
      out.push({ accountId: w.account_id, tradeId: w.trade_id, bound: false, reason: String(error?.message || error) })
    }
  }
  return out
}
