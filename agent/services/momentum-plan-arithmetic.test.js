// T1 (V3 P0-1a): plan and bind arithmetic in ticks and integers.
//
// The P0 reviewer measured two refusals the #1079 tests could not show, because
// every fixture used integer geometry (100 -> 101, stop 90 -> 91):
//   - the fill-shifted stop was compared unrounded, so a BUY 265.87/247.77
//     filled at 265.91 compared the broker's 247.81 against
//     247.81000000000003 and refused ("entry fill bracket mismatch") — about
//     1 in 6 of 30,000 simulated slipped fills;
//   - the recorded lots were multiplied back by lotSize and compared with a
//     1e-8 tolerance, which FX's lotSize 1e7 misses by 1.49e-8 at 8.04 lots.
// These tests drive the real record -> bind -> book handover path with
// grid-snapped broker brackets, so a float comparison anywhere on it goes red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { anchorBracketToFill } from '../lib/fill-anchor.js'
import { prepareMomentumTargetProposal } from './momentum-target-proposal.js'
import { recordMomentumEntry, bindMomentumEntry, readMomentumEntry } from './momentum-entry-contract.js'
import { bookEntryWrite } from './book-entry-write.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { priceTicks } from './momentum-target-policy.js'

const now = 1790264000000
const schedule = JSON.parse(readFileSync(new URL('../config/tick-shadow-sim.json', import.meta.url)))
const identity = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }

