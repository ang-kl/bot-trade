import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { recordDepositCurrency } from './account-money.js'
import { accountHistory } from './account-history.js'
import { makeBrokerHistoryRecorder, startBrokerHistoryRecording } from './broker-history-recorder.js'
import { emitBrokerRead, observeBrokerReads, brokerReadObservationStatus } from '../lib/broker-read-observer.js'
import { wsGetTrader, wsReconcile, wsGetUnrealizedPnl, PT } from '../lib/ctrader-ws.js'
import { _setConnectForTests, _resetPool } from '../lib/ctrader-session.js'
import { makeIndependentProtectionPoll } from './independent-protection.js'

const host = 'demo.ctraderapi.com', T = Date.now()
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (11,0),(22,1)').run()
  setState(db, 'account_history_pruned_ms', String(T))
  for (const [accountId, route, currency] of [['11',host,'SGD'],['22','live.ctraderapi.com','USD']])
    recordDepositCurrency(db, { accountId, host: route, depositAssetId: '1', currency, receivedAt: T-1000 })
  let now = T
  return { db, record: makeBrokerHistoryRecorder(db, { clock: () => now }), time: value => { now = value },
    read: () => accountHistory(db, '11', { from: T-1000, to: now+1 }) }
}
const event = (kind, payload, receivedAt = T, accountId = '11', route = host) => ({kind, payload, receivedAt, accountId, host: route})
const trader = balance => ({ ctidTraderAccountId: 11, trader: { ctidTraderAccountId: 11, balance, moneyDigits: 2, depositAssetId: 1 } })
const pos = (positionId = 7) => ({ positionId, tradeData: { symbolId: 9, volume: 100, tradeSide: 1 }, stopLoss: 100, takeProfit: null })
const rec = positions => ({ ctidTraderAccountId: 11, position: positions })
const pnl = (positions = [{ positionId: 7, netUnrealizedPnL: 250, grossUnrealizedPnL: 300 }]) => ({ ctidTraderAccountId: 11, moneyDigits: 2, positionUnrealizedPnL: positions })

test('background observations retain own native equity, exposure and actual protection without browser requests', t => {
  const f = fixture(t)
  f.record(event('trader', trader(10000)))
  f.record(event('reconcile', rec([pos()])))
  f.record(event('pnl', pnl()))
  const points = f.read().points, value = points.find(p => p.source === 'broker_equity')
  assert.equal(value.equity, 102.5); assert.equal(value.currency, 'SGD')
  assert.equal(value.pnlReceivedAt, T); assert.equal(value.balanceReceivedAt, T)
  assert.equal(value.protection.missingSL, 0); assert.equal(value.protection.missingTP, 1)
  assert.equal(value.exposure[0].positionId, '7'); assert.equal(value.exposureComplete, true)
  assert.equal(f.db.prepare('SELECT count(*) n FROM entry_intents').get().n, 0)
})

test('an empty or partial P&L map cannot turn known open positions into flat equity', t => {
  for (const rows of [[], [{positionId: 8, netUnrealizedPnL: 0}]]) {
    const f = fixture(t)
    f.record(event('trader', trader(10000))); f.record(event('reconcile', rec([pos()])))
    f.record(event('pnl', pnl(rows)))
    assert.equal(f.read().points.some(p => p.equity != null), false)
    assert.equal(f.read().points.find(p => p.source === 'broker_reconcile').openPositions, 1)
  }
})

test('a confirmed empty account can record zero balance and zero equity', t => {
  const f = fixture(t)
  f.record(event('trader', trader(0))); f.record(event('reconcile', rec([]))); f.record(event('pnl', pnl([])))
  assert.equal(f.read().points.find(p => p.source === 'broker_equity').equity, 0)
})

