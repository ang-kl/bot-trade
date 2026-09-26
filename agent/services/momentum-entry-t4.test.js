// node --test agent/services/momentum-entry-t4.test.js
//
// V3 T4 (P0-3): a momentum market entry carries the partial-TP1 plan, behind
// config/momentum-entries.json (OFF until the owner answers OD-1).
//
// What is proven here, by behaviour through the real autoTrade:
//   * the switch is OFF as shipped, and with it off a momentum entry takes
//     exactly the pre-T4 path: no evidence read, no intent, the order refused
//     at the shared execution boundary for having no target;
//   * with it on, a closed-market momentum entry is refused BY NAME and
//     nothing rests (OD-1(b)); an entry that would rest as an HTF limit is
//     refused by name (OD-15 / P0-4);
//   * with it on, an open-market entry runs end to end — tryEnter's
//     autoTrade → bookEntryWrite → ARMED → trigger → one close → CONFIRMED —
//     through the test seam and the fake broker, with the database closed and
//     reopened between every stage;
//   * the seam is ignored outside node's test runner (no production bypass).
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { startFakeBroker } from '../test-support/fake-broker.js'
import { initDB, setState } from '../db.js'
import { validateOrderBracket, invalidateSidecarSession } from '../lib/exec-engine.js'
import { relativePoints } from '../lib/lot-sizing.js'
import { loadMomentumEntrySwitch, momentumPlanApplies, MOMENTUM_ENTRY_PRODUCERS } from './momentum-entry-switch.js'
import { swapCarryReserve, medianBookHoldingNights, gridStop, MOMENTUM_CLOSED_MARKET_REFUSAL,
  MOMENTUM_RESTING_LIMIT_REFUSAL } from './momentum-entry-producer.js'