// Deterministic PRNG (mulberry32), so a red run names a reproducible case.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Every price here is built from integer ticks, as a broker quotes it.
function propose({ symbol = 'ETHUSD', side, entryTicks, stopTicks, digits, spreadTicks = 1,
  lotSize = 100, volume = 10000, minVolume = 100, stepVolume = 100 }) {
  const f = 10 ** digits, entry = entryTicks / f
  const bid = side === 'BUY' ? (entryTicks - spreadTicks) / f : entry
  const ask = side === 'BUY' ? entry : (entryTicks + spreadTicks) / f
  return prepareMomentumTargetProposal({ identity, symbol, side, entry, originalStop: stopTicks / f,
    volume, requiredRr: 3, nowMs: now, maxAgeMs: 5000, carryingCostReservePrice: 0,
    quote: { ...identity, bid, ask, observedAtMs: now, receivedAtMs: now, source: 'broker_spot' },
    symbolMeta: { ...identity, lotSize, minVolume, stepVolume, digits, quoteAsset: 'USD', receivedAtMs: now, source: 'broker_symbol' },
    conversion: { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' } }, schedule)
}

// The producer's row, written the way autoTrade writes one: lots are the
// broker volume divided by lotSize (lot-sizing.js lotsToVolume).
function insertTrade(db, id, proposal) {
  const p = proposal.plan
  db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume)
    VALUES(?,?,?,'submitting','11','bot_market_dispatch',?,?,?,?,?)`)
    .run(id, proposal.evidence.symbol, p.side, id, p.entry, p.originalStop, p.brokerTarget, p.volume / proposal.evidence.symbolMeta.lotSize)
}

// cTrader anchors the relative SL/TP the order carried to the fill, in whole
// ticks: the bracket the broker holds is the planned one moved by the slippage.
function brokerFill(proposal, positionId, slipTicks, { stopTicksDelta = 0, targetTicksDelta = 0 } = {}) {
  const p = proposal.plan, d = p.digits, f = 10 ** d
  const fillTicks = priceTicks(p.entry, d) + slipTicks
  return { ...identity, positionId, side: p.side, entry: fillTicks / f, volume: p.volume,
    stopLoss: (priceTicks(p.originalStop, d) + slipTicks + stopTicksDelta) / f,
    takeProfit: (priceTicks(p.brokerTarget, d) + slipTicks + targetTicksDelta) / f,
    observedAtMs: now, source: 'broker_reconcile' }
}

test('the reviewer\'s named fill binds: BUY 265.87/247.77 filled at 265.91 holds the broker\'s 247.81', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const proposal = propose({ side: 'BUY', entryTicks: 26587, stopTicks: 24777, digits: 2 })
  assert.equal(proposal.ok, true, proposal.reason)
  // The float the old bind compared against, kept here as the evidence.
  assert.equal(247.77 + (265.91 - 265.87), 247.81000000000003)
  insertTrade(db, 7, proposal)
  recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
  const fill = brokerFill(proposal, '33', 4)
  assert.equal(fill.entry, 265.91); assert.equal(fill.stopLoss, 247.81)
  const bound = bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: fill, nowMs: now })
  assert.equal(bound.state, 'BOUND')
  assert.equal(bound.plan.originalStop, 247.81)
  assert.equal(bound.plan.brokerTarget, fill.takeProfit)
})

test('randomized 0/2/3/5-digit BUY and SELL fills with 1-5 ticks of slippage bind to the broker\'s grid bracket', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const random = rng(20260925)
  const pick = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  // Price bands per precision: 0-digit indices/coins, 2-digit stocks and
  // coins, 3-digit JPY crosses, 5-digit FX majors.
  const bands = { 0: [1000, 60000], 2: [1000, 500000], 3: [50000, 250000], 5: [50000, 200000] }
  let id = 0, cases = 0
  for (const digits of [0, 2, 3, 5]) {
    for (const side of ['BUY', 'SELL']) {
      for (let i = 0; i < 250; i++) {
        const entryTicks = pick(...bands[digits])
        const riskTicks = pick(5, Math.max(5, Math.floor(entryTicks * 0.04)))
        const stopTicks = side === 'BUY' ? entryTicks - riskTicks : entryTicks + riskTicks
        const proposal = propose({ side, entryTicks, stopTicks, digits, spreadTicks: pick(1, 5) })
        assert.equal(proposal.ok, true, `${digits}/${side}/${entryTicks}/${stopTicks}: ${proposal.reason}`)
        const slip = pick(1, 5) * (random() < 0.5 ? -1 : 1)
        const tradeId = ++id, positionId = String(1000 + tradeId)
        insertTrade(db, tradeId, proposal)
        recordMomentumEntry(db, { accountId: '11', tradeId, proposal, nowMs: now })
        const label = `digits ${digits} ${side} entry ${proposal.plan.entry} stop ${proposal.plan.originalStop} slip ${slip}`
        // A broker stop one tick WIDER than the shifted plan stop, or a target
        // one tick off, still refuses: the snap did not loosen the bind.
        const wider = side === 'BUY' ? -1 : 1
        assert.throws(() => bindMomentumEntry(db, { accountId: '11', tradeId, nowMs: now,
          position: brokerFill(proposal, positionId, slip, { stopTicksDelta: wider }) }), /bracket/, label)
        assert.throws(() => bindMomentumEntry(db, { accountId: '11', tradeId, nowMs: now,
          position: brokerFill(proposal, positionId, slip, { targetTicksDelta: 1 }) }), /bracket/, label)
        assert.equal(readMomentumEntry(db, '11', tradeId).state, 'PREPARED', label)
        const fill = brokerFill(proposal, positionId, slip)
        let bound
        assert.doesNotThrow(() => { bound = bindMomentumEntry(db, { accountId: '11', tradeId, position: fill, nowMs: now }) }, label)
        assert.equal(bound.state, 'BOUND', label)
        // The bound plan carries the broker's grid prices exactly, not a
        // float that is a few ulps beside them.
        assert.equal(bound.plan.originalStop, fill.stopLoss, label)
        assert.equal(bound.plan.brokerTarget, fill.takeProfit, label)
        assert.equal(bound.plan.entry, fill.entry, label)
        assert.equal(priceTicks(bound.plan.initialRisk, digits), riskTicks, label)
        cases++
      }
    }
  }
  assert.equal(cases, 2000)
})

test('a proposal for a symbol finer than five digits, or with Q under the gate floor, is refused before any record', () => {
  const six = propose({ side: 'BUY', entryTicks: 1100000, stopTicks: 1090000, digits: 6 })
  assert.equal(six.ok, false); assert.equal(six.reason, 'relative_bracket_precision_unsupported')
  assert.equal(propose({ side: 'BUY', entryTicks: 110000, stopTicks: 109000, digits: 5 }).ok, true)
  const f = 10 ** 2
  const low = prepareMomentumTargetProposal({ identity, symbol: 'ETHUSD', side: 'BUY', entry: 26587 / f, originalStop: 24777 / f,
    volume: 10000, requiredRr: 2.9, nowMs: now, maxAgeMs: 5000, carryingCostReservePrice: 0,
    quote: { ...identity, bid: 26586 / f, ask: 26587 / f, observedAtMs: now, receivedAtMs: now, source: 'broker_spot' },
    symbolMeta: { ...identity, lotSize: 100, minVolume: 100, stepVolume: 100, digits: 2, quoteAsset: 'USD', receivedAtMs: now, source: 'broker_symbol' },
    conversion: { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' } }, schedule)
  assert.equal(low.ok, false); assert.equal(low.reason, 'required_rr_below_hard_minimum')
})

test('an FX row at lotSize 1e7 records at every size from 0.01 to 10 lots', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const failures = []
  for (let steps = 1; steps <= 1000; steps++) {
    const volume = steps * 100000
    const proposal = propose({ symbol: 'EURUSD', side: 'BUY', entryTicks: 110000, stopTicks: 109000, digits: 5,
      lotSize: 10000000, volume, minVolume: 100000, stepVolume: 100000 })
    assert.equal(proposal.ok, true, proposal.reason)
    insertTrade(db, steps, proposal)
    try { recordMomentumEntry(db, { accountId: '11', tradeId: steps, proposal, nowMs: now }) } catch (err) { failures.push(`${steps / 100} lots: ${err.message}`) }
  }
  // (v / 1e7) * 1e7 misses v by 1.49e-8 at 8.04 lots, beyond the old 1e-8.
  assert.equal(Math.abs(8.04e7 / 1e7 * 1e7 - 8.04e7), 1.4901161193847656e-8)
  assert.deepEqual(failures, [])
  // Genuinely fractional broker units still refuse.
  db.prepare('UPDATE trades SET volume=? WHERE id=804').run(8.04 + 0.4 / 1e7)
  db.prepare('DELETE FROM momentum_target_intents WHERE trade_id=804').run()
  const proposal = propose({ symbol: 'EURUSD', side: 'BUY', entryTicks: 110000, stopTicks: 109000, digits: 5,
    lotSize: 10000000, volume: 80400000, minVolume: 100000, stepVolume: 100000 })
  assert.throws(() => recordMomentumEntry(db, { accountId: '11', tradeId: 804, proposal, nowMs: now }), /bracket/)
})

test('the producer\'s fill-anchored rows enroll the bound plan: ownership compares ticks, not float residue', t => {
  for (const side of ['BUY', 'SELL']) {
    const db = initDB(':memory:'); t.after(() => db.close())
    const proposal = side === 'BUY' ? propose({ side, entryTicks: 26587, stopTicks: 24777, digits: 2 })
      : propose({ side, entryTicks: 26587, stopTicks: 28397, digits: 2 })
    insertTrade(db, 7, proposal)
    recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
    const fill = brokerFill(proposal, '33', 4)
    const bound = bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: fill, nowMs: now })
    // autoTrade's own arithmetic (loop.js:986-993): the bracket re-anchored to
    // the fill as distances, and initial_risk from that anchored stop.
    const anchored = anchorBracketToFill({ side, proposalEntry: proposal.plan.entry, fill: fill.entry,
      sl: proposal.plan.originalStop, tp1: proposal.plan.brokerTarget })
    const producerRisk = Math.abs(fill.entry - anchored.sl)
    assert.notEqual(producerRisk, bound.plan.initialRisk, 'the fixture must carry float residue to test anything')
    db.prepare("UPDATE trades SET status='open',ctrader_position_id='33',entry_price=?,sl_price=?,tp_price=?,label_strategy='tsmom_long' WHERE id=7")
      .run(fill.entry, anchored.sl, anchored.tp1)
    const book = side === 'BUY' ? 'long' : 'short'
    db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
      VALUES('ETHUSD',7,?,?,?,?,?,'11','tsmom_long')`).run(book, fill.entry, producerRisk, anchored.sl, anchored.tp1)
    const result = bookEntryWrite(db, { accountId: '11', row: { tradeId: 7, symbol: 'ETHUSD', positionId: '33',
      side: book, entry: fill.entry, stop: anchored.sl, enteredAt: new Date(now).toISOString() } })
    assert.equal(result.targetPolicy, 'partial_runner', side)
    assert.equal(readMomentumEntry(db, '11', 7).state, 'ENROLLED', side)
    assert.deepEqual(readPartialPlan(db, '11', 7).plan, bound.plan)
  }
})