test('wrong host/account, malformed money, duplicate positions and future observations leave no history', t => {
  const f = fixture(t)
  for (const e of [event('trader', trader(10000), T, '22'), event('trader', trader(10000), T, '11', 'live.ctraderapi.com'),
    event('trader', trader(10000), T+1), event('trader', trader('not-money')),
    event('reconcile', rec([pos(),pos()])), event('pnl', {...pnl(), moneyDigits: null}),
    event('pnl', pnl([{positionId: 7, netUnrealizedPnL: null}]))]) assert.equal(f.record(e), false)
  assert.equal(f.read().points.length, 0)
})

test('old balance/positions are not relabelled as current equity; repeated receipts keep their original age', t => {
  const f = fixture(t)
  f.record(event('trader', trader(10000))); f.record(event('reconcile', rec([pos()])))
  f.time(T+61000); f.record(event('pnl', pnl(), T+61000))
  assert.equal(f.read().points.some(p => p.equity != null), false)
  f.record(event('reconcile', rec([pos()]), T))
  assert.equal(f.read().points.find(p=>p.source==='broker_reconcile').receivedAt, T)
  assert.equal(f.read().points.filter(p=>p.source==='broker_reconcile').length, 1)
})

test('independent protection preserves broker time and does not invent missing exposure fields', t => {
  const f = fixture(t)
  const payload = {accountId:'11', source:'broker_reconcile', ok:true, openCount:1, missingSl:0, missingTp:1,
    positions:[{positionId:'7',symbolId:'9',stopLoss:100,takeProfit:null}]}
  f.record(event('protection',payload))
  const p=f.read().points[0]
  assert.equal(p.protection.source,'cpp_verify'); assert.equal(p.protection.observedAt,new Date(T).toISOString())
  assert.equal(p.exposureComplete,false); assert.equal(p.equity,null)
  assert.equal(f.record(event('protection',{...payload,missingTp:0})),false)
})

test('currency changes and missing metadata prevent mixing earlier observations into equity', t => {
  const f=fixture(t)
  f.record(event('trader', trader(10000))); f.record(event('reconcile', rec([pos()])))
  f.record(event('trader', {ctidTraderAccountId:11,trader:{...trader(10000).trader,depositAssetId:2}}))
  f.record(event('pnl', pnl()))
  assert.equal(f.read().points.some(p=>p.equity!=null),false)
})

test('a newly verified currency cannot relabel an earlier P&L response', t => {
  const f=fixture(t)
  f.record(event('trader', trader(10000))); f.record(event('pnl', pnl()))
  f.time(T+1000)
  recordDepositCurrency(f.db,{accountId:'11',host,depositAssetId:'2',currency:'USD',receivedAt:T+500})
  f.record(event('trader',{ctidTraderAccountId:11,trader:{...trader(10000).trader,depositAssetId:2}},T+1000))
  f.record(event('reconcile',rec([pos()]),T+1000))
  assert.equal(f.read().points.some(p=>p.equity!=null),false)
  f.record(event('pnl',pnl(),T+1000))
  assert.equal(f.read().points.find(p=>p.source==='broker_equity').currency,'USD')
})

test('bounded observer isolates copies, exceptions and stopped consumers', async t => {
  const seen=[], stop=observeBrokerReads(e=>{seen.push(e);throw new Error('observer failure')})
  t.after(stop)
  const before=brokerReadObservationStatus(), e=event('reconcile',rec([pos()]))
  for(let i=0;i<65;i++) emitBrokerRead(e)
  e.payload.position[0].stopLoss=1
  assert.equal(brokerReadObservationStatus().pending,64)
  for(let i=0;i<10;i++) await nextTurn()
  assert.equal(seen.length,64); assert.equal(seen[0].payload.position[0].stopLoss,100)
  assert.equal(brokerReadObservationStatus().failed-before.failed,64)
  assert.equal(brokerReadObservationStatus().dropped-before.dropped,1)
  stop();assert.equal(emitBrokerRead(e),false)
})

