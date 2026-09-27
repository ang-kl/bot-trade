// node --test agent/services/momentum-entry-t4.test.js
//
// V3 T4 (P0-3): a momentum market entry carries the partial-TP1 plan, behind
// config/momentum-entries.json (shipped OFF; ON since the owner's OD-1,
// 27-09-2026 ~12:30 SGT: "yes. Resume momentum entries after T4").
//
// What is proven here, by behaviour through the real autoTrade:
//   * the switch is ON as the repo declares it, and with it off a momentum entry takes
//     exactly the pre-T4 path: no evidence read, no intent, the order refused
//     at the shared execution boundary for having no target;
//   * with it on, a closed-market momentum entry is refused BY NAME and
//     nothing rests (OD-1(b)); an entry that would rest as an HTF limit is
//     refused by name (P0-4 and OD-15's counting not built);
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
import { initDB, setState, getState } from '../db.js'
import { seedMomentumAccountFromConfig, isMomentumAccount } from './momentum-account.js'
import { seedStrategyPinsFromConfig, armedTradeKeys } from './stage-matrix.js'
import { seedGlobalStrategiesFromConfig } from './global-strategy-seed.js'
import { validateOrderBracket, invalidateSidecarSession } from '../lib/exec-engine.js'
import { relativePoints } from '../lib/lot-sizing.js'
import { loadMomentumEntrySwitch, momentumPlanApplies, MOMENTUM_ENTRY_PRODUCERS } from './momentum-entry-switch.js'
import { swapCarryReserve, medianBookHoldingNights, gridStop, MOMENTUM_CLOSED_MARKET_REFUSAL,
  MOMENTUM_RESTING_LIMIT_REFUSAL, MOMENTUM_INTENT_AMBIGUOUS } from './momentum-entry-producer.js'
import { readMomentumEntry } from './momentum-entry-contract.js'
import { loadClosedMarketLimitsConfig } from './closed-market-limits.js'
import { bookEntryWrite } from './book-entry-write.js'
import { readPartialPlan, runPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { runMomentumPartialPass } from './momentum-partial-runtime.js'
import { secondsIntoWeek } from './symbol-hours.js'
import { recordMarketCalendar } from './market-calendar.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'

const ACCT = '4001', SYMBOL = 'ETHUSD', SID = 22
const TRIAL_ACCT = '46130058' // the approved account in config/momentum-entries.json (B1)
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
test('the switch is ON as the repo declares it (owner OD-1, 27-09): both momentum producers take the T4 path, nothing else does', () => {
  const sw = loadMomentumEntrySwitch()
  assert.equal(sw.market, true, 'config/momentum-entries.json carries the owner\'s OD-1: market entries on')
  assert.equal(sw.error, null, 'the shipped file is readable')
  // B1: exactly the approved account (…0058, the tsmom_long trial account).
  assert.deepEqual(sw.accounts, [TRIAL_ACCT])
  for (const p of MOMENTUM_ENTRY_PRODUCERS) {
    assert.equal(momentumPlanApplies(p, { accountId: TRIAL_ACCT }), true, p)
    assert.equal(momentumPlanApplies(p, { accountId: '46130949' }), false, `${p} on an unlisted account`)
    assert.equal(momentumPlanApplies(p), false, `${p} with no account`)
  }
  // No widening: the switch names exactly the two momentum producers; every
  // other producer (the scan, the routes, the fib orders) never takes the path.
  assert.deepEqual([...MOMENTUM_ENTRY_PRODUCERS], ['cross_sectional_book', 'daily_momentum_account'])
  for (const p of ['scan_dispatch', 'pending_fib_orders', 'manual_assisted', undefined]) assert.equal(momentumPlanApplies(p, { accountId: TRIAL_ACCT }), false, String(p))
})

test('B1: a fresh database seeded with the shipped configs in boot order arms tsmom_long on every account, and only the listed account takes the momentum market path', () => {
  const db = initDB(':memory:')
  try {
    const ids = [TRIAL_ACCT, '46130949', '46139908', '46133489']
    for (const id of ids) db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id.slice(-4))
    // index.js boot order: momentum account → strategy pins → (watchlists) → global arm.
    seedMomentumAccountFromConfig(db)
    seedStrategyPinsFromConfig(db, { getState, setState })
    seedGlobalStrategiesFromConfig(db, { getState, setState })
    // The hazard the account list closes: the arm state alone arms every account.
    for (const id of ids) assert.equal(armedTradeKeys(db, getState, id).has('tsmom_long'), true, `tsmom_long armed on ${id} by the shipped seeds`)
    for (const id of ids) assert.equal(isMomentumAccount(db, id), true, `${id} runs the daily pass under _all`)
    // The shipped switch: only the listed account takes the plan path.
    for (const p of MOMENTUM_ENTRY_PRODUCERS) {
      assert.deepEqual(ids.filter(id => momentumPlanApplies(p, { accountId: id })), [TRIAL_ACCT], p)
    }
  } finally { db.close() }
})

