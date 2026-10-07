import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { attachEntryFence } from '../lib/ctrader-creds.js'
import { placeMomentumLimit } from './momentum-limit-entry.js'
import { countedPositionsWithTickFires, persistRiskEvent, persistPostApprovalVeto } from './risk.js'
import { restingExposure } from './resting-exposure.js'
import { readMomentumEntry, promoteMomentumLimitFill, promoteMomentumLimitFills, bindMomentumEntry, enrollMomentumBook } from './momentum-entry-contract.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { readPartialOwnership } from './momentum-partial-ownership.js'
import { reconcileStaleClosedMarketLimits } from './closed-market-limits.js'
import { bookEntryWrite } from './book-entry-write.js'
import { bindAwaitingMomentumEntries } from './momentum-entry-producer.js'
import { reconcilePositions } from './reconciler.js'

const accountId = '11', producerId = 'daily_momentum_account'
const synth = { consensus_bias: 'long', entry: 98, sl: 88, strategy: 'tsmom_long', timeframe: '1d', sizing: 'vol_target', sizedVolume: 100 }
function fixture(t, path = ':memory:') {
  const db = initDB(path); t.after(() => { if (db.open) db.close() })
  const now = Date.now()
  const creds = attachEntryFence(db, { accountId, host: 'demo.ctraderapi.com', ready: true }, { producerId })
  const sent = []
  const opts = { producerId, reason: 'htf', expiresAtMs: now + 3600000, clock: () => now,
    loadSwitch: () => ({ market: true, accounts: ['11'] }), marketGate: () => ({ open: true }),
    resolveSymbolId: async () => ({ id: '22' }), medianNights: { nights: 2, n: 5 },
    transports: {
      symbolsList: async () => ({ symbol: [{ symbolId: 22, quoteAssetId: 1 }] }),
      assets: async () => ({ asset: [{ assetId: 1, name: 'USD' }] }),
      symbolsById: async () => ({ symbol: [{ symbolId: 22, lotSize: 100, minVolume: 100, stepVolume: 100, digits: 2, pipPosition: 2, swapLong: 0, swapShort: 0 }] }),
      quote: async () => ({ ctidTraderAccountId: 11, symbolId: 22, bid: 9990000, ask: 10000000, timestamp: now }),
    },
    risk: { effectiveRrFloor: () => 3, loadRiskConfig: () => ({}), marginRateFor: () => null, getAccountLeverage: () => 100,
      evaluateTrade: () => countedPositionsWithTickFires(db, '11').counted.length >= 5
        ? { approved: false, veto_reason: 'max_positions=5/5' }
        : { approved: true, adjusted_volume: 100, checks: { margin_required_usd: 98 } },
      persistRiskEvent, persistPostApprovalVeto },
    exec: { placeOrder: async (c, p) => {
      // Codex · №11,673 (codex-footprint: signals-ui-2026-10-07): keep the simulated reservation on the fixture clock.
      const r = c.entryLedger.reserve({ symbolId: p.symbolId, symbol: p.symbolName, side: p.tradeSide,
        orderType: 'LIMIT', volume: p.volume, sl: p.relativeStopLoss, tp: p.relativeTakeProfit,
        slUnits: 'relative_points', tpUnits: 'relative_points', now })
      if (!r.ok) throw Error(r.reason)
      assert.ok(db.prepare('SELECT 1 FROM momentum_limit_intents WHERE intent_id=?').get(r.intentId), 'plan exists before transport')
      assert.equal(restingExposure(db, '11').length, 1, 'reservation already consumes capacity')
      assert.equal(c.entryLedger.redeem(r.permit.id).ok, true)
      c.entryLedger.markSent(r.intentId)
      sent.push({ p, r })
      c.entryLedger.resolve(r.intentId, { state: 'ACCEPTED', brokerOrderId: '900', source: 'response' })
      return { order: { orderId: 900 }, position: { positionId: 33 } }
    } },
  }
  return { db, now, creds, opts, sent, place: (patch = {}, signal = synth) => placeMomentumLimit(db, creds, 'ETHUSD', signal, { ...opts, ...patch }) }
}

test('resting entry stores the TP1 plan before sending, counts once and never binds an accepted position id', async t => {
  const f = fixture(t), result = await f.place()
  assert.equal(result.placed, true, result.reason)
  assert.equal(f.sent.length, 1)
  const row = f.db.prepare('SELECT * FROM pending_orders').get()
  const plan = JSON.parse(f.db.prepare('SELECT proposal_json FROM momentum_limit_intents').get().proposal_json)
  assert.equal(row.level, 98); assert.equal(row.tp, plan.plan.brokerTarget)
  assert.equal(f.sent[0].p.relativeTakeProfit, Math.round((row.tp - row.level) * 100000))
  assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 1)
  assert.equal(countedPositionsWithTickFires(f.db, '12').counted.length, 0)
  assert.equal(readMomentumEntry(f.db, '11', 7), null)
  assert.equal((await f.place()).skipped, 'already_working')
  assert.equal(f.sent.length, 1)
  assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.now + 7200000 }).stillWorking, 1)
})

