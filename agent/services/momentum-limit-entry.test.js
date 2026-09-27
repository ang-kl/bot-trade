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
      const r = c.entryLedger.reserve({ symbolId: p.symbolId, symbol: p.symbolName, side: p.tradeSide,
        orderType: 'LIMIT', volume: p.volume, sl: p.relativeStopLoss, tp: p.relativeTakeProfit,
        slUnits: 'relative_points', tpUnits: 'relative_points' })
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
