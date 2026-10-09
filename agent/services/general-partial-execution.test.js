// Codex · №12,639 · 2026-10-09; codex-footprint: actual-partial-transaction-integration.
// Execute the repository's real executor/monitor/statements over real SQLite.
// Broker transports, offline credential/metadata boundaries and evaluator policy inputs are controlled.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, getState, setState, closeTradeRow } from '../db.js'
import * as loop from '../loop.js'
import * as nullGuardModule from './null-exit-guard.js'
import * as moneyModule from '../lib/deal-money.js'
import { loadRiskConfig } from './risk.js'
import * as creds from '../lib/ctrader-creds.js'
import { assertReconcileIdentity } from './reconciler.js'
import { recordPositionEvent } from './position-events.js'
import { runGeneralPartial, readGeneralPartial, recordEvaluationMetrics, pendingGeneralPartialPositions } from './general-partial-execution.js'
import { runFastMonitor, _resetFastDecisionStateForTests } from './fast-monitor.js'
import { evaluatePosition, DEFAULT_RULES } from './position-manager.js'

const source = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
const segment = (start, end) => {
  const i = source.indexOf(start), j = source.indexOf(end, i)
  assert.ok(i >= 0 && j > i, `actual source boundary: ${start}`)
  return source.slice(i, j).replace(/^export /, '')
}
const executor = segment('export async function executeBrokerAction(', '\n// D4 (2026-07-27)')
  .replaceAll("await import('./lib/ctrader-creds.js')", 'credsModule')
  .replaceAll("await import('./lib/lot-sizing.js')", 'metaModule')
  .replaceAll("await import('./lib/ctrader-ws.js')", 'wsModule')
  .replaceAll("await import('./services/null-exit-guard.js')", 'nullGuardModule')
  .replaceAll("await import('./lib/deal-money.js')", 'moneyModule')
const statements = segment('export function prepareStatements(', '\n  return stmts\n}') + '\n  return stmts\n}'
const monitor = segment('export async function monitorOnePosition(', '\nexport const MONITOR_CONCURRENCY')
const phase = segment('export async function runMonitorPhase(', '\n// D4b:')

