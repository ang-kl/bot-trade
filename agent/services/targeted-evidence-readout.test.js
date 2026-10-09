// Codex · №12,435 · 2026-10-09; codex-footprint: targeted-owned-evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { initDB, setState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
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
  db.exec("UPDATE trades SET status='closed' WHERE id=1")
  const prepare=db.prepare.bind(db);let ownersPlan
  db.prepare=sql=>{if(sql.includes("WHERE status='open' ORDER"))ownersPlan=prepare('EXPLAIN QUERY PLAN '+sql).all(65);return prepare(sql)}
  startTargetedEvidenceReadout(db,{env:{OWNED_EVIDENCE_RUN_ID:'saturated-owned',OWNED_EVIDENCE_TRADE_IDS:'1',OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()},
    now:()=>NOW,log:x=>logs.push(x),setTimer:cb=>{callback=cb},clearTimer:()=>{}})
  callback();db.prepare=prepare
  assert.ok(ownersPlan.some(x=>/SEARCH trades USING INDEX idx_trades_status_closed/.test(x.detail)))
  assert.ok(ownersPlan.every(x=>!x.detail.includes('TEMP B-TREE')))
  const final=JSON.parse(logs.at(-1))
  assert.equal(final.kind,'exit');assert.equal(final.value.done,true);assert.ok(final.value.dropped>0)
  assert.equal(JSON.parse(logs.find(x=>JSON.parse(x).kind==='owned-position')).value.owner.id,1, 'explicit closed target is emitted before detail saturation')
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

// Codex · №12,721 · 2026-10-10; codex-footprint: bounded-gap-batch.
test('scanner opt-in uses the same durable one-shot claim after target evidence, and is dormant without the exact flag',async t=>{
  const db=scene(t),logs=[];let callback,calls=0
  const env={OWNED_EVIDENCE_RUN_ID:'scanner-once-1234',OWNED_EVIDENCE_TRADE_IDS:'1',OWNED_EVIDENCE_SCANNER:'1',
    OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString(),SCANNER_TIMEFRAME_URL:'http://scanner.invalid',SCANNER_TIMEFRAME_SECRET:'not-logged-secret'}
  const options={env,now:()=>NOW,log:x=>logs.push(JSON.parse(x)),setTimer:cb=>{callback=cb},clearTimer:()=>{},
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify({observedAtMs:NOW,workComplete:true,work:[],cells:{count:0,capacity:1024,stale:0}}))}}
  startTargetedEvidenceReadout(db,options);assert.equal(calls,0);await callback()
  assert.equal(calls,1);assert.equal(logs[0].value.scannerRead,true)
  const scannerIndex=logs.findIndex(x=>x.kind==='scanner-summary')
  assert.ok(scannerIndex>logs.findIndex(x=>x.kind==='initial-risk'&&x.value.owner?.id===1))
  assert.ok(scannerIndex<logs.findIndex(x=>x.kind==='owned-position'&&x.value.owner?.id===2))
  assert.equal(logs.at(-1).kind,'exit');assert.equal(logs.at(-1).value.done,true)
  assert.ok(logs.at(-1).value.scanner.emittedRecords>=1)
  assert.equal(startTargetedEvidenceReadout(db,options),null);assert.equal(calls,1)
  for(const value of [undefined,'0','true']){
    startTargetedEvidenceReadout(db,{...options,env:{...env,OWNED_EVIDENCE_RUN_ID:`scanner-off-${value||'unset'}`,OWNED_EVIDENCE_SCANNER:value}})
    await callback()
  }
  assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(logs),/not-logged-secret/)
})

test('scanner callback failure and expiry finish once without raw exception text or extra native reads',async t=>{
  const db=scene(t),logs=[];let callback,clock=NOW,calls=0
  const env={OWNED_EVIDENCE_RUN_ID:'scanner-expiry-1234',OWNED_EVIDENCE_SCANNER:'1',OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+10000).toISOString(),
    SCANNER_TIMEFRAME_URL:'http://scanner.invalid',SCANNER_TIMEFRAME_SECRET:'secret'}
  const options={env,now:()=>clock,log:x=>logs.push(JSON.parse(x)),setTimer:cb=>{callback=cb},clearTimer:()=>{},
    fetchImpl:async()=>{calls++;clock=NOW+10001;return new Response(JSON.stringify({observedAtMs:NOW,workComplete:true,work:[],cells:{count:0,capacity:1024}}))}}
  startTargetedEvidenceReadout(db,options);await callback()
  assert.equal(calls,1);assert.equal(logs.at(-1).value.reason,'deadline_expired')
  assert.equal(logs.some(x=>x.kind==='scanner-summary'),false)
  clock=NOW
  startTargetedEvidenceReadout(db,{...options,env:{...env,OWNED_EVIDENCE_RUN_ID:'scanner-storage-1234'}})
  db.exec('DROP TABLE accounts');await callback()
  assert.equal(calls,1);assert.equal(logs.at(-1).value.scanner.reason,'scanner_read_failed')
  assert.doesNotMatch(JSON.stringify(logs),/no such table|secret/)
})