test('closed/unknown market, unlisted account, stale evidence, wrong limit side and missing ledger cannot send', async t => {
  for (const patch of [
    { marketGate: () => ({ open: false }) }, { marketGate: () => ({ open: true, unknown: true }) },
    { reason: 'closed_market' }, { loadSwitch: () => ({ market: true, accounts: ['12'] }) },
    { expiresAtMs: 0 },
    { marketGate: final => ({ open: !final }) },
  ]) {
    const f = fixture(t)
    assert.equal((await f.place(patch)).placed, false)
    assert.equal(f.sent.length, 0)
  }
  const f = fixture(t)
  assert.equal((await f.place({}, { ...synth, entry: 101 })).placed, false)
  f.opts.transports.quote = async () => ({ ctidTraderAccountId: 12, symbolId: 22, bid: 9990000, ask: 10000000, timestamp: f.now })
  assert.equal((await f.place()).placed, false)
  assert.equal(f.sent.length, 0)
  const missing = fixture(t)
  delete missing.creds.entryLedger
  assert.equal((await missing.place()).reason, 'entry_ledger_required')
  const stale = fixture(t)
  stale.opts.transports.quote = async () => ({ ctidTraderAccountId: 11, symbolId: 22, bid: 9990000, ask: 10000000, timestamp: stale.now - 5001 })
  assert.equal((await stale.place()).placed, false)
  assert.equal(stale.sent.length, 0)
})

test('limit plans and reserved USD margin are identical on both registered account hosts', async t => {
  const plans = []
  for (const live of [false, true]) {
    const f = fixture(t)
    f.db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,?)').run('11', live ? 1 : 0)
    f.creds.host = live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
    const result = await f.place()
    assert.equal(result.placed, true, result.reason)
    const row = f.db.prepare('SELECT proposal_json,reserved_margin_usd FROM momentum_limit_intents').get()
    plans.push({ plan: JSON.parse(row.proposal_json).plan, margin: row.reserved_margin_usd })
  }
  assert.deepEqual(plans[0], plans[1])
})

test('mandatory plan write failure rolls back the permit and reservation and prevents transport', async t => {
  const f = fixture(t)
  f.db.exec('CREATE TABLE momentum_limit_intents(wrong TEXT)')
  const result = await f.place()
  assert.equal(result.placed, false)
  assert.equal(f.sent.length, 0)
  assert.equal(f.db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
  assert.equal(f.db.prepare('SELECT count(*) n FROM pending_orders').get().n, 0)
})

test('capacity consumed while evidence was read vetoes the final atomic reservation', async t => {
  const f = fixture(t)
  let reads = 0
  const original = f.opts.transports.quote
  f.opts.transports.quote = async (...args) => {
    if (++reads === 2) for (let n = 0; n < 5; n++) f.db.prepare("INSERT INTO pending_orders(symbol,account_id,dir,level,volume,status) VALUES(?,'11',1,10,1,'working')").run(`OTHER${n}`)
    return original(...args)
  }
  const result = await f.place()
  assert.equal(result.placed, false); assert.match(result.reason, /max_positions/)
  assert.equal(f.sent.length, 0)
})

test('a partial limit fill keeps its slot and margin when the broker order snapshot is absent', async t => {
  const f = fixture(t)
  assert.equal((await f.place()).placed, true)
  const stored = f.db.prepare('SELECT * FROM momentum_limit_intents').get()
  const proposal = JSON.parse(stored.proposal_json)
  f.db.prepare("UPDATE entry_intents SET state='FILLED',broker_position_id='33',resolution_source='event' WHERE id=?").run(stored.intent_id)
  f.db.prepare(`INSERT INTO trades(id,account_id,symbol,side,status,ctrader_position_id,origin,entry_price,sl_price,tp_price,volume,label_strategy,intent_id)
    VALUES(7,'11','ETHUSD','BUY','open','33','reconciler_adopted',98,88,?,50,'tsmom_long',?)`).run(proposal.plan.brokerTarget, stored.intent_id)
  f.db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
    VALUES('ETHUSD',7,'long',98,10,88,?,'11','tsmom_long')`).run(proposal.plan.brokerTarget)
  assert.equal(f.db.prepare('SELECT count(*) n FROM broker_orders').get().n, 0)
  assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 2)
  for (const nowMs of [f.now, f.now + 7200000]) {
    const swept = reconcileStaleClosedMarketLimits(f.db, { nowMs })
    assert.equal(swept.filled, 0, 'FILLED from a partial execution is not full-order proof')
    assert.equal(swept.stillWorking, 1)
    assert.equal(f.db.prepare('SELECT status FROM pending_orders').get().status, 'working')
    assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 2)
    assert.equal(restingExposure(f.db, '11')[0].reservedMarginUsd, stored.reserved_margin_usd)
  }
  // Once the same position proves the whole original volume, its exposure
  // replaces the reservation even if no broker_orders row was ever observed.
  f.db.prepare('UPDATE trades SET volume=100 WHERE id=7').run()
  assert.equal(reconcileStaleClosedMarketLimits(f.db).filled, 1)
  assert.equal(f.db.prepare('SELECT status FROM pending_orders').get().status, 'filled')
  assert.equal(restingExposure(f.db, '11').length, 0)
  assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 1)
})

test('a proven unfilled terminal limit releases its reservation without a broker order snapshot', async t => {
  for (const state of ['REJECTED', 'RELEASED', 'EXPIRED']) {
    const f = fixture(t)
    assert.equal((await f.place()).placed, true)
    f.db.prepare('UPDATE entry_intents SET state=?,resolution_source=?').run(state, 'event')
    const swept = reconcileStaleClosedMarketLimits(f.db)
    assert.equal(swept.expired, 1, state)
    assert.equal(swept.stillWorking, 0, state)
    assert.equal(restingExposure(f.db, '11').length, 0, state)
  }
})

test('a full open fill retains capacity until the same-account active monitor counts it', async t => {
  const f = fixture(t)
  assert.equal((await f.place()).placed, true)
  const stored = f.db.prepare('SELECT * FROM momentum_limit_intents').get()
  f.db.prepare("UPDATE entry_intents SET state='FILLED',broker_position_id='33',resolution_source='event' WHERE id=?").run(stored.intent_id)
  f.db.prepare(`INSERT INTO trades(id,account_id,symbol,side,status,ctrader_position_id,origin,entry_price,sl_price,tp_price,volume,label_strategy,intent_id)
    VALUES(7,'11','ETHUSD','BUY','open','33','reconciler_adopted',98,88,140,100,'tsmom_long',?)`).run(stored.intent_id)
  const held = () => {
    assert.equal(restingExposure(f.db, '11').length, 1)
    assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 1)
    assert.equal(reconcileStaleClosedMarketLimits(f.db).stillWorking, 1)
    assert.equal(restingExposure(f.db, '11')[0].reservedMarginUsd, stored.reserved_margin_usd)
  }
  held() // The trade write succeeded but monitor adoption has not completed.
  f.db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy,status)
    VALUES('ETHUSD',7,'long',98,10,88,140,'11','tsmom_long','closed')`).run()
  held()
  f.db.prepare("UPDATE monitored_positions SET status='active',account_id='12' WHERE trade_id=7").run()
  held()
  f.db.prepare('UPDATE monitored_positions SET account_id=NULL WHERE trade_id=7').run()
  held()
  f.db.prepare("UPDATE monitored_positions SET account_id='11' WHERE trade_id=7").run()
  assert.equal(reconcileStaleClosedMarketLimits(f.db).filled, 1)
  assert.equal(restingExposure(f.db, '11').length, 0)
  assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 1)
})

