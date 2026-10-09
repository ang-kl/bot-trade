// Codex · №12,523 · 2026-10-09; codex-footprint: six-strategy-lifecycle.
// One batch, real native strategy/shadow/firer/order/ring -> Node ledger/adoption
// -> native ratchet/durable trigger -> Node partial/SQLite residual/journal.
// The five candle computations below preserve their actual predicates; they are
// NOT represented as native tick entries or as a joined candle-admission test.
// Broker replies and account evidence are controlled fixtures, never live facts.
// SpotFeed subscription coverage remains in the unchanged native timestamp suite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDB, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { runOracle, normalizeParams, profileHashFull } from '../lib/tick-strategy.js'
import { vwapSeries } from '../lib/indicators.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, writeEngineStatus, requestEntryMode, acknowledgeEntryEpochs } from './entry-mode.js'
import { runTickPermitFeeder, PAUSE_CHECKS } from './tick-permits.js'
import { reconcileIntents } from './entry-ledger.js'
import { reconcilePositions } from './reconciler.js'
import { backfillAdoptedReasons } from './adopted-reasons.js'
import { runTickFireLedger } from './tick-fire-ledger.js'
import { enrolCappedHybrids } from './capped-hybrid-enrolment.js'
import { planCappedHybrid, readCappedHybridOwner } from './capped-hybrid-policy.js'
import { hybridSpec, hybridGroups, processHybridTick } from './hybrid-tick-controller.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { recordNativeTrailDecision } from './native-trail-events.js'
import { computeDonchianBreakout } from './donchian-breakout.js'
import { computeVaBreakout } from './va-breakout.js'
import { computeEmaPullback, emaSeries } from './ema-pullback.js'
import { computeVwapTrend } from './vwap-trend.js'
import { computeRsi2 } from './rsi2-reversion.js'
import { atr } from './fib-strategy.js'
import { applyManagedRules } from './managed-exit.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BINARY = join(ROOT, 'cpp-exec/bin/strategy-lifecycle-native')
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'cpp-exec/src/tests/fixtures/tick_momentum_fixture.json'), 'utf8'))
// A controlled minimum stop clears the unchanged production 0.15% floor.
// No production profile/config is changed. Real strategy/shadow rules still run.
FIXTURE.params = normalizeParams({ ...FIXTURE.params, minStopPrice: 300 })
const META = { lotSize: 10_000_000, minVolume: 1000, stepVolume: 1000, maxVolume: 1_000_000_000, digits: 5 }
const ACCOUNT = '4002', SYMBOL = 'EURUSD', SID = 41
const ready = () => ({ ready: true, readiness: PAUSE_CHECKS.map(check => ({ check, ok: true })) })
const rounded = n => Math.round(n * 100000) / 100000

