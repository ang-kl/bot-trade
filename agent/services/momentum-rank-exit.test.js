import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB, getState, setState } from '../db.js'
import { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY } from './momentum-book.js'
import { MOMENTUM_ACCOUNT_KEY } from './momentum-account.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
import { setStage } from './stage-matrix.js'
import { registerPartialPlan, runPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { runMomentumRankExit } from './momentum-rank-exit.js'

const at = 1790264000000
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
function fixture(t, state = 'ARMED', full = false) {
  const db = full ? initDB(':memory:') : new Database(':memory:'); t.after(() => db.close())
  const identity = { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
  registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '33', plan, evidenceId: 'fixture', identity })
  db.prepare('UPDATE momentum_partial_plans SET state=?').run(state)
  const creds = { ...identity, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  const row = { account_id: '11', trade_id: 7, position_id: '33', symbol: 'ETHUSD', status: 'open' }
  let volume = state === 'CONFIRMED' ? plan.runnerVolume : plan.volume, calls = 0
  const deps = {
    now: () => at, timeoutMs: 100,
    readCredentials: () => creds,
    readOwnership: () => ({ accountId: '11', tradeId: 7, positionId: '33', side: 'BUY', entry: 100,
      initialRisk: 10, status: 'open', owner: 'momentum_book', guardActive: false }),
    rankReconcile: async () => ({ ctidTraderAccountId: '11', position: volume ? [{ positionId: '33',
      positionStatus: 'POSITION_STATUS_OPEN', price: 100, stopLoss: 95, takeProfit: 140.4,
      tradeData: { symbolId: '22', tradeSide: 'BUY', volume } }] : [] }),
    close: async (c, order) => {
      assert.equal(c.accountId, '11'); assert.equal(order.positionId, '33'); assert.equal(order.volume, volume)
      calls++; const closedVolume = volume; volume = 0
      return { ctidTraderAccountId: '11', executionType: 'ORDER_FILLED', deal: { dealId: '44', orderId: '55',
        positionId: '33', symbolId: '22', tradeSide: 'SELL', dealStatus: 'FILLED', volume: closedVolume,
        filledVolume: closedVolume, executionPrice: 131, executionTimestamp: at,
        closePositionDetail: { entryPrice: 100, closedVolume } } }
    },
  }
  return { db, creds, row, deps, calls: () => calls }
}

test('rank closes the fresh full or residual volume once and keeps its durable result', async t => {
  for (const state of ['ARMED', 'CONFIRMED']) {
    const f = fixture(t, state)
    assert.deepEqual(await runMomentumRankExit(f.db, f.creds, f.row, f.deps), { handled: true, state: 'CONFIRMED' })
    assert.equal(readPartialPlan(f.db, '11', 7).state, 'RANK_CONFIRMED')
    await runMomentumRankExit(f.db, f.creds, f.row, f.deps)
    assert.equal(f.calls(), 1)
  }
})

test('rank reservation wins before its read awaits; a simultaneous partial sends nothing', async t => {
  const f = fixture(t), read = f.deps.rankReconcile
  let release
  f.deps.rankReconcile = async () => { await new Promise(r => { release = r }); return read() }
  const rank = runMomentumRankExit(f.db, f.creds, f.row, f.deps)
  await new Promise(r => setImmediate(r))
  let partialCalls = 0
  const partial = await runPartialPlan(f.db, f.creds, 7, { close: () => { partialCalls++ } })
  assert.equal(partial.state, 'RANK_RESERVED'); assert.equal(partialCalls, 0)
  f.deps.rankReconcile = read; release()
  assert.equal((await rank).state, 'CONFIRMED'); assert.equal(f.calls(), 1)
})

test('a partial already sending, ambiguous or awaiting readback prevents a rank submission', async t => {
  for (const state of ['SENDING', 'AMBIGUOUS', 'RECEIVED']) {
    const f = fixture(t, state)
    await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /partial.*unresolved/)
    assert.equal(f.calls(), 0); assert.equal(readPartialPlan(f.db, '11', 7).state, state)
  }
})

test('a timeout is durable, and a late original receipt recovers without another close', async t => {
  const f = fixture(t), close = f.deps.close
  let release
  f.deps.timeoutMs = 10
  f.deps.close = async (...args) => { await new Promise(r => { release = r }); return close(...args) }
  await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /unconfirmed/)
  assert.equal(readPartialPlan(f.db, '11', 7).state, 'RANK_AMBIGUOUS')
  await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /unresolved/)
  release(); await new Promise(r => setImmediate(r))
  assert.equal(readPartialPlan(f.db, '11', 7).state, 'RANK_RECEIVED')
  assert.equal((await runMomentumRankExit(f.db, f.creds, f.row, f.deps)).state, 'CONFIRMED')
  assert.equal(f.calls(), 1)
})

