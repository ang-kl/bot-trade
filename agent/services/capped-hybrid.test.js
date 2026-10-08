// Codex · №12,253 · 2026-10-08; codex-footprint: capped-hybrid-profit.
// Real DB, enrolment, pass, ownership, adapter, state machine and journal.
// Only the broker boundary is controlled; no orders leave this process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { CAPPED_HYBRID_POLICY, planCappedHybrid, readCappedHybridOwner } from './capped-hybrid-policy.js'
import { runMomentumPartialPass } from './momentum-partial-runtime.js'
import { readPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { evaluatePosition } from './position-manager.js'
import { applyManagedRules } from './managed-exit.js'
import { rulesForSymbol } from './asset-controllers.js'

const AT = 1791460800000
test('a sub-tick risk cannot collapse the profit trigger to the entry price', () => {
  for (const side of ['BUY', 'SELL']) {
    assert.equal(planCappedHybrid({ side, entry: 100, initialRisk: 1e-10, brokerTarget: side === 'BUY' ? 140 : 60,
      volume: 10000, minVolume: 100, stepVolume: 100, digits: 2, openingDealIds: ['1'] }).ok, false)
  }
})
function scene(t, { side = 'BUY', live = false, volume = 10000, step = 100, path = ':memory:' } = {}) {
  const f = { db: initDB(path), at: AT, volume, step, closes: [], reads: [], side, reply: null,
    entry: 100, sl: side === 'BUY' ? 98 : 102, tp: side === 'BUY' ? 140 : 60,
    bid: side === 'BUY' ? 120 : 79.9, ask: side === 'BUY' ? 120.1 : 80 }
  t.after(() => { try { f.db.close() } catch { /* reopened/closed by test */ } })
  f.host = live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  f.creds = { accountId: '42', host: f.host, ready: true, clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' }
  f.db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES ('42',?,1,'active')").run(live ? 1 : 0)
  f.db.prepare(`INSERT INTO entry_intents(id,account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,
    permit_id,permit_expires_at,state,broker_order_id,broker_position_id,risk_event_id)
    VALUES('entry-7','42',?,'EURUSD',22,?,'MARKET',?,'analysis','risk',1,'fixture-permit','2099-01-01','FILLED','55','33',1)`)
    .run(live ? 'live' : 'demo', side, volume)
  f.db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
    strategy,label_strategy,ctrader_position_id,intent_id,source)
    VALUES(7,'EURUSD',?,'open','42','bot_market_dispatch',1,100,?,?,0.01,'ema_pullback','ema_pullback','33','entry-7','autopilot')`)
    .run(side, side === 'BUY' ? 90 : 110, f.tp)
  f.db.prepare(`INSERT INTO monitored_positions(id,trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused) VALUES(8,7,'42','EURUSD',?,100,?,?,10,'ema_pullback','autopilot','active',0)`)
    .run(side === 'BUY' ? 'long' : 'short', f.sl, f.tp)
  const check = args => { assert.equal(args[0], f.host); assert.equal(String(args[4]), '42') }
  f.opening = { dealId: '1', orderId: '55', positionId: '33', symbolId: '22', tradeSide: side, dealStatus: 'FILLED',
    volume, filledVolume: volume, executionPrice: 100, executionTimestamp: AT - 100000 }
  f.transports = {
    now: () => f.at, readCredentials: () => f.creds,
    symbols: async (...args) => { check(args); assert.deepEqual(args[5], ['22']); f.reads.push('symbols');
      return { ctidTraderAccountId: '42', symbol: [{ symbolId: '22', digits: 2, minVolume: 100, stepVolume: f.step }] } },
    reconcile: async (...args) => { check(args); f.reads.push('position'); return {
      ctidTraderAccountId: '42', position: [{ positionId: '33', positionStatus: 'POSITION_STATUS_OPEN', price: 100,
        stopLoss: f.sl, takeProfit: f.tp, tradeData: { symbolId: '22', tradeSide: side, volume: f.volume } }],
    } },
    deals: async (...args) => { check(args); f.reads.push('deals'); return { ctidTraderAccountId: '42', hasMore: false, deal: [f.opening] } },
    quote: async (c, symbol) => { assert.equal(c.accountId, '42'); assert.equal(symbol, '22');
      return { ctidTraderAccountId: '42', symbolId: '22', bid: Math.round(f.bid * 100000), ask: Math.round(f.ask * 100000), timestamp: f.at - 1 } },
    close: async (c, order) => {
      assert.equal(c.accountId, '42'); assert.equal(c.host, f.host)
      assert.equal(readPartialPlan(f.db, '42', 7).state, 'SENDING', 'claim must be durable before send')
      f.closes.push(order)
      if (f.reply) return f.reply(order)
      f.volume -= order.volume
      return f.fill(order.volume)
    },
  }
  f.fill = amount => ({ ctidTraderAccountId: '42', executionType: 'ORDER_FILLED', deal: {
    dealId: '44', orderId: '66', positionId: '33', symbolId: '22', tradeSide: side === 'BUY' ? 'SELL' : 'BUY', dealStatus: 'FILLED',
    volume: amount, filledVolume: amount, executionPrice: side === 'BUY' ? f.bid : f.ask,
    executionTimestamp: f.at, closePositionDetail: { entryPrice: 100, closedVolume: amount },
  } })
  f.adapter = () => makeMomentumPartialBroker(f.db, { identity: { host: f.host, accountId: '42', symbolId: '22' }, tradeId: 7 }, f.transports)
  f.pass = () => runMomentumPartialPass(f.db, { credsFor: () => f.creds, now: () => f.at,
    deps: { hybridEnrolment: { transports: f.transports }, adapterFor: () => f.adapter() } })
  f.events = () => f.db.prepare("SELECT * FROM position_events WHERE trade_id=7 AND kind='scale_out'").all()
  return f
}

test('real runtime: BUY/SELL on demo/live bank exact half once, with receipt and residual; no protection overwrite', async t => {
  for (const side of ['BUY', 'SELL']) for (const live of [false, true]) {
    const f = scene(t, { side, live })
    assert.equal(readCappedHybridOwner(f.db, '42', 7, '33', 2).owner, 'managed_capped_hybrid')
    const before = f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
    const result = await f.pass()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED', JSON.stringify(result))
    const p = readPartialPlan(f.db, '42', 7).plan
    assert.equal(p.policy, CAPPED_HYBRID_POLICY); assert.equal(p.trigger, side === 'BUY' ? 120 : 80)
    assert.equal(p.brokerTarget, f.tp); assert.deepEqual(f.closes, [{ positionId: '33', volume: 5000 }])
    assert.equal(f.volume, 5000); assert.equal(f.events().length, 1)
    assert.equal(f.events()[0].r_at, 2)
    assert.deepEqual(f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get(), { ...before, scaled_out: 1 }, 'only the proven partial flag changes; SL/TP/entry remain frozen')
    assert.equal(f.sl, before.current_sl); assert.equal(f.tp, before.current_tp)
    f.at += 61000; await f.pass()
    assert.equal(f.closes.length, 1); assert.equal(f.events().length, 1)
  }
})

// Codex · №12,259 · 2026-10-08; codex-footprint: capped-hybrid-review.
test('a completed entry composed of partial-fill deals can enrol; incomplete totals still refuse', async t => {
  for (const status of [3, 'PARTIALLY_FILLED']) for (const complete of [true, false]) {
    const f = scene(t)
    f.transports.deals = async () => ({ ctidTraderAccountId: '42', hasMore: false, deal: [
      { ...f.opening, filledVolume: 4000, dealStatus: status },
      { ...f.opening, dealId: '2', filledVolume: complete ? 6000 : 5000 },
    ] })
    const out = await f.pass()
    assert.equal(out.cappedHybrid.enrolled.length, complete ? 1 : 0)
    assert.equal(f.closes.length, complete ? 1 : 0)
    if (complete) assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
  }
})

test('a proven partial remains journaled when another deal closes or reduces its runner before readback', async t => {
  for (const remaining of [0, 4000]) {
    const f = scene(t), reconcile = f.transports.reconcile
    f.transports.reconcile = async (...args) => f.volume === 0
      ? { ctidTraderAccountId: '42', position: [] } : reconcile(...args)
    f.transports.deals = async () => ({ ctidTraderAccountId: '42', hasMore: false, deal: [f.opening,
      ...(f.closes.length ? [f.fill(5000).deal, { ...f.fill(5000 - remaining).deal, dealId: '45', orderId: '67' }] : []),
    ] })
    f.reply = () => { f.volume = remaining; return f.fill(5000) }
    await f.pass()
    const state = remaining ? 'VOLUME_CHANGED' : 'CLOSED_EXTERNALLY'
    assert.equal(readPartialPlan(f.db, '42', 7).state, state)
    assert.equal(f.events().length, 1)
    const detail = JSON.parse(f.events()[0].detail_json)
    assert.equal(detail.planState, state); assert.equal(detail.volume, 5000)
    assert.equal(f.db.prepare('SELECT scaled_out FROM monitored_positions WHERE id=8').get().scaled_out, 1)
    f.at += 61000; await f.pass()
    assert.equal(f.events().length, 1); assert.equal(f.closes.length, 1)
  }
})

test('confirmed hybrid latches the profit flag without altering managed SL decisions or enabling another legacy partial', async t => {
  const f = scene(t), before = f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
  const rules = applyManagedRules(f.db, '42', rulesForSymbol(f.db, 'EURUSD'), { strategy: 'ema_pullback', tradeId: 7 })
  const ctx = { currentPrice: 120, now: new Date(AT), rules }
  const stopBefore = evaluatePosition(before, ctx)
  await f.pass()
  const after = f.db.prepare('SELECT * FROM monitored_positions WHERE id=8').get()
  assert.equal(after.scaled_out, 1)
  assert.deepEqual(evaluatePosition(after, ctx), stopBefore, 'managed stop decision remains identical after profit-only flag')
  // Existing evaluator, with its legacy partial window restored by an owner.
  // Breakeven is already met in this controlled evaluator fixture.
  const legacy = { currentPrice: 120, now: new Date(AT), rules: { bankTriggerR: 0, partialTriggerR: 2 } }
  assert.equal(evaluatePosition({ ...before, be_moved: 1 }, legacy).action, 'PARTIAL_EXIT')
  assert.notEqual(evaluatePosition({ ...after, be_moved: 1 }, legacy).action, 'PARTIAL_EXIT')
})

test('BUY uses bid and SELL uses ask: a spread-side touch below 2R cannot take a partial', async t => {
  for (const side of ['BUY', 'SELL']) {
    const f = scene(t, { side })
    if (side === 'BUY') { f.bid = 119.99; f.ask = 120.1 } else { f.bid = 79.9; f.ask = 80.01 }
    await f.pass(); assert.equal(f.closes.length, 0)
    assert.equal(readPartialPlan(f.db, '42', 7).state, 'ARMED')
  }
})

test('half below minimum or between steps refuses; no rounding and no whole-close fallback', async t => {
  for (const [volume, step] of [[100, 100], [300, 100], [10000, 300]]) {
    const f = scene(t, { volume, step }); const out = await f.pass()
    assert.equal(out.cappedHybrid.enrolled.length, 0); assert.equal(f.closes.length, 0)
    assert.match(out.cappedHybrid.deferred[0].reason, /representable|volume/)
  }
})

test('missing/foreign/underfilled close receipts do not journal success or resend', async t => {
  for (const mutate of [() => ({}), f => ({ ...f.fill(5000), ctidTraderAccountId: '99' }), f => f.fill(1000)]) {
    const f = scene(t); f.reply = () => mutate(f)
    await f.pass(); assert.equal(readPartialPlan(f.db, '42', 7).state, 'AMBIGUOUS')
    assert.equal(f.events().length, 0); f.at += 61000; await f.pass()
    assert.equal(f.closes.length, 1); assert.equal(f.events().length, 0)
  }
})

test('a valid partial receipt without matching residual is retained, not labelled a confirmed runner', async t => {
  const f = scene(t); f.reply = () => { f.volume = 7000; return f.fill(5000) }
  await f.pass(); assert.equal(readPartialPlan(f.db, '42', 7).state, 'RECEIVED')
  assert.equal(f.events().length, 0)
  f.volume = 5000; f.at += 61000; await f.pass()
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
  assert.equal(f.events().length, 1); assert.equal(f.closes.length, 1)
})

test('owner/identity fences refuse with no new profit authority', async t => {
  const changes = [
    "UPDATE monitored_positions SET guard_json='{}'", "UPDATE monitored_positions SET paused=1",
    "UPDATE accounts SET mode='paused'", "UPDATE trades SET origin='external'", "UPDATE trades SET intent_id=NULL",
    "UPDATE entry_intents SET state='ACCEPTED'", "UPDATE entry_intents SET account_id='99'",
    "UPDATE entry_intents SET risk_event_id=2", "UPDATE trades SET label_strategy='vwap_trend'",
    "UPDATE monitored_positions SET initial_risk=NULL", "UPDATE monitored_positions SET bank_partial_at='2026-10-08'",
    "UPDATE monitored_positions SET strategy='rsi_meanrev'",
    "UPDATE trades SET strategy='rsi_meanrev',label_strategy='rsi_meanrev'",
    "UPDATE monitored_positions SET source='manual'",
    "INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,status,entered_at) VALUES(7,'42','EURUSD','33','long',100,90,'open','2026-10-08')",
  ]
  for (const sql of changes) {
    const f = scene(t); f.db.exec(sql); const out = await f.pass()
    assert.equal(f.closes.length, 0, sql); assert.equal(out.cappedHybrid.enrolled.length, 0, sql)
    assert.equal(f.reads.length, 0, sql)
  }
})

test('ownership and broker symbol are rechecked after the quote and before claim', async t => {
  for (const sql of ["UPDATE monitored_positions SET guard_json='{}'", "UPDATE entry_intents SET symbol_id=23"]) {
    const f = scene(t), quote = f.transports.quote
    f.transports.quote = async (...args) => { const q = await quote(...args); f.db.exec(sql); return q }
    await f.pass(); assert.equal(f.closes.length, 0)
    assert.equal(readPartialPlan(f.db, '42', 7).state, 'ARMED')
  }
})

test('missing/incomplete opening-deal evidence, prior partials and foreign symbol metadata never enrol', async t => {
  for (const change of [
    f => { f.transports.deals = async () => ({ ctidTraderAccountId: '42', hasMore: false, deal: [] }) },
    f => { f.transports.deals = async () => ({ ctidTraderAccountId: '42', hasMore: true, deal: [f.opening] }) },
    f => { f.opening.filledVolume = 9000 },
    f => { f.opening.closePositionDetail = { closedVolume: 1000 } },
    f => { f.opening.orderId = '99' },
    f => { f.transports.symbols = async () => ({ ctidTraderAccountId: '99', symbol: [{ symbolId: '22', digits: 2, minVolume: 100, stepVolume: 100 }] }) },
    f => { f.tp = 120 }, f => { f.sl = 89 },
  ]) {
    const f = scene(t); change(f); const out = await f.pass()
    assert.equal(out.cappedHybrid.enrolled.length, 0); assert.equal(f.closes.length, 0)
  }
})

test('ambiguous claim survives SQLite reopen without duplicate close or invented scale-out', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'capped-hybrid-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'test.db'), f = scene(t, { path })
  f.reply = () => { throw Error('timeout after possible execution') }
  await f.pass(); assert.equal(f.closes.length, 1)
  f.db.close(); f.db = initDB(path); f.at += 61000
  await f.pass(); assert.equal(f.closes.length, 1); assert.equal(f.events().length, 0)
})

test('an owner-added profit override cancels eligibility without changing its settings or stop rules', async t => {
  const f = scene(t); f.bid = 119; await f.pass()
  setState(f.db, 'managed_exit_json', JSON.stringify({ on: true, takeAtR: 1, takeAtRFamilies: ['trend'] }))
  f.bid = 121; f.at += 61000; await f.pass()
  assert.equal(f.closes.length, 0)
})

test('entry planner remains 3R risk-coverage policy; new 2R policy is exclusively post-entry', () => {
  const input = { side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3, costReservePrice: 0,
    digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 }
  assert.equal(planMomentumTargets(input).closeVolume, 2500)
  assert.equal(planMomentumTargets(input).trigger, 130)
  assert.equal(planMomentumTargets({ ...input, requiredRr: 2 }).ok, false)
  assert.equal(planCappedHybrid({ side: 'BUY', entry: 100, initialRisk: 10, brokerTarget: 140, volume: 10000,
    minVolume: 100, stepVolume: 100, digits: 2, openingDealIds: ['1'] }).closeVolume, 5000)
})

test('simultaneous real manager calls share one SQLite claim and one close', async t => {
  const f = scene(t); f.bid = 119; await f.pass(); f.bid = 120
  const a = f.adapter()
  await Promise.all([runPartialPlan(f.db, f.creds, 7, a), runPartialPlan(f.db, f.creds, 7, a)])
  assert.equal(f.closes.length, 1)
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'CONFIRMED')
})

test('late fill is retained after timeout and requires residual recovery, never a second close', async t => {
  const f = scene(t); f.bid = 119; await f.pass(); f.bid = 120
  let release
  f.reply = () => new Promise(resolve => { release = () => { f.volume = 5000; resolve(f.fill(5000)) } })
  const a = f.adapter(); a.timeoutMs = 10
  const first = await runPartialPlan(f.db, f.creds, 7, a)
  assert.equal(first.state, 'AMBIGUOUS'); assert.equal(f.closes.length, 1)
  release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(readPartialPlan(f.db, '42', 7).state, 'RECEIVED')
  assert.equal((await runPartialPlan(f.db, f.creds, 7, a)).state, 'CONFIRMED')
  assert.equal(f.closes.length, 1)
})

test('bounded enrolment advances past an unavailable first position on the next pass', async t => {
  const f = scene(t)
  f.db.prepare(`INSERT INTO entry_intents(id,account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,
    permit_id,permit_expires_at,state,broker_order_id,broker_position_id,risk_event_id)
    SELECT 'entry-8',account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,
      'permit-8',permit_expires_at,state,'56','34',risk_event_id FROM entry_intents WHERE id='entry-7'`).run()
  f.db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
    strategy,label_strategy,ctrader_position_id,intent_id,source)
    SELECT 8,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,strategy,label_strategy,
      '34','entry-8',source FROM trades WHERE id=7`).run()
  f.db.prepare(`INSERT INTO monitored_positions(trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused) SELECT 8,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused FROM monitored_positions WHERE id=8`).run()
  const options = { credsFor: () => f.creds, now: () => f.at, maxCandidates: 1,
    transports: { ...f.transports, symbols: async () => { throw Error('bounded broker failure') } } }
  assert.equal((await enrolCappedHybrids(f.db, options)).errors[0].tradeId, 7)
  assert.equal((await enrolCappedHybrids(f.db, options)).errors[0].tradeId, 8)
  assert.equal(f.closes.length, 0)
})

// Claude · № 12,280 08-Oct (A·1; ordered "all three" after № 12,279; claude-builder).
// Measured 08-10 on the live gateway: a deal-list bound two seconds ahead of the
// clock was refused with INCORRECT_BOUNDARIES on every pass for trade 1771.
test('the enrolment deal read is bounded by its own clock, never ahead of it', async t => {
  const f = scene(t, { live: true })
  const bounds = []
  const options = { credsFor: () => f.creds, now: () => f.at,
    transports: { ...f.transports, deals: async (...args) => { bounds.push(args[6]); return f.transports.deals(...args) } } }
  const out = await enrolCappedHybrids(f.db, options)
  assert.equal(out.errors.length, 0)
  assert.equal(out.enrolled.length, 1)
  assert.deepEqual(bounds, [f.at], 'toTimestamp is the enrolment clock itself')
})