function fixture(t, { short = false, account = '42' } = {}) {
  const path = join(tempDir('general-partial-'), 'db.sqlite')
  let db = initDB(path), s
  const state = { closes: [], amends: [], volume: 10000, after: 5000, history: [], logs: [], response: null }
  setState(db, 'ctrader_access_token', 'offline')
  setState(db, 'ctrader_account_id', '42')
  for (const [acct, live, symbol] of [['42', 0, 1], ['99', 1, 73]]) {
    db.prepare('INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,?,1,\'active\')').run(acct, live)
    setState(db, `symbol_id_map:${acct}`, JSON.stringify({ accountId: acct, map: { EURUSD: symbol }, builtAt: new Date().toISOString() }))
  }
  const symbolId = account === '42' ? 1 : 73, direction = short ? 2 : 1
  const tradeId = Number(db.prepare("INSERT INTO trades(symbol,side,entry_price,volume,status,ctrader_position_id,account_id,opened_at) VALUES ('EURUSD',?,1.1,0.1,'open','9001',?,datetime('now'))").run(short ? 'SELL' : 'BUY', account).lastInsertRowid)
  const monitorId = Number(db.prepare("INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,status,account_id,source,strategy) VALUES ('EURUSD',?,?,1.1,?, ?,0.01,'active',?,'autopilot','rsi2')").run(tradeId, short ? 'short' : 'long', short ? 1.11 : 1.09, short ? 1.06 : 1.14, account).lastInsertRowid)
  const pos = () => db.prepare('SELECT * FROM monitored_positions WHERE id=?').get(monitorId)
  const snapshot = () => ({ ctidTraderAccountId: Number(account), position: [{ positionId: '9001', positionStatus: 1, price: 1.1,
    stopLoss: pos().current_sl, takeProfit: pos().current_tp, tradeData: { symbolId, tradeSide: direction, volume: state.volume } }] })
  const fill = (quantity = 5000) => ({ ctidTraderAccountId: Number(account), executionType: 3,
    deal: { dealId: '7001', orderId: '8001', positionId: '9001', symbolId, tradeSide: short ? 1 : 2, dealStatus: 2,
      volume: quantity, filledVolume: quantity, executionPrice: short ? 1.08 : 1.12, executionTimestamp: Date.now(),
      closePositionDetail: { entryPrice: 1.1, closedVolume: quantity } } })
  const context = vm.createContext({ ...loop, getState, setState, closeTradeRow, nullGuardModule, moneyModule, loadRiskConfig, runGeneralPartial, recordEvaluationMetrics, pendingGeneralPartialPositions,
    ctraderEnv: () => 'offline', withCtraderTokenSource: creds.withCtraderTokenSource, assertReconcileIdentity, recordPositionEvent,
    credsModule: { ...creds, credsForRegisteredAccount: () => ({ ready: true, host: account === '42' ? 'demo.ctraderapi.com' : 'live.ctraderapi.com', accountId: account }) },
    metaModule: { getVolumeMeta: async () => ({ lotSize: 100000, minVolume: 100, stepVolume: 100, digits: 5, brokerDigits: 5, ...state.meta }) },
    wsModule: { wsReconcile: async (_host, _id, _secret, _token, acct, timeout, retries) => {
      assert.equal(String(acct), account); assert.equal(timeout, 4000); assert.equal(retries, 0)
      return state.reconcile ? state.reconcile() : snapshot()
    }, wsGetPositionDeals: async () => ({ ctidTraderAccountId: Number(account), hasMore: false, deal: state.history }) },
    execReconcile: async () => state.reconcile ? state.reconcile() : snapshot(),
    execClosePosition: async (c, order) => {
      state.closes.push({ accountId: c.accountId, host: c.host, ...order })
      const r = state.response ? await state.response() : fill()
      state.volume = state.after
      return r
    },
    execAmendPosition: async (c, order) => { state.amends.push(order); return { protection: { stopLoss: order.stopLoss } } },
    symbolDigitsFor: async () => 5, measureAmend: async (_meta, fn) => fn(),
    applyManagedRules: (_db, _acct, rules) => rules, rulesForSymbol: () => ({ ...DEFAULT_RULES, bankTriggerR: 0 }),
    cachedAtrForSymbol: () => null, evaluatePosition, manageStageAllows: () => true,
    runWithClosedMarketHold: ({ run }) => run(), log: (...args) => state.logs.push(args.join(' ')),
  })
  vm.runInContext('let stmts; ' + statements + '\n' + executor + '\n' + monitor + '\n' + phase, context)
  const resetStatements = () => { vm.runInContext('stmts = null', context); s = context.prepareStatements(db) }
  resetStatements()
  const decision = { action: 'PARTIAL_EXIT', exitFraction: 0.5, newSL: null, reason: 'integrated partial', updates: { scaled_out: 1, be_moved: 1 } }
  const run = (extra = {}) => context.executeBrokerAction(db, s, pos(), { ...decision, ...extra })
  const read = () => ({ trade: db.prepare('SELECT * FROM trades WHERE id=?').get(tradeId), position: pos(),
    journal: db.prepare("SELECT * FROM position_events WHERE trade_id=? AND kind='scale_out'").all(tradeId),
    attempt: readGeneralPartial(db, account, '9001') })
  t.after(() => db.close())
  return { get db() { return db }, get s() { return s }, state, fill, snapshot, run, read, pos,
    fast: () => {
      _resetFastDecisionStateForTests()
      const now = Date.now()
      return runFastMonitor(db, { ready: true, host: 'demo.ctraderapi.com', clientId: 'offline', clientSecret: 'offline', accessToken: 'offline', accountId: account, isLive: false }, {
        now: () => now, loop: { ...loop, prepareStatements: () => s, executeBrokerAction: context.executeBrokerAction },
        exec: { sidecarQuotes: async () => ({ accountId: account, quotes: [{ symbolId, bid: 1.12, ask: 1.1201, tsMs: now, recvMs: now }] }) },
        ws: { wsGetSpotOnce: async () => { throw Error('unexpected quote fallback') }, wsGetTrendbarsBatch: async () => ({ '1m': [] }) },
      })
    },
    monitor: () => context.monitorOnePosition(db, s, pos(), short ? 1.08 : 1.12, null),
    recover: () => context.runMonitorPhase(db, s, [], () => null, null),
    restart: () => { db.close(); db = initDB(path); resetStatements() } }
}
function untouched(f) {
  const r = f.read()
  assert.equal(r.trade.volume, 0.1)
  assert.equal(r.position.scaled_out, 0)
  assert.equal(r.position.be_moved, 0)
  assert.equal(r.journal.length, 0)
}