function native(input) {
  assert.ok(existsSync(BINARY), 'required native integration fixture missing; compile strategy-lifecycle-native.cpp before the complete gate')
  const output = execFileSync(BINARY, { input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  // The actual native classes retain their ordinary diagnostic lines.
  return JSON.parse(output.trim().split('\n').at(-1))
}

function account(db, id, live) {
  upsertAccount(db, { accountId: id, isLive: live })
  db.prepare("UPDATE accounts SET enabled=1,mode='active' WHERE account_id=?").run(id)
  setState(db, `acct:${id}:account_balance_usd`, '10000')
  setState(db, `symbol_id_map:${id}`, JSON.stringify({ accountId: id, map: { [SYMBOL]: SID }, builtAt: new Date().toISOString() }))
  const st = engineStatusFor(db, id)
  writeEngineStatus(db, { ...st, profileHash: profileHashFull(FIXTURE.params), profileId: 'tick_momentum_breakout@v1',
    validationStage: 'SHADOW_PASSED', configRevision: st.configRevision + 1, updatedAt: new Date().toISOString() })
  const changed = requestEntryMode(db, id, 'TICK_MOMENTUM', { readiness: ready })
  assert.equal(changed.ok, true)
  acknowledgeEntryEpochs(db, { [id]: changed.status.modeEpoch })
}

async function feeder(db, live, extra = {}) {
  const host = live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com'
  const side = { isLive: live, name: live ? 'cpp_exec' : 'cpp_exec_demo' }
  const creds = { ready: true, accountId: ACCOUNT, host, clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' }
  const pushes = [], metadata = []
  const result = await runTickPermitFeeder(db, side, { creds, readiness: ready,
    resolveSymbolId: async () => ({ id: SID, source: 'controlled account catalogue' }),
    volumeMeta: async (c, id, symbol) => { metadata.push({ account: c.accountId, id, symbol }); return META },
    push: async (_c, body) => { pushes.push(body); return { ok: true } }, log: () => {}, ...extra })
  return { result, pushes, metadata, creds, gatewaySide: side }
}

function storeRing(db, side, ring) {
  const insert = db.prepare(`INSERT INTO cpp_decisions(side,boot_id,seq,ts_ms,component,kind,account_id,symbol_id,code,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  for (const e of ring.entries) insert.run(side.name, ring.bootId, e.seq, e.tsMs, e.component, e.kind,
    e.accountId == null ? null : String(e.accountId), e.symbolId ?? null, e.code ?? '', e.detail ?? '')
}

async function lifecycle(t, { live = false, side = 'BUY', snapshotFirst = false, damage = null } = {}) {
  const dir = tempDir('strategy-lifecycle-'), path = join(dir, 'ledger.db')
  const f = { db: initDB(path), dir, path, side, direction: side === 'BUY' ? 1 : -1, closes: [] }
  t.after(() => { try { f.db.close() } catch { /* already closed */ } })
  setState(f.db, 'ctrader_account_id', '4999') // deliberately not the trading account
  setState(f.db, 'tick_symbols_json', JSON.stringify([SYMBOL]))
  account(f.db, ACCOUNT, live)
  Object.assign(f, await feeder(f.db, live))
  assert.equal(f.result.permits, 2, JSON.stringify(f.result))
  const permit = f.pushes.at(-1).tickPermits.find(p => p.side === side).permit
  f.intent = permit.intentId
  assert.equal(f.db.prepare('SELECT state FROM entry_intents WHERE id=?').get(f.intent).state, 'RESERVED')
  f.entry = native({ mode: 'entry', host: f.creds.host, permit, fixture: FIXTURE })
  f.position = structuredClone(f.entry.position)
  f.initialRisk = Math.abs(f.position.price - f.position.stopLoss)
  // Model a broker stop already improved before the first owned snapshot.
  // This is not logged as a proven native movement. The immutable fire risk
  // must survive adoption of this current protection in BOTH arrival orders.
  f.position.stopLoss = rounded(f.position.price - f.direction * f.initialRisk / 4)
  f.initialVolume = f.position.tradeData.volume
  const ring = structuredClone(f.entry.ring)
  if (damage) damage(ring, f)
  setState(f.db, `${f.gatewaySide.name}_health_json`, JSON.stringify({ bootId: ring.bootId, accounts: [ACCOUNT],
    side: live ? 'live' : 'demo', tick: { feedAccountId: ACCOUNT } }))
  const adopt = () => {
    reconcileIntents(f.db, { accountId: ACCOUNT, positions: [f.position] })
    reconcilePositions(f.db, [f.position], [], (k, v) => setState(f.db, k, v), { accountId: ACCOUNT })
  }
  if (snapshotFirst) adopt()
  storeRing(f.db, f.gatewaySide, ring)
  f.ledger = runTickFireLedger(f.db)
  if (!snapshotFirst) {
    reconcileIntents(f.db, { accountId: ACCOUNT }) // real engine order_result establishes its order ID
    adopt()
  }
  // This is the ordinary repair path for an adoption that preceded its ring
  // receipt. Do not seed or rewrite a risk-event link in the test.
  await backfillAdoptedReasons(f.db)
  f.trade = f.db.prepare('SELECT * FROM trades WHERE account_id=? AND intent_id=?').get(ACCOUNT, f.intent)
  assert.ok(f.trade, 'actual reconciler adopted the native labelled fill')
  assert.equal(f.trade.origin, 'bot_market_dispatch')
  assert.equal(f.trade.strategy, 'tick_momentum_breakout')
  f.at = Date.now()
  const check = args => { assert.equal(args[0], f.creds.host); assert.equal(String(args[4]), ACCOUNT) }
  f.transports = {
    readCredentials: () => f.creds,
    symbols: async (...args) => { check(args); assert.deepEqual(args[5], [String(SID)]);
      return { ctidTraderAccountId: ACCOUNT, symbol: [{ symbolId: SID, ...META }] } },
    reconcile: async (...args) => { check(args); return { ctidTraderAccountId: ACCOUNT, position: [structuredClone(f.position)] } },
    deals: async (...args) => { check(args); return { ctidTraderAccountId: ACCOUNT, hasMore: false, deal: [f.entry.opening] } },
    close: async (c, order) => {
      assert.equal(c.accountId, ACCOUNT); assert.equal(c.host, f.creds.host)
      assert.equal(readPartialPlan(f.db, ACCOUNT, f.trade.id).state, 'SENDING')
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM hybrid_tick_receipts').get().n, 1)
      assert.equal(order.positionId, String(f.position.positionId))
      assert.equal(order.volume, f.initialVolume / 2)
      f.closes.push(order); f.position.tradeData.volume -= order.volume
      return { ctidTraderAccountId: ACCOUNT, executionType: 'ORDER_FILLED', deal: {
        dealId: '8002', orderId: '9002', positionId: String(f.position.positionId), symbolId: String(SID),
        tradeSide: side === 'BUY' ? 'SELL' : 'BUY', dealStatus: 'FILLED', volume: order.volume, filledVolume: order.volume,
        executionPrice: f.price, executionTimestamp: f.at, closePositionDetail: { entryPrice: f.position.price, closedVolume: order.volume },
      } }
    },
  }
  f.enrol = () => enrolCappedHybrids(f.db, { credsFor: () => f.creds, now: () => f.at, transports: f.transports })
  f.tick = event => processHybridTick(f.db, f.creds.host, event, { credsFor: () => f.creds, now: () => f.at, transports: f.transports })
  f.events = kind => f.db.prepare('SELECT * FROM position_events WHERE trade_id=? AND kind=?').all(f.trade.id, kind)
  f.reopen = () => { f.db.close(); f.db = initDB(path) }
  return f
}

function nativeExit(f, { race = false, runner = false } = {}) {
  const row = readPartialPlan(f.db, ACCOUNT, f.trade.id)
  const spec = hybridSpec(row, f.at)
  f.price = rounded(row.plan.trigger + (runner ? f.direction * f.initialRisk / 2 : 0))
  const bid = f.direction === 1 ? f.price : rounded(f.price - 0.00001)
  const ask = f.direction === 1 ? rounded(f.price + 0.00001) : f.price
  const out = native({ mode: 'exit', spec, position: f.position, now: f.at, bid, ask,
    protectionOnly: runner,
    trailDistance: f.initialRisk, staleTp: rounded(f.position.price + f.direction * 2.5 * f.initialRisk),
    ...(race ? { raceSl: rounded(f.price - f.direction * f.initialRisk / 2) } : {}),
    journal: join(f.dir, runner ? 'runner-native.ndjson' : 'native.ndjson') })
  f.position = out.position
  for (const entry of out.ring.entries) recordNativeTrailDecision(f.db, { side: f.gatewaySide, bootId: out.ring.bootId,
    entry, accountBinding: { accountId: ACCOUNT, host: f.creds.host } })
  return out
}

for (const live of [false, true]) for (const side of ['BUY', 'SELL']) for (const snapshotFirst of [false, true]) {
  test(`joined native ${live ? 'live' : 'demo'} ${side}, ${snapshotFirst ? 'snapshot' : 'ring'} first: owned entry, ratchet, half and durable runner`, async t => {
    const f = await lifecycle(t, { live, side, snapshotFirst })
    assert.equal(f.ledger.written, 1)
    const adopted = f.db.prepare('SELECT initial_risk,label_raw FROM monitored_positions WHERE trade_id=?').get(f.trade.id)
    assert.ok(Math.abs(adopted.initial_risk - f.initialRisk) > f.initialRisk / 2,
      'fixture really adopted a tighter broker stop, not the entry stop')
    assert.equal(f.trade.label_strategy, null, 'tick profile label is not fabricated into a candle label')
    assert.equal(f.db.prepare('SELECT state FROM entry_intents WHERE id=?').get(f.intent).state, 'FILLED')
    assert.equal((await f.enrol()).enrolled.length, 1)
    const plan = readPartialPlan(f.db, ACCOUNT, f.trade.id).plan
    assert.ok(Math.abs(plan.initialRisk - f.initialRisk) < 1e-10, 'current adopted SL must not redefine initial R')
    const tp = f.position.takeProfit
    const out = nativeExit(f)
    assert.equal(out.position.takeProfit, tp, 'stale Node TP is never sent by the native ratchet')
    assert.equal(out.amends.length, 1)
    assert.equal(out.amends[0].stopLossTriggerMethod, 2)
    assert.equal(out.amends[0].trailingStopLoss, true)
    assert.equal(f.events('trail_tightened').length, 1, 'actual native movement reaches the owned journal')
    const stop = f.position.stopLoss
    assert.equal((await f.tick(out.trigger)).state, 'CONFIRMED')
    assert.equal(f.closes.length, 1)
    assert.equal(f.position.tradeData.volume, f.initialVolume / 2)
    assert.equal(f.position.stopLoss, stop); assert.equal(f.position.takeProfit, tp)
    f.reopen()
    const retained = readPartialPlan(f.db, ACCOUNT, f.trade.id)
    assert.equal(retained.state, 'CONFIRMED')
    assert.equal(retained.evidence.observation.volume, f.initialVolume / 2)
    assert.equal(retained.evidence.observation.stopLoss, stop)
    assert.equal(retained.evidence.observation.takeProfit, tp)
    assert.deepEqual(f.db.prepare('SELECT initial_risk,label_raw FROM monitored_positions WHERE trade_id=?').get(f.trade.id), adopted,
      'new ownership proof never rewrites the adopted risk or broker label')
    const receipt = f.db.prepare('SELECT * FROM hybrid_tick_receipts').get()
    assert.deepEqual(JSON.parse(receipt.raw_json), out.trigger)
    assert.equal(JSON.parse(receipt.wire_response_json).deal.dealId, '8002')
    assert.equal(f.events('scale_out').length, 1)
    await f.tick(out.trigger)
    assert.equal(f.closes.length, 1); assert.equal(f.events('scale_out').length, 1)
    assert.deepEqual(hybridGroups(f.db, f.creds.host, { now: () => f.at, credsFor: () => f.creds }), [],
      'confirmed partial is no longer subscribed to native profit triggers')
    const runner = nativeExit(f, { runner: true })
    assert.equal(runner.trigger, undefined, 'runner continuation exercises protection only')
    assert.equal(runner.position.tradeData.volume, f.initialVolume / 2)
    assert.ok((runner.position.stopLoss - stop) * f.direction > 0, 'same residual still tightens on the next native tick')
    assert.equal(runner.position.takeProfit, tp)
    assert.equal(f.events('trail_tightened').length, 2)
  })
}

for (const side of ['BUY', 'SELL']) test(`joined ${side}: a competing tighter stop is unchanged, never a fictitious move`, async t => {
  const f = await lifecycle(t, { side })
  assert.equal((await f.enrol()).enrolled.length, 1)
  const tp = f.position.takeProfit, out = nativeExit(f, { race: true })
  assert.equal(out.amends.length, 0)
  assert.equal(out.trail.alreadyTighter, 1)
  assert.equal(out.ring.entries[0].kind, 'already_tighter')
  assert.equal(f.events('trail_tightened').length, 0)
  assert.equal(f.position.takeProfit, tp)
  assert.equal((await f.tick(out.trigger)).state, 'CONFIRMED')
  assert.equal(f.closes.length, 1)
})

for (const [name, damage] of [
  ['absent fire companion', ring => { ring.entries = ring.entries.filter(e => e.kind !== 'fire') }],
  ['foreign result account', ring => { ring.entries.find(e => e.kind === 'fire_result').accountId = 4999 }],
  ['malformed result stop', ring => { const e = ring.entries.find(e => e.kind === 'fire_result'); e.detail = e.detail.replace(/stop=\S+/, 'stop=true') }],
  ['different result symbol', ring => { ring.entries.find(e => e.kind === 'fire_result').symbolId = 99 }],
  ['fire companion beyond bounded provenance window', ring => {
    ring.entries.find(e => e.kind === 'fire_result').seq = ring.entries.find(e => e.kind === 'fire').seq + 4097
  }],
]) test(`actual ring/adoption refuses hybrid authority with ${name}`, async t => {
  const f = await lifecycle(t, { snapshotFirst: true, damage })
  assert.equal((await f.enrol()).enrolled.length, 0)
  assert.equal(readCappedHybridOwner(f.db, ACCOUNT, f.trade.id, String(f.position.positionId), 5), null)
  assert.equal(f.closes.length, 0)
})

test('RSI2 family retains its existing take and cannot inherit a native tick hybrid proof', async t => {
  const f = await lifecycle(t)
  f.db.prepare("UPDATE trades SET strategy='rsi2_reversion',label_strategy='rsi2_reversion' WHERE id=?").run(f.trade.id)
  f.db.prepare("UPDATE monitored_positions SET strategy='rsi2_reversion' WHERE trade_id=?").run(f.trade.id)
  assert.equal((await f.enrol()).enrolled.length, 0)
  const rules = applyManagedRules(f.db, ACCOUNT, {}, { strategy: 'rsi2_reversion' })
  assert.equal(rules.bankTriggerR, 1); assert.equal(rules.bankFraction, 0.5)
  assert.equal(f.closes.length, 0)
})

test('actual fill whose exact halves do not fit current broker steps refuses without rounding', async t => {
  const f = await lifecycle(t)
  f.transports.symbols = async () => ({ ctidTraderAccountId: ACCOUNT,
    symbol: [{ symbolId: SID, ...META, stepVolume: f.initialVolume }] })
  const result = await f.enrol()
  assert.equal(result.enrolled.length, 0)
  assert.ok(result.deferred.some(row => row.reason === 'half_and_runner_not_representable'), JSON.stringify(result))
  assert.equal(f.closes.length, 0)
})

for (const ownId of [99, null, SID]) test(`real feeder: target account symbol ${ownId} never borrows the feed's ${SID}`, async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'tick_symbols_json', JSON.stringify([SYMBOL]))
  account(db, ACCOUNT, false); account(db, '4003', false)
  const f = await feeder(db, false, { resolveSymbolId: async (_db, c) => ({ id: c.accountId === '4003' ? ownId : SID }) })
  const target = f.pushes.at(-1).tickPermits.filter(p => String(p.accountId) === '4003')
  assert.equal(target.length, ownId === SID ? 2 : 0)
  assert.equal(f.metadata.filter(m => m.account === '4003').length, ownId === SID ? 1 : 0)
  assert.ok(f.metadata.every(m => m.account === String(m.id) && m.symbol === SID))
  if (ownId !== SID) assert.ok(f.result.refused.some(r => r.reason.startsWith('tick_feed_symbol_identity_')))
})

test('collapsed feeder refuses a registered account whose host differs from the actual gateway', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'tick_symbols_json', JSON.stringify([SYMBOL]))
  account(db, ACCOUNT, false); account(db, '4003', true)
  const reads = [], pushes = []
  const result = await runTickPermitFeeder(db, { name: 'cpp_exec', isLive: null }, {
    creds: { ready: true, accountId: ACCOUNT, host: 'demo.ctraderapi.com', clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' },
    readiness: ready, resolveSymbolId: async () => ({ id: SID }),
    volumeMeta: async c => { reads.push(c.accountId); return META },
    push: async (_c, body) => { pushes.push(body); return { ok: true } }, log: () => {},
  })
  assert.ok(result.paused.some(p => p.reason === 'tick_account_host_identity_conflict'))
  assert.ok(!reads.includes('4003'))
  assert.ok(pushes.at(-1).tickPermits.every(p => String(p.accountId) !== '4003'))
})

test('six actual computations remain distinct: five candle predicates plus native tick reference', () => {
  const bar = (c, more = {}) => ({ o: c, h: c + 0.5, l: c - 0.5, c, v: 1000, ...more })
  const range = Array.from({ length: 45 }, (_, i) => { const phase = i % 12; return bar(100 + (phase <= 6 ? phase : 12 - phase) * 10 / 6) })
  const donchian = computeDonchianBreakout([...range, bar(111.5, { h: 111.7, l: 109.5, v: 2000 })], '1h')
  assert.equal(donchian?.strategy, 'donchian_breakout')
  assert.equal(computeDonchianBreakout([...range, bar(111.5, { h: 111.7, l: 109.5, v: 1000 })], '1h'), null)
  const t0 = 1_000_000_000_000
  const vaBars = Array.from({ length: 68 }, (_, i) => bar(105, { t: t0 + i * 60000 }))
  vaBars.push(bar(111.5, { t: t0 + 68 * 60000, o: 109, h: 111.6, l: 108.8 }),
    bar(110.9, { t: t0 + 69 * 60000, o: 111.3, h: 111.4, l: 110.1 }))
  const structure = { prev: { vpoc: 105, vah: 110, val: 100, height: 10, rows: [] }, current: null,
    openPrice: 105, openMs: t0, sessionBars: 70, structure: 'ranging', reference: null, role: null, lvns: [], migration: null }
  assert.equal(computeVaBreakout(vaBars, '15m', { structure })?.strategy, 'va_breakout')
  assert.equal(computeVaBreakout(vaBars.map((b, i) => i === 68 ? { ...b, c: 109.8 } : b), '15m', { structure }), null)
  const emaBars = Array.from({ length: 460 }, (_, i) => bar(100 + i * 0.15, { t: i, o: 100 + i * 0.15 - 0.15, v: 1 }))
  const close = emaBars.at(-1).c + 0.1, ema = close * 2 / 21 + emaSeries(emaBars, 20).at(-1) * 19 / 21
  const emaSignal = computeEmaPullback([...emaBars, bar(close, { l: ema - 0.3, v: 1 })], '1h')
  assert.equal(emaSignal?.strategy, 'ema_pullback')
  assert.equal(computeEmaPullback(emaBars.slice(0, 100), '1h'), null)
  const vwBars = Array.from({ length: 40 }, (_, i) => {
    const mid = 100 + i * 0.1
    return bar(mid + 0.4, { t: Date.UTC(2026, 6, 20) + i * 3600000, o: mid - 0.5, h: mid + 1.5, l: mid - 1.5 })
  })
  const v = vwapSeries(vwBars, 0).at(-1), a = atr(vwBars, 14)
  vwBars.push(bar(v + 0.6 * a, { t: Date.UTC(2026, 6, 20) + 40 * 3600000, o: v + 0.2, h: v + a, l: v - 0.3 * a, v: 1500 }))
  const vwapSignal = computeVwapTrend(vwBars, '1h')
  assert.equal(vwapSignal?.strategy, 'vwap_trend')
  assert.equal(computeVwapTrend(Array.from({ length: 40 }, (_, i) => bar(100, { t: i * 3600000 })), '1h'), null)
  const rsiBars = Array.from({ length: 120 }, (_, i) => bar(101 + i, { h: 101.4 + i, l: 100.6 + i }))
  rsiBars.push(bar(215, { h: 215.4, l: 214.6 }), bar(210, { h: 210.4, l: 209.6 }))
  assert.equal(computeRsi2(rsiBars, '1h')?.strategy, 'rsi2_reversion')
  assert.equal(computeRsi2(rsiBars, '15m'), null)
  for (const signal of [emaSignal, vwapSignal]) {
    const policy = planCappedHybrid({ side: 'BUY', entry: signal.entry, initialRisk: signal.entry - signal.sl,
      brokerTarget: signal.tp1, volume: 10000, minVolume: 1000, stepVolume: 1000, digits: 5, openingDealIds: ['1'] })
    assert.equal(policy.reason, 'existing_tp_caps_before_runner', 'actual 2R candle target is preserved, never stretched for a hybrid pass')
  }
  const ticks = runOracle(FIXTURE.events, FIXTURE.params)
  assert.deepEqual(ticks.signals.map(s => s.side), ['BUY', 'SELL'])
  assert.ok(ticks.signals.every(s => s.confirmations === 2 && s.stopDistance >= 300))
})
