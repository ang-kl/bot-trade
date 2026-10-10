// Codex · №12,944 · 2026-10-10; codex-footprint: stored-lifecycle-projection.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initDB } from '../db.js'
import { readLifecycleEvidence, LIFECYCLE_READ_LIMITS as LIMIT } from './lifecycle-evidence-readout.js'
const NOW=1791580000000
function fixture(t) {
  const db=initDB(':memory:');t.after(()=>db.close())
  db.prepare("INSERT INTO trades(id,symbol,side,status,account_id,ctrader_position_id,volume,requested_volume) VALUES(1,'EURUSD','BUY','closed','42','33',0.1,0.14),(2,'EURUSD','BUY','closed','43','33',0.2,0.2)").run()
  db.exec(`CREATE TABLE general_partial_attempts(id INTEGER PRIMARY KEY,account_id TEXT,position_id TEXT,trade_id INTEGER,
    monitor_id INTEGER,state TEXT,attempted_at INTEGER,plan_json TEXT,raw_json TEXT,receipt_json TEXT,residual_json TEXT,
    reason TEXT,confirmed_at INTEGER,checked_at INTEGER)`)
  const identity={provider:'ctrader',host:'demo.ctraderapi.com',accountId:'42',symbolId:'9'}
  const receipt={...identity,positionId:'33',dealId:'7',orderId:'70',closedVolume:1000,price:2,executedAtMs:NOW}
  const residual={...identity,positionId:'33',volume:1000,side:'BUY',entry:1,source:'broker_reconcile',absent:false,observedAtMs:NOW}
  const plan={accountId:'42',positionId:'33',tradeId:1,monitorId:1,symbol:'EURUSD',side:'BUY',host:identity.host,
    identity,requested:1000,lotSize:10000,digits:5,before:{...residual,volume:2000},source:'position_manager'}
  const raw={ctidTraderAccountId:42,executionType:3,accessToken:'must-not-leak',deal:{dealId:'7',orderId:'70',positionId:'33',symbolId:9,
    tradeSide:2,dealStatus:2,volume:1000,filledVolume:1000,executionPrice:2,executionTimestamp:NOW,
    closePositionDetail:{entryPrice:1,closedVolume:1000,moneyDigits:2,grossProfit:1000,commission:-100,swap:200,secret:'must-not-leak'}}}
  db.prepare("INSERT INTO general_partial_attempts VALUES(1,'42','33',1,1,'CONFIRMED',?,?,?,?,?,NULL,?,?)")
    .run(NOW,JSON.stringify(plan),JSON.stringify(raw),JSON.stringify(receipt),JSON.stringify(residual),NOW,NOW)
  db.prepare("INSERT INTO broker_deals(deal_id,account_id,position_id,symbol,side,lots,requested_lots,volume_contract,gross_pnl,commission,swap,net_pnl,matched_trade_id) VALUES('7','42','33','EURUSD','BUY',0.1,0.14,1,10,-1,2,11,1),('8','43','33','EURUSD','BUY',0.2,0.2,1,20,-2,0,18,2)").run()
  db.prepare("INSERT INTO position_lifecycle_evidence(account_id,position_id,host,verdict,final,rules,read_at,broker_net,broker_gross,broker_commission,broker_swap,conversion_fee,ledger_rows,trade_ids) VALUES('42','33',?,'agrees',1,1,?,11,10,-1,2,0,?,?)")
    .run(identity.host,new Date(NOW).toISOString(),JSON.stringify([{id:1,status:'closed',net:11,secret:'must-not-leak'}]),JSON.stringify([1]))
  const expected={accountId:'42',positionId:'33',dealId:'7',orderId:'70',symbolId:'9',tradeSide:2,filledVolume:1000,executionPrice:2,executionTimestamp:NOW,entryPrice:1,secret:'must-not-leak'}
  db.prepare("INSERT INTO broker_close_attribution(account_id,deal_id,position_id,order_id,execution_at,expected_json,next_attempt_at,state,evidence_json) VALUES('42','7','33','70',?,?,?,'verified',?)")
    .run(NOW,JSON.stringify(expected),NOW,JSON.stringify({...expected,orderType:1,orderStatus:2,cause:'market',confidence:'order_confirmed_initiator_unknown'}))
  db.prepare("INSERT INTO position_events(account_id,position_id,trade_id,symbol,kind,to_value,source,detail_json) VALUES('42','33',1,'EURUSD','scale_out',1000,'position_manager',?),('42','33',1,'EURUSD','close',NULL,'reconciler','{}'),('43','33',1,'EURUSD','scale_out',999,'foreign','{}')")
    .run(JSON.stringify({attemptId:1,requestedVolume:1000,receipt,residual,secret:'must-not-leak'}))
  return {db,plan,receipt,residual,raw,expected}
}
const values=(out,kind)=>out.records.filter(r=>r.kind===kind).map(r=>r.value)
test('exact stored deal and closed-trade targets expose signed money and partial bridge without writing or mixing the same position on another account',t=>{
  const {db}=fixture(t),before=db.prepare('SELECT total_changes() n').get().n
  const out=readLifecycleEvidence(db,{tradeIds:[1],dealIds:['7'],now:NOW})
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before)
  assert.equal(out.summary.brokerRequests,0);assert.equal(out.summary.financialCertification,false)
  assert.deepEqual(values(out,'lifecycle-deal-target')[0].target,{accountId:'42',positionId:'33'})
  const deal=values(out,'closing-deal')[0]
  assert.equal(deal.row.net_pnl,11);assert.equal(deal.row.commission,-1);assert.equal(deal.row.swap,2)
  assert.equal(deal.row.lots,0.1);assert.equal(deal.row.requested_lots,0.14)
  assert.equal(deal.quantityMeaning,'executed_lots')
  assert.equal(values(out,'closing-deal').length,1)
  const partial=values(out,'general-partial')[0]
  assert.equal(partial.receipt.dealId,'7');assert.equal(partial.residual.volume,1000)
  assert.equal(partial.raw.deal.closePositionDetail.closedVolume,1000)
  assert.equal(values(out,'closing-attribution')[0].expected.filledVolume,1000)
  assert.match(values(out,'closing-attribution')[0].actorMeaning,/does_not_prove/)
  const journal=values(out,'lifecycle-journal').find(v=>v.row.kind==='scale_out')
  assert.equal(journal.detail.receipt.dealId,'7');assert.equal(journal.detail.residual.volume,1000)
  assert.equal(out.summary.identityConflicts,1)
  assert.equal(values(out,'lifecycle-journal').filter(v=>v.row.kind==='close').length,1)
  assert.equal(values(out,'lifecycle-owner')[0].entryReleaseStamp,'not_recorded_in_trade_schema')
  assert.ok(!JSON.stringify(out).includes('must-not-leak'))
})
test('nested foreign account, position, symbol and closing identity refuse their projected bridge',t=>{
  const {db,receipt,expected}=fixture(t)
  db.prepare('UPDATE general_partial_attempts SET receipt_json=?,residual_json=? WHERE id=1')
    .run(JSON.stringify({...receipt,accountId:'43'}),JSON.stringify({...receipt,symbolId:'99'}))
  db.prepare('UPDATE broker_close_attribution SET expected_json=?').run(JSON.stringify({...expected,dealId:'99'}))
  const out=readLifecycleEvidence(db,{tradeIds:[1],now:NOW}),partial=values(out,'general-partial')[0]
  assert.equal(partial.receiptStatus,'identity_conflict');assert.equal(partial.receipt,null)
  assert.equal(partial.residualStatus,'identity_conflict');assert.equal(partial.residual,null)
  assert.equal(values(out,'closing-attribution')[0].expectedStatus,'identity_conflict')
  assert.equal(values(out,'closing-attribution')[0].expected,null)
  assert.equal(out.summary.identityConflicts,4)
})
test('same-position foreign journal host, symbol or side and contradictory enclosing order are explicit conflicts',t=>{
  const {db,receipt,residual,raw}=fixture(t)
  db.prepare('UPDATE general_partial_attempts SET raw_json=? WHERE id=1')
    .run(JSON.stringify({...raw,order:{positionId:'33',orderId:'99'}}))
  const update=db.prepare("UPDATE position_events SET detail_json=? WHERE account_id='42' AND kind='scale_out'")
  for(const patch of [{symbolId:'99'},{host:'live.ctraderapi.com'},{side:'SELL'}]){
    update.run(JSON.stringify({attemptId:1,receipt:{...receipt,...patch},residual:{...residual,...patch}}))
    const out=readLifecycleEvidence(db,{tradeIds:[1],now:NOW})
    const partial=values(out,'general-partial')[0],journal=values(out,'lifecycle-journal').find(v=>v.row.kind==='scale_out')
    assert.equal(partial.rawStatus,'identity_conflict');assert.equal(partial.raw,null)
    assert.equal(journal.detail.receiptStatus,'identity_conflict');assert.equal(journal.detail.receipt,null)
    assert.equal(journal.detail.residualStatus,'identity_conflict');assert.equal(journal.detail.residual,null)
    assert.equal(out.summary.identityConflicts,4);assert.equal(out.summary.status,'incomplete')
  }
})
test('a journal without its bounded retained attempt leaves its nested bridge unverified',t=>{
  const {db,receipt,residual}=fixture(t)
  db.prepare("UPDATE position_events SET detail_json=? WHERE account_id='42' AND kind='scale_out'")
    .run(JSON.stringify({attemptId:999,receipt,residual}))
  const out=readLifecycleEvidence(db,{tradeIds:[1],now:NOW})
  const journal=values(out,'lifecycle-journal').find(v=>v.row.kind==='scale_out')
  assert.equal(journal.detail.receiptStatus,'attempt_basis_not_retained');assert.equal(journal.detail.receipt,null)
  assert.equal(journal.detail.residualStatus,'attempt_basis_not_retained');assert.equal(journal.detail.residual,null)
})
test('missing targets, retained unverified lots, oversized JSON and absent tables stay explicit',t=>{
  const {db}=fixture(t)
  db.prepare('UPDATE general_partial_attempts SET plan_json=?').run(JSON.stringify({secret:'must-not-leak'.repeat(2000)}))
  db.prepare('UPDATE broker_deals SET volume_contract=NULL WHERE deal_id=?').run('7')
  const out=readLifecycleEvidence(db,{tradeIds:[1,999],dealIds:['7','999'],now:NOW})
  assert.equal(values(out,'lifecycle-target').find(v=>v.tradeId===999).status,'trade_missing')
  assert.equal(values(out,'lifecycle-deal-target').find(v=>v.dealId==='999').status,'deal_missing')
  assert.equal(values(out,'general-partial')[0].planStatus,'not_recorded_or_oversized')
  assert.equal(values(out,'closing-deal')[0].quantityMeaning,'unverified_retained_lots')
  assert.ok(!JSON.stringify(out).includes('must-not-leak'))
  const empty=new Database(':memory:');t.after(()=>empty.close())
  assert.equal(values(readLifecycleEvidence(empty,{tradeIds:[1]}),'lifecycle-target')[0].status,'missing_table')
})
test('caps refuse arbitrary selectors and disclose truncated indexed position and event ranges',t=>{
  const {db}=fixture(t)
  assert.throws(()=>readLifecycleEvidence(db,{tradeIds:Array(9).fill(1)}),/invalid_lifecycle_targets/)
  assert.throws(()=>readLifecycleEvidence(db,{dealIds:Array(65).fill('7')}),/invalid_lifecycle_targets/)
  assert.throws(()=>readLifecycleEvidence(db,{dealIds:['7); DELETE FROM trades;']}),/invalid_lifecycle_targets/)
  const put=db.prepare("INSERT INTO broker_deals(deal_id,account_id,position_id) VALUES(?,'42','33')")
  for(let n=10;n<20;n++)put.run(String(n))
  const out=readLifecycleEvidence(db,{dealIds:['7'],now:NOW})
  assert.equal(values(out,'closing-deal').length,LIMIT.dealsPerPosition)
  assert.equal(values(out,'lifecycle-range').find(v=>v.kind==='closing-deal').truncated,true)
  assert.ok(out.summary.truncatedRanges>0);assert.equal(out.summary.status,'incomplete')
  const prepare=db.prepare.bind(db),plans=[]
  db.prepare=sql=>{
    if(sql.includes('FROM broker_deals WHERE account_id=?'))plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all('42','33',9))
    if(sql.includes('FROM position_events WHERE trade_id=?'))plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(1,'scale_out',9))
    return prepare(sql)
  }
  readLifecycleEvidence(db,{tradeIds:[1],now:NOW});db.prepare=prepare
  assert.ok(plans.some(p=>p.some(r=>/SEARCH broker_deals USING INDEX idx_broker_deals_position/.test(r.detail))))
  assert.ok(plans.some(p=>p.some(r=>/SEARCH position_events USING INDEX idx_position_events_trade_kind/.test(r.detail))))
})
test('the maximum explicit financial deal population has a finite byte cap with omissions disclosed',t=>{
  const {db}=fixture(t),targets=[]
  const trade=db.prepare("INSERT INTO trades(id,symbol,side,status,account_id,ctrader_position_id) VALUES(?,'EURUSD','BUY','closed','42',?)")
  const deal=db.prepare("INSERT INTO broker_deals(deal_id,account_id,position_id,symbol) VALUES(?,'42',?,'EURUSD')")
  const event=db.prepare("INSERT INTO position_events(account_id,position_id,trade_id,symbol,kind,source,detail_json) VALUES('42',?,?,'EURUSD','close',?,'{}')")
  for(let id=10;id<74;id++){
    const position=String(10000+id),did=String(20000+id);trade.run(id,position);deal.run(did,position);targets.push(did)
    for(let n=0;n<8;n++)event.run(position,id,'x'.repeat(100))
  }
  const out=readLifecycleEvidence(db,{dealIds:targets,now:NOW})
  assert.equal(out.summary.positions,64)
  assert.ok(out.summary.bytes<=LIMIT.outputBytes)
  assert.ok(Buffer.byteLength(JSON.stringify(out))<=LIMIT.outputBytes)
  assert.ok(out.records.every(r=>Buffer.byteLength(JSON.stringify(r))<=LIMIT.jsonBytes))
  assert.ok(out.summary.omittedRecords>0)
  assert.equal(out.summary.status,'incomplete')
})