for (const opts of [{}, { short: true, account: '99' }]) test(`actual executor confirms owned ${opts.short ? 'live short' : 'demo long'} partial exactly once`, async t => {
  const f = fixture(t, opts), r = await f.run()
  assert.equal(r.partialConfirmed, true, JSON.stringify(r))
  assert.equal(f.read().trade.volume, 0.05)
  assert.equal(f.read().position.scaled_out, 1)
  assert.equal(f.read().position.be_moved, 0)
  assert.equal(f.read().journal[0].to_value, 5000)
  const detail = JSON.parse(f.read().journal[0].detail_json)
  assert.equal(detail.receipt.dealId, '7001'); assert.equal(detail.residual.volume, 5000)
  await f.run(); f.restart(); await f.run()
  assert.equal(f.state.closes.length, 1); assert.equal(f.read().journal.length, 1)
  assert.equal(f.state.amends.length, 0)
})
test('actual executor records an underfill and its confirmed residual, not requested units', async t => {
  const f = fixture(t); f.state.response = () => f.fill(1000); f.state.after = 9000
  const r = await f.run(); assert.equal(r.partialConfirmed, true, JSON.stringify(r))
  assert.equal(f.state.closes[0].volume, 5000)
  assert.equal(f.read().trade.volume, 0.09); assert.equal(f.read().journal[0].to_value, 1000)
})
for (const [name, mutate] of [
  ['empty', () => ({})], ['malformed quantity', r => ({ ...r, deal: { ...r.deal, filledVolume: '5000' } })],
  ['missing quantity', r => ({ ...r, deal: { ...r.deal, filledVolume: undefined } })],
  ['foreign account', r => ({ ...r, ctidTraderAccountId: 99 })],
  ['foreign position', r => ({ ...r, deal: { ...r.deal, positionId: '9002' } })],
  ['foreign symbol', r => ({ ...r, deal: { ...r.deal, symbolId: 73 } })],
  ['opposite ownership', r => ({ ...r, deal: { ...r.deal, tradeSide: 1 } })],
]) test(`actual executor holds ${name} response across repeated delivery and restart`, async t => {
  const f = fixture(t); f.state.response = () => mutate(f.fill())
  const r = await f.run(); assert.equal(r.pending, true, JSON.stringify(r)); untouched(f)
  f.restart(); await f.run(); assert.equal(f.state.closes.length, 1); untouched(f)
  assert.ok(f.read().attempt.reason)
})
test('actual executor refuses conflicting broker basis before sending', async t => {
  const f = fixture(t); f.state.reconcile = () => ({ ...f.snapshot(), ctidTraderAccountId: 99 })
  assert.equal((await f.run()).reason, 'partial_broker_basis_unverified')
  assert.equal(f.state.closes.length, 0); untouched(f)
})
test('actual executor refuses database account/position conflict before sending', async t => {
  const f = fixture(t); f.db.prepare("UPDATE monitored_positions SET account_id='99'").run()
  assert.equal((await f.run()).reason, 'partial_owner_changed'); assert.equal(f.state.closes.length, 0); untouched(f)
})
test('accepted order recovers by its own history and residual through ordinary monitor after restart', async t => {
  const f = fixture(t)
  f.state.response = () => ({ ctidTraderAccountId: 42, executionType: 2, order: { orderId: '8001', positionId: '9001' } })
  assert.equal((await f.run()).pending, true); untouched(f)
  f.state.history = [f.fill().deal]; f.restart(); await f.recover()
  assert.equal(f.read().attempt.state, 'CONFIRMED'); assert.equal(f.read().trade.volume, 0.05)
  assert.equal(f.state.closes.length, 1); assert.equal(f.state.amends.length, 0)
})
test('receipt with unconfirmed residual waits, then recovery commits without another close', async t => {
  const f = fixture(t); f.state.after = 6000
  assert.equal((await f.run()).reason, 'partial_residual_unconfirmed'); untouched(f)
  f.restart(); f.state.volume = 5000; await f.recover()
  assert.equal(f.read().attempt.state, 'CONFIRMED'); assert.equal(f.state.closes.length, 1)
})
test('ambiguous transport outcome stays pending without another close', async t => {
  const f = fixture(t); f.state.response = () => { throw Error('connection lost after send') }
  assert.equal((await f.run()).pending, true); f.restart(); await f.recover(); await f.run()
  untouched(f); assert.equal(f.state.closes.length, 1)
})
test('concurrent actual callers acquire only one durable close claim', async t => {
  const f = fixture(t); await Promise.all([f.run(), f.run()])
  assert.equal(f.state.closes.length, 1); assert.equal(f.read().journal.length, 1)
})
test('claim storage failure prevents the broker call', async t => {
  const f = fixture(t)
  // Create the lazy schema using an identity refusal, before exercising the trigger.
  f.state.reconcile = () => ({ ...f.snapshot(), ctidTraderAccountId: 99 }); await f.run(); delete f.state.reconcile
  f.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON general_partial_attempts BEGIN SELECT RAISE(ABORT,'disk fault'); END")
  assert.match((await f.run()).error, /disk fault/); assert.equal(f.state.closes.length, 0); untouched(f)
})
test('raw-response persistence failure leaves durable sending claim across restart', async t => {
  const f = fixture(t)
  f.state.response = () => {
    f.db.exec("CREATE TRIGGER fail_raw BEFORE UPDATE OF raw_json ON general_partial_attempts BEGIN SELECT RAISE(ABORT,'disk fault'); END")
    return f.fill()
  }
  assert.match((await f.run()).error, /disk fault/); untouched(f)
  f.restart(); await f.run(); assert.equal(f.state.closes.length, 1); untouched(f)
})
test('journal failure rolls back lots and latches; stored receipt recovers after restart', async t => {
  const f = fixture(t)
  f.db.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON position_events BEGIN SELECT RAISE(ABORT,'disk fault'); END")
  assert.equal((await f.run()).error, 'partial_journal_not_committed'); untouched(f)
  assert.equal(f.read().attempt.state, 'RECEIVED')
  f.db.exec('DROP TRIGGER fail_journal'); f.restart(); await f.recover()
  assert.equal(f.read().attempt.state, 'CONFIRMED'); assert.equal(f.read().journal.length, 1)
  assert.equal(f.state.closes.length, 1)
})
test('real ordinary monitor does not pre-stamp partial flags or report a missing receipt as success', async t => {
  const f = fixture(t); f.state.response = () => ({})
  await f.monitor(); untouched(f)
  assert.equal(f.state.closes.length, 1)
  assert.match(f.read().position.last_check_reasoning, /intent_only: partial_receipt_unconfirmed/)
})
test('real ordinary monitor confirms partial before existing runner stop and preserves TP', async t => {
  const f = fixture(t); await f.monitor()
  assert.equal(f.read().trade.volume, 0.05); assert.equal(f.read().position.scaled_out, 1)
  assert.equal(f.read().position.be_moved, 1)
  assert.equal(f.state.amends.length, 1); assert.equal(f.state.amends[0].takeProfit, 1.14)
  assert.equal(f.state.amends[0].ratchetOnly, true)
})