test('a confirmed full fill already closed can retire its reservation without an active monitor', async t => {
  const f = fixture(t)
  assert.equal((await f.place()).placed, true)
  const stored = f.db.prepare('SELECT * FROM momentum_limit_intents').get()
  f.db.prepare("UPDATE entry_intents SET state='FILLED',broker_position_id='33',resolution_source='event' WHERE id=?").run(stored.intent_id)
  f.db.prepare(`INSERT INTO trades(id,account_id,symbol,side,status,ctrader_position_id,origin,entry_price,sl_price,tp_price,volume,label_strategy,intent_id,closed_at)
    VALUES(7,'11','ETHUSD','BUY','closed','33','reconciler_adopted',98,88,140,100,'tsmom_long',?,?)`).run(stored.intent_id, new Date(f.now).toISOString())
  assert.equal(reconcileStaleClosedMarketLimits(f.db).filled, 1)
  assert.equal(restingExposure(f.db, '11').length, 0)
})

test('unknown send stays reserved across restart; delayed confirmed fill transfers once and binds from fresh broker evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'momentum-limit-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.db'), f = fixture(t, path)
  const send = f.opts.exec.placeOrder
  f.opts.exec.placeOrder = async (...args) => { await send(...args); throw Error('transport timed out after acceptance') }
  const result = await f.place()
  assert.equal(result.placed, false)
  const stored = f.db.prepare('SELECT * FROM momentum_limit_intents').get()
  f.db.close()
  const db = initDB(path); t.after(() => db.close())
  assert.equal(restingExposure(db, '11').length, 1)
  db.prepare(`INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,limit_price,status,label)
    VALUES('900','11','ETHUSD','BUY',100,98,'working',?)`).run(`PRE|v1|TM|H|NY|1d|TR|${stored.intent_id}`)
  assert.equal(restingExposure(db, '11').length, 1, 'a missing local order id still deduplicates through the ledger')
  db.prepare(`INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,limit_price,status,label)
    VALUES('901','11','ETHUSD','BUY',100,98,'working',?)`).run(`PRE|v1|TM|H|NY|1d|TR|${stored.intent_id}`)
  assert.equal(restingExposure(db, '11').length, 2, 'two broker orders remain two slots even with the same intent tag')
  const proposal = JSON.parse(stored.proposal_json), p = proposal.plan
  db.prepare(`INSERT INTO trades(id,account_id,symbol,side,status,ctrader_position_id,origin,entry_price,sl_price,tp_price,volume,label_strategy)
    VALUES(7,'11','ETHUSD','BUY','open','33','reconciler_adopted',98,88,?,100,'tsmom_long')`).run(p.brokerTarget)
  // A pre-created id attached to ACCEPTED is still not sufficient.
  db.prepare("UPDATE entry_intents SET broker_position_id='33' WHERE id=?").run(stored.intent_id)
  assert.equal(db.transaction(() => promoteMomentumLimitFill(db, { accountId: '11', tradeId: 7, positionId: '33' }))(), null)
  db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
    VALUES('ETHUSD',7,'long',98,10,88,?,'11','tsmom_long')`).run(p.brokerTarget)
  bookEntryWrite(db, { accountId: '11', row: { tradeId: 7, symbol: 'ETHUSD', positionId: '33', side: 'long', entry: 98, stop: 88, enteredAt: new Date(f.now).toISOString() } })
  db.prepare("UPDATE entry_intents SET state='FILLED',resolution_source='reconcile' WHERE id=?").run(stored.intent_id)
  db.prepare('UPDATE trades SET volume=50 WHERE id=7').run()
  assert.equal(restingExposure(db, '11').length, 2, 'a partial fill retains its remaining order and the distinct broker order')
  db.prepare("UPDATE pending_orders SET status='filled' WHERE intent_id=?").run(stored.intent_id)
  assert.equal(restingExposure(db, '11').find(r => r.orderId === '900').reservedMarginUsd, stored.reserved_margin_usd,
    'a working remainder retains the immutable reserve after the pending row is settled')
  db.prepare('UPDATE trades SET volume=100 WHERE id=7').run()
  const duplicate = restingExposure(db, '11')
  assert.equal(duplicate.length, 1, 'only the original fully filled order is replaced by its position')
  assert.equal(duplicate[0].orderId, '901')
  assert.equal(duplicate[0].reservedMarginUsd, null, 'a distinct order cannot borrow another order\'s margin plan')
  db.prepare("DELETE FROM broker_orders WHERE order_id='901'").run()
  assert.equal(promoteMomentumLimitFills(db).length, 1)
  assert.equal(promoteMomentumLimitFills(db).length, 0)
  assert.equal(restingExposure(db, '11').length, 0, 'position replaces reservation')
  assert.equal(countedPositionsWithTickFires(db, '11').counted.length, 1)
  const intent = readMomentumEntry(db, '11', 7)
  assert.equal(intent.created_at_ms, stored.created_at_ms)
  assert.equal(intent.proposal.evidenceId, proposal.evidenceId)
  const position = { ...proposal.identity, positionId: '33', side: 'BUY', entry: 98, volume: p.volume,
    stopLoss: 88, takeProfit: p.brokerTarget, observedAtMs: f.now + 3600000, source: 'broker_reconcile' }
  assert.throws(() => bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: { ...position, accountId: '12' }, nowMs: position.observedAtMs }), /evidence/)
  assert.equal(bindMomentumEntry(db, { accountId: '11', tradeId: 7, position, nowMs: position.observedAtMs }).state, 'BOUND')
  db.transaction(() => enrollMomentumBook(db, { accountId: '11', tradeId: 7, positionId: '33' }))()
  assert.equal(readPartialPlan(db, '11', 7).state, 'ARMED')
  assert.equal(readMomentumEntry(db, '11', 7).state, 'ENROLLED')
  assert.ok(readPartialOwnership(db, '11', 7, '33', 2))
  db.prepare("UPDATE trades SET intent_id='unrelated' WHERE id=7").run()
  assert.equal(readPartialOwnership(db, '11', 7, '33', 2), null, 'an origin label does not authorise a different lifecycle')
})

async function finalPartialFixture(t, status = 5, path = ':memory:', placePatch = {}) {
  const f = fixture(t, path)
  assert.equal((await f.place(placePatch)).placed, true)
  const stored = f.db.prepare('SELECT * FROM momentum_limit_intents').get()
  const proposal = JSON.parse(stored.proposal_json), p = proposal.plan
  f.db.prepare("UPDATE entry_intents SET state='FILLED',broker_position_id='33',resolution_source='event' WHERE id=?").run(stored.intent_id)
  f.db.prepare(`INSERT INTO trades(id,account_id,symbol,side,status,ctrader_position_id,origin,entry_price,sl_price,tp_price,volume,label_strategy,intent_id)
    VALUES(7,'11','ETHUSD','BUY','open','33','reconciler_adopted',98,88,?,50,'tsmom_long',?)`).run(p.brokerTarget, stored.intent_id)
  f.db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
    VALUES('ETHUSD',7,'long',98,10,88,?,'11','tsmom_long')`).run(p.brokerTarget)
  bookEntryWrite(f.db, { accountId: '11', row: { tradeId: 7, symbol: 'ETHUSD', positionId: '33', side: 'long', entry: 98, stop: 88, enteredAt: new Date(f.now).toISOString() } })
  const nowMs = f.now + 200
  const position = { ...proposal.identity, positionId: '33', side: 'BUY', entry: 98, volume: 5000,
    stopLoss: 88, takeProfit: p.brokerTarget, observedAtMs: nowMs, source: 'broker_reconcile' }
  const limitFinalFill = {
    detailsReceivedAtMs: f.now + 100, reconcileStartedAtMs: f.now + 101,
    details: { ctidTraderAccountId: 11, order: { orderId: 900, positionId: 33, orderType: 2,
      orderStatus: status, executedVolume: 5000, tradeData: { symbolId: 22, tradeSide: 1, volume: 10000 } },
    deal: [2500, 2500].map((volume, n) => ({ dealId: 81 + n, orderId: 900, positionId: 33, symbolId: 22,
      tradeSide: 1, dealStatus: 2, volume, filledVolume: volume, executionPrice: 98, executionTimestamp: f.now + 50 + n })) },
    reconcile: { ctidTraderAccountId: 11, order: [], position: [{ positionId: 33, positionStatus: 1, price: 98,
      stopLoss: 88, takeProfit: p.brokerTarget, tradeData: { symbolId: 22, tradeSide: 1, volume: 5000 } }] },
  }
  return { ...f, stored, proposal, p, nowMs, position, limitFinalFill,
    bind: () => bindMomentumEntry(f.db, { accountId: '11', tradeId: 7, position, nowMs, limitFinalFill }) }
}

