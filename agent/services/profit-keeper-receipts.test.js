// Codex · №13,024 · 2026-10-10; codex-footprint: keeper-actual-receipts.
// Real keeper and SQLite, with only broker/quote boundaries controlled.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { runProfitKeeper, clearAtrCache, DEFAULT_PROFIT_KEEPER } from './profit-keeper.js'
import { readKeeperClose, runKeeperClose } from './keeper-close-receipts.js'

const CREDS = { ready: true, host: 'demo.ctraderapi.com', accountId: '1',
  clientId: 'fixture', clientSecret: 'fixture', accessToken: 'fixture' }
function fixture(t, { full = false, source = 'external', side = 'SELL', account = '1', host = CREDS.host } = {}) {
  clearAtrCache()
  const path = join(tempDir('keeper-receipts-'), 'keeper.db')
  let db = initDB(path)
  t.after(() => { if (db.open) db.close() })
  const cfg = { ...DEFAULT_PROFIT_KEEPER, mode: 'adaptive', scope: 'external',
    armBalancePct: 0, structureTrailEnabled: false, spikeTightenEnabled: false,
    scaleOutFrac: full ? 0 : 0.5, takeProfitUsd: full ? 55 : null }
  setState(db, 'profit_keeper_json', JSON.stringify(cfg))
  const creds={...CREDS,accountId:account,host},price=side==='SELL'?2.30:3.50
  db.prepare("INSERT INTO trades(symbol,side,account_id,ctrader_position_id,status,volume) VALUES('NATGAS',?,?,'9001','open',1)").run(side,account)
  db.prepare("INSERT INTO monitored_positions(symbol,side,entry_price,current_sl,current_tp,status,source,trade_id,account_id) VALUES('NATGAS',?,2.8795,?,?,'active',?,1,?)")
    .run(side,side==='SELL'?2.918:2.0,side==='SELL'?1.8:4.5,source,account)
  const state = { volume: 10000, calls: [], amends: [], notifications: [], response: () => ({}) }
  const snapshot = () => ({ ctidTraderAccountId: Number(account), position: state.volume ? [{
    positionId: 9001, positionStatus: 1, price: 2.8795, stopLoss: side==='SELL'?2.918:2.0, takeProfit: side==='SELL'?1.8:4.5,
    tradeData: { symbolId: 1, volume: state.volume, tradeSide: side==='SELL'?2:1 },
  }] : [] })
  const deps = {
    managedExit: { managedExitApplies: () => false },
    exec: { reconcile: async () => snapshot(),
      closePosition: async (_creds, body) => { state.calls.push(body); return state.response(body) },
      amendPosition: async (_creds, body) => { state.amends.push(body); return { unchanged: true, protection: { stopLoss: 2.3 } } },
      pushTrailConfig: async () => true },
    ws: { wsGetLastCloses: async () => ({ 1: price }),
      wsGetTrendbarsBatch: async () => ({ '1h': Array.from({ length: 50 }, () => ({ h: 2.35, l: 2.30, c: 2.33 })) }),
      wsReconcile: async () => state.reconcile ? state.reconcile() : snapshot(),
      wsGetPositionDeals: async () => state.history || { ctidTraderAccountId: Number(account), hasMore: false, deal: [] } },
    sizing: { getVolumeMeta: async () => ({ symbolId: 1, lotSize: 10000, minVolume: 1, stepVolume: 1, digits: 3, brokerDigits: 3 }) },
    notify: message => state.notifications.push(message),
  }
  const fill = (quantity = 5000) => ({ ctidTraderAccountId: Number(account), executionType: 3,
    deal: { dealId: 7001, orderId: 6001, positionId: 9001, symbolId: 1,
      dealStatus: 2, tradeSide: side==='SELL'?1:2, volume: quantity, filledVolume: quantity,
      executionPrice: price, executionTimestamp: Date.now(),
      closePositionDetail: { closedVolume: quantity, entryPrice: 2.8795 } } })
  return { get db() { return db }, cfg, state, deps, snapshot, fill, creds,
    secondConnection:()=>{const other=initDB(path);t.after(()=>{if(other.open)other.close()});return other},
    run: () => runProfitKeeper(db, creds, deps),
    restart: () => { db.close(); db = initDB(path); clearAtrCache() },
    row: () => db.prepare('SELECT * FROM monitored_positions').get(),
    events: () => db.prepare("SELECT * FROM position_events WHERE kind IN ('scale_out','close')").all(),
    attempt:()=>readKeeperClose(db,account,'9001') }
}
for (const full of [false, true]) {
  for (const accepted of [false, true]) test(`actual keeper ${full ? 'full close' : 'scale-out'} does not certify ${accepted ? 'acceptance' : 'an empty reply'}`, async t => {
    const f = fixture(t, { full })
    f.state.response = () => accepted ? { ctidTraderAccountId: 1, executionType: 2, order: { orderId: 6001, positionId: 9001 } } : {}
    const result = await f.run()
    assert.equal(f.state.calls.length, 1)
    assert.equal(result.scaleOuts, 0)
    assert.equal(result.closes, 0)
    assert.equal(f.row().scaled_out, 0)
    assert.equal(f.events().length, 0)
    assert.equal(f.state.notifications.filter(x => /banked|closed/.test(x)).length, 0)
    f.restart(); await f.run()
    assert.equal(f.state.calls.length, 1, 'unresolved delivery must not be sent again after restart')
  })
}
test('actual keeper commits an underfill quantity and owned residual rather than the request', async t => {
  const f = fixture(t)
  f.state.response = () => { f.state.volume = 8000; return f.fill(2000) }
  const result = await f.run()
  assert.equal(result.scaleOuts, 1, JSON.stringify(result))
  assert.equal(f.state.calls[0].volume, 5000)
  assert.equal(f.events()[0].to_value, 2000)
  assert.equal(f.db.prepare('SELECT volume FROM trades').get().volume, 0.8)
  assert.equal(f.row().broker_volume_units, 80)
  assert.equal(f.row().scaled_out, 1)
})
test('actual keeper retains an ambiguous timeout across restart without duplicate submission', async t => {
  const f = fixture(t)
  f.state.response = () => { throw Error('controlled timeout after delivery') }
  await f.run(); f.restart(); await f.run()
  assert.equal(f.state.calls.length, 1)
  assert.equal(f.row().scaled_out, 0)
  assert.equal(f.events().length, 0)
})
for(const opts of [{source:'external'},{source:'manual',side:'BUY',account:'99',host:'live.ctraderapi.com'}]){
  test(`actual ${opts.source} ${opts.side||'SELL'} keeper confirms a fill and restarts without replay`,async t=>{
    const f=fixture(t,opts)
    f.state.response=()=>{f.state.volume=5000;return f.fill()}
    assert.equal((await f.run()).scaleOuts,1)
    assert.equal(f.row().scaled_out,1)
    assert.equal(f.events()[0].to_value,5000)
    const detail=JSON.parse(f.events()[0].detail_json)
    assert.equal(detail.receipt.host,f.creds.host)
    assert.equal(detail.receipt.accountId,f.creds.accountId)
    assert.equal(detail.residual.volume,5000)
    assert.equal(f.attempt().state,'CONFIRMED')
    f.restart();await f.run()
    assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
  })
}
test('actual keeper full close requires a completed fill and fresh account-owned absence',async t=>{
  const f=fixture(t,{full:true})
  f.state.response=()=>{f.state.volume=0;return f.fill(10000)}
  assert.equal((await f.run()).closes,1)
  assert.equal(f.events()[0].kind,'close');assert.equal(f.events()[0].to_value,10000)
  assert.equal(f.row().scaled_out,0)
  f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
})
for(const mutation of [r=>{r.ctidTraderAccountId=2},r=>{r.deal.positionId=9002},r=>{r.deal.symbolId=2},
  r=>{r.order={orderId:6002}},r=>{r.position={positionId:9001,ctidTraderAccountId:2}},
  r=>{r.deal.tradeSide=2},r=>{r.deal.filledVolume='5000'},r=>{r.deal.filledVolume=6000},
  r=>{r.deal.closePositionDetail.closedVolume=4000},r=>{r.deal.executionTimestamp=Date.now()-60000},
  r=>{r.errorCode='UNKNOWN'},r=>{r.executionType='ORDER_PARTIAL_FILL'}]){
  test(`keeper leaves malformed/conflicting receipt unresolved: ${mutation}`,async t=>{
    const f=fixture(t)
    f.state.response=()=>{const r=f.fill();mutation(r);return r}
    await f.run();f.restart();await f.run()
    assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
    assert.equal(f.attempt().state,'AMBIGUOUS')
    assert.ok(f.state.amends.length,'uncertain profit receipt does not suppress ordinary SL evaluation')
  })
}
for(const conflicting of [false,true])test(`keeper retains a fill until ${conflicting?'owned':'quantity'} residual proof agrees`,async t=>{
  const f=fixture(t)
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  let reads=0
  f.state.reconcile=()=>{const r=f.snapshot();if(++reads>1){if(conflicting)r.ctidTraderAccountId=2;else r.position[0].tradeData.volume=4000}return r}
  assert.equal((await f.run()).scaleOuts,0)
  assert.equal(f.attempt().state,'RECEIVED');assert.equal(f.row().scaled_out,0);assert.equal(f.events().length,0)
  f.state.reconcile=null;f.restart()
  assert.equal((await f.run()).scaleOuts,1)
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
})
test('accepted keeper delivery recovers its owned historical fill with optional scale-out now disabled',async t=>{
  const f=fixture(t)
  f.state.response=()=>({ctidTraderAccountId:1,executionType:2,order:{orderId:6001,positionId:9001}})
  await f.run()
  f.state.volume=5000
  f.state.history={ctidTraderAccountId:1,hasMore:false,deal:[f.fill().deal]}
  f.restart();setState(f.db,'profit_keeper_json',JSON.stringify({...f.cfg,scaleOutFrac:0}))
  assert.equal((await f.run()).scaleOuts,1)
  assert.equal(f.events()[0].to_value,5000);assert.equal(f.state.calls.length,1)
})
for(const stage of ['claim','raw','journal'])test(`keeper ${stage} persistence failure preserves atomic bookkeeping and prevents duplicate delivery`,async t=>{
  const f=fixture(t),prepare=f.db.prepare.bind(f.db)
  const patterns={claim:/INSERT INTO keeper_close_attempts/,raw:/UPDATE keeper_close_attempts SET raw_json/,journal:/INSERT INTO position_events/}
  f.db.prepare=sql=>{if(patterns[stage].test(sql))throw Error(`controlled ${stage} write failure`);return prepare(sql)}
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  await f.run()
  assert.equal(f.row().scaled_out,0);assert.equal(f.events().length,0)
  assert.equal(f.db.prepare('SELECT volume FROM trades').get().volume,1)
  assert.equal(f.state.calls.length,stage==='claim'?0:1)
  f.db.prepare=prepare;f.restart();await f.run()
  assert.equal(f.state.calls.length,1)
  assert.equal(f.events().length,stage==='raw'?0:1)
})
test('keeper full-close underfill stays unresolved instead of stamping a whole close or resubmitting',async t=>{
  const f=fixture(t,{full:true})
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  assert.equal((await f.run()).closes,0)
  assert.equal(f.attempt().state,'RECEIVED')
  f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0)
})
test('keeper duplicate concurrent delivery shares one actual broker attempt',async t=>{
  const f=fixture(t)
  let finish,entered
  const ready=new Promise(resolve=>{entered=resolve})
  f.state.response=()=>new Promise(resolve=>{finish=()=>{f.state.volume=5000;resolve(f.fill())};entered()})
  const first=f.run();await ready
  const second=f.run();finish()
  await Promise.all([first,second])
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
})
for(const cfg of [{scaleOutFrac:0},{on:false}])test(`keeper disabled/default control sends no close: ${JSON.stringify(cfg)}`,async t=>{
  const f=fixture(t)
  setState(f.db,'profit_keeper_json',JSON.stringify({...f.cfg,...cfg}))
  await f.run()
  assert.equal(f.state.calls.length,0);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
  assert.equal(f.attempt(),null)
})