test('real fast monitor leaves requested scale-out uncommitted when broker reply is empty', async t => {
  const f = fixture(t); f.state.response = () => ({})
  f.db.prepare("UPDATE monitored_positions SET strategy='fib_618_fade'").run()
  const out = await f.fast()
  assert.equal(out.checked, 1, JSON.stringify(out)); assert.equal(f.state.closes.length, 1)
  untouched(f); assert.match(f.read().position.last_check_reasoning, /intent_only: partial_receipt_unconfirmed/)
})
test('rejected before-send failure can retry, unlike an ambiguous send', async t => {
  const f = fixture(t)
  f.state.response = () => { throw Object.assign(Error('not sent'), { notSent: true }) }
  assert.equal((await f.run()).error, 'not sent'); untouched(f)
  f.state.response = null; assert.equal((await f.run()).partialConfirmed, true)
  assert.equal(f.state.closes.length, 2); assert.equal(f.read().journal.length, 1)
})
test('accepted order with multiple or foreign history receipts remains unresolved', async t => {
  const f = fixture(t)
  f.state.response = () => ({ ctidTraderAccountId: 42, executionType: 2, order: { orderId: '8001', positionId: '9001' } })
  await f.run(); f.state.history = [f.fill().deal, { ...f.fill().deal, dealId: '7002' }]
  await f.recover(); untouched(f)
  f.state.history = [{ ...f.fill().deal, positionId: '9002' }]
  await f.recover(); untouched(f); assert.equal(f.state.closes.length, 1)
})