test('delayed partial-fill setup uses one clock and still rejects fills before reservation', async t => {
  const f = await finalPartialFixture(t, 5, ':memory:', {
    resolveSymbolId: async () => { await new Promise(resolve => setTimeout(resolve, 130)); return { id: '22' } },
  })
  const intent = f.db.prepare('SELECT created_at FROM entry_intents WHERE id=?').get(f.stored.intent_id)
  assert.equal(Date.parse(intent.created_at), f.now, 'reservation shares the proposal, quote and fill fixture clock')
  f.limitFinalFill.details.deal[0].executionTimestamp = f.now - 1
  assert.throws(() => f.bind(), /final limit fill evidence/, 'a pre-reservation fill still fails the real evidence guard')
  f.limitFinalFill.details.deal[0].executionTimestamp = f.now + 50
  assert.equal(f.bind().state, 'BOUND')
})

test('a final partial entry enrolls TP1 and releases only its cancelled or expired remainder after counted ownership', async t => {
  for (const status of [4, 5]) {
    const f = await finalPartialFixture(t, status)
    assert.equal(restingExposure(f.db, '11').length, 1)
    const bound = f.bind()
    assert.equal(bound.state, 'BOUND')
    assert.equal(bound.plan.volume, 5000)
    assert.equal(bound.proposal.plan.volume, 10000, 'the original approval stays immutable')
    assert.equal(bound.plan.costReservePrice, f.p.costReservePrice)
    assert.equal(bound.plan.originalStop, f.p.originalStop)
    assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.nowMs }).stillWorking, 1, 'binding alone is not TP1 enrollment')
    f.db.transaction(() => enrollMomentumBook(f.db, { accountId: '11', tradeId: 7, positionId: '33' }))()
    const plan = readPartialPlan(f.db, '11', 7)
    assert.equal(plan.state, 'ARMED')
    assert.equal(plan.plan.volume, 5000)
    assert.ok(plan.plan.closeVolume > 0 && plan.plan.runnerVolume > 0)
    assert.equal(f.db.prepare('SELECT status FROM pending_orders WHERE id=?').get(f.stored.pending_id).status, 'filled')
    assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.nowMs }).stillWorking, 0)
    assert.equal(countedPositionsWithTickFires(f.db, '11').counted.length, 1)
    assert.equal(restingExposure(f.db, '11').length, 0)
  }
})

