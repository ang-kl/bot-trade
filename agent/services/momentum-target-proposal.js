import { createHash } from 'node:crypto'
import { marketIdentity, marketIdentityKey } from '../lib/market-identity.js'
import { modelMomentumCost } from './momentum-target-cost.js'
import { planMomentumTargets } from './momentum-target-policy.js'

// Pure proposal boundary. These inputs must come from the runtime's fresh,
// account-scoped broker adapters, never symbol-only caches. Producing a
// candidate does not qualify a strategy or grant permission to send an order.
export function prepareMomentumTargetProposal(input, schedule) {
  const refuse = reason => ({ ok: false, executionAuthorized: false, reason })
  const identity = marketIdentity(input?.identity), key = marketIdentityKey(identity)
  const { nowMs, maxAgeMs, quote, symbolMeta: meta, conversion } = input || {}
  const fresh = n => Number.isSafeInteger(n) && n > 0 && n <= nowMs && nowMs - n <= maxAgeMs
  if (!identity || !Number.isSafeInteger(nowMs) || !(maxAgeMs > 0) || maxAgeMs > 10000)
    return refuse('identity_and_freshness_required')
  if (marketIdentityKey(quote) !== key || quote?.source !== 'broker_spot'
    || !fresh(quote.observedAtMs) || !fresh(quote.receivedAtMs)
    || !Number.isFinite(quote.bid) || !(quote.bid > 0) || !Number.isFinite(quote.ask) || quote.ask < quote.bid)
    return refuse('fresh_owned_quote_required')
  if (marketIdentityKey(meta) !== key || meta?.source !== 'broker_symbol' || !fresh(meta.receivedAtMs))
    return refuse('fresh_owned_symbol_required')
  if (!['BUY', 'SELL'].includes(input.side) || input.entry !== (input.side === 'BUY' ? quote.ask : quote.bid))
    return refuse('proposal_quote_price_mismatch')
  if (typeof input.symbol !== 'string' || !input.symbol.trim()) return refuse('symbol_required')
  // USD identity is exact. Other conversions must carry their own account,
  // host, instrument and broker quote time; unknown rates never become 1.
  const usd = conversion?.quoteAsset === 'USD' && conversion.quoteUsdRate === 1 && conversion.source === 'usd_identity'
  const converted = conversion?.source === 'broker_spot_conversion'
    && marketIdentity(conversion)?.host === identity.host && marketIdentity(conversion)?.accountId === identity.accountId
    && typeof conversion.quoteAsset === 'string' && conversion.quoteAsset !== 'USD'
    && fresh(conversion.observedAtMs) && fresh(conversion.receivedAtMs)
    && Number.isFinite(conversion.quoteUsdRate) && conversion.quoteUsdRate > 0
  if ((!usd && !converted) || meta.quoteAsset !== conversion?.quoteAsset) return refuse('quote_currency_conversion_required')
  const direction = input.side === 'BUY' ? 1 : -1
  const cost = modelMomentumCost({ symbol: input.symbol, side: input.side, entry: input.entry,
    initialRisk: direction * (input.entry - input.originalStop), requiredRr: input.requiredRr,
    spread: quote.ask - quote.bid, quoteUsdRate: conversion.quoteUsdRate,
    lotSize: meta.lotSize, minVolume: meta.minVolume, digits: meta.digits,
    carryingCostReservePrice: input.carryingCostReservePrice }, schedule)
  if (!cost.ok) return refuse(cost.reason)
  const plan = planMomentumTargets({ side: input.side, entry: input.entry, originalStop: input.originalStop,
    requiredRr: input.requiredRr, costReservePrice: cost.costReservePrice, digits: meta.digits,
    volume: input.volume, minVolume: meta.minVolume, stepVolume: meta.stepVolume })
  if (!plan.ok) return refuse(plan.reason)
  const evidence = { identity, symbol: input.symbol, quote: { bid: quote.bid, ask: quote.ask,
    observedAtMs: quote.observedAtMs, receivedAtMs: quote.receivedAtMs }, symbolMeta: {
    lotSize: meta.lotSize, minVolume: meta.minVolume, stepVolume: meta.stepVolume, digits: meta.digits,
    receivedAtMs: meta.receivedAtMs, quoteAsset: meta.quoteAsset }, conversion: {
      quoteAsset: conversion.quoteAsset, quoteUsdRate: conversion.quoteUsdRate, source: conversion.source,
      ...(converted ? { identity: marketIdentity(conversion), observedAtMs: conversion.observedAtMs, receivedAtMs: conversion.receivedAtMs } : {}) }, cost, plan }
  return { ok: true, executionAuthorized: false, identity, plan, cost, evidence,
    evidenceId: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    synth: { tp1: plan.brokerTarget, tp2: plan.mode === 'partial_runner' ? plan.brokerTarget : null,
      partialTrigger: plan.mode === 'partial_runner' ? plan.trigger : null } }
}