test('completed underfill with requested deal.volume still commits only actual filledVolume', async t => {
  const f = fixture(t); f.state.after = 9000
  f.state.response = () => { const r = f.fill(1000); r.deal.volume = 5000; return r }
  assert.equal((await f.run()).partialConfirmed, true)
  assert.equal(f.read().trade.volume, 0.09); assert.equal(f.read().journal[0].to_value, 1000)
})
test('existing ladder partial then distinct bank partial both execute once', async t => {
  const f = fixture(t); await f.run()
  f.state.response = () => { const r = f.fill(2500); r.deal.dealId = '7002'; r.deal.orderId = '8002'; return r }
  f.state.after = 2500
  const bank = { updates: { bank_partial_at: new Date().toISOString(), scaled_out: 1, be_moved: 1 } }
  assert.equal((await f.run(bank)).partialConfirmed, true)
  assert.equal(f.read().trade.volume, 0.025); assert.equal(f.read().journal.length, 2)
  assert.ok(f.read().position.bank_partial_at)
  await f.run(bank); await f.run(); assert.equal(f.state.closes.length, 2)
})
test('recovering an earlier ladder fill cannot stamp or execute a later bank decision', async t => {
  const f = fixture(t); f.state.after = 6000
  await f.run(); f.state.volume = 5000
  const bank = { updates: { bank_partial_at: new Date().toISOString(), scaled_out: 1, be_moved: 1 } }
  const r = await f.run(bank)
  assert.equal(r.reason, 'prior_partial_recovered'); assert.equal(r.skipped, true)
  loop.stampExitMarks(f.s, f.pos(), { action: 'PARTIAL_EXIT', ...bank }, r)
  assert.equal(f.read().position.bank_partial_at, null)
  assert.equal(f.state.closes.length, 1); assert.equal(f.read().journal.length, 1)
})
test('conflicting enclosing identity is refused', async t => {
  const f = fixture(t); f.state.response = () => ({ ...f.fill(), position: { positionId: 'foreign' } })
  assert.equal((await f.run()).pending, true); untouched(f)
})

test('nonterminal partial-fill event remains unresolved without requesting another close', async t => {
  const f = fixture(t); f.state.after = 9000
  f.state.response = () => ({ ...f.fill(1000), executionType: 11 })
  assert.equal((await f.run()).pending, true); await f.run(); untouched(f)
  assert.equal(f.state.closes.length, 1)
})

// Codex · №12,659 · 2026-10-09; codex-footprint: actual-bank-fallback.
test('unfillable bank partial takes its existing full-exit fallback; ladder remains skipped', async t => {
  for (const bank of [false, true]) {
    const f = fixture(t); f.state.volume = 1000; f.state.after = 0
    f.state.meta = { minVolume: 1000, stepVolume: 1000 }
    f.state.response = () => f.fill(1000)
    const out = await f.run({ fallbackFullExitIfUnfillable: bank, metrics: { currentR: 2 },
      updates: bank ? { bank_partial_at: new Date().toISOString(), scaled_out: 1, be_moved: 1 } : {} })
    assert.equal(f.state.closes.length, bank ? 1 : 0, JSON.stringify(out))
    if (bank) {
      assert.equal(f.state.closes[0].volume, 1000)
      assert.equal(out.closedRemotely, true)
      assert.equal(f.read().trade.status, 'closed')
      assert.equal(f.read().position.status, 'closed')
    } else { assert.equal(out.skipped, true); assert.equal(f.read().trade.status, 'open') }
    assert.equal(f.read().journal.length, 0, 'a whole fallback or skipped ladder is not a successful partial')
    assert.equal(f.read().attempt ?? null, null, 'no partial close was submitted')
  }
})