test('final partial entry uncertainty cannot bind TP1 or release reserved capacity', async t => {
  const cases = [
    ['still accepted', f => { f.limitFinalFill.details.order.orderStatus = 1 }],
    ['wrong account details', f => { f.limitFinalFill.details.ctidTraderAccountId = 12 }],
    ['wrong account snapshot', f => { f.limitFinalFill.reconcile.ctidTraderAccountId = 12 }],
    ['wrong order', f => { f.limitFinalFill.details.order.orderId = 901 }],
    ['wrong requested volume', f => { f.limitFinalFill.details.order.tradeData.volume = 9000 }],
    ['wrong type', f => { f.limitFinalFill.details.order.orderType = 1 }],
    ['closing order', f => { f.limitFinalFill.details.order.closingOrder = true }],
    ['wrong deal position', f => { f.limitFinalFill.details.deal[0].positionId = 34 }],
    ['wrong deal side', f => { f.limitFinalFill.details.deal[0].tradeSide = 2 }],
    ['wrong deal symbol', f => { f.limitFinalFill.details.deal[0].symbolId = 23 }],
    ['missing deal', f => { f.limitFinalFill.details.deal.pop() }],
    ['duplicate deal', f => { f.limitFinalFill.details.deal[1].dealId = 81 }],
    ['changed open volume', f => { f.limitFinalFill.details.order.executedVolume = 6000 }],
    ['closing deal', f => { f.limitFinalFill.details.deal[0].closePositionDetail = {} }],
    ['remaining order', f => { f.limitFinalFill.reconcile.order.push({ orderId: 900 }) }],
    ['old snapshot', f => { f.limitFinalFill.reconcileStartedAtMs = f.now + 99 }],
    ['future details', f => { f.limitFinalFill.detailsReceivedAtMs = f.nowMs + 1 }],
    ['old details', f => { f.limitFinalFill.detailsReceivedAtMs = f.now - 6000 }],
    ['future deal', f => { f.limitFinalFill.details.deal[0].executionTimestamp = f.nowMs + 1 }],
    ['different execution price', f => { f.limitFinalFill.details.deal[0].executionPrice = 99 }],
    ['fractional broker unit', f => { f.limitFinalFill.details.deal[0].filledVolume = 2499.5 }],
    ['broker error', f => { f.limitFinalFill.reconcile.errorCode = 'TIMEOUT' }],
    ['trade volume mismatch', f => { f.db.prepare('UPDATE trades SET volume=40 WHERE id=7').run() }],
    ['position grows after terminal details', f => {
      f.position.volume = 10000
      f.limitFinalFill.reconcile.position[0].tradeData.volume = 10000
    }],
  ]
  for (const [name, corrupt] of cases) {
    const f = await finalPartialFixture(t)
    corrupt(f)
    assert.throws(f.bind, /entry fill|limit fill/, name)
    assert.equal(readMomentumEntry(f.db, '11', 7).state, 'AWAITING_BIND', name)
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get(), undefined, name)
    assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.nowMs }).stillWorking, 1, name)
    assert.equal(restingExposure(f.db, '11')[0].reservedMarginUsd, f.stored.reserved_margin_usd, name)
  }
})

test('final partial receipt cannot hide a newer working remainder or another order, or release an uncounted position', async t => {
  const f = await finalPartialFixture(t)
  f.bind()
  f.db.prepare(`INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,limit_price,status,last_seen)
    VALUES('900','11','ETHUSD','BUY',50,98,'working',?)`).run(new Date(f.nowMs + 1).toISOString())
  assert.throws(() => f.db.transaction(() => enrollMomentumBook(f.db, { accountId: '11', tradeId: 7, positionId: '33' }))(), /proof changed/)
  assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.nowMs + 2 }).stillWorking, 1)
  assert.equal(restingExposure(f.db, '11').length, 1)
  f.db.prepare("UPDATE broker_orders SET status='gone' WHERE order_id='900'").run()
  f.db.prepare(`INSERT INTO broker_orders(order_id,account_id,symbol,side,volume,limit_price,status)
    VALUES('901','11','ETHUSD','BUY',50,98,'working')`).run()
  f.db.prepare("UPDATE monitored_positions SET account_id='12' WHERE trade_id=7").run()
  assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: f.nowMs }).stillWorking, 1)
  assert.throws(() => f.db.transaction(() => enrollMomentumBook(f.db, { accountId: '11', tradeId: 7, positionId: '33' }))(), /ownership/)
  f.db.prepare("UPDATE monitored_positions SET account_id='11' WHERE trade_id=7").run()
  f.db.transaction(() => enrollMomentumBook(f.db, { accountId: '11', tradeId: 7, positionId: '33' }))()
  assert.deepEqual(restingExposure(f.db, '11').map(r => r.orderId), ['901'])
})