import { readMomentumEntry } from './momentum-entry-contract.js'
import { bookEntryWrite } from './book-entry-write.js'
import { readPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { runMomentumPartialPass } from './momentum-partial-runtime.js'
import { secondsIntoWeek } from './symbol-hours.js'

const ACCT = '4001', SYMBOL = 'ETHUSD', SID = 22
const ENV = ['EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK', 'CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']
const ALWAYS_OPEN = JSON.stringify([{ startSecond: 0, endSecond: 7 * 86400 }])
// One minute of trading two hours from now: closed at the time of the test.
const closedNow = () => { const w = 7 * 86400, n = secondsIntoWeek(new Date(), 'UTC'); return JSON.stringify([{ startSecond: (n + 7200) % w, endSecond: (n + 7260) % w }]) }

// The book's synth as buildEntrySynth makes it (tp1 null), ATR stop off the grid.
const bookSynth = (over = {}) => ({ consensus_bias: 'long', direction_reason: 'tsmom:long_top_band', entry: 100, sl: 94.8137,
  tp1: null, tp2: null, strategy: 'tsmom_long', timeframe: '1d', overall_conviction: 8, auto_trade: true, marketOnly: true,
  time_cap_minutes: null, source: 'momentum_book', synthesis: 'TS momentum long', ...over })

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------
test('the switch ships OFF: no momentum producer takes the T4 path', () => {
  const sw = loadMomentumEntrySwitch()
  assert.equal(sw.market, false, 'config/momentum-entries.json must ship with market off until the owner answers OD-1')
  assert.equal(sw.error, null, 'the shipped file is readable')
  for (const p of MOMENTUM_ENTRY_PRODUCERS) assert.equal(momentumPlanApplies(p), false, p)
})

test('only the literal true turns the switch on; unreadable is off; non-momentum producers never take the path', () => {
  const dir = tempDir('t4-switch-')
  const at = (name, text) => { const f = join(dir, name); if (text != null) writeFileSync(f, text); return f }
  for (const [name, text] of [['string.json', '{"market":"true"}'], ['one.json', '{"market":1}'], ['bad.json', '{market:true'],
    ['missing.json', null], ['null.json', 'null']]) {
    assert.equal(loadMomentumEntrySwitch(at(name, text)).market, false, name)
  }
  const on = at('on.json', '{"market":true}')
  assert.equal(loadMomentumEntrySwitch(on).market, true)
  const load = () => loadMomentumEntrySwitch(on)
  assert.equal(momentumPlanApplies('cross_sectional_book', { load }), true)
  assert.equal(momentumPlanApplies('daily_momentum_account', { load }), true)
  for (const p of ['scan_dispatch', 'tick_momentum', 'closed_market_limits', 'manual_assisted', undefined]) {
    assert.equal(momentumPlanApplies(p, { load }), false, String(p))
  }
})

test('the autoTrade transport seam is honoured only inside node\'s test runner (no production bypass)', async () => {
  const { autoTradeTestSeam } = await import('../loop.js')
  const t = { execPlaceOrder: () => {} }
  assert.equal(autoTradeTestSeam({ testTransport: t }), t, 'inside `node --test` the seam is read')
  const saved = process.env.NODE_TEST_CONTEXT
  delete process.env.NODE_TEST_CONTEXT
  try {
    assert.equal(autoTradeTestSeam({ testTransport: t }), null, 'outside the runner (production) the seam is ignored')
  } finally { process.env.NODE_TEST_CONTEXT = saved }
})

// ---------------------------------------------------------------------------
// Swap (OD-3) and the stop as sent
// ---------------------------------------------------------------------------
test('swap: broker rate × median nights, triple-swap aware, a positive swap never lowers the reserve', () => {
  const base = { side: 'BUY', swapLong: -1.5, swapShort: 2, pipPosition: 2, digits: 2, price: 100, medianNights: 10 }
  const pips = swapCarryReserve({ ...base, swapCalculationType: 'PIPS' })
  assert.equal(pips.ok, true)
  assert.equal(pips.basis.nights, 14, '10 nights span two triple-swap days: +4')
  assert.equal(pips.carryingCostReservePrice, 0.21, '1.5 pips × 0.01 × 14')
  assert.equal(swapCarryReserve({ ...base, swapCalculationType: 2 }).carryingCostReservePrice, 0.21, 'POINTS at 2 digits')
  const pct = swapCarryReserve({ ...base, swapCalculationType: 'PERCENTAGE', swapLong: -3.6 }).carryingCostReservePrice
  assert.ok(pct >= 0.14 && pct - 0.14 < 1e-9, `100 × 3.6% / 360 × 14, rounded up: ${pct}`)
  const credit = swapCarryReserve({ ...base, side: 'SELL' })
  assert.equal(credit.carryingCostReservePrice, 0, 'a credit reserves nothing and never subtracts')
  assert.equal(credit.basis.credit, true)
  const absent = swapCarryReserve({ ...base, swapCalculationType: undefined })
  assert.equal(absent.basis.type, 'PIPS'); assert.equal(absent.basis.typeAssumed, true)
  assert.equal(swapCarryReserve({ ...base, swapLong: undefined }).reason, 'swap_rate_unavailable')
  assert.equal(swapCarryReserve({ ...base, swapCalculationType: 'WEEKLY' }).reason, 'swap_calculation_type_unknown')
  assert.equal(swapCarryReserve({ ...base, medianNights: null }).reason, 'swap_nights_unavailable')
  assert.equal(swapCarryReserve({ ...base, medianNights: 0 }).carryingCostReservePrice, 0)
})

test('median nights come from the book\'s closed rows (upper median)', () => {
  const db = initDB(':memory:')
  assert.equal(medianBookHoldingNights(db), null)
  const add = db.prepare(`INSERT INTO momentum_book (account_id, symbol, side, entered_at, exited_at, status) VALUES ('1', 'X', 'long', ?, ?, ?)`)
  add.run('2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', 'closed')
  add.run('2026-09-01T00:00:00Z', '2026-09-06T12:00:00Z', 'closed')
  add.run('2026-09-01T00:00:00Z', null, 'open')
  assert.deepEqual(medianBookHoldingNights(db), { nights: 6, n: 2 })
})

test('the plan\'s stop is the approved distance exactly as relativePoints sends it, on the grid', () => {
  const g = gridStop({ side: 'BUY', entry: 100, stopDistance: 5.1863, digits: 2, relativePoints })
  assert.deepEqual(g, { stop: 94.81, ticks: 519, points: 519000 })
  assert.equal(gridStop({ side: 'SELL', entry: 99.9, stopDistance: 5.1863, digits: 2, relativePoints }).stop, 105.09)
  assert.equal(gridStop({ side: 'BUY', entry: 100.005, stopDistance: 5, digits: 2, relativePoints }), null, 'an entry off the grid')
  assert.equal(gridStop({ side: 'BUY', entry: 100, stopDistance: 5, digits: 6, relativePoints }), null, 'digits above 5')
})

// ---------------------------------------------------------------------------
// autoTrade, through the test seam and the fake broker
// ---------------------------------------------------------------------------
async function scene(t, { open = true } = {}) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  const broker = await startFakeBroker({ accounts: [ACCT], symbols: { [SID]: { digits: 2 } }, startMs: Date.now() })
  for (const k of ['EXEC_URL_DEMO', 'EXEC_URL_LIVE']) delete process.env[k]
  Object.assign(process.env, { EXEC_ENGINE: 'cpp', EXEC_URL: broker.url, EXEC_SECRET: 'sekret', EXEC_FALLBACK: '0',
    CTRADER_CLIENT_ID: 'c', CTRADER_CLIENT_SECRET: 's' })
  invalidateSidecarSession()
  const dbPath = join(tempDir('t4-e2e-'), 'bot.db')
  let db = initDB(dbPath)
  t.after(async () => {
    try { db.close() } catch { /* closed */ }
    invalidateSidecarSession()
    await broker.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  setState(db, 'ctrader_access_token', 't')
  setState(db, 'evidence_gate_json', JSON.stringify({ on: false }))
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)`).run(SYMBOL, open ? ALWAYS_OPEN : closedNow(), 'UTC')
  // The book's holding record: one closed row of 10 nights (OD-3's median).
  db.prepare(`INSERT INTO momentum_book (account_id, symbol, side, entered_at, exited_at, status) VALUES (?, 'BTCUSD', 'long', ?, ?, 'closed')`)
    .run(ACCT, '2026-09-01T00:00:00Z', '2026-09-11T00:00:00Z')
  broker.setQuote(SID, { bid: 99.9, ask: 100 })
  const s = { broker, dbPath, reads: { symbolsList: 0, assets: 0, symbolsById: 0, quote: 0, reconcile: 0 }, sent: [], fillAsk: null }
  const count = (k, fn) => async (...a) => { s.reads[k]++; return fn(...a) }
  s.momentum = {
    symbolsList: count('symbolsList', async () => ({ symbol: [{ symbolId: SID, symbolName: SYMBOL, baseAssetId: 5, quoteAssetId: 1, enabled: true }] })),
    assets: count('assets', async () => ({ asset: [{ assetId: 1, name: 'USD' }, { assetId: 5, name: 'ETH' }] })),
    symbolsById: count('symbolsById', async () => ({ symbol: [{ symbolId: SID, lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2,
      pipPosition: 2, swapLong: -1.5, swapShort: -1, swapCalculationType: 0 }] })),
    // Spot events stamped on the wall clock the contract's freshness reads.
    quote: count('quote', async (c, symbolId) => ({ ...broker.spot(c.accountId, symbolId), timestamp: Date.now() })),
    reconcile: count('reconcile', async (c) => broker.reconcile(c.accountId)),
  }
  s.seam = (entrySwitch) => ({
    entrySwitch, momentum: s.momentum, skipForensics: true, bindSleep: async () => {},
    resolveSymbolId: async () => ({ id: String(SID), source: 'test' }),
    getVolumeMeta: async () => ({ lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2 }),
    wsGetSpotOnce: async () => ({ bid: 99.9, ask: 100 }),
    wsReconcile: async () => broker.reconcile(ACCT),
    // The shared execution boundary's own guard, then the fake broker's fill.
    execPlaceOrder: async (_creds, payload) => {
      s.sent.push(payload)
      const v = validateOrderBracket(payload)
      if (!v.ok) throw new Error(v.reason)
      if (s.fillAsk != null) broker.setQuote(SID, { bid: s.fillAsk - 0.1, ask: s.fillAsk })
      const pos = broker.open(ACCT, { symbolId: SID, tradeSide: payload.tradeSide, volume: payload.volume,
        relativeStopLoss: payload.relativeStopLoss, relativeTakeProfit: payload.relativeTakeProfit })
      // The sidecar's ORDER_ACCEPTED shape: a position id, no price.
      return { position: { positionId: pos.positionId } }
    },
  })
  s.run = async (entrySwitch, synth = bookSynth(), producerId = 'cross_sectional_book') => {
    const { autoTrade } = await import('../loop.js')
    return autoTrade(db, SYMBOL, synth, { maxVolume: 1.005 }, { accountId: ACCT, isLive: false, producerId }, { testTransport: s.seam(entrySwitch) })
  }
  s.db = () => db
  s.reopen = () => { db.close(); db = initDB(dbPath) }
  s.vetoes = () => db.prepare(`SELECT veto_reason FROM risk_events WHERE approved = 0 ORDER BY id`).all().map(r => r.veto_reason)
  s.intents = () => { try { return db.prepare('SELECT * FROM momentum_target_intents').all() } catch { return [] } }
  return s
}

test('SWITCH OFF: a momentum entry takes the pre-T4 path — no evidence read, no intent, refused at the boundary for no target', async t => {
  const s = await scene(t)
  const out = await s.run({ market: false })
  assert.equal(out ?? null, null, 'no entry')
  assert.deepEqual(s.reads, { symbolsList: 0, assets: 0, symbolsById: 0, quote: 0, reconcile: 0 }, 'no momentum evidence read')
  assert.equal(s.intents().length, 0, 'no target intent recorded')
  assert.equal(s.broker.positions(ACCT).length, 0, 'nothing opened at the broker')
  assert.equal(s.sent.length, 1, 'the order reached the shared boundary as before')
  assert.equal(s.sent[0].relativeTakeProfit, undefined, 'without a target, as before T4')
  assert.ok(s.vetoes().some(v => /guard_no_target/.test(v)), JSON.stringify(s.vetoes()))
  assert.ok(!s.vetoes().some(v => v.startsWith('momentum_')), 'no T4 refusal while off')
})

test('SWITCH OFF, closed market: the pre-T4 closed-market branch runs, no named momentum refusal', async t => {
  const s = await scene(t, { open: false })
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: false }))
  assert.equal(await s.run({ market: false }) ?? null, null)
  assert.ok(s.vetoes().some(v => v.startsWith('market_closed:')), JSON.stringify(s.vetoes()))
  assert.ok(!s.vetoes().some(v => v.startsWith(MOMENTUM_CLOSED_MARKET_REFUSAL)))
})

test('SWITCH ON, closed market: refused by name, nothing rested, no evidence read (OD-1(b))', async t => {
  const s = await scene(t, { open: false })
  // The resting-limit feature ON: without the named refusal the entry would rest.
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: true }))
  assert.equal(await s.run({ market: true }) ?? null, null)
  const v = s.vetoes()
  assert.equal(v.filter(x => x.startsWith(`${MOMENTUM_CLOSED_MARKET_REFUSAL}: ${SYMBOL} market closed`)).length, 1, JSON.stringify(v))
  const d = s.db().prepare(`SELECT stage, decision FROM decision_log WHERE stage = 'momentum_closed_market'`).all()
  assert.deepEqual(d, [{ stage: 'momentum_closed_market', decision: 'veto' }])
  assert.equal(s.db().prepare(`SELECT count(*) n FROM pending_orders`).get().n, 0, 'no limit rested')
  assert.equal(s.sent.length, 0); assert.equal(s.reads.quote, 0)
  // Once per closed spell: a second attempt logs but does not add a row.
  await s.run({ market: true })
  assert.equal(s.vetoes().filter(x => x.startsWith(MOMENTUM_CLOSED_MARKET_REFUSAL)).length, 1)
})

test('SWITCH ON, an entry that would rest as an HTF limit is refused by name (OD-15, P0-4)', async t => {
  const s = await scene(t)
  const synth = bookSynth({ marketOnly: false, source: 'momentum_account', timeframe: '1d' })
  assert.equal(await s.run({ market: true }, synth, 'daily_momentum_account') ?? null, null)
  const v = s.vetoes()
  assert.ok(v.some(x => x.startsWith(`${MOMENTUM_RESTING_LIMIT_REFUSAL}: ${SYMBOL} 1d would rest as a limit`)), JSON.stringify(v))
  assert.equal(s.db().prepare(`SELECT count(*) n FROM pending_orders`).get().n, 0)
  assert.equal(s.sent.length, 0)
})

test('SWITCH ON, end to end: autoTrade → bookEntryWrite → ARMED → trigger → one close → CONFIRMED, db reopened between stages', async t => {
  const s = await scene(t)
  // The market order slips four ticks, to a fill whose float anchor carries
  // residue (100.04 - 5.19 = 94.85000000000001): the ledger must hold the
  // bound plan's tick-exact bracket, not the float shift.
  s.fillAsk = 100.04
  // Stage 1: the entry.
  const out = await s.run({ market: true })
  assert.ok(out, `entered: ${JSON.stringify(s.vetoes())}`)
  const [order] = s.sent
  assert.ok(order.relativeTakeProfit > 0 && order.relativeStopLoss > 0, 'the order carries the plan\'s bracket')
  assert.equal(order.relativeStopLoss, relativePoints(100 - 94.8137, 2), 'the stop exactly as relativePoints sends it')
  let db = s.db()
  const trade = db.prepare(`SELECT * FROM trades WHERE account_id = ?`).get(ACCT)
  const intent = readMomentumEntry(db, ACCT, trade.id)
  assert.equal(intent.state, 'BOUND', JSON.stringify(intent))
  const plan = intent.plan
  assert.equal(plan.mode, 'partial_runner')
  assert.equal(plan.entry, 100.04, 'bound at the slipped fill')
  assert.equal(plan.originalStop, 94.85, 'the stop moved with the fill in whole ticks')
  assert.equal(intent.proposal.plan.entry, 100, 'the proposal keeps the quote it was made on')
  assert.equal(intent.proposal.carry.nights, 14, 'swap reserve on the book median (10) plus the triple-swap days')
  // The ledger carries the bound plan: entry, stop and broker target.
  assert.deepEqual([trade.status, trade.entry_price, trade.sl_price, trade.tp_price], ['open', plan.entry, plan.originalStop, plan.brokerTarget])
  assert.equal(Math.round(trade.volume * 100), plan.volume, 'integer-consistent volume')
  assert.equal(trade.proposal_entry_price, 100)
  const tp = db.prepare('SELECT * FROM trade_plans WHERE trade_id = ?').get(trade.id)
  // The plan record is the plan AS PLANNED (before the fill moved it).
  const planned = intent.proposal.plan
  assert.equal(tp.exit_rule, `momentum partial-TP1: close ${planned.closeVolume} of ${planned.volume} at ${planned.trigger}; runner to ${planned.brokerTarget}`)
  assert.deepEqual([tp.planned_entry, tp.planned_sl, tp.planned_tp], [planned.entry, planned.originalStop, planned.brokerTarget])
  const [pos] = s.broker.positions(ACCT)
  assert.equal(pos.takeProfit, plan.brokerTarget, 'the broker holds the plan\'s runner target')

  // Stage 2: the book takes the position (tryEnter's own write).
  s.reopen(); db = s.db()
  const hand = bookEntryWrite(db, { accountId: ACCT, row: { tradeId: trade.id, symbol: SYMBOL, positionId: trade.ctrader_position_id,
    side: 'long', entry: trade.entry_price, stop: trade.sl_price, atr: 2, rank: 0.9, enteredAt: new Date().toISOString(), note: 't4' } })
  assert.equal(hand.targetPolicy, 'partial_runner')
  assert.equal(readMomentumEntry(db, ACCT, trade.id).state, 'ENROLLED')
  assert.equal(readPartialPlan(db, ACCT, trade.id).state, 'ARMED')

  // Stage 3: the trigger trades; the partial manager sends one close.
  s.reopen(); db = s.db()
  s.broker.tick(1000)
  s.broker.setQuote(SID, { bid: plan.trigger + 0.5, ask: plan.trigger + 0.6 })
  const identity = { host: 'demo.ctraderapi.com', accountId: ACCT, symbolId: String(SID) }
  const creds = { ...identity, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  const adapter = makeMomentumPartialBroker(db, { identity, tradeId: trade.id }, {
    now: () => s.broker.nowMs, readCredentials: () => creds,
    reconcile: async (_h, _ci, _cs, _at, account) => s.broker.reconcile(account),
    quote: async (c, symbolId) => s.broker.spot(c.accountId, symbolId),
    deals: async (_h, _ci, _cs, _at, account, pid, to) => s.broker.positionDeals(account, pid, { toTimestamp: to }),
  })
  let r = await runPartialPlan(db, creds, trade.id, adapter)
  s.reopen(); db = s.db()
  if (r.state !== 'CONFIRMED') r = await runPartialPlan(db, creds, trade.id, makeMomentumPartialBroker(db, { identity, tradeId: trade.id }, {
    now: () => s.broker.nowMs, readCredentials: () => creds,
    reconcile: async (_h, _ci, _cs, _at, account) => s.broker.reconcile(account),
    quote: async (c, symbolId) => s.broker.spot(c.accountId, symbolId),
    deals: async (_h, _ci, _cs, _at, account, pid, to) => s.broker.positionDeals(account, pid, { toTimestamp: to }) }))
  assert.equal(r.state, 'CONFIRMED', JSON.stringify(r))
  assert.equal(s.broker.callsFor('close').length, 1, 'exactly one close')
  const [runner] = s.broker.positions(ACCT)
  assert.equal(runner.volume, plan.runnerVolume, 'the runner stays open with its broker target')
  assert.equal(runner.takeProfit, plan.brokerTarget)
})

test('deferred binding: an unproven fill stays AWAITING_BIND, the book still takes it, and the partial pass binds and arms it', async t => {
  const s = await scene(t)
  // The first reads show the position without its bracket (not yet applied).
  const real = s.momentum.reconcile
  let blind = 3
  s.momentum.reconcile = async (c) => {
    const raw = await real(c)
    if (blind-- > 0) raw.position = raw.position.map(p => ({ ...p, takeProfit: undefined }))
    return raw
  }
  const out = await s.run({ market: true })
  assert.ok(out, JSON.stringify(s.vetoes()))
  let db = s.db()
  const trade = db.prepare(`SELECT * FROM trades WHERE account_id = ?`).get(ACCT)
  assert.equal(readMomentumEntry(db, ACCT, trade.id).state, 'AWAITING_BIND')
  s.reopen(); db = s.db()
  const hand = bookEntryWrite(db, { accountId: ACCT, row: { tradeId: trade.id, symbol: SYMBOL, positionId: trade.ctrader_position_id,
    side: 'long', entry: trade.entry_price, stop: trade.sl_price, atr: 2, rank: 0.9, enteredAt: new Date().toISOString(), note: 't4' } })
  assert.equal(hand.targetPolicy, 'awaiting_bind', 'the book owns the position before the bind')
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='momentum_partial_plans'").get().n, 0, 'no partial plan before the bind')
  s.reopen(); db = s.db()
  const creds = { host: 'demo.ctraderapi.com', accountId: ACCT, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  const { bindAwaitingMomentumEntries } = await import('./momentum-entry-producer.js')
  const summary = await runMomentumPartialPass(db, { credsFor: () => creds,
    deps: { bindAwaiting: (d, o) => bindAwaitingMomentumEntries(d, { ...o, transports: s.momentum, now: Date.now }),
      adapterFor: async () => ({ now: () => s.broker.nowMs, maxAgeMs: 5000, readPosition: async () => null, quote: async () => null }) } })
  assert.deepEqual(summary.deferredBinds.map(b => [b.bound, b.mode]), [[true, 'partial_runner']], JSON.stringify(summary))
  assert.equal(readMomentumEntry(db, ACCT, trade.id).state, 'ENROLLED')
  assert.equal(readPartialPlan(db, ACCT, trade.id).state, 'ARMED')
})

test('the partial pass makes no deferred-bind read when nothing awaits', async () => {
  const db = initDB(':memory:')
  let called = 0
  const summary = await runMomentumPartialPass(db, { deps: { bindAwaiting: async () => { called++; return [] } } })
  assert.equal(called, 0); assert.equal(summary.deferredBinds, undefined)
})

test('a plan the evidence cannot stand on refuses the entry by name before the gate', async t => {
  const s = await scene(t)
  s.momentum.assets = async () => ({ asset: [{ assetId: 5, name: 'ETH' }] }) // the quote asset cannot be named
  assert.equal(await s.run({ market: true }) ?? null, null)
  assert.ok(s.vetoes().some(v => v === 'momentum_plan_refused: quote_asset_unknown'), JSON.stringify(s.vetoes()))
  assert.equal(s.sent.length, 0); assert.equal(s.intents().length, 0)
})

test('the bound plan survives a restart: the intent, the trade and the partial plan read back unchanged', async t => {
  const s = await scene(t)
  assert.ok(await s.run({ market: true }))
  const db0 = s.db()
  const trade = db0.prepare(`SELECT * FROM trades WHERE account_id = ?`).get(ACCT)
  const before = readMomentumEntry(db0, ACCT, trade.id)
  s.reopen()
  const after = readMomentumEntry(s.db(), ACCT, trade.id)
  assert.deepEqual(after, before)
  const raw = new Database(s.dbPath, { readonly: true })
  t.after(() => raw.close())
  assert.equal(raw.prepare(`SELECT state FROM momentum_target_intents`).get().state, 'BOUND')
})
