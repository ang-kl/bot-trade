import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { planMomentumTargets } from './momentum-target-policy.js'
import { registerPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'

const now = 1790264000000
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
function fixture(t, host = 'demo.ctraderapi.com') {
  const db = new Database(':memory:'); t.after(() => db.close())
  registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '33', plan, evidenceId: 'fixture', identity: { host, accountId: '11', symbolId: '22' } })
  const identity = { host, accountId: '11', symbolId: '22' }, creds = { ...identity, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  let volume = 10000, closes = 0, current = creds
  const transports = {
    now: () => now, readCredentials: () => current,
    reconcile: async (...args) => {
      assert.equal(args[0], host); assert.equal(args[4], '11'); assert.equal(args[6], 0)
      return { ctidTraderAccountId: '11', position: [{ positionId: '33', positionStatus: 'POSITION_STATUS_OPEN',
        price: 100, stopLoss: 95, takeProfit: 140.4, tradeData: { symbolId: '22', tradeSide: 'BUY', volume } }] }
    },
    quote: async (c, symbol) => { assert.equal(c.host, host); assert.equal(symbol, '22'); return {
      ctidTraderAccountId: '11', symbolId: '22', bid: 13040000, ask: 13050000, timestamp: now - 10,
    } },
    close: async (c, order) => {
      assert.equal(c.accountId, '11'); assert.deepEqual(order, { positionId: '33', volume: 2600 }); closes++; volume -= order.volume
      return { ctidTraderAccountId: '11', executionType: 'ORDER_FILLED', deal: { dealId: '44', orderId: '55', positionId: '33', symbolId: '22',
        tradeSide: 'SELL', dealStatus: 'FILLED', volume: 2600, filledVolume: 2600, executionPrice: 130.4,
        executionTimestamp: now, closePositionDetail: { entryPrice: 100, closedVolume: 2600 } } }
    },
  }
  const deps = makeMomentumPartialBroker(db, { identity, tradeId: 7 }, transports)
  deps.readOwnership = () => ({ accountId: '11', tradeId: 7, positionId: '33', status: 'open', owner: 'momentum_book', guardActive: false,
    entry: 100, initialRisk: 10, side: 'BUY' })
  return { db, creds, deps, closes: () => closes, rotate: () => { current = { ...creds, accessToken: 'rotated' } } }
}

test('actual manager plus broker adapter confirms one scoped partial on either environment', async t => {
  for (const host of ['demo.ctraderapi.com', 'live.ctraderapi.com']) {
    const f = fixture(t, host)
    assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'CONFIRMED')
    await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(f.closes(), 1)
  }
})

test('changed credentials or routing refuse before an action and never choose a primary account', async t => {
  for (const patch of [{ accountId: '12' }, { host: 'live.ctraderapi.com' }, { accessToken: 'foreign' }]) {
    const f = fixture(t)
    await assert.rejects(f.deps.close({ ...f.creds, ...patch }, { positionId: '33', volume: 2600 }, { attemptedAtMs: now }), /identity/)
    assert.equal(f.closes(), 0)
  }
  const f = fixture(t); f.rotate()
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).reason, 'preflight_unavailable')
  assert.equal(f.closes(), 0)
})