test('a final partial below the runner minimum cannot adopt the original runner bracket as TP1', async t => {
  const f = await finalPartialFixture(t)
  f.position.volume = 100
  f.limitFinalFill.details.order.executedVolume = 100
  f.limitFinalFill.details.deal = [{ ...f.limitFinalFill.details.deal[0], volume: 100, filledVolume: 100 }]
  f.limitFinalFill.reconcile.position[0].tradeData.volume = 100
  f.db.prepare('UPDATE trades SET volume=1 WHERE id=7').run()
  assert.throws(f.bind, /bracket mismatch/)
  assert.equal(readMomentumEntry(f.db, '11', 7).state, 'AWAITING_BIND')
  assert.equal(restingExposure(f.db, '11').length, 1)
})

test('final partial enrollment transfers the reservation before TP1 can reduce the position on that same pass', async t => {
  const f = await finalPartialFixture(t)
  f.bind()
  f.db.transaction(() => enrollMomentumBook(f.db, { accountId: '11', tradeId: 7, positionId: '33' }))()
  assert.equal(f.db.prepare('SELECT status FROM pending_orders WHERE id=?').get(f.stored.pending_id).status, 'filled')
  const plan = readPartialPlan(f.db, '11', 7).plan
  f.db.prepare('UPDATE trades SET volume=? WHERE id=7').run(plan.runnerVolume / 100)
  assert.equal(restingExposure(f.db, '11').length, 0, 'a later owned partial cannot resurrect the cancelled remainder')
})

test('deferred runtime reads terminal details before a new snapshot and atomically enrolls a final partial', async t => {
  const f = await finalPartialFixture(t)
  const calls = []
  let clock = f.now + 50
  const transports = {
    reconcile: async c => { assert.equal(c.accountId, '11'); calls.push('reconcile'); clock += 10; return f.limitFinalFill.reconcile },
    orderDetails: async (c, orderId) => { assert.equal(c.accountId, '11'); assert.equal(orderId, '900'); calls.push('details'); clock += 10; return f.limitFinalFill.details },
  }
  const result = await bindAwaitingMomentumEntries(f.db, { credsFor: () => f.creds, transports, now: () => clock, minIntervalMs: 0 })
  assert.equal(result.length, 1)
  assert.equal(result[0].bound, true, result[0].reason)
  assert.deepEqual(calls, ['reconcile', 'details', 'reconcile'])
  assert.equal(readMomentumEntry(f.db, '11', 7).state, 'ENROLLED')
  assert.equal(readPartialPlan(f.db, '11', 7).plan.volume, 5000)
  assert.equal(reconcileStaleClosedMarketLimits(f.db, { nowMs: clock }).stillWorking, 0)
  assert.equal(f.db.prepare('SELECT status FROM pending_orders WHERE id=?').get(f.stored.pending_id).status, 'filled')
  const again = await bindAwaitingMomentumEntries(f.db, { credsFor: () => f.creds, transports, now: () => clock, minIntervalMs: 0 })
  assert.deepEqual(again, [])
  assert.equal(calls.length, 3, 'enrollment is idempotent')
})

test('final partial enrollment survives a restart with the same immutable plan and no recreated reservation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'momentum-final-partial-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.db'), f = await finalPartialFixture(t, 5, path)
  f.bind()
  f.db.close()
  const db = initDB(path)
  db.transaction(() => enrollMomentumBook(db, { accountId: '11', tradeId: 7, positionId: '33' }))()
  const before = readPartialPlan(db, '11', 7)
  db.close()
  const after = initDB(path); t.after(() => after.close())
  assert.deepEqual(readPartialPlan(after, '11', 7), before)
  assert.equal(readMomentumEntry(after, '11', 7).state, 'ENROLLED')
  assert.equal(restingExposure(after, '11').length, 0)
  assert.equal(countedPositionsWithTickFires(after, '11').counted.length, 1)
  assert.equal(reconcileStaleClosedMarketLimits(after).stillWorking, 0)
})

test('a final reservation write failure rolls back the deferred bind and TP1 enrollment together', async t => {
  const f = await finalPartialFixture(t)
  f.db.exec("CREATE TRIGGER fail_final_fill BEFORE UPDATE OF status ON pending_orders WHEN NEW.status='filled' BEGIN SELECT RAISE(ABORT, 'reservation_write_failed'); END")
  let clock = f.now + 60
  const result = await bindAwaitingMomentumEntries(f.db, { credsFor: () => f.creds, now: () => clock, minIntervalMs: 0,
    transports: {
      reconcile: async () => { clock += 10; return f.limitFinalFill.reconcile },
      orderDetails: async () => { clock += 10; return f.limitFinalFill.details },
    } })
  assert.equal(result[0].bound, false)
  assert.match(result[0].reason, /reservation_write_failed/)
  assert.equal(readMomentumEntry(f.db, '11', 7).state, 'AWAITING_BIND')
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get(), undefined)
  assert.equal(restingExposure(f.db, '11')[0].reservedMarginUsd, f.stored.reserved_margin_usd)
  assert.equal(f.db.prepare('SELECT status FROM pending_orders WHERE id=?').get(f.stored.pending_id).status, 'working')
})

