import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { prepareMomentumTargetProposal } from './momentum-target-proposal.js'

const schedule = JSON.parse(readFileSync(new URL('../config/tick-shadow-sim.json', import.meta.url)))
const now = 1790264000000
const identity = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
const input = { identity, symbol: 'ETHUSD', side: 'BUY', entry: 100, originalStop: 90, volume: 10000, requiredRr: 3,
  nowMs: now, maxAgeMs: 5000, carryingCostReservePrice: 0.3,
  quote: { ...identity, bid: 99.9, ask: 100, observedAtMs: now - 100, receivedAtMs: now - 90, source: 'broker_spot' },
  symbolMeta: { ...identity, quoteAsset: 'USD', lotSize: 100, minVolume: 100, stepVolume: 100, digits: 2, receivedAtMs: now - 50, source: 'broker_symbol' },
  conversion: { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' },
}

test('target proposal binds formula, cost source and exact account/instrument inputs into a reproducible hash', () => {
  const r = prepareMomentumTargetProposal(input, schedule)
  assert.equal(r.ok, true); assert.equal(r.plan.mode, 'partial_runner')
  assert.equal(r.synth.tp1, r.plan.brokerTarget); assert.equal(r.synth.partialTrigger, r.plan.trigger)
  assert.equal(r.executionAuthorized, false)
  assert.equal(r.evidenceId, prepareMomentumTargetProposal(input, schedule).evidenceId)
  assert.notEqual(r.evidenceId, prepareMomentumTargetProposal({ ...input, carryingCostReservePrice: 0.4 }, schedule).evidenceId)
})

test('foreign, stale or invented quote/meta/conversion cannot construct a usable target', () => {
  for (const patch of [{ quote: { ...input.quote, accountId: '12' } },
    { quote: { ...input.quote, observedAtMs: now - 5001 } },
    { quote: { ...input.quote, source: 'local_cache' } },
    { symbolMeta: { ...input.symbolMeta, host: 'live.ctraderapi.com' } },
    { symbolMeta: { ...input.symbolMeta, digits: null } },
    { symbolMeta: { ...input.symbolMeta, receivedAtMs: now - 5001 } },
    { conversion: { quoteAsset: 'EUR', quoteUsdRate: 1, source: 'usd_identity' } },
    { symbolMeta: { ...input.symbolMeta, quoteAsset: 'EUR' } },
    { carryingCostReservePrice: undefined }, { entry: 101 }]) {
    assert.equal(prepareMomentumTargetProposal({ ...input, ...patch }, schedule).ok, false, JSON.stringify(patch))
  }
})

test('demo and live use identical arithmetic and minimum-lot fallback but different provenance', () => {
  const demo = prepareMomentumTargetProposal(input, schedule)
  const liveId = { ...identity, host: 'live.ctraderapi.com' }
  const live = prepareMomentumTargetProposal({ ...input, identity: liveId,
    quote: { ...input.quote, ...liveId }, symbolMeta: { ...input.symbolMeta, ...liveId } }, schedule)
  assert.deepEqual(demo.plan, live.plan); assert.notEqual(demo.evidenceId, live.evidenceId)
  const small = prepareMomentumTargetProposal({ ...input, volume: 100 }, schedule)
  assert.equal(small.plan.mode, 'whole_position_minimum')
  assert.equal(small.synth.tp1, small.plan.trigger)
})