test('the real independent relay records protection for every registered account without a browser', async t => {
  const f=fixture(t), stop=startBrokerHistoryRecording(f.db); t.after(stop)
  for(const key of ['CTRADER_CLIENT_ID','CTRADER_CLIENT_SECRET']) {
    const old=process.env[key];process.env[key]='fixture'
    t.after(()=>{if(old==null)delete process.env[key];else process.env[key]=old})
  }
  setState(f.db,'ctrader_access_token','fixture')
  const sessions=[]
  const poll=makeIndependentProtectionPoll(f.db,{env:{VERIFY_URL:'https://verifier.test',EXEC_SECRET:'fixture'},log:()=>{},
    fetchImpl:async(url,options)=>{
      if(url.endsWith('/connect')) {
        const body=JSON.parse(options.body);sessions.push({host:body.host,open:true,accounts:body.accountIds})
        return {ok:true,json:async()=>({accounts:body.accountIds.map(accountId=>({accountId,authorized:true}))})}
      }
      if(url.endsWith('/watchdog-status')) return {ok:true,json:async()=>({schemaVersion:1})}
      return {ok:true,json:async()=>({source:'cpp-verify',sessions,accounts:sessions.flatMap(s=>s.accounts.map(accountId=>({
        accountId,host:s.host,ok:true,source:'broker_reconcile',checkedAtMs:Date.now(),openCount:0,missingSl:0,missingTp:0,positions:[]})))})}
    }})
  await poll();await nextTurn()
  const rows=f.db.prepare("SELECT account_id,observation_json FROM account_history WHERE source='broker_reconcile'").all()
  assert.deepEqual(rows.map(r=>r.account_id).sort(),['11','22'])
  assert.ok(rows.every(r=>JSON.parse(r.observation_json).protection.source==='cpp_verify'))
})

test('actual broker helpers feed the recorder and preserve their caller results', async t => {
  const f=fixture(t), old=process.env.CTRADER_WS_POOL;process.env.CTRADER_WS_POOL='1'
  const stop=startBrokerHistoryRecording(f.db)
  assert.equal(startBrokerHistoryRecording(f.db),stop)
  t.after(()=>{stop();_resetPool();_setConnectForTests(null);if(old==null)delete process.env.CTRADER_WS_POOL;else process.env.CTRADER_WS_POOL=old})
  class FakeWs extends EventEmitter {
    constructor(){super();this.readyState=1;setImmediate(()=>this.emit('open'))}
    close(){this.readyState=3}
    send(raw){
      const m=JSON.parse(raw)
      const replies={ [PT.APP_AUTH_REQ]:[PT.APP_AUTH_RES,{}], [PT.ACCOUNT_AUTH_REQ]:[PT.ACCOUNT_AUTH_RES,{}],
        [PT.TRADER_REQ]:[PT.TRADER_RES,trader(10000)], [PT.RECONCILE_REQ]:[PT.RECONCILE_RES,rec([pos()])],
        [PT.GET_POSITION_UNREALIZED_PNL_REQ]:[PT.GET_POSITION_UNREALIZED_PNL_RES,pnl()] }
      if(!replies[m.payloadType])return
      const [payloadType,payload]=replies[m.payloadType]
      this.emit('message',Buffer.from(JSON.stringify({payloadType,payload,clientMsgId:m.clientMsgId})))
    }
  }
  _resetPool();_setConnectForTests(()=>new FakeWs())
  const args=[host,'fixture-id','fixture-secret','fixture-token','11']
  assert.deepEqual(await wsGetTrader(...args),trader(10000).trader)
  assert.deepEqual(await wsReconcile(...args),rec([pos()]))
  assert.deepEqual(await wsGetUnrealizedPnl(...args),{'7':{gross:3,net:2.5}})
  await nextTurn(); f.time(Date.now())
  assert.equal(f.read().points.find(p=>p.source==='broker_equity')?.equity,102.5)
  assert.ok(!JSON.stringify(f.read()).includes('fixture-secret'))
  const loop=readFileSync(new URL('../loop.js',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'')
  assert.match(loop,/import\('\.\/services\/broker-history-recorder\.js'\)[\s\S]*?startBrokerHistoryRecording\(db\)/)
})