test('an unresolved first partial cannot starve another order of the bounded details read', async t => {
  const f = await finalPartialFixture(t)
  const clone = (table, patch) => {
    const row = { ...f.db.prepare(`SELECT * FROM ${table} LIMIT 1`).get(), ...patch }
    const keys = Object.keys(row)
    f.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row))
  }
  clone('entry_intents', { id: 'second-entry', permit_id: 'second-permit', broker_order_id: '901', broker_position_id: '34' })
  clone('trades', { id: 8, intent_id: 'second-entry', ctrader_position_id: '34' })
  clone('pending_orders', { id: 100, intent_id: 'second-entry', order_id: '901' })
  clone('momentum_limit_intents', { intent_id: 'second-entry', trade_id: 8, pending_id: 100 })
  clone('momentum_target_intents', { trade_id: 8, position_id: '34' })
  clone('momentum_book', { id: 100, trade_id: 8, position_id: '34' })
  const snapshot = structuredClone(f.limitFinalFill.reconcile)
  snapshot.position.push({ ...snapshot.position[0], positionId: 34 })
  const reads = []
  let clock = f.now + 100
  const opts = { credsFor: () => f.creds, now: () => clock, minIntervalMs: 0,
    transports: {
      reconcile: async () => { clock += 10; return snapshot },
      orderDetails: async (c, orderId) => { reads.push(orderId); throw Error('order still working') },
    } }
  await bindAwaitingMomentumEntries(f.db, opts)
  assert.equal(reads.length, 1, 'one extra order investigation per pass')
  clock += 60_000
  await bindAwaitingMomentumEntries(f.db, opts)
  assert.equal(reads.length, 2)
  assert.deepEqual(new Set(reads), new Set(['900', '901']), 'both orders get a turn even when the first never resolves')
  assert.equal(f.db.prepare("SELECT count(*) n FROM momentum_target_intents WHERE state='AWAITING_BIND'").get().n, 2)
})


// A terminal snapshot can arrive after an earlier partial was already adopted.
// Keep all three local owners at that earlier fill, as production does.
function earlierLimitAdoption(f, entry = 98) {
  const shift = entry - f.p.entry, stop = f.p.originalStop + shift, target = f.p.brokerTarget + shift
  f.db.prepare('UPDATE trades SET volume=25,entry_price=?,sl_price=?,tp_price=?,broker_sl_initial=? WHERE id=7')
    .run(entry, stop, target, stop)
  f.db.prepare('UPDATE momentum_book SET entry_price=?,stop=? WHERE trade_id=7').run(entry, stop)
  f.db.prepare(`UPDATE monitored_positions SET entry_price=?,current_sl=?,current_tp=?,
    broker_sl=?,broker_tp=?,broker_volume_units=25 WHERE trade_id=7`).run(entry, stop, target, stop, target)
  f.limitFinalFill.details.deal[0].executionPrice = entry
  f.limitFinalFill.details.deal[1].executionPrice = 196 - entry
}

let laterFillClock = 0
async function bindLaterOpeningFill(f) {
  // The earlier fairness regression advances the module's read clock by a
  // minute. Use a monotonic clock across these isolated same-id databases.
  laterFillClock = Math.max(laterFillClock + 1000, f.now + 120_000)
  let clock = laterFillClock
  return bindAwaitingMomentumEntries(f.db, { credsFor: () => f.creds, now: () => clock, minIntervalMs: 0,
    transports: {
      reconcile: async () => { clock += 10; return f.limitFinalFill.reconcile },
      orderDetails: async () => { clock += 10; return f.limitFinalFill.details },
    } })
}

function adoptionRows(f) {
  return {
    trade: f.db.prepare('SELECT * FROM trades WHERE id=7').get(),
    book: f.db.prepare('SELECT * FROM momentum_book WHERE trade_id=7').get(),
    monitor: f.db.prepare('SELECT * FROM monitored_positions WHERE trade_id=7').get(),
    intent: readMomentumEntry(f.db, '11', 7),
    pending: f.db.prepare('SELECT * FROM pending_orders WHERE id=?').get(f.stored.pending_id),
  }
}

test('later same-order opening deals refresh an earlier adoption before final partial TP1 enrollment', async t => {
  for (const entry of [98, 97]) {
    const f = await finalPartialFixture(t)
    earlierLimitAdoption(f, entry)
    if (entry === 97) f.limitFinalFill.details.deal.reverse()
    const before = adoptionRows(f)
    const proposalJson = before.intent.proposal_json
    // A real account reconcile updates broker baselines but deliberately does
    // not reinterpret recorded fill volume or entry on an existing trade.
    reconcilePositions(f.db, f.limitFinalFill.reconcile.position.map(p => ({ ...p, symbolName: 'ETHUSD' })), [], () => {}, { accountId: '11' })
    assert.equal(f.db.prepare('SELECT volume FROM trades WHERE id=7').get().volume, 25)
    const result = await bindLaterOpeningFill(f)
    assert.equal(result[0].bound, true, result[0].reason)
    const after = adoptionRows(f), plan = readPartialPlan(f.db, '11', 7).plan
    assert.equal(after.trade.volume, 50)
    assert.equal(after.trade.entry_price, 98)
    assert.equal(after.trade.sl_price, 88)
    assert.equal(after.trade.tp_price, f.p.brokerTarget)
    assert.equal(after.book.entry_price, 98)
    assert.equal(after.book.stop, 88)
    assert.equal(after.monitor.entry_price, 98)
    assert.equal(after.monitor.initial_risk, before.monitor.initial_risk)
    assert.equal(after.monitor.current_sl, 88)
    assert.equal(after.monitor.current_tp, f.p.brokerTarget)
    assert.equal(after.monitor.broker_volume_units, 50)
    assert.equal(after.trade.broker_sl_initial, before.trade.broker_sl_initial, 'the first broker stop remains historical evidence')
    assert.equal(after.trade.risk_event_id, before.trade.risk_event_id)
    assert.equal(after.intent.proposal_json, proposalJson)
    assert.equal(plan.initialRisk, f.p.initialRisk)
    assert.equal(plan.costReservePrice, f.p.costReservePrice)
    assert.equal(plan.volume, 5000)
    assert.equal(after.intent.state, 'ENROLLED')
    assert.deepEqual(after.intent.fill.finalLimitFill.adoptionRefresh.dealIds, ['81'])
    assert.equal(after.intent.fill.finalLimitFill.adoptionRefresh.volume, 2500)
    assert.equal(after.intent.fill.finalLimitFill.adoptionRefresh.entry, entry)
    assert.equal(restingExposure(f.db, '11').length, 0)
    const receipt = after.intent.fill_json
    assert.deepEqual(await bindLaterOpeningFill(f), [])
    assert.equal(readMomentumEntry(f.db, '11', 7).fill_json, receipt, 'the successful migration receipt stays immutable')
  }
})

