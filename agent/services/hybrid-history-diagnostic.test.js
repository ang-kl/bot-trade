// Codex · №12,284 · 2026-10-08; codex-footprint: hybrid-history-boundary.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = process.env.HYBRID_TEST_SOURCE_ROOT || new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const { initDB, getState } = await import(`${root}/agent/db.js`)
const { enrolCappedHybrids } = await import(`${root}/agent/services/capped-hybrid-enrolment.js`)
const AT = 1791460800000
const args = ['demo.example.test', 'fixture-client', 'DO_NOT_LOG_SECRET', 'DO_NOT_LOG_TOKEN', '42']

// Codex · №12,288 · 2026-10-08; codex-footprint: diagnostic-review-boundaries.
test('no available probe budget does not consume the once-only diagnosis', async t => {
  const { diagnoseHybridHistory } = await import(`${root}/agent/services/hybrid-history-diagnostic.js`)
  const db = initDB(':memory:'); t.after(() => db.close())
  let calls = 0
  const options = { args, positionId: '33', presentTimestamp: AT, toTimestamp: AT + 2000,
    now: () => AT, log: () => {}, read: async () => { calls++; return {} } }
  for (const budgetMs of [0, -1, 20, NaN]) await diagnoseHybridHistory(db, { ...options, budgetMs })
  assert.equal(calls, 0)
  assert.equal(getState(db, 'hybrid_history_boundary_v1'), null)
  await diagnoseHybridHistory(db, { ...options, budgetMs: 4500 })
  assert.equal(calls, 1, 'one bounded variant per ordinary pass')
})

test('a deadline owns its direct socket even with pooling enabled; no late history sends', async () => {
  const { wsProbePositionHistoryBounds, _setWebSocketForTests, PT } = await import(`${root}/agent/lib/ctrader-ws.js`)
  const { _setConnectForTests, _resetPool } = await import(`${root}/agent/lib/ctrader-session.js`)
  const sent = [], sockets = [], previous = process.env.CTRADER_WS_POOL
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; sockets.push(this); setImmediate(() => { if (this.readyState === 1) this.emit('open') }) }
    close() { this.readyState = 3 }
    send(raw) {
      const m = JSON.parse(raw); sent.push(m)
      const type = { [PT.APP_AUTH_REQ]: PT.APP_AUTH_RES, [PT.ACCOUNT_AUTH_REQ]: PT.ACCOUNT_AUTH_RES,
        [PT.DEAL_LIST_BY_POSITION_ID_REQ]: PT.DEAL_LIST_BY_POSITION_ID_RES }[m.payloadType]
      setTimeout(() => {
        if (this.readyState === 1) this.emit('message', Buffer.from(JSON.stringify({ payloadType: type,
          clientMsgId: m.clientMsgId, payload: { ctidTraderAccountId: 42, hasMore: false, deal: [] } })))
      }, 40)
    }
  }
  try {
    process.env.CTRADER_WS_POOL = '1'; _resetPool()
    _setWebSocketForTests(Socket); _setConnectForTests(() => new Socket())
    await assert.rejects(wsProbePositionHistoryBounds(...args, '33', {}, 5), /timeout/)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(sent.filter(m => m.payloadType === PT.DEAL_LIST_BY_POSITION_ID_REQ).length, 0)
    assert.ok(sockets.every(s => s.readyState === 3), 'timeout must close its owned socket')
  } finally {
    _resetPool(); _setConnectForTests(null); _setWebSocketForTests(null)
    if (previous === undefined) delete process.env.CTRADER_WS_POOL; else process.env.CTRADER_WS_POOL = previous
  }
})

