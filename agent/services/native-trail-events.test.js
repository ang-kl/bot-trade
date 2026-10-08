// Codex · №12,183 · 2026-10-08; codex-footprint: fixtures retain account-owned writer provenance.
// Codex · №12,073 · 2026-10-08; codex-footprint: confirmed-trail.
// Actual native ingestion and public history/state readers, with HTTP alone substituted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { probeOneSidecar, execSidesToProbe } from './heartbeat.js'
import { managementFor } from './position-history.js'
import { currentManagementState, lastStateBeforeExit, recordPositionEvent } from './position-events.js'
import { INSPECTIONS, SPEECH_ACTS, evalFalsifierMetric } from './log-inspector.js'
import { recordNativeTrailDecision } from './native-trail-events.js'

const NOW = Date.parse('2026-10-08T02:30:00Z')
// Codex · №12,109 · 2026-10-08; codex-footprint: default-trail-binding.
function sharedRoute(f, isLive = false) {
  f.exec.execBaseFor = () => 'http://native.test'
  Object.assign(f.side, execSidesToProbe(f.exec)[0])
  setState(f.db, 'ctrader_account_id', '11')
  setState(f.db, 'ctrader_is_live', isLive ? 'true' : 'false')
}
function anotherEpisode(f) {
  return f.db.prepare(`INSERT INTO trades(symbol,side,account_id,ctrader_position_id,status,opened_at,entry_price)
    VALUES ('TEST','BUY','11','77','closed','2026-10-08 01:00:00',10)`).run().lastInsertRowid
}
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('11',0)
  setState(db,'symbol_id_map:11',JSON.stringify({ accountId: '11',map:{TEST:9},builtAt:new Date(NOW).toISOString()}))
  const tradeId = db.prepare(`INSERT INTO trades(symbol,side,account_id,ctrader_position_id,status,opened_at,entry_price)
    VALUES ('TEST','BUY','11','77','open','2026-10-08 02:00:00',10)`).run().lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions(symbol,side,account_id,trade_id,entry_price,status,mfe_r)
    VALUES ('TEST','long','11',?,10,'active',2)`).run(tradeId)
  const side = { name:'cpp_exec_demo', base:'http://native.test', isLive:false }
  const health = {ok:true,mode:'cpp',connected:true,hasCredentials:true,lastReconcileAt:NOW,bootId:'boot-a'}
  const proof = {v:1,source:'broker_reconcile',confirmation:'amend_readback',accountId:11,positionId:77,
    symbolId:9,direction:1,entryPrice:10,beforeStopLoss:8.5,afterStopLoss:9.5,stopMoved:true,
    beforeCheckedAtMs:NOW-5000,afterCheckedAtMs:NOW-1000}
  let entry = {seq:1,tsMs:NOW,component:'trail',kind:'amend_ok',accountId:11,symbolId:9,
    detail:'pos=77 sl=9.500000 amend_readback proof='+JSON.stringify(proof)}
  const exec = {pingSidecar:async()=>health,pullSidecarDecisions:async({after})=>({bootId:health.bootId,
    latestSeq:entry.seq,entries:entry.seq>after?[entry]:[]})}
  return {db,tradeId,proof,entry,health,side,exec,
    replace(patch){ entry={...entry,...patch} },
    run:()=>probeOneSidecar(db,exec,side,{now:new Date(NOW)})}
}

test('default collapsed route journals a registered demo movement once',async t=>{
  const f=fixture(t);sharedRoute(f)
  await f.run();await f.run()
  const event=f.db.prepare("SELECT * FROM position_events WHERE kind='trail_tightened'").get()
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,1)
  assert.equal(event.account_id,'11')
  assert.equal(JSON.parse(event.detail_json).host,'demo.ctraderapi.com')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cpp_decisions WHERE seq>0').get().n,1)
})

test('collapsed route binds another registered account on its primary host',async t=>{
  const f=fixture(t);sharedRoute(f)
  f.db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('22',0)
  setState(f.db,'ctrader_account_id','22')
  await f.run()
  const event=f.db.prepare("SELECT * FROM position_events WHERE kind='trail_tightened'").get()
  assert.equal(event.account_id,'11')
  assert.equal(JSON.parse(event.detail_json).host,'demo.ctraderapi.com')
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,1)
})

test('default collapsed route also journals a registered live short movement',async t=>{
  const f=fixture(t)
  f.db.prepare('UPDATE accounts SET is_live=1').run()
  f.db.prepare("UPDATE trades SET side='SELL'").run()
  f.db.prepare("UPDATE monitored_positions SET side='short'").run()
  sharedRoute(f,true)
  f.replace({detail:'pos=77 sl=10.500000 amend_readback proof='+JSON.stringify({
    ...f.proof,direction:-1,beforeStopLoss:11.5,afterStopLoss:10.5})})
  await f.run()
  const event=f.db.prepare("SELECT * FROM position_events WHERE kind='trail_tightened'").get()
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,1)
  assert.equal(JSON.parse(event.detail_json).host,'live.ctraderapi.com')
})

test('collapsed route leaves foreign-host, missing-primary and contradictory routing raw',async t=>{
  for(const change of ['foreign','missing','contradictory']){
    const f=fixture(t);sharedRoute(f)
    if(change==='foreign'){
      f.db.prepare('INSERT INTO accounts(account_id,is_live) VALUES (?,?)').run('22',1)
      setState(f.db,'ctrader_account_id','22');setState(f.db,'ctrader_is_live','true')
    }
    if(change==='missing')setState(f.db,'ctrader_account_id','999')
    if(change==='contradictory')setState(f.db,'ctrader_is_live','true')
    await f.run()
    assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cpp_decisions WHERE seq>0').get().n,1)
  }
})

test('collapsed routing requires the actual shared endpoint and the same native boot',async t=>{
  for(const change of ['split','endpoint','boot','undefined']){
    const f=fixture(t);sharedRoute(f)
    if(change==='split'){
      f.exec.EXEC_HOST_LIVE='live';f.exec.EXEC_HOST_DEMO='demo'
      f.exec.execBaseFor=host=>'http://'+host+'.test'
    }
    if(change==='endpoint')f.side.base='http://foreign.test'
    if(change==='boot')f.exec.pullSidecarDecisions=async()=>({bootId:'another-boot',latestSeq:1,entries:[f.entry]})
    if(change==='undefined')f.side.isLive=undefined
    await f.run()
    assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cpp_decisions WHERE seq>0').get().n,1)
  }
})

test('confirmed owned native movement reaches history, lifecycle and the armed-trail promise',async t=>{
  const f=fixture(t),{db,tradeId}=f
  recordPositionEvent(db,{accountId:11,positionId:77,tradeId,symbol:'TEST',kind:'trail_armed'})
  db.prepare("UPDATE position_events SET at='2026-10-08 02:01:00'").run()
  await f.run();await f.run()
  assert.equal(managementFor(db,{accountId:11,positionId:77,tradeId}).sl_moves,1)
  assert.equal(currentManagementState(db,{tradeId}),'trail_tightened')
  assert.equal(lastStateBeforeExit(db,tradeId).state,'trail_tightened')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM position_events WHERE kind='trail_tightened'").get().n,1)
  const inspection=INSPECTIONS.find(x=>x.key==='broken_commissive')
  assert.deepEqual(inspection.run(db,{commissiveGraceMin:5},NOW+60000),[])
  const event=db.prepare("SELECT * FROM position_events WHERE kind='trail_tightened'").get()
  assert.equal(Date.parse(event.at+'Z'),f.proof.afterCheckedAtMs)
  assert.equal(event.from_value,8.5);assert.equal(event.to_value,9.5)
})

test('a failed confirmed journal write retries atomically without losing the native receipt',async t=>{
  const f=fixture(t),prepare=f.db.prepare.bind(f.db);let fail=true
  f.db.prepare=sql=>{if(fail&&/INSERT INTO position_events/.test(sql)){fail=false;throw Error('fixture journal failure')}return prepare(sql)}
  await f.run()
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cpp_decisions').get().n,0)
  assert.equal(getState(f.db,'cpp_decisions_cursor_json'),null)
  await f.run();await f.run()
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,1)
})

test('new boot same sequence is distinct while replay in the same boot is one journal event',async t=>{
  const f=fixture(t);await f.run();await f.run();f.health.bootId='boot-b';await f.run();await f.run()
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,2)
})

test('seeded, already tighter, failed, policy-only, malformed and foreign native receipts stay non-moves',async t=>{
  const patches=[{kind:'already_tighter'},{kind:'amend_fail'},{detail:'pos=77 sl=9.500000 amend_readback'},
    {proof:{stopMoved:false}},{proof:{beforeStopLoss:9.5}},{proof:{entryPrice:11}},
    {proof:{direction:-1}},{proof:{accountId:22}},{symbolId:10},{accountId:22},
    {proof:{afterCheckedAtMs:NOW+1000}},{proof:{beforeStopLoss:null}},
    {proof:{v:2}},{proof:{padding:'x'.repeat(500)}}]
  for(const patch of patches){const f=fixture(t)
    if(patch.proof)f.replace({detail:'pos=77 sl=9.500000 amend_readback proof='+JSON.stringify({...f.proof,...patch.proof})})
    else f.replace(patch)
    await f.run();assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cpp_decisions WHERE seq>0').get().n,1)
  }
})

// Codex · №12,074 · 2026-10-08; codex-footprint: confirmed-trail.
test('another account or episode cannot keep this armed trail promise',t=>{
  for(const foreign of ['account','trade']){const f=fixture(t)
    const otherTradeId=foreign==='trade'?anotherEpisode(f):f.tradeId
    recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:f.tradeId,symbol:'TEST',kind:'trail_armed',atMs:NOW-20*60000})
    recordPositionEvent(f.db,{accountId:foreign==='account'?22:11,positionId:77,
      tradeId:otherTradeId,symbol:'TEST',kind:'trail_tightened',atMs:NOW})
    const inspection=INSPECTIONS.find(x=>x.key==='broken_commissive')
    assert.equal(inspection.run(f.db,{commissiveGraceMin:5},NOW+60000).length,1)
    const args={accountId:'11',tradeId:f.tradeId,positionId:'77',sinceIso:new Date(NOW-60000).toISOString()}
    assert.equal(SPEECH_ACTS.find(x=>x.match==="kind = 'trail_armed'").successPredicate(f.db,args),false)
    assert.equal(evalFalsifierMetric(f.db,{...args,kind:'position_event_exists',kinds:['trail_tightened'],sinceMs:NOW-60000}),true)
  }
})

test('owned reader predicates compare source times in SQLite and ISO forms',t=>{
  const f=fixture(t)
  recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:f.tradeId,symbol:'TEST',kind:'trail_tightened',atMs:NOW})
  const args={accountId:'11',tradeId:f.tradeId,positionId:'77',sinceIso:new Date(NOW-1).toISOString()}
  assert.equal(SPEECH_ACTS.find(x=>x.match==="kind = 'trail_armed'").successPredicate(f.db,args),true)
  assert.equal(evalFalsifierMetric(f.db,{...args,kind:'position_event_exists',kinds:['trail_tightened'],sinceMs:NOW-1}),false)
  assert.equal(evalFalsifierMetric(f.db,{...args,kind:'position_event_exists',kinds:['trail_tightened'],sinceMs:NOW+1}),true)
})

// Codex · №12,076 · 2026-10-08; codex-footprint: confirmed-trail.
test('delayed logging cannot attach broker reads completed before this same-ID episode',t=>{
  const f=fixture(t)
  f.db.prepare("UPDATE trades SET opened_at='2026-10-08 02:29:59.500'").run()
  assert.equal(recordNativeTrailDecision(f.db,{side:f.side,bootId:f.health.bootId,entry:f.entry,
    accountBinding:{accountId:'11',host:'demo.ctraderapi.com'}}),false)
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
})

test('native history from a previous same-ID episode does not inflate this trade',t=>{
  const f=fixture(t)
  assert.equal(recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:anotherEpisode(f),symbol:'TEST',
    kind:'trail_tightened',source:'cpp_trail_engine',atMs:NOW}),true)
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
})

test('ring logging after arming does not turn an earlier broker movement into a kept promise',async t=>{
  const f=fixture(t)
  recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:f.tradeId,symbol:'TEST',kind:'trail_armed',atMs:NOW-500})
  await f.run()
  assert.equal(INSPECTIONS.find(x=>x.key==='broken_commissive').run(f.db,{commissiveGraceMin:5},NOW+10*60000).length,1)
  assert.equal(Date.parse(f.db.prepare("SELECT at FROM position_events WHERE kind='trail_tightened'").get().at+'Z'),f.proof.afterCheckedAtMs)
})

// Codex · №12,083 · 2026-10-08; codex-footprint: confirmed-trail.
test('registered host routing uses the same movement proof for a live short position',async t=>{
  const f=fixture(t)
  f.db.prepare('UPDATE accounts SET is_live=1').run()
  f.db.prepare("UPDATE trades SET side='SELL'").run()
  f.db.prepare("UPDATE monitored_positions SET side='short'").run()
  f.side.isLive=true;f.side.name='cpp_exec_live'
  f.replace({detail:'pos=77 sl=10.500000 amend_readback proof='+JSON.stringify({
    ...f.proof,direction:-1,beforeStopLoss:11.5,afterStopLoss:10.5})})
  await f.run()
  const event=f.db.prepare("SELECT * FROM position_events WHERE kind='trail_tightened'").get()
  assert.equal(event.account_id,'11')
  assert.equal(JSON.parse(event.detail_json).host,'live.ctraderapi.com')
  assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,1)
})

test('foreign host, missing ownership and same-ID reversal cannot attach earlier native movement',async t=>{
  for(const change of ['host','missing','reversal','ambiguous']){const f=fixture(t)
    if(change==='host')f.side.isLive=true
    if(change==='missing')f.db.prepare('UPDATE monitored_positions SET account_id=NULL').run()
    if(change==='reversal')f.db.prepare("UPDATE monitored_positions SET side='short',entry_price=11").run()
    if(change==='ambiguous')f.db.prepare(`INSERT INTO monitored_positions(symbol,side,account_id,trade_id,entry_price,status)
      VALUES ('TEST','long','11',?,10,'active')`).run(f.tradeId)
    await f.run();assert.equal(managementFor(f.db,{accountId:11,positionId:77,tradeId:f.tradeId}).sl_moves,0)
  }
})

test('native source time before arming does not satisfy a later promise or reopen a terminal position',async t=>{
  const f=fixture(t)
  recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:f.tradeId,symbol:'TEST',kind:'trail_armed'})
  f.db.prepare("UPDATE position_events SET at='2026-10-08 02:31:00'").run()
  await f.run()
  const inspection=INSPECTIONS.find(x=>x.key==='broken_commissive')
  assert.equal(inspection.run(f.db,{commissiveGraceMin:5},NOW+10*60000).length,1)
  assert.equal(currentManagementState(f.db,{tradeId:f.tradeId}),'trail_tightened')
  assert.equal(lastStateBeforeExit(f.db,f.tradeId).state,'trail_tightened')
  recordPositionEvent(f.db,{accountId:11,positionId:77,tradeId:f.tradeId,symbol:'TEST',kind:'close'})
  f.db.prepare("UPDATE position_events SET at='2026-10-08 02:32:00' WHERE kind='close'").run()
  f.replace({seq:2});await f.run()
  assert.equal(currentManagementState(f.db,{tradeId:f.tradeId}),'closed:close')
})