test('a later fill cannot reinterpret manual, ambiguous or differently owned local exposure', async t => {
  const cases = [
    ['unproven local volume', f => { f.db.prepare('UPDATE trades SET volume=40 WHERE id=7').run() }],
    ['reduced final volume', f => { f.db.prepare('UPDATE trades SET volume=60 WHERE id=7').run() }],
    ['unproven local entry', f => {
      for (const table of ['trades', 'momentum_book', 'monitored_positions']) {
        f.db.prepare(`UPDATE ${table} SET entry_price=96 WHERE ${table === 'trades' ? 'id' : 'trade_id'}=7`).run()
      }
    }],
    ['ambiguous same-time opening prefix', f => { f.limitFinalFill.details.deal[1].executionTimestamp = f.limitFinalFill.details.deal[0].executionTimestamp }],
    ['monitor ownership changed', f => { f.db.prepare("UPDATE monitored_positions SET account_id='12' WHERE trade_id=7").run() }],
    ['monitor resumed', f => { f.db.prepare('UPDATE monitored_positions SET paused=0 WHERE trade_id=7').run() }],
    ['guard acquired ownership', f => { f.db.prepare("UPDATE monitored_positions SET guard_json='{}' WHERE trade_id=7").run() }],
    ['book entry changed', f => { f.db.prepare('UPDATE momentum_book SET entry_price=96 WHERE trade_id=7').run() }],
    ['initial risk changed', f => { f.db.prepare('UPDATE monitored_positions SET initial_risk=9 WHERE trade_id=7').run() }],
    ['trade bracket changed', f => { f.db.prepare('UPDATE trades SET sl_price=90 WHERE id=7').run() }],
    ['book stop changed', f => { f.db.prepare('UPDATE momentum_book SET stop=90 WHERE trade_id=7').run() }],
    ['monitor target changed', f => { f.db.prepare('UPDATE monitored_positions SET current_tp=150 WHERE trade_id=7').run() }],
  ]
  for (const [name, mutate] of cases) {
    const f = await finalPartialFixture(t)
    earlierLimitAdoption(f, 97)
    mutate(f)
    const before = adoptionRows(f)
    const result = await bindLaterOpeningFill(f)
    assert.equal(result[0].bound, false, name)
    assert.notEqual(result[0].reason, 'read_within_interval', name)
    assert.deepEqual(adoptionRows(f), before, name)
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get(), undefined, name)
    assert.equal(restingExposure(f.db, '11').length, 1, name)
  }
})

test('later-fill anchor refresh rolls back with any ownership or reservation write failure', async t => {
  for (const table of ['trades', 'momentum_book', 'monitored_positions', 'pending_orders']) {
    const f = await finalPartialFixture(t)
    earlierLimitAdoption(f, 97)
    const before = adoptionRows(f)
    f.db.exec(`CREATE TRIGGER fail_adoption_refresh BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'adoption_write_failed'); END`)
    const result = await bindLaterOpeningFill(f)
    assert.equal(result[0].bound, false, table)
    assert.match(result[0].reason, /adoption_write_failed/, table)
    assert.deepEqual(adoptionRows(f), before, table)
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get(), undefined, table)
    assert.equal(restingExposure(f.db, '11').length, 1, table)
  }
})

test('later-fill migration requires a transaction and preserves its receipt across restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'momentum-later-fill-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.db'), f = await finalPartialFixture(t, 5, path)
  earlierLimitAdoption(f, 97)
  const before = adoptionRows(f)
  assert.throws(f.bind, /requires atomic handover/)
  assert.deepEqual(adoptionRows(f), before)
  assert.equal((await bindLaterOpeningFill(f))[0].bound, true)
  const receipt = readMomentumEntry(f.db, '11', 7).fill_json
  const plan = readPartialPlan(f.db, '11', 7)
  f.db.close()
  const after = initDB(path); t.after(() => after.close())
  assert.equal(readMomentumEntry(after, '11', 7).fill_json, receipt)
  assert.deepEqual(readPartialPlan(after, '11', 7), plan)
  assert.equal(after.prepare('SELECT volume FROM trades WHERE id=7').get().volume, 50)
  assert.equal(after.prepare('SELECT entry_price FROM momentum_book WHERE trade_id=7').get().entry_price, 98)
  assert.equal(after.prepare('SELECT entry_price FROM monitored_positions WHERE trade_id=7').get().entry_price, 98)
  assert.equal(restingExposure(after, '11').length, 0)
})

// R4 (the 03-10-2026 replays): the momentum HTF limit stamps the trend reading
// at evaluation on the proposal the gate judges, as the market path does.
test('R4: the trend reading at evaluation rides into the momentum limit proposal', async t => {
  const f = fixture(t)
  f.db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('ETHUSD', 'trending', 'long', datetime('now'))`).run()
  const seen = []
  const risk = { ...f.opts.risk, evaluateTrade: (db, proposal) => { seen.push(proposal); return f.opts.risk.evaluateTrade(db, proposal) } }
  const result = await f.place({ risk })
  assert.equal(result.placed, true, result.reason)
  assert.ok(seen.length >= 1)
  for (const p of seen) assert.deepEqual([p.trend_at_evaluation?.regime, p.trend_at_evaluation?.trend_direction, p.trend_at_evaluation?.stale], ['trending', 'long', false])
})