test('independent SQLite deliveries race the durable claim and commit one owned fill',async t=>{
  const f=fixture(t),other=f.secondConnection()
  const input={accountId:'1',positionId:'9001',tradeId:1,monitorId:1,symbol:'NATGAS',side:'SELL',
    host:CREDS.host,kind:'scale_out',volume:5000,beforeVolume:10000,entry:2.8795,symbolId:1,
    meta:{lotSize:10000,brokerDigits:3},reason:'controlled keeper race'}
  let release,entered=0,ready
  const barrier=new Promise(resolve=>{release=resolve}),bothReady=new Promise(resolve=>{ready=resolve})
  const broker={reconcile:async()=>{if(++entered<=2){const before=f.snapshot();if(entered===2)ready();await barrier;return before}return f.snapshot()},
    close:async body=>{f.state.calls.push(body);f.state.volume=5000;return f.fill()},deals:async()=>null}
  const first=runKeeperClose(f.db,input,broker),second=runKeeperClose(other,input,broker)
  await bothReady;release()
  const results=await Promise.all([first,second])
  assert.equal(results.filter(r=>r.committed).length,1)
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1);assert.equal(f.row().scaled_out,1)
  assert.equal(f.db.prepare('SELECT count(*) n FROM keeper_close_attempts').get().n,1)
  f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
})