// Codex · №12,808 · 2026-10-10; codex-footprint: hybrid-verdict-only-read.
function hybridScene(t, path=':memory:') {
  const db=new Database(path);t.after(()=>db.close())
  db.pragma('journal_mode=WAL')
  // Deliberately no account, movement, risk, protection or scanner tables.
  db.exec(`CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY,account_id TEXT,ctrader_position_id TEXT);
    INSERT INTO trades VALUES(1,'42','33'),(2,'43','33'),(3,NULL,NULL)`)
  return db
}
function hybridRun(db, suffix, extra={}) {
  const logs=[],callbacks=[]
  const options={env:{OWNED_EVIDENCE_SCOPE:'hybrid',OWNED_EVIDENCE_RUN_ID:`hybrid-only-${suffix}`,
    OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()},now:()=>NOW,
    log:line=>logs.push(JSON.parse(line)),setTimer:(callback,ms)=>{assert.equal(ms,180000);callbacks.push(callback)},clearTimer:()=>{},
    fetchImpl:()=>{throw Error('unexpected_network_read')},...extra}
  const stop=startTargetedEvidenceReadout(db,options)
  return {logs,callbacks,options,stop}
}
function refusalInputs(extra={}) {
  return {source:'ordinary_enrolment_reads',units:'ctrader_protocol_volume',host:'demo.ctraderapi.com',
    accountId:'42',positionId:'33',symbolId:'22',side:'BUY',metadataReceivedAtMs:NOW-10,reconcileReceivedAtMs:NOW-5,
    volume:300,halfVolume:150,minVolume:100,stepVolume:100,minVolumeValid:true,stepVolumeValid:true,...extra}
}
function saveRefusals(db, rows) {
  setState(db,'momentum_partial_pass_json',JSON.stringify({at:'2026-10-09T01:00:00Z',ok:true,activePlans:0,
    cappedHybrid:{examined:rows.length,enrolled:[],excluded:[],delegated:[],deferred:rows,errors:[]}}))
  setState(db,'hybrid_tick_controller_json',JSON.stringify({at:NOW,hosts:{'demo.ctraderapi.com':{plans:0,errors:0,error:null}}}))
}

