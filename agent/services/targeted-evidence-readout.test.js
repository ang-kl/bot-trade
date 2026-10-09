// Codex · №12,435 · 2026-10-09; codex-footprint: targeted-owned-evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { readTargetedEvidence, startTargetedEvidenceReadout } from './targeted-evidence-readout.js'
const NOW=1791508672695
function scene(t){
  const db=initDB(':memory:');t.after(()=>db.close())
  db.exec("INSERT INTO trades(id,symbol,account_id,ctrader_position_id,status) VALUES(1,'EURUSD','42','33','open'),(2,'EURUSD','43','33','open')")
  return db
}
test('targeted movements remain available above the old population cap; indexed, account/position owned, bounded and read-only',t=>{
  const db=scene(t)
  const insert=db.prepare('INSERT INTO position_events(trade_id,account_id,position_id,symbol,kind,from_value,to_value,detail_json) VALUES(?,?,?,?,?,?,?,?)')
  db.transaction(()=>{
    for(let i=0;i<6000;i++) insert.run(1,'42','33','EURUSD','trail_observed',1,2,'{}')
    for(let i=0;i<12;i++) insert.run(1,'42','33','EURUSD','trail_tightened',1,2,JSON.stringify({nativeSeq:i,nativeBootId:'abc',
      accessToken:'must-not-leak',movement:{accountId:42,positionId:33,symbolId:22,stopMoved:true,beforeStopLoss:1,afterStopLoss:2,secret:'must-not-leak'}}))
    insert.run(1,'43','33','EURUSD','sl_moved',1,2,'{}')
    insert.run(1,'42','99','EURUSD','sl_moved',1,2,'{}')
    insert.run(2,'43','33','EURUSD','sl_moved',3,4,'{}')
  })()
  const before=db.prepare('SELECT total_changes() n').get().n,prepare=db.prepare.bind(db),plans=[]
  db.prepare=sql=>{if(sql.includes('FROM position_events WHERE'))plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(1,'trail_tightened',9));return prepare(sql)}
  const result=readTargetedEvidence(db,NOW);db.prepare=prepare
  const a=result.trades.find(x=>x.owner.id===1),b=result.trades.find(x=>x.owner.id===2)
  assert.equal(a.movements[0].rows.length,8);assert.equal(a.movements[0].truncated,true)
  assert.equal(a.movements[1].identityConflicts,2);assert.equal(a.movements[1].rows.length,0)
  assert.equal(b.movements[1].rows[0].from_value,3)
  assert.equal(a.movements[0].rows[0].movement.afterStopLoss,2)
  assert.ok(plans.every(p=>p.some(x=>/SEARCH position_events USING INDEX idx_position_events_trade_kind/.test(x.detail))))
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before)
  assert.ok(!JSON.stringify(result).includes('must-not-leak'))
})
test('dated refusal inputs and independent protection join only their account/position; legacy missing inputs remain unknown',t=>{
  const db=scene(t)
  setState(db,'momentum_partial_pass_json',JSON.stringify({at:'2026-10-09T01:00:00Z',cappedHybrid:{deferred:[
    {tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',volumeInputs:{accountId:'42',positionId:'33',symbolId:'22',volume:300,minVolume:100,stepVolume:100,secret:'must-not-leak'}},
    {tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',volumeInputs:{accountId:'43',positionId:'33',volume:999}},
    {tradeId:2,accountId:'43',reason:'half_and_runner_not_representable'},
  ]}}))
  setState(db,'independent_protection_json',JSON.stringify({accounts:[{accountId:'43',checkedAtMs:NOW,positions:[{positionId:'33',stopLoss:50}]},{accountId:'42',checkedAtMs:NOW,positions:[{positionId:'33',stopLoss:10}]}]}))
  const out=readTargetedEvidence(db,NOW),a=out.trades.find(x=>x.owner.id===1),b=out.trades.find(x=>x.owner.id===2)
  assert.equal(a.volumeRefusals[0].inputs.volume,300)
  assert.equal(a.volumeRefusals[1].inputStatus,'identity_conflict');assert.equal(a.volumeRefusals[1].inputs,null)
  assert.equal(b.volumeRefusals[0].inputStatus,'not_recorded')
  assert.equal(a.protection[0].position.stopLoss,10);assert.equal(b.protection[0].position.stopLoss,50)
  assert.ok(!JSON.stringify(out).includes('must-not-leak'))
})
test('opt-in exports once after delay; durable claim blocks restart replay; no profiler, SQL tap or broker path',t=>{
  const db=scene(t),logs=[],callbacks=[]
  const options={env:{OWNED_EVIDENCE_RUN_ID:'test-owned-1234',OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()},
    now:()=>NOW,log:x=>logs.push(JSON.parse(x)),setTimer:(cb,ms)=>{assert.equal(ms,180000);callbacks.push(cb)},clearTimer:()=>{}}
  assert.equal(startTargetedEvidenceReadout(db,{...options,env:{}}),null)
  assert.equal(callbacks.length,0)
  assert.equal(typeof startTargetedEvidenceReadout(db,options),'function')
  assert.equal(startTargetedEvidenceReadout(db,options),null)
  assert.equal(callbacks.length,1);callbacks[0]()
  assert.equal(logs[0].kind,'scheduled');assert.equal(logs.at(-1).value.done,true)
  assert.equal(logs.at(-1).value.dropped,0)
  assert.equal(logs[0].value.brokerRequests,0);assert.equal(logs[0].value.profiling,false)
  assert.equal(db.prepare("SELECT count(*) n FROM agent_state WHERE key LIKE 'owned_evidence:%'").get().n,1)
})
test('expired run cannot export',t=>{
  const db=scene(t),logs=[];let cb
  let now=NOW
  const opts={env:{OWNED_EVIDENCE_RUN_ID:'test-owned-5678',OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+1000).toISOString()},now:()=>now,
    log:x=>logs.push(JSON.parse(x)),setTimer:f=>{cb=f},clearTimer:()=>{}}
  startTargetedEvidenceReadout(db,opts);now+=1001;cb()
  assert.equal(logs.at(-1).value.reason,'deadline_expired')
  assert.equal(startTargetedEvidenceReadout(db,opts),null)
})

// Codex · №12,437 · 2026-10-09; codex-footprint: bounded-evidence-review.
test('owner selection is an indexed bounded range and saturated output retains the terminal receipt',t=>{
  const db=scene(t),logs=[];let callback
  const trade=db.prepare("INSERT INTO trades(id,symbol,account_id,ctrader_position_id,status) VALUES(?,'EURUSD','42',?,'open')")
  const event=db.prepare('INSERT INTO position_events(trade_id,account_id,position_id,symbol,kind,detail_json) VALUES(?,?,?,?,?,?)')
  db.transaction(()=>{
    for(let id=3;id<=70;id++)trade.run(id,String(100+id))
    for(let id=3;id<=70;id++)for(const kind of ['trail_tightened','sl_moved','scale_out'])for(let j=0;j<8;j++)
      event.run(id,'42',String(100+id),'EURUSD',kind,JSON.stringify({nativeSide:'demo',nativeBootId:'a'.repeat(100),nativeSeq:1000+j,
        nativeAtMs:NOW,host:'demo.ctraderapi.com',movement:{v:1,source:'broker_reconcile',confirmation:'amend_readback',
          stopMoved:true,accountId:42,positionId:100+id,symbolId:22,direction:1,entryPrice:100,beforeStopLoss:99,afterStopLoss:100,
          beforeCheckedAtMs:NOW-1000,afterCheckedAtMs:NOW}}))
  })()
  const prepare=db.prepare.bind(db);let ownersPlan
  db.prepare=sql=>{if(sql.includes("WHERE status='open' ORDER"))ownersPlan=prepare('EXPLAIN QUERY PLAN '+sql).all(65);return prepare(sql)}
  startTargetedEvidenceReadout(db,{env:{OWNED_EVIDENCE_RUN_ID:'saturated-owned',OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()},
    now:()=>NOW,log:x=>logs.push(x),setTimer:cb=>{callback=cb},clearTimer:()=>{}})
  callback();db.prepare=prepare
  assert.ok(ownersPlan.some(x=>/SEARCH trades USING INDEX idx_trades_status_closed/.test(x.detail)))
  assert.ok(ownersPlan.every(x=>!x.detail.includes('TEMP B-TREE')))
  const final=JSON.parse(logs.at(-1))
  assert.equal(final.kind,'exit');assert.equal(final.value.done,true);assert.ok(final.value.dropped>0)
  assert.ok(logs.reduce((n,line)=>n+Buffer.byteLength(line),0)<=256*1024)
  assert.equal(JSON.parse(logs.find(x=>JSON.parse(x).kind==='summary')).value.truncatedTrades,true)
})

// Codex · №12,439 · 2026-10-09; codex-footprint: retained-movement-targets.
test('explicit existing trade target survives a natural close without scanning closed history',t=>{
  const db=scene(t)
  db.exec("UPDATE trades SET status='closed' WHERE id=1; INSERT INTO position_events(trade_id,account_id,position_id,symbol,kind,from_value,to_value) VALUES(1,'42','33','EURUSD','sl_moved',1,2)")
  assert.equal(readTargetedEvidence(db,NOW).trades.some(r=>r.owner.id===1),false)
  const read=readTargetedEvidence(db,NOW,[1,1,999]),target=read.trades.find(r=>r.owner.id===1)
  assert.equal(read.trades.filter(r=>r.owner.id===1).length,1)
  assert.equal(target.owner.status,'closed');assert.equal(target.movements[1].rows[0].to_value,2)
  assert.throws(()=>readTargetedEvidence(db,NOW,Array(9).fill(1)),/invalid_targets/)
  let calls=0
  assert.equal(startTargetedEvidenceReadout(db,{env:{OWNED_EVIDENCE_TRADE_IDS:'1); DELETE FROM trades;'},setTimer:()=>{calls++}}),null)
  assert.equal(calls,0)
})
