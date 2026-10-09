// Codex · №12,587 · 2026-10-09; codex-footprint: manual-profit-hybrid.
// Real SQLite, ordinary pass, enrolment, native-event consumer and partial broker.
// Broker facts and native-shaped events are controlled boundary inputs. Native
// event production remains covered by the unchanged six-strategy native fixture.
// No bot entry intent or historical risk stamp is manufactured for manual rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { runMomentumPartialPass, readMomentumPartialPass } from './momentum-partial-runtime.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { hybridSpec, hybridGroups, processHybridTick } from './hybrid-tick-controller.js'

const AT = Date.UTC(2026, 9, 9, 7, 30)
const exists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

function manualScene(t, { side = 'BUY', live = false, accountId = live ? '42993489' : '43097342', volume = 10000 } = {}) {
  const path = join(tempDir('manual-hybrid-'), 'ledger.db')
  const f = { db: initDB(path), path, at: AT, accountId, live, side, volume, initialVolume: volume,
    sl: side === 'BUY' ? 98 : 102, tp: side === 'BUY' ? 140 : 60, bid: 100, ask: 100.1, reads: [], closes: [] }
  t.after(() => { try { f.db.close() } catch { /* already closed */ } })
  f.host = live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  f.creds = { accountId, host: f.host, ready: true, clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' }
  f.db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(accountId, live ? 1 : 0)
  setState(f.db, 'ctrader_account_id', '999')
  setState(f.db, 'symbol_id_map', JSON.stringify({ EURUSD: 99 }))
  setState(f.db, accountSymbolMapKey(accountId), JSON.stringify({ accountId, builtAt: new Date(AT).toISOString(), map: { EURUSD: 22 } }))
  f.db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,entry_price,sl_price,tp_price,volume,
    strategy,label_strategy,ctrader_position_id,intent_id,risk_event_id,source,opened_at)
    VALUES(7,'EURUSD',?,'open',?,'reconciler_adopted',100,?,?,0.01,NULL,NULL,'33',NULL,NULL,'external',?)`)
    .run(side, accountId, f.sl, f.tp, new Date(AT - 100000).toISOString())
  // Adoption saw an already tightened stop. Its risk is deliberately 2,
  // while the broker's original order below proves 10. Preserve both facts.
  f.db.prepare(`INSERT INTO monitored_positions(id,trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused) VALUES(8,7,?,'EURUSD',?,100,?,?,2,NULL,'external','active',0)`)
    .run(accountId, side === 'BUY' ? 'long' : 'short', f.sl, f.tp)
  f.opening = { dealId: '1', orderId: '55', positionId: '33', symbolId: '22', tradeSide: side,
    dealStatus: 'FILLED', volume, filledVolume: volume, executionPrice: 100, executionTimestamp: AT - 100000 }
  f.history = { ctidTraderAccountId: accountId, hasMore: false, deal: [structuredClone(f.opening)] }
  f.details = { ctidTraderAccountId: accountId, order: { orderId: '55', positionId: '33', orderType: 'MARKET',
    orderStatus: 'ORDER_STATUS_FILLED', executedVolume: volume, executionPrice: 100, closingOrder: false,
    relativeStopLoss: 1000000, utcLastUpdateTimestamp: AT - 100000,
    tradeData: { symbolId: '22', tradeSide: side, volume } }, deal: [structuredClone(f.opening)] }
  f.position = () => ({ positionId: '33', ctidTraderAccountId: accountId, positionStatus: 'POSITION_STATUS_OPEN', price: 100,
    stopLoss: f.sl, takeProfit: f.tp, tradeData: { symbolId: '22', tradeSide: side, volume: f.volume } })
  const check = args => { assert.equal(args[0], f.host); assert.equal(String(args[4]), accountId) }
  f.transports = {
    now: () => f.at, readCredentials: () => f.creds,
    symbols: async (...args) => {
      check(args); assert.deepEqual(args[5], ['22']); f.reads.push('symbols')
      return { ctidTraderAccountId: accountId, symbol: [{ symbolId: '22', symbolName: 'EURUSD', digits: 2, minVolume: 100, stepVolume: 100 }] }
    },
    reconcile: async (...args) => { check(args); f.reads.push('position'); return { ctidTraderAccountId: accountId, position: [f.position()] } },
    deals: async (...args) => { check(args); assert.equal(String(args[5]), '33'); f.reads.push('deals'); return structuredClone(f.history) },
    orderDetails: async (...args) => { check(args); assert.equal(String(args[5]), '55'); f.reads.push('orderDetails'); return structuredClone(f.details) },
    quote: async (c, symbol) => {
      assert.equal(c.accountId, accountId); assert.equal(c.host, f.host); assert.equal(symbol, '22'); f.reads.push('quote')
      return { ctidTraderAccountId: accountId, symbolId: '22', bid: Math.round(f.bid * 100000), ask: Math.round(f.ask * 100000), timestamp: f.at - 1 }
    },
    close: async (c, order) => {
      assert.equal(c.accountId, accountId); assert.equal(c.host, f.host)
      assert.equal(f.plan().state, 'SENDING', 'same durable claim precedes every broker close')
      assert.ok(f.proof(), 'manual authority must already be durable')
      assert.deepEqual(order, { positionId: '33', volume: f.initialVolume / 2 })
      f.closes.push(order); f.volume -= order.volume
      return { ctidTraderAccountId: accountId, executionType: 'ORDER_FILLED', deal: {
        dealId: '44', orderId: '66', positionId: '33', symbolId: '22', tradeSide: side === 'BUY' ? 'SELL' : 'BUY',
        dealStatus: 'FILLED', volume: order.volume, filledVolume: order.volume, executionPrice: side === 'BUY' ? f.bid : f.ask,
        executionTimestamp: f.at, closePositionDetail: { entryPrice: 100, closedVolume: order.volume },
      } }
    },
  }
  f.plan = () => exists(f.db, 'momentum_partial_plans') ? readPartialPlan(f.db, accountId, 7) : null
  f.proof = () => exists(f.db, 'manual_hybrid_authority')
    ? f.db.prepare('SELECT * FROM manual_hybrid_authority WHERE account_id=? AND trade_id=7').get(accountId) : null
  f.trade = () => f.db.prepare('SELECT * FROM trades WHERE id=7').get()
  f.monitor = () => f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
  f.events = () => f.db.prepare("SELECT * FROM position_events WHERE trade_id=7 AND kind='scale_out'").all()
  f.enrol = () => enrolCappedHybrids(f.db, { credsFor: () => f.creds, now: () => f.at, transports: f.transports })
  f.adapter = () => makeMomentumPartialBroker(f.db, { identity: { host: f.host, accountId, symbolId: '22' }, tradeId: 7 }, f.transports)
  f.pass = () => runMomentumPartialPass(f.db, { credsFor: () => f.creds, now: () => f.at,
    deps: { hybridEnrolment: { transports: f.transports }, adapterFor: () => f.adapter() } })
  f.tick = event => processHybridTick(f.db, f.host, event, { credsFor: () => f.creds, now: () => f.at, transports: f.transports, log: () => {} })
  f.reopen = () => { f.db.close(); f.db = initDB(path) }
  f.trigger = () => {
    f.bid = side === 'BUY' ? 120 : 79.9; f.ask = side === 'BUY' ? 120.1 : 80
    return { ...hybridSpec(f.plan(), f.at), kind: 'trigger', version: 1, eventId: 'a'.repeat(32) + ':1',
      bid: f.bid, ask: f.ask, receivedAtMs: f.at, observedAtMs: f.at, brokerAtMs: f.at,
      bidAtMs: f.at, askAtMs: f.at, bidBrokerAtMs: f.at, askBrokerAtMs: f.at, persistedAtMs: f.at,
      source: 'owned_native_spot_tick', feedGeneration: 1, decisionNs: 1234 }
  }
  return f
}

function unchanged(f, trade, monitor, scaled = false) {
  assert.deepEqual(f.trade(), trade, 'manual source/origin/strategy/risk and entry history are not rewritten')
  assert.deepEqual(f.monitor(), scaled ? { ...monitor, scaled_out: 1 } : monitor)
  assert.equal(f.sl, monitor.current_sl); assert.equal(f.tp, monitor.current_tp)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
}

for (const live of [false, true]) for (const side of ['BUY', 'SELL']) test(`manual ${live ? 'live' : 'demo'} ${side}: original order risk, one half fill, residual and journal survive reopen`, async t => {
  const f = manualScene(t, { live, side }), trade = f.trade(), monitor = f.monitor()
  if (live) f.db.prepare("UPDATE accounts SET mode='manage_only' WHERE account_id=?").run(f.accountId)
  const pass = await f.pass()
  assert.equal(pass.ok, true, JSON.stringify(pass)); assert.equal(pass.cappedHybrid.enrolled.length, 1, JSON.stringify(pass))
  assert.equal(f.plan().state, 'ARMED'); assert.equal(f.plan().plan.initialRisk, 10)
  assert.equal(f.plan().plan.originalStop, side === 'BUY' ? 90 : 110)
  assert.equal(f.plan().plan.trigger, side === 'BUY' ? 120 : 80)
  assert.equal(f.plan().plan.brokerTarget, f.tp)
  assert.ok(f.reads.includes('orderDetails')); assert.equal(f.closes.length, 0)
  unchanged(f, trade, monitor)
  const authority = f.proof()
  assert.ok(authority?.proof_json); assert.equal(authority.account_id, f.accountId); assert.equal(authority.position_id, '33')
  const proof = JSON.parse(authority.proof_json)
  assert.equal(proof.initialRisk, 10); assert.equal(proof.entryOrderId, '55')
  assert.deepEqual(proof.raw.history, f.history); assert.deepEqual(proof.raw.orderDetails, f.details)
  assert.equal(hybridGroups(f.db, f.host, { now: () => f.at, credsFor: () => f.creds }).length, 1)
  const event = f.trigger()
  assert.equal((await f.tick(event)).state, 'CONFIRMED')
  assert.equal(f.closes.length, 1); assert.equal(f.volume, 5000); assert.equal(f.events().length, 1)
  unchanged(f, trade, monitor, true)
  f.reopen()
  assert.deepEqual(f.proof(), authority)
  assert.equal(f.plan().state, 'CONFIRMED'); assert.equal(f.plan().receipt.closedVolume, 5000)
  assert.equal(f.plan().evidence.observation.volume, 5000)
  assert.equal(f.plan().evidence.observation.stopLoss, f.sl); assert.equal(f.plan().evidence.observation.takeProfit, f.tp)
  const receipt = f.db.prepare('SELECT * FROM hybrid_tick_receipts WHERE host=? AND event_id=?').get(f.host, event.eventId)
  assert.deepEqual(JSON.parse(receipt.raw_json), event); assert.equal(JSON.parse(receipt.wire_response_json).deal.dealId, '44')
  assert.equal(JSON.parse(f.events()[0].detail_json).residualEvidence.observation.volume, 5000)
  await f.tick(event); f.at += 61000; await f.pass()
  assert.equal(f.closes.length, 1); assert.equal(f.events().length, 1)
  assert.equal(readMomentumPartialPass(f.db).cappedHybrid.delegated[0].planState, 'CONFIRMED')
  assert.deepEqual(hybridGroups(f.db, f.host, { now: () => f.at, credsFor: () => f.creds }), [])
  unchanged(f, trade, monitor, true)
})

test('manual tick and ordinary pass race through the same durable partial claim', async t => {
  const f = manualScene(t), trade = f.trade(), monitor = f.monitor()
  assert.equal((await f.enrol()).enrolled.length, 1)
  const event = f.trigger()
  await Promise.all([f.tick(event), f.pass()])
  assert.equal(f.plan().state, 'CONFIRMED'); assert.equal(f.closes.length, 1); assert.equal(f.events().length, 1)
  assert.equal(f.volume, 5000); unchanged(f, trade, monitor, true)
})

test('unowned, incomplete or riskless broker opening evidence cannot create manual profit authority', async t => {
  const cases = [
    ['foreign history account', f => { f.history.ctidTraderAccountId = '42' }],
    ['foreign order account', f => { f.details.ctidTraderAccountId = '42' }],
    ['different opening symbol', f => { f.history.deal[0].symbolId = '99' }],
    ['different order identity', f => { f.details.order.orderId = '99' }],
    ['different order deal', f => { f.details.deal[0].dealId = '99' }],
    ['incomplete opening quantity', f => { f.history.deal[0].filledVolume = 5000 }],
    ['prior manual partial', f => { f.history.deal.push({ ...f.opening, dealId: '2', closePositionDetail: { closedVolume: 100 } }) }],
    ['unknown original risk', f => { delete f.details.order.relativeStopLoss }],
    ['bracket edited after opening fill', f => { f.details.order.utcLastUpdateTimestamp += 1 }],
    ['bracket timestamp before opening fill', f => { f.details.order.utcLastUpdateTimestamp -= 1 }],
    ['bracket timestamp absent', f => { delete f.details.order.utcLastUpdateTimestamp }],
  ]
  for (const [name, damage] of cases) {
    const f = manualScene(t), trade = f.trade(), monitor = f.monitor()
    damage(f)
    const result = await f.pass(), report = result.cappedHybrid
    assert.equal(report.enrolled.length, 0, name)
    assert.ok([...report.excluded, ...report.deferred, ...report.errors].some(r => r.tradeId === 7), `${name}: explicit refusal`)
    assert.equal(f.plan(), null, name); assert.ok(!f.proof(), name)
    assert.equal(f.closes.length, 0, name); assert.equal(f.events().length, 0, name)
    unchanged(f, trade, monitor)
  }
})

test('manual scope and existing owner fences remain closed before broker reads', async t => {
  const cases = [
    ['other demo account', { accountId: '47790949' }, () => {}],
    ['other live account', { accountId: '43069009', live: true }, () => {}],
    ['keeper opt-out', {}, f => f.db.prepare('UPDATE monitored_positions SET keeper_opt_out=1 WHERE id=8').run()],
    ['guarded', {}, f => f.db.prepare("UPDATE monitored_positions SET guard_json='{}' WHERE id=8").run()],
    ['paused', {}, f => f.db.prepare('UPDATE monitored_positions SET paused=1 WHERE id=8').run()],
    ['managed exits off', {}, f => setState(f.db, 'managed_exit_json', JSON.stringify({ on: false }))],
    ['known mean reversion', {}, f => {
      f.db.prepare("UPDATE trades SET strategy='rsi2_reversion' WHERE id=7").run()
      f.db.prepare("UPDATE monitored_positions SET strategy='rsi2_reversion' WHERE id=8").run()
    }],
    ['conflicting profit policy', {}, f => {
      f.db.prepare("UPDATE trades SET strategy='ema_pullback' WHERE id=7").run()
      f.db.prepare("UPDATE monitored_positions SET strategy='ema_pullback' WHERE id=8").run()
      setState(f.db, 'managed_exit_json', JSON.stringify({ on: true, takeAtR: 1, takeAtRFamilies: ['trend'] }))
    }],
    ['momentum book owns position', {}, f => f.db.prepare(`INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,status,entered_at)
      VALUES(7,?,'EURUSD','33','long',100,90,'open','2026-10-09')`).run(f.accountId)],
  ]
  for (const [name, options, change] of cases) {
    const f = manualScene(t, options); change(f)
    const trade = f.trade(), monitor = f.monitor(), result = await f.pass()
    assert.equal(result.cappedHybrid.enrolled.length, 0, name)
    assert.equal(f.closes.length, 0, name); assert.deepEqual(f.reads, [], name)
    assert.equal(f.plan(), null, name); unchanged(f, trade, monitor)
  }
})

test('manual exact-half and existing TP limits are retained after original-risk verification', async t => {
  for (const reason of ['half_and_runner_not_representable', 'existing_tp_caps_before_runner']) {
    const f = manualScene(t, reason === 'half_and_runner_not_representable' ? { volume: 300 } : {})
    if (reason === 'existing_tp_caps_before_runner') {
      f.tp = 120
      f.db.prepare('UPDATE trades SET tp_price=120 WHERE id=7').run()
      f.db.prepare('UPDATE monitored_positions SET current_tp=120 WHERE id=8').run()
    }
    const trade = f.trade(), monitor = f.monitor(), result = await f.pass()
    assert.equal(result.cappedHybrid.enrolled.length, 0)
    assert.ok(result.cappedHybrid.deferred.some(r => r.reason === reason), JSON.stringify(result))
    assert.equal(f.plan(), null); assert.equal(f.closes.length, 0); unchanged(f, trade, monitor)
  }
})

test('manual authority changed during the broker read prevents the later claim', async t => {
  const f = manualScene(t)
  assert.equal((await f.enrol()).enrolled.length, 1)
  const before = f.proof(), trade = f.trade(), event = f.trigger(), read = f.transports.reconcile
  f.transports.reconcile = async (...args) => {
    const result = await read(...args)
    f.db.prepare('UPDATE monitored_positions SET keeper_opt_out=1 WHERE id=8').run()
    return result
  }
  await f.tick(event)
  assert.equal(f.closes.length, 0); assert.equal(f.events().length, 0)
  assert.notEqual(f.plan().state, 'SENDING'); assert.equal(f.plan().attempted_at, null)
  assert.deepEqual(f.proof(), before); assert.deepEqual(f.trade(), trade)
  assert.equal(f.sl, f.monitor().current_sl); assert.equal(f.tp, f.monitor().current_tp)
})

test('manual authority storage failure prevents plan registration and every broker close', async t => {
  // Dynamic import keeps the main joined case runnable against pre-feature
  // baseline enrolment; a missing new module is not its intended red result.
  const { ensureManualHybridSchema } = await import('./manual-hybrid-policy.js')
  const f = manualScene(t), trade = f.trade(), monitor = f.monitor()
  ensureManualHybridSchema(f.db)
  f.db.exec(`CREATE TRIGGER deny_manual_authority BEFORE INSERT ON manual_hybrid_authority
    BEGIN SELECT RAISE(ABORT, 'controlled manual proof storage failure'); END`)
  const result = await f.pass()
  assert.equal(result.cappedHybrid.enrolled.length, 0)
  assert.ok(result.cappedHybrid.errors.length > 0 || result.cappedHybrid.deferred.length > 0)
  assert.ok(f.reads.includes('orderDetails'), 'reach the durable proof boundary using actual controlled broker evidence')
  assert.ok(!f.proof()); assert.equal(f.plan(), null); assert.equal(f.closes.length, 0); assert.equal(f.events().length, 0)
  unchanged(f, trade, monitor)
})