test('a retained full-close receipt recovers after ordinary reconciliation closes its monitor',async t=>{
  const f=fixture(t,{full:true}),prepare=f.db.prepare.bind(f.db)
  f.db.prepare=sql=>{if(/INSERT INTO position_events/.test(sql))throw Error('controlled journal outage');return prepare(sql)}
  f.state.response=()=>{f.state.volume=0;return f.fill(10000)}
  assert.equal((await f.run()).closes,0)
  assert.equal(f.attempt().state,'RECEIVED');assert.equal(f.events().length,0)
  f.db.prepare=prepare
  f.db.prepare("UPDATE monitored_positions SET status='closed'").run()
  f.db.prepare("UPDATE trades SET status='closed'").run()
  f.restart()
  assert.equal((await f.run()).closes,1)
  assert.equal(f.row().status,'closed');assert.equal(f.events()[0].to_value,10000)
  await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,1)
})

test('confirmed keeper partial can be followed by its later genuine full exit',async t=>{
  const f=fixture(t)
  f.state.response=body=>{f.state.volume-=body.volume;return f.fill(body.volume)}
  assert.equal((await f.run()).scaleOuts,1)
  setState(f.db,'profit_keeper_json',JSON.stringify({...f.cfg,takeProfitUsd:20}))
  assert.equal((await f.run()).closes,1)
  assert.deepEqual(f.state.calls.map(c=>c.volume),[5000,5000])
  assert.deepEqual(f.events().map(e=>[e.kind,e.to_value]),[['scale_out',5000],['close',5000]])
  assert.equal(f.state.volume,0)
})