test('invalid fresh identity or changed ownership releases only the unsent reservation', async t => {
  for (const fault of ['identity', 'ownership', 'volume']) {
    const f = fixture(t), read = f.deps.rankReconcile
    f.deps.rankReconcile = async () => {
      const raw = await read()
      if (fault === 'identity') raw.ctidTraderAccountId = '12'
      if (fault === 'volume') raw.position[0].tradeData.volume = 9000
      if (fault === 'ownership') f.deps.readOwnership = () => null
      return raw
    }
    await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /preflight/)
    assert.equal(f.calls(), 0); assert.equal(readPartialPlan(f.db, '11', 7).state, 'ARMED')
  }
})

test('without a partial plan the caller retains its existing close behavior', async t => {
  const db = new Database(':memory:'); t.after(() => db.close())
  assert.deepEqual(await runMomentumRankExit(db, { accountId: '11' }, { trade_id: 7, position_id: '33' }, {}), { handled: false })
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'momentum_%'").get().n, 0)
})

test('both actual book exit paths defer while the partial owns the position', async t => {
  for (const daily of [false, true]) {
    const f = fixture(t, 'SENDING', true), { db } = f
    db.prepare("INSERT INTO accounts(account_id,trader_login,is_live,enabled,mode) VALUES('11','1',0,1,'active')").run()
    setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookExitCadence: 'every_pass' }))
    setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: daily ? '11' : null, cadence: 'loop' }))
    setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {}, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
    setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: '11' }, { getState, setState })
    db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,label_strategy,ctrader_position_id)
      VALUES(7,'ETHUSD','BUY','open','11','bot_market_dispatch',1,100,90,140.4,100,'tsmom_long','33')`).run()
    db.prepare(`INSERT INTO momentum_book(trade_id,account_id,symbol,position_id,side,entry_price,stop,status,entered_at)
      VALUES(7,'11','ETHUSD','33','long',100,90,'open',?)`).run(new Date(at - 5 * 86400000).toISOString())
    db.prepare(`INSERT INTO momentum_shadow(symbol,action,side,rank_pct,conviction,price,timeframe,universe,applied,at)
      VALUES('ETHUSD','exit','long',0.1,9,100,'1d',20,0,?)`).run(new Date(at).toISOString())
    const out = await runMomentumBook(db, { accounts: [{ accountId: '11', isLive: false }], credsFor: () => f.creds,
      deps: { ...f.deps, phasesOn: () => true, positionVolume: async () => 10000, bars: async () => [],
        symbolIdFor: async () => null, equity: () => 100000 }, now: at })
    assert.equal(f.calls(), 0, `daily=${daily}: competing close sent`)
    assert.equal(out.exits, 0)
    assert.ok(out.skipped.some(s => /partial.*unresolved/.test(s)), JSON.stringify(out))
    assert.equal(db.prepare('SELECT status FROM momentum_book WHERE trade_id=7').get().status, 'open')
  }
})

test('a superseded reservation cannot send after its delayed broker read completes', async t => {
  const f = fixture(t), read = f.deps.rankReconcile
  let release
  f.deps.rankReconcile = () => new Promise(r => { release = () => read().then(r) })
  const first = runMomentumRankExit(f.db, f.creds, f.row, f.deps)
  const refused = assert.rejects(first, /preflight/)
  await new Promise(r => setImmediate(r))
  f.deps.rankReconcile = read
  assert.equal((await runMomentumRankExit(f.db, f.creds, f.row, f.deps)).state, 'CONFIRMED')
  release(); await refused
  assert.equal(f.calls(), 1); assert.equal(readPartialPlan(f.db, '11', 7).state, 'RANK_CONFIRMED')
})

test('foreign filled receipt stays ambiguous through disk restore and cannot resend', async t => {
  const f = fixture(t), close = f.deps.close
  f.deps.close = async (...args) => ({ ...await close(...args), ctidTraderAccountId: '12' })
  await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /unconfirmed/)
  const dir = mkdtempSync(join(tmpdir(), 'momentum-rank-')), path = join(dir, 'agent.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await f.db.backup(path)
  const restored = new Database(path); t.after(() => restored.close())
  await assert.rejects(runMomentumRankExit(restored, f.creds, f.row, f.deps), /unresolved/)
  assert.equal(f.calls(), 1)
  assert.equal(readPartialPlan(restored, '11', 7).state, 'RANK_AMBIGUOUS')
})

test('filled receipt without an absence read stays recoverable and does not repeat the close', async t => {
  const f = fixture(t), read = f.deps.rankReconcile
  let reads = 0
  f.deps.rankReconcile = async (...args) => {
    if (++reads === 2) throw Error('readback unavailable')
    return read(...args)
  }
  await assert.rejects(runMomentumRankExit(f.db, f.creds, f.row, f.deps), /readback/)
  assert.equal(readPartialPlan(f.db, '11', 7).state, 'RANK_RECEIVED')
  assert.equal((await runMomentumRankExit(f.db, f.creds, f.row, f.deps)).state, 'CONFIRMED')
  assert.equal(f.calls(), 1)
})