test('hybrid scope emits one query-only owned refusal snapshot without ancillary reads or writes',t=>{
  const db=hybridScene(t)
  saveRefusals(db,[{tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',volumeInputs:refusalInputs()}])
  const run=hybridRun(db,'once')
  assert.equal(typeof run.stop,'function')
  assert.equal(startTargetedEvidenceReadout(db,run.options),null)
  assert.equal(run.callbacks.length,1)
  const changes=db.prepare('SELECT total_changes() n').get().n,reads=[]
  const prepare=db.prepare.bind(db)
  db.prepare=sql=>{
    const statement=prepare(sql),get=statement.get.bind(statement)
    statement.get=(...args)=>{reads.push({sql,args});return get(...args)}
    return statement
  }
  db.pragma('query_only=ON');run.callbacks[0]();run.callbacks[0]();db.prepare=prepare
  assert.equal(db.prepare('SELECT total_changes() n').get().n,changes)
  assert.deepEqual(run.logs.map(row=>row.kind),['scheduled','summary','stored-verdict','stored-verdict','hybrid-refusal','exit'])
  const refusal=run.logs.find(row=>row.kind==='hybrid-refusal').value
  assert.deepEqual(refusal.owner,{tradeId:1,accountId:'42',positionId:'33'})
  assert.equal(refusal.inputStatus,'stored_owned_observation')
  assert.equal(refusal.inputs.volume,300);assert.equal(refusal.inputs.halfVolume,150)
  assert.equal(refusal.inputs.reconcileReceivedAtMs,NOW-5)
  assert.deepEqual(refusal.invalidFields,[])
  assert.equal(run.logs.at(-1).value.done,true);assert.equal(run.logs.at(-1).value.dropped,0)
  assert.deepEqual(reads.filter(row=>row.sql.includes('FROM agent_state')).map(row=>row.args[0]),
    ['momentum_partial_pass_json','hybrid_tick_controller_json','momentum_partial_pass_json'])
  assert.equal(reads.filter(row=>row.sql.includes('FROM trades')).length,1)
  assert.ok(reads.every(row=>/FROM (agent_state|trades)\b/.test(row.sql)))
})

test('hybrid refusal identities distinguish missing and conflicting owners without leaking foreign volume or arbitrary input fields',t=>{
  const db=hybridScene(t),secret='private-token-must-not-appear'
  const refusal=(extra={})=>({tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',...extra})
  saveRefusals(db,[
    refusal({positionId:'33'}),
    refusal({positionId:'33',volumeInputs:secret}),
    refusal({volumeInputs:refusalInputs({source:secret,units:secret,host:secret,side:secret,symbolId:secret,
      volume:secret,minVolumeValid:secret,accessToken:secret,nested:{secret}})}),
    refusal({volumeInputs:refusalInputs({accountId:'43',volume:987654321})}),
    refusal({positionId:'44',volumeInputs:refusalInputs({volume:987654322})}),
    refusal({tradeId:999,volumeInputs:refusalInputs({volume:987654323})}),
    refusal({accountId:null,volumeInputs:refusalInputs({volume:987654324})}),
    refusal({tradeId:3,volumeInputs:refusalInputs({volume:987654325})}),
    refusal({positionId:'33',volumeInputs:refusalInputs({accountId:null,volume:987654326})}),
    refusal({tradeId:2,volumeInputs:refusalInputs({volume:987654327})}),
    refusal({reason:`SQLITE_BUSY ${secret}`,positionId:'33'}),
  ])
  const run=hybridRun(db,'identity');db.pragma('query_only=ON');run.callbacks[0]()
  const rows=run.logs.filter(row=>row.kind==='hybrid-refusal').map(row=>row.value)
  assert.equal(rows[0].inputStatus,'not_recorded');assert.equal(rows[0].ownerStatus,'stored_owned_position')
  assert.equal(rows[1].inputStatus,'malformed');assert.equal(rows[1].inputs,null)
  assert.equal(rows[2].inputStatus,'stored_owned_observation');assert.equal(rows[2].inputs.volume,null)
  assert.deepEqual(rows[2].invalidFields,['source','units','host','symbolId','side','volume','minVolumeValid'])
  assert.equal(rows[3].inputStatus,'identity_conflict');assert.equal(rows[3].inputs,null)
  assert.equal(rows[4].ownerStatus,'identity_conflict');assert.equal(rows[4].owner,null)
  assert.equal(rows[5].ownerStatus,'trade_missing')
  assert.equal(rows[6].ownerStatus,'refusal_identity_missing_or_invalid')
  assert.equal(rows[7].ownerStatus,'owner_identity_missing_or_invalid')
  assert.equal(rows[8].inputStatus,'identity_missing_or_invalid')
  assert.equal(rows[9].ownerStatus,'identity_conflict')
  assert.equal(rows[10].reason,'SQLITE_BUSY')
  assert.doesNotMatch(JSON.stringify(run.logs),/private-token-must-not-appear|98765432[1-7]|accessToken|nested/)
  assert.equal(run.logs.at(-1).value.done,true)
})

test('hybrid verdict absence and malformed stored inputs remain explicit, and empty refusals need no owner table',t=>{
  const db=hybridScene(t)
  db.exec('DROP TABLE trades')
  let run=hybridRun(db,'absent');run.callbacks[0]()
  assert.deepEqual(run.logs.filter(row=>row.kind==='stored-verdict').map(row=>row.value.reason),['missing','missing'])
  assert.equal(run.logs.find(row=>row.kind==='summary').value.refusals.status,'unavailable')
  saveRefusals(db,[])
  run=hybridRun(db,'empty');run.callbacks[0]()
  assert.equal(run.logs.find(row=>row.kind==='summary').value.refusals.total,0)
  assert.equal(run.logs.at(-1).value.done,true)
  setState(db,'momentum_partial_pass_json','{')
  run=hybridRun(db,'invalid-json');run.callbacks[0]()
  assert.equal(run.logs.find(row=>row.kind==='stored-verdict').value.reason,'invalid_json')
  setState(db,'momentum_partial_pass_json',JSON.stringify({cappedHybrid:{deferred:'malformed-private-data'}}))
  run=hybridRun(db,'invalid-list');run.callbacks[0]()
  assert.equal(run.logs.find(row=>row.kind==='summary').value.refusals.status,'unavailable')
  setState(db,'momentum_partial_pass_json',JSON.stringify({cappedHybrid:{deferred:[null]}}))
  run=hybridRun(db,'null-row');run.callbacks[0]()
  assert.equal(run.logs.at(-1).value.done,false);assert.equal(run.logs.at(-1).value.reason,'stored_read_failed')
  assert.doesNotMatch(JSON.stringify(run.logs),/TypeError|Cannot read|malformed-private-data/)
})

test('invalid hybrid controls fail before claiming and expiry prevents every stored read',t=>{
  const db=hybridScene(t)
  for(const extra of [{OWNED_EVIDENCE_SCOPE:''},{OWNED_EVIDENCE_SCOPE:'HYBRID'},{OWNED_EVIDENCE_SCOPE:'other'},
    {OWNED_EVIDENCE_SCANNER:'1'},{OWNED_EVIDENCE_TRADE_IDS:'1'}]){
    const base={OWNED_EVIDENCE_SCOPE:'hybrid',OWNED_EVIDENCE_RUN_ID:'hybrid-invalid-mode',
      OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()}
    const run=hybridRun(db,'invalid',{env:{...base,...extra}})
    assert.equal(run.stop,null);assert.equal(run.callbacks.length,0);assert.equal(run.logs.length,0)
  }
  assert.equal(db.prepare('SELECT count(*) n FROM agent_state').get().n,0)
  let now=NOW
  const run=hybridRun(db,'expired',{now:()=>now})
  now=NOW+600001
  db.exec('DROP TABLE agent_state;DROP TABLE trades')
  run.callbacks[0]();run.callbacks[0]()
  assert.equal(run.logs.length,2);assert.equal(run.logs.at(-1).value.reason,'deadline_expired')
})

test('hybrid snapshot keeps verdict and refusal owner consistent across a real concurrent WAL commit',t=>{
  const db=hybridScene(t,join(tempDir('hybrid-read-snapshot-'),'ledger.db'))
  saveRefusals(db,[{tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',volumeInputs:refusalInputs()}])
  const peer=new Database(db.name);t.after(()=>peer.close())
  const run=hybridRun(db,'snapshot'),prepare=db.prepare.bind(db)
  let changed=false
  db.prepare=sql=>{
    const statement=prepare(sql),get=statement.get.bind(statement)
    statement.get=(...args)=>{
      const result=get(...args)
      if(!changed&&args[0]==='momentum_partial_pass_json'){
        changed=true
        peer.transaction(()=>{
          peer.exec("UPDATE trades SET ctrader_position_id='44' WHERE id=1")
          saveRefusals(peer,[])
          setState(peer,'hybrid_tick_controller_json',JSON.stringify({at:NOW+100,hosts:{}}))
        })()
      }
      return result
    }
    return statement
  }
  db.pragma('query_only=ON');run.callbacks[0]();db.prepare=prepare
  assert.equal(changed,true)
  assert.equal(run.logs.find(row=>row.kind==='hybrid-refusal').value.owner.positionId,'33')
  assert.equal(run.logs.find(row=>row.kind==='stored-verdict'&&row.value.key==='hybrid_tick_controller_json').value.at,NOW)
  assert.equal(JSON.parse(db.prepare("SELECT value FROM agent_state WHERE key='hybrid_tick_controller_json'").get().value).at,NOW+100)
  assert.equal(db.prepare('SELECT ctrader_position_id FROM trades WHERE id=1').get().ctrader_position_id,'44')
  assert.equal(run.logs.at(-1).value.done,true)
})

test('hybrid refusal joins are capped and an oversized required verdict cannot claim complete output',t=>{
  const db=hybridScene(t)
  saveRefusals(db,Array.from({length:70},()=>({tradeId:1,accountId:'42',reason:'half_and_runner_not_representable',volumeInputs:refusalInputs()})))
  const run=hybridRun(db,'bounds');run.callbacks[0]()
  assert.equal(run.logs.filter(row=>row.kind==='hybrid-refusal').length,64)
  const bounds=run.logs.find(row=>row.kind==='summary').value.refusals
  assert.equal(bounds.total,70);assert.equal(bounds.truncated,true)
  assert.equal(run.logs.at(-1).value.done,true)
  const row={accountId:'42',tradeId:1,positionId:'33',monitorId:1,stage:'ownership',observedAtMs:NOW,reason:'strategy_not_momentum'}
  setState(db,'momentum_partial_pass_json',JSON.stringify({cappedHybrid:{deferred:[],excluded:Array(64).fill(row),delegated:Array(64).fill(row)}}))
  const oversized=hybridRun(db,'output-cap');oversized.callbacks[0]()
  assert.equal(oversized.logs.at(-1).value.done,false)
  assert.equal(oversized.logs.at(-1).value.reason,'output_incomplete')
  assert.ok(oversized.logs.at(-1).value.dropped>0)
  assert.ok(oversized.logs.every(row=>Buffer.byteLength(JSON.stringify(row))<=16000))
  assert.ok(oversized.logs.reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row)),0)<=256*1024)
})