test('legacy unstamped external keeper rows retain broker-proven eligibility and restart recovery',async t=>{
  const f=fixture(t);let reads=0
  f.db.prepare('UPDATE monitored_positions SET account_id=NULL').run()
  f.db.prepare('UPDATE trades SET account_id=NULL').run()
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  f.state.reconcile=()=>{const r=f.snapshot();if(++reads>1)r.ctidTraderAccountId=2;return r}
  await f.run()
  assert.equal(f.state.calls.length,1,'fresh own broker response resolves the unstamped legacy owner')
  assert.equal(f.attempt().state,'RECEIVED')
  f.state.reconcile=null;f.restart()
  assert.equal((await f.run()).scaleOuts,1)
  assert.equal(f.row().account_id,null,'do not rewrite legacy account stamps')
  assert.equal(f.db.prepare('SELECT volume FROM trades').get().volume,0.5)
  assert.equal(f.events()[0].account_id,'1');assert.equal(f.state.calls.length,1)
})

for(const mutation of [h=>{h.hasMore=true},h=>{delete h.hasMore},h=>{h.ctidTraderAccountId=2},
  h=>{h.deal.push({...h.deal[0],dealId:7002})},h=>{h.deal[0].orderId=6002},
  h=>{h.deal[0].positionId=9002},h=>{h.deal[0].ctidTraderAccountId=2}]){
  test(`accepted keeper history cannot certify incomplete or conflicting delivery: ${mutation}`,async t=>{
    const f=fixture(t)
    f.state.response=()=>({ctidTraderAccountId:1,executionType:2,order:{orderId:6001,positionId:9001}})
    await f.run();f.state.volume=5000
    const history={ctidTraderAccountId:1,hasMore:false,deal:[f.fill().deal]};mutation(history)
    f.state.history=history;f.restart();await f.run()
    assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
  })
}
test('an underfill with requested deal.volume records only the actual completed quantity',async t=>{
  const f=fixture(t)
  f.state.response=()=>{f.state.volume=8000;const r=f.fill(2000);r.deal.volume=5000;return r}
  assert.equal((await f.run()).scaleOuts,1)
  assert.equal(f.events()[0].to_value,2000);assert.equal(f.row().broker_volume_units,80)
})
test('conflicting identity inside a fresh residual cannot latch the profit execution',async t=>{
  const f=fixture(t);let reads=0
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  f.state.reconcile=()=>{const r=f.snapshot();if(++reads>1)r.position[0].ctidTraderAccountId=2;return r}
  await f.run();f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
})
test('an owner changed after broker fill prevents atomic execution bookkeeping',async t=>{
  const f=fixture(t)
  f.state.response=()=>{f.state.volume=5000;f.db.prepare("UPDATE trades SET account_id='2'").run();return f.fill()}
  await f.run();f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
  assert.equal(f.db.prepare('SELECT volume FROM trades').get().volume,1)
})
test('corrupt retained receipt remains unresolved without another submission',async t=>{
  const f=fixture(t);let reads=0
  f.state.response=()=>{f.state.volume=5000;return f.fill()}
  f.state.reconcile=()=>{const r=f.snapshot();if(++reads>1)r.ctidTraderAccountId=2;return r}
  await f.run()
  const receipt={...f.attempt().receipt,accountId:'2'}
  f.db.prepare('UPDATE keeper_close_attempts SET receipt_json=?').run(JSON.stringify(receipt))
  f.state.reconcile=null;f.restart();await f.run()
  assert.equal(f.state.calls.length,1);assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
})
for(const failure of ['not_sent','rejected','already_closed'])test(`keeper failure classification keeps ${failure} truthful`,async t=>{
  const f=fixture(t)
  f.state.response=()=>{const e=Error(failure==='rejected'?'cTrader order rejected: MARKET_CLOSED':failure==='already_closed'?'POSITION_NOT_FOUND':'controlled pre-transport refusal');if(failure==='not_sent')e.notSent=true;throw e}
  await f.run()
  assert.equal(f.attempt().state,failure==='already_closed'?'AMBIGUOUS':'REJECTED')
  assert.equal(f.events().length,0);assert.equal(f.row().scaled_out,0)
  f.state.response=()=>{f.state.volume=5000;return f.fill()};f.restart();await f.run()
  assert.equal(f.state.calls.length,failure==='already_closed'?1:2)
  assert.equal(f.events().length,failure==='already_closed'?0:1)
})