for (const duplicate of [false, true]) test(`actual enrolment diagnoses only once per pass, with duplicate position rows=${duplicate}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-history-')), path = join(dir, 'test.db')
  let db = initDB(path)
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES ('42',0,1,'active')").run()
  db.prepare(`INSERT INTO entry_intents(id,account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,
    permit_id,permit_expires_at,state,broker_order_id,broker_position_id,risk_event_id)
    VALUES('entry-7','42','demo','EURUSD',22,'BUY','MARKET',10000,'analysis','risk',1,'fixture','2099-01-01','FILLED','55','33',1)`).run()
  db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
    strategy,label_strategy,ctrader_position_id,intent_id,source)
    VALUES(7,'EURUSD','BUY','open','42','bot_market_dispatch',1,100,90,140,0.01,'ema_pullback','ema_pullback','33','entry-7','autopilot')`).run()
  db.prepare(`INSERT INTO monitored_positions(id,trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
    strategy,source,status,paused) VALUES(8,7,'42','EURUSD','long',100,98,140,10,'ema_pullback','autopilot','active',0)`).run()
  const before = db.prepare('SELECT * FROM monitored_positions').all(), calls = []
  if (duplicate) {
    db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
      strategy,label_strategy,ctrader_position_id,intent_id,source)
      SELECT 17,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume,
      strategy,label_strategy,ctrader_position_id,intent_id,source FROM trades WHERE id=7`).run()
    db.prepare(`INSERT INTO monitored_positions(id,trade_id,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
      strategy,source,status,paused) SELECT 18,17,account_id,symbol,side,entry_price,current_sl,current_tp,initial_risk,
      strategy,source,status,paused FROM monitored_positions WHERE id=8`).run()
    before.push(db.prepare('SELECT * FROM monitored_positions WHERE id=18').get())
  }
  const transports = {
    symbols: async () => ({ ctidTraderAccountId: '42', symbol: [{ symbolId: '22', digits: 2, minVolume: 100, stepVolume: 100 }] }),
    reconcile: async () => ({ ctidTraderAccountId: '42', position: [{ positionId: '33', positionStatus: 'POSITION_STATUS_OPEN',
      price: 100, stopLoss: 98, takeProfit: 140, tradeData: { symbolId: '22', tradeSide: 'BUY', volume: 10000 } }] }),
    deals: async () => { throw Error('cTrader error: INCORRECT_BOUNDARIES — Incorrect period boundaries') },
    probeHistory: async (...a) => { calls.push(a); return { ctidTraderAccountId: '42', hasMore: false, deal: [] } },
  }
  const options = { credsFor: () => ({ ready: true, host: 'demo.ctraderapi.com', accountId: '42', clientId: args[1], clientSecret: args[2], accessToken: args[3] }),
    now: () => AT, transports }
  const out = await enrolCappedHybrids(db, options)
  assert.equal(out.enrolled.length, 0); assert.match(out.errors[0].reason, /INCORRECT_BOUNDARIES/)
  assert.equal(calls.length, 1, 'RED on previous enrolment: exact rejected read was never diagnosed')
  for (let i = 0; i < 3; i++) await enrolCappedHybrids(db, options)
  assert.deepEqual(calls.map(a => a[6]), [{ fromTimestamp: 0, toTimestamp: AT }, { toTimestamp: AT + 2000 }, { fromTimestamp: 0 }, {}])
  assert.ok(calls.every(a => a[4] === '42' && a[5] === '33'))
  assert.deepEqual(db.prepare('SELECT * FROM monitored_positions').all(), before)
  const saved = JSON.parse(getState(db, 'hybrid_history_boundary_v1'))
  assert.equal(saved.state, 'complete'); assert.equal(saved.results.length, 4)
  db.close(); db = initDB(path)
  await enrolCappedHybrids(db, options)
  assert.equal(calls.length, 4, 'restart must not repeat the experiment')
  transports.symbols = async () => { throw Error('INCORRECT_BOUNDARIES') }
  await enrolCappedHybrids(db, options)
  assert.equal(calls.length, 4, 'only the history-stage catch may probe')
})

test('probe claim is durable before reads; logs are metadata only; refused storage prevents reads', async t => {
  const { diagnoseHybridHistory } = await import(`${root}/agent/services/hybrid-history-diagnostic.js`)
  const db = initDB(':memory:'); t.after(() => db.close())
  const logs = []; let calls = 0
  const options = { args, positionId: '33', presentTimestamp: AT, toTimestamp: AT + 2000, now: () => AT,
    log: line => logs.push(line), read: async () => {
      assert.ok(getState(db, 'hybrid_history_boundary_v1')); calls++
      throw Error('DO_NOT_LOG_SECRET arbitrary remote description')
    } }
  for (let i = 0; i < 4; i++) assert.equal(await diagnoseHybridHistory(db, options), undefined)
  assert.equal(calls, 4)
  assert.ok(logs.every(line => !/DO_NOT_LOG|fixture-client/.test(line)))
  assert.ok(JSON.parse(getState(db, 'hybrid_history_boundary_v1')).results.every(r => r.result === 'read_failed'))
  db.prepare("DELETE FROM agent_state WHERE key='hybrid_history_boundary_v1'").run()
  db.pragma('query_only = ON')
  await assert.rejects(diagnoseHybridHistory(db, { ...options, positionId: '34' }), /readonly/i)
  assert.equal(calls, 4)
})

test('timeout stops further probes and a repeated pass cannot restart the pending experiment', async t => {
  const { diagnoseHybridHistory } = await import(`${root}/agent/services/hybrid-history-diagnostic.js`)
  const db = initDB(':memory:'); t.after(() => db.close())
  let calls = 0
  const options = { args, positionId: '33', presentTimestamp: AT, toTimestamp: AT + 2000, budgetMs: 4500,
    log: () => {}, read: async () => { calls++; throw Error('cTrader WS timeout') } }
  await diagnoseHybridHistory(db, options); await diagnoseHybridHistory(db, options)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(getState(db, 'hybrid_history_boundary_v1')).state, 'timeout')
})

test('interruption after a broker read retains the claim across reopen; another account cannot resume it', async t => {
  const { diagnoseHybridHistory } = await import(`${root}/agent/services/hybrid-history-diagnostic.js`)
  const dir = mkdtempSync(join(tmpdir(), 'hybrid-interrupted-')), path = join(dir, 'test.db')
  let db = initDB(path), calls = 0
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const options = { args, positionId: '33', presentTimestamp: AT, toTimestamp: AT + 2000,
    log: () => {}, read: async () => { calls++; db.pragma('query_only=ON'); return {} } }
  await assert.rejects(diagnoseHybridHistory(db, options), /readonly/i)
  db.close(); db = initDB(path)
  await diagnoseHybridHistory(db, options)
  await diagnoseHybridHistory(db, { ...options, args: [...args.slice(0, 4), '43'] })
  assert.equal(calls, 1)
  assert.equal(JSON.parse(getState(db, 'hybrid_history_boundary_v1')).state, 'probing')
})

test('diagnostic serializes only history reads with pooling either enabled or disabled', async () => {
  const { wsProbePositionHistoryBounds, _setWebSocketForTests, PT } = await import(`${root}/agent/lib/ctrader-ws.js`)
  const { _setConnectForTests, _resetPool } = await import(`${root}/agent/lib/ctrader-session.js`)
  const sent = [], previous = process.env.CTRADER_WS_POOL
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => { if (this.readyState === 1) this.emit('open') }) }
    close() { this.readyState = 3 }
    send(raw) {
      const m = JSON.parse(raw); sent.push(m)
      const type = { [PT.APP_AUTH_REQ]: PT.APP_AUTH_RES, [PT.ACCOUNT_AUTH_REQ]: PT.ACCOUNT_AUTH_RES,
        [PT.DEAL_LIST_BY_POSITION_ID_REQ]: PT.DEAL_LIST_BY_POSITION_ID_RES }[m.payloadType]
      assert.ok(type, 'no broker write or unrelated request allowed')
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ payloadType: type, clientMsgId: m.clientMsgId,
        payload: { ctidTraderAccountId: 42, hasMore: false, deal: [] } }))))
    }
  }
  try {
    _setWebSocketForTests(Socket); _setConnectForTests(() => new Socket())
    for (const pooled of ['0', '1']) {
      _resetPool(); process.env.CTRADER_WS_POOL = pooled
      for (const bounds of [{ fromTimestamp: 0, toTimestamp: AT }, { toTimestamp: AT + 2000 }, { fromTimestamp: 0 }, {}]) {
        await wsProbePositionHistoryBounds(...args, '33', bounds, 1000)
        assert.deepEqual(sent.at(-1).payload, { ctidTraderAccountId: 42, positionId: 33, ...bounds })
      }
    }
    for (const bounds of [null, [], { other: 1 }, { fromTimestamp: -1 }, { toTimestamp: NaN }, { toTimestamp: '1' }, { toTimestamp: 2147483646001 }]) {
      assert.throws(() => wsProbePositionHistoryBounds(...args, '33', bounds), /bounds invalid/)
    }
  } finally {
    _resetPool(); _setConnectForTests(null); _setWebSocketForTests(null)
    if (previous === undefined) delete process.env.CTRADER_WS_POOL; else process.env.CTRADER_WS_POOL = previous
  }
})