test('the account list: only well-formed ids count; missing, empty or malformed names no account (fail closed)', () => {
  const dir = tempDir('t4-accounts-')
  const at = (name, text) => { const f = join(dir, name); writeFileSync(f, text); return f }
  for (const [name, text] of [['none.json', '{"market":true}'], ['empty.json', '{"market":true,"accounts":[]}'],
    ['string.json', '{"market":true,"accounts":"46130058"}'], ['number.json', '{"market":true,"accounts":[46130058]}'],
    ['alias.json', '{"market":true,"accounts":["_all"]}']]) {
    const load = () => loadMomentumEntrySwitch(at(name, text))
    assert.deepEqual(load().accounts, [], name)
    assert.equal(momentumPlanApplies('cross_sectional_book', { accountId: TRIAL_ACCT, load }), false, name)
  }
})

test('only the literal true turns the switch on; unreadable is off; non-momentum producers never take the path', () => {
  const dir = tempDir('t4-switch-')
  const at = (name, text) => { const f = join(dir, name); if (text != null) writeFileSync(f, text); return f }
  for (const [name, text] of [['string.json', '{"market":"true"}'], ['one.json', '{"market":1}'], ['bad.json', '{market:true'],
    ['missing.json', null], ['null.json', 'null']]) {
    assert.equal(loadMomentumEntrySwitch(at(name, text)).market, false, name)
  }
  const on = at('on.json', '{"market":true,"accounts":["11"]}')
  assert.equal(loadMomentumEntrySwitch(on).market, true)
  const load = () => loadMomentumEntrySwitch(on)
  assert.equal(momentumPlanApplies('cross_sectional_book', { accountId: '11', load }), true)
  assert.equal(momentumPlanApplies('daily_momentum_account', { accountId: 11, load }), true)
  for (const p of ['scan_dispatch', 'tick_momentum', 'closed_market_limits', 'manual_assisted', undefined]) {
    assert.equal(momentumPlanApplies(p, { accountId: '11', load }), false, String(p))
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
  const hours = open ? ALWAYS_OPEN : closedNow()
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)`).run(SYMBOL, hours, 'UTC')
  // The SAME hours as the account's own calendar (V3 S-8's entry-hours
  // source: the registry's host, the account's own symbol map, the recorded
  // calendar), so the scene reads one market state whichever source the
  // entry gate uses — symbol_hours before S-8, the account calendar after.
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  setState(db, accountSymbolMapKey(ACCT), JSON.stringify({ builtAt: new Date().toISOString(), accountId: ACCT, map: { [SYMBOL]: SID } }))
  const cal = recordMarketCalendar(db, { host: 'demo.ctraderapi.com', accountId: ACCT, symbolId: String(SID) },
    { symbolId: SID, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: JSON.parse(hours), holiday: [] })
  assert.deepEqual([cal.recorded, cal.reason], [true, null], 'the scene\'s calendar is valid evidence')
  // The book's holding record: one closed row of 10 nights (OD-3's median).
  db.prepare(`INSERT INTO momentum_book (account_id, symbol, side, entered_at, exited_at, status) VALUES (?, 'BTCUSD', 'long', ?, ?, 'closed')`)
    .run(ACCT, '2026-09-01T00:00:00Z', '2026-09-11T00:00:00Z')
  broker.setQuote(SID, { bid: 99.9, ask: 100 })
  const s = { broker, dbPath, reads: { symbolsList: 0, assets: 0, symbolsById: 0, quote: 0, reconcile: 0 }, sent: [], limits: [], fillAsk: null }
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
  // A switch given without an account list names the scene's account (B1:
  // the switch applies only to listed accounts); a test that passes its own
  // `accounts` gets exactly that.
  s.seam = (entrySwitch) => ({
    entrySwitch: entrySwitch && !('accounts' in entrySwitch) ? { ...entrySwitch, accounts: [ACCT] } : entrySwitch,
    // SF5: the resting-limit placement, recorded instead of sent. It answers
    // 'off' exactly as the real module does when the feature is off, and a
    // placement otherwise, so a mutant that reaches it fails on an assertion
    // (s.limits) rather than on a broker read that never answers.
    placeClosedMarketLimit: async (db_, _creds, symbol, synth, opts) => {
      if (!loadClosedMarketLimitsConfig(db_).on) return { skipped: 'off' }
      s.limits.push({ symbol, synth, opts })
      return { placed: true, limitPrice: synth.entry, expiresAt: 'test' }
    },
    momentum: s.momentum, skipForensics: true, bindSleep: async () => {},
    resolveSymbolId: async () => ({ id: String(SID), source: 'test' }),
    getVolumeMeta: async () => ({ lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2 }),
    wsGetSpotOnce: async () => ({ bid: 99.9, ask: 100 }),
    wsReconcile: async () => broker.reconcile(ACCT),
    // The shared execution boundary's own guard, then the fake broker's fill.
    execPlaceOrder: async (_creds, payload) => {
      s.sent.push(payload)
      if (s.placeError) throw s.placeError
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

test('B1, SWITCH ON as shipped, an account NOT in the list takes the pre-T4 path — no evidence read, no intent, refused at the boundary', async t => {
  const s = await scene(t)
  const shipped = loadMomentumEntrySwitch()
  assert.deepEqual([shipped.market, shipped.accounts.includes(ACCT)], [true, false], 'the scene account is not listed')
  assert.equal(await s.run(shipped) ?? null, null, 'no entry')
  assert.deepEqual(s.reads, { symbolsList: 0, assets: 0, symbolsById: 0, quote: 0, reconcile: 0 }, 'no momentum evidence read')
  assert.equal(s.intents().length, 0, 'no target intent recorded')
  assert.equal(s.broker.positions(ACCT).length, 0)
  assert.ok(s.vetoes().some(v => /guard_no_target/.test(v)), JSON.stringify(s.vetoes()))
  assert.ok(!s.vetoes().some(v => v.startsWith('momentum_')), 'no T4 refusal for an unlisted account')
})

test('SWITCH OFF, closed market: the pre-T4 closed-market branch runs, no named momentum refusal', async t => {
  const s = await scene(t, { open: false })
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: false }))
  assert.equal(await s.run({ market: false }) ?? null, null)
  assert.ok(s.vetoes().some(v => v.startsWith('market_closed:')), JSON.stringify(s.vetoes()))
  assert.ok(!s.vetoes().some(v => v.startsWith(MOMENTUM_CLOSED_MARKET_REFUSAL)))
})

test('SWITCH OFF, an HTF entry of the daily momentum account takes the pre-T4 resting-limit branch, no named refusal (N1)', async t => {
  const s = await scene(t)
  // Deterministic "not fresh": no backtest-parity window, so a 1d signal
  // always reaches the resting-limit branch. With the resting-limit feature
  // off, placeClosedMarketLimit answers 'off' before any broker call.
  setState(s.db(), 'risk_config_json', JSON.stringify({ htfLimitDispatch: { minTf: '4h', freshnessMin: 0 } }))
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: false }))
  const lines = []
  const orig = console.log
  console.log = (...a) => { lines.push(a.join(' ')); orig(...a) }
  try {
    const synth = bookSynth({ marketOnly: false, source: 'momentum_account', timeframe: '1d' })
    assert.equal(await s.run({ market: false }, synth, 'daily_momentum_account') ?? null, null)
  } finally { console.log = orig }
  assert.ok(lines.some(l => /HTF limit for ETHUSD 1d: off/.test(l)), 'the pre-T4 resting-limit branch was reached: ' + JSON.stringify(lines.filter(l => /HTF|MOMENTUM/.test(l))))
  assert.ok(!s.vetoes().some(v => v.startsWith(MOMENTUM_RESTING_LIMIT_REFUSAL)), JSON.stringify(s.vetoes()))
  assert.ok(!lines.some(l => /MOMENTUM REFUSED/.test(l)), 'no T4 refusal while off')
  assert.deepEqual(s.reads, { symbolsList: 0, assets: 0, symbolsById: 0, quote: 0, reconcile: 0 })
  assert.equal(s.sent.length, 0)
})

test('SWITCH ON, a refused intent rolls the submitting trade row back and no order is sent (N2)', async t => {
  const s = await scene(t)
  // The intent table as recordMomentumEntry creates it, refusing every insert.
  s.db().exec(`CREATE TABLE momentum_target_intents (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, risk_event_id INTEGER NOT NULL,
    proposal_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'PREPARED', position_id TEXT, plan_json TEXT, fill_json TEXT,
    PRIMARY KEY(account_id,trade_id));
    CREATE TRIGGER t4_refuse_intent BEFORE INSERT ON momentum_target_intents BEGIN SELECT RAISE(ABORT, 'test refuses the intent'); END;`)
  assert.equal(await s.run({ market: true }) ?? null, null)
  assert.ok(s.vetoes().some(v => v === 'momentum_intent_refused: test refuses the intent'), JSON.stringify(s.vetoes()))
  assert.equal(s.db().prepare('SELECT count(*) n FROM trades').get().n, 0, 'the submitting trade row rolled back with the intent')
  assert.equal(s.intents().length, 0)
  assert.equal(s.sent.length, 0, 'no order sent'); assert.equal(s.broker.positions(ACCT).length, 0)
  assert.ok(s.reads.quote > 0, 'control: the plan path ran up to the intent')
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
  assert.equal(s.limits.length, 0, 'the resting-limit placement was never asked')
  assert.equal(s.sent.length, 0); assert.equal(s.reads.quote, 0)
  // Once per closed spell: a second attempt logs but does not add a row.
  await s.run({ market: true })
  assert.equal(s.vetoes().filter(x => x.startsWith(MOMENTUM_CLOSED_MARKET_REFUSAL)).length, 1)
})

test('SWITCH ON, an entry that would rest as an HTF limit is refused by name (OD-15, P0-4)', async t => {
  const s = await scene(t)
  // The resting-limit feature ON and no parity window: without the named
  // refusal the entry would rest (SF5: the seam records it in s.limits).
  setState(s.db(), 'risk_config_json', JSON.stringify({ htfLimitDispatch: { minTf: '4h', freshnessMin: 0 } }))
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: true }))
  const synth = bookSynth({ marketOnly: false, source: 'momentum_account', timeframe: '1d' })
  assert.equal(await s.run({ market: true }, synth, 'daily_momentum_account') ?? null, null)
  const v = s.vetoes()
  assert.ok(v.some(x => x.startsWith(`${MOMENTUM_RESTING_LIMIT_REFUSAL}: ${SYMBOL} 1d would rest as a limit`)), JSON.stringify(v))
  assert.equal(s.limits.length, 0, 'the resting-limit placement was never asked')
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

test('SF3: an ambiguous momentum send leaves the intent PREPARED and records it by name (no silent loss of the partial)', async t => {
  const s = await scene(t)
  // A sidecar timeout after the request left: the outcome is UNKNOWN.
  s.placeError = new Error('exec sidecar timeout after 30000 ms')
  assert.equal(await s.run({ market: true }) ?? null, null)
  const db = s.db()
  const trade = db.prepare(`SELECT id, status FROM trades WHERE account_id = ?`).get(ACCT)
  assert.equal(trade.status, 'unconfirmed', 'the ledger row says the outcome is unknown')
  const [intent] = s.intents()
  assert.deepEqual([intent.state, intent.position_id], ['PREPARED', null], 'nothing to bind: no position was named')
  const rows = db.prepare(`SELECT stage, decision, reason, detail_json FROM decision_log WHERE stage = 'momentum_intent_ambiguous'`).all()
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.ok(rows[0].reason.startsWith(`${MOMENTUM_INTENT_AMBIGUOUS}: ${SYMBOL} trade ${trade.id}`), rows[0].reason)
  assert.equal(JSON.parse(rows[0].detail_json).tradeId, trade.id)
  assert.ok(s.vetoes().some(v => v.startsWith('order_ambiguous:')), JSON.stringify(s.vetoes()))
})

test('SF3 control: a provably-unsent momentum order is not recorded as an ambiguous intent', async t => {
  const s = await scene(t)
  // The sidecar's own attestation that the request never reached the socket.
  s.placeError = new Error('sidecar 503: {"errorCode":"NOT_CONNECTED","description":"not sent"}')
  await s.run({ market: true })
  assert.equal(s.db().prepare(`SELECT status FROM trades WHERE account_id = ?`).get(ACCT)?.status, 'rejected')
  assert.equal(s.db().prepare(`SELECT count(*) n FROM decision_log WHERE stage = 'momentum_intent_ambiguous'`).get().n, 0)
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

// ---------------------------------------------------------------------------
// S-8 x T4: one market verdict, no double refusal and no gap. S-8's UNKNOWN
// (the account calendar cannot say) is refused by S-8 for every producer; a
// real CLOSED reading, a broker holiday included, gets T4's named refusal.
// ---------------------------------------------------------------------------
test('S-8 x T4, SWITCH ON, hours UNKNOWN: S-8 refuses it once; no T4 closed-market refusal and nothing rested', async t => {
  const s = await scene(t)
  // The account's own map lacks the symbol: UNKNOWN, not refreshable, no broker read.
  setState(s.db(), accountSymbolMapKey(ACCT), JSON.stringify({ builtAt: new Date().toISOString(), accountId: ACCT, map: { OTHER: 99 } }))
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: true }))
  assert.equal(await s.run({ market: true }) ?? null, null)
  const d = s.db().prepare(`SELECT stage, decision FROM decision_log WHERE stage IN ('market_hours_unknown', 'momentum_closed_market') ORDER BY id`).all()
  assert.deepEqual(d.map(r => r.stage), ['market_hours_unknown'], JSON.stringify(d))
  assert.ok(!s.vetoes().some(v => v.startsWith(MOMENTUM_CLOSED_MARKET_REFUSAL)), 'UNKNOWN is not recorded as a closed market')
  assert.equal(s.db().prepare(`SELECT value FROM agent_state WHERE key = ?`).get(`momentum_closed_refused_cross_sectional_book_${ACCT}_${SYMBOL}`)?.value ?? null, null,
    'an UNKNOWN pass neither records nor re-arms the closed-spell key')
  assert.equal(s.db().prepare(`SELECT count(*) n FROM pending_orders`).get().n, 0, 'no limit rested')
  assert.equal(s.sent.length, 0); assert.equal(s.reads.quote, 0)
})

test('S-8 x T4, SWITCH ON, a broker holiday on the account calendar: T4 refuses it by name, once; S-8 records no UNKNOWN', async t => {
  const s = await scene(t)
  const today = Math.floor(Date.now() / 86400_000)
  const cal = recordMarketCalendar(s.db(), { host: 'demo.ctraderapi.com', accountId: ACCT, symbolId: String(SID) }, {
    symbolId: SID, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: JSON.parse(ALWAYS_OPEN),
    holiday: [{ holidayId: 1, name: 'test holiday', scheduleTimeZone: 'UTC', holidayDate: today, isRecurring: false, startSecond: 0, endSecond: 86400 }] })
  assert.deepEqual([cal.recorded, cal.reason], [true, null])
  setState(s.db(), 'closed_market_limits_json', JSON.stringify({ on: true }))
  assert.equal(await s.run({ market: true }) ?? null, null)
  await s.run({ market: true })
  const refusals = s.vetoes().filter(v => v.startsWith(`${MOMENTUM_CLOSED_MARKET_REFUSAL}: ${SYMBOL} market closed`))
  assert.equal(refusals.length, 1, JSON.stringify(s.vetoes()))
  assert.match(refusals[0], /broker holiday/, 'the calendar\'s reason rides the named refusal')
  const d = s.db().prepare(`SELECT stage FROM decision_log WHERE stage IN ('market_hours_unknown', 'momentum_closed_market') ORDER BY id`).all()
  assert.deepEqual(d.map(r => r.stage), ['momentum_closed_market'])
  assert.equal(s.db().prepare(`SELECT count(*) n FROM pending_orders`).get().n, 0, 'no limit rested for the next open')
  assert.equal(s.sent.length, 0); assert.equal(s.reads.quote, 0)
})
