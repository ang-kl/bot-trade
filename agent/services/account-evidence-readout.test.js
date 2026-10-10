// Codex · №12,944 · 2026-10-10; codex-footprint: bounded-account-evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import stateRouter from '../routes/state.js'
import { recordDepositCurrency, recordAccountMoney } from './account-money.js'
import { readAccountEvidence, ACCOUNT_EVIDENCE_LIMITS } from './account-evidence-readout.js'
import { invalidateStateCache } from '../lib/state-cache.js'

const demo='43097342', live='42993489', orderAccount='47790949'
function fixture(t) { const db=initDB(':memory:'); t.after(()=>db.close()); return db }
function account(db,id,currency,balance,nowMs=Date.now()) {
  const isLive=id===live,host=isLive?'live.ctraderapi.com':'demo.ctraderapi.com'
  db.prepare("INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(id,+isLive)
  setState(db,`acct:${id}:account_balance_usd`,String(balance))
  setState(db,`acct:${id}:risk_config_json`,JSON.stringify({dailyLossFloorUsd:400,dailyLossLimit:150,dailyLossPct:0.02,dailyLossTierAtUsd:10000,dailyLossTierSmallPct:0.03,dailyLossTierLargePct:0.04}))
  recordDepositCurrency(db,{accountId:id,host,depositAssetId:'1',currency,receivedAt:nowMs})
  recordAccountMoney(db,{accountId:id,host,trader:{ctidTraderAccountId:id,depositAssetId:'1'},balance,receivedAt:nowMs})
  setState(db,`acct:${id}:broker_snapshot_cache_json`,JSON.stringify({fetchedAt:new Date(nowMs).toISOString(),account:{accountId:id,currency,host,health:{balance,usedMargin:10,freeMargin:balance-10,equity:balance},positions:[]}}))
}
function state(db) { return ['agent_state','accounts','trades','broker_orders','pending_orders','risk_events','entry_intents'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) }
function values(result) { return result.records.filter(r=>r.kind==='account-evidence').map(r=>r.value) }
function route(db,path,query={}) {
  const handler=stateRouter(db).stack.find(layer=>layer.route?.path===path).route.stack[0].handle
  return new Promise((resolve,reject)=>{
    const res={json:resolve,status(code){if(code!==200)reject(Error(`route status ${code}`));return this}}
    Promise.resolve(handler({query},res)).catch(reject)
  })
}

test('bounded account read shares actual risk/config route pacing, native units and engine floor without writes',async t=>{
  const db=fixture(t),now=Date.now()-100
  account(db,demo,'SGD',3000,now);account(db,live,'SGD',50,now)
  setState(db,'fx_rates_json',JSON.stringify({USDSGD:{p:1.25,t:now}}))
  setState(db,'autotrade_enabled','true')
  db.prepare("INSERT INTO trades(symbol,side,status,net_pnl,account_id,closed_at) VALUES ('EURUSD','BUY','closed',-125,?,datetime('now'))").run(demo)
  db.prepare('INSERT INTO risk_events(account_id,checks_json) VALUES (?,?)').run(demo,JSON.stringify({account_id:demo,daily_cap_usd:200,daily_pnl:-10,secret:'DO_NOT_EMIT'}))
  const before=state(db),result=readAccountEvidence(db,{accountIds:[demo,live]})
  invalidateStateCache()
  const r=await route(db,'/risk-full',{account:demo})
  const p=await route(db,'/config-proposals')
  const actual=values(result)[0]
  assert.equal(actual.money.observation.balance,3000)
  assert.equal(actual.money.observation.currency,'SGD')
  assert.equal(actual.currentRisk.balanceUsd,r.account.engineBalanceUsd)
  for(const key of ['capUsd','spentUsd','floorUsd','tierPct','binding']) {
    assert.equal(actual.currentRisk.dailyPacing[key],r.dailyPacing[key])
    assert.equal(actual.currentRisk.dailyPacing[key],p.accounts.find(a=>a.accountId===demo).dailyPacing[key])
  }
  assert.equal(actual.currentRisk.dailyPacing.capUsd,400)
  assert.equal(actual.currentRisk.dailyPacing.spentUsd,100)
  assert.equal(actual.savedEngine.checks.daily_cap_usd,200,'older verdict is not overwritten or called current parity')
  assert.equal(actual.phases.effective.autotrade,true)
  assert.equal(actual.feasibility.status,'unverified')
  assert.equal(JSON.stringify(result).includes('DO_NOT_EMIT'),false)
  assert.deepEqual(state(db),before)
})

test('large closed population withholds current canonical scans and retains dated money, config and saved engine',t=>{
  const db=fixture(t);account(db,demo,'USD',3000)
  const insert=db.prepare("INSERT INTO trades(symbol,status,side,net_pnl,closed_at,account_id) VALUES ('EURUSD','closed','BUY',1,datetime('now'),?)")
  db.transaction(()=>{for(let i=0;i<=ACCOUNT_EVIDENCE_LIMITS.closedRiskRows;i++)insert.run(demo)})()
  let canonicalCalls=0
  const spy={prepare(sql){if(sql.includes('REPLACE(closed_at'))canonicalCalls++;return db.prepare(sql)},transaction:db.transaction.bind(db)}
  const before=state(db),r=readAccountEvidence(spy,{accountIds:[demo]}),a=values(r)[0]
  assert.equal(r.riskBound,false);assert.equal(canonicalCalls,0)
  assert.equal(a.currentRisk.reason,'canonical_risk_population_exceeds_read_bound')
  assert.equal(a.money.observation.balance,3000);assert.equal(a.riskConfig.dailyLossFloorUsd,400)
  assert.deepEqual(state(db),before)
})

test('owned pending projection keeps gone ambiguous, account joins, SL/TP and recorded policy separate',t=>{
  const db=fixture(t)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,order_type,volume,limit_price,tp,status,label,last_seen) VALUES ('100',?,'SpotCrude','BUY','LIMIT',400,68.548,100.759,'gone','manual',datetime('now'))").run(orderAccount)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,status) VALUES ('101',?,'SpotCrude','BUY','working')").run(demo)
  const risk=db.prepare('INSERT INTO risk_events(account_id,symbol,side,approved,checks_json) VALUES (?,\'SpotCrude\',\'BUY\',1,?)').run(orderAccount,JSON.stringify({entry:68.548,sl:60,tp:100.759,raw_token:'DO_NOT_EMIT'})).lastInsertRowid
  db.prepare("INSERT INTO pending_orders(account_id,order_id,symbol,dir,level,sl,tp,status,risk_event_id) VALUES (?,'100','SpotCrude',1,68.548,60,100.759,'filled',?)").run(orderAccount,risk)
  db.prepare("INSERT INTO pending_orders(account_id,order_id,symbol,dir,status,risk_event_id) VALUES (?,'100','SpotCrude',1,'working',?)").run(demo,risk)
  const before=state(db),r=readAccountEvidence(db,{pendingTarget:{accountId:orderAccount,symbol:'SpotCrude'}}),rows=r.records.filter(r=>r.kind==='pending-order-evidence').map(r=>r.value.row)
  assert.equal(rows.length,1);assert.equal(rows[0].sl,null);assert.equal(rows[0].tp,100.759)
  assert.equal(rows[0].statusMeaning,'no_longer_resting_filled_or_cancelled_unresolved')
  assert.equal(rows[0].pending.length,1);assert.equal(rows[0].pending[0].account_id,orderAccount)
  assert.equal(rows[0].recordedPolicy[0].checks.sl,60)
  assert.equal(JSON.stringify(r).includes('DO_NOT_EMIT'),false)
  assert.deepEqual(state(db),before)
})

test('bounded order window cannot certify an older target absent or read unrelated private notes',t=>{
  const db=fixture(t)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,status) VALUES ('1',?,'SpotCrude','working')").run(orderAccount)
  const insert=db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,status,label) VALUES (?,?,'OTHER','working','DO_NOT_EMIT')")
  db.transaction(()=>{for(let i=2;i<=ACCOUNT_EVIDENCE_LIMITS.brokerOrderWindow+2;i++)insert.run(String(i),demo)})()
  const r=readAccountEvidence(db,{pendingTarget:{accountId:orderAccount,symbol:'SpotCrude'}}),p=r.records[0].value
  assert.equal(p.brokerWindowTruncated,true);assert.equal(r.records.some(r=>r.kind==='pending-order-evidence'),false)
  assert.equal(p.reason,'target_not_in_bounded_stored_window')
  assert.equal(JSON.stringify(r).includes('DO_NOT_EMIT'),false)
})

test('explicit targets and byte ceilings reject malformed identity and do not treat missing money as zero',t=>{
  const db=fixture(t)
  assert.throws(()=>readAccountEvidence(db,{accountIds:['all']}),/invalid_account_targets/)
  assert.throws(()=>readAccountEvidence(db,{accountIds:Array(9).fill(demo)}),/invalid_account_targets/)
  assert.throws(()=>readAccountEvidence(db,{pendingTarget:{accountId:orderAccount,symbol:'SpotCrude',orderId:'x'}}),/invalid_pending_target/)
  account(db,demo,'USD',10)
  setState(db,`acct:${demo}:money_observation_json`,'x'.repeat(ACCOUNT_EVIDENCE_LIMITS.stateBytes+1))
  const r=readAccountEvidence(db,{accountIds:[demo]}),a=values(r)[0]
  assert.equal(a.money.observation,null);assert.equal(a.money.balanceUsd,null)
  assert.equal(r.refusals.includes('state_value_exceeds_byte_bound'),true)
  assert.equal(a.currentRisk.reason,'canonical_input_exceeds_byte_bound')
})

test('currency conflict, stale owned quantities and an unowned global volume map never certify exact-half feasibility',t=>{
  const db=fixture(t),now=Date.now()
  account(db,demo,'SGD',3000,now-3600000)
  setState(db,'lot_size_registry_json',JSON.stringify({BTCUSD:{lotSize:100,minVolume:1,stepVolume:1}}))
  setState(db,`acct:${demo}:broker_snapshot_cache_json`,JSON.stringify({fetchedAt:new Date(now-3600000).toISOString(),account:{accountId:demo,currency:'USD',positions:[{positionId:12,symbol:'BTCUSD',side:'BUY',rawVolume:2,lots:0.02,minLot:0.01,comment:'DO_NOT_EMIT'}]}}))
  const before=state(db),r=readAccountEvidence(db,{accountIds:[demo],nowMs:now}),a=values(r)[0],v=r.records.find(r=>r.kind==='account-volume-evidence').value
  assert.equal(a.currencyConflict,true)
  assert.equal(a.money.status,'stale');assert.equal(a.snapshot.status,'stale')
  assert.equal(a.snapshot.health,null)
  assert.equal(v.snapshotStatus,'stale');assert.equal(v.position.rawVolume,2)
  assert.equal(v.exactHalf,'unverified_step_and_lotSize_not_stored')
  assert.equal(a.feasibility.status,'unverified')
  assert.equal(JSON.stringify(r).includes('DO_NOT_EMIT'),false)
  assert.deepEqual(state(db),before)
})

test('saved engine nested foreign account is explicitly conflicted and its checks are withheld',t=>{
  const db=fixture(t);account(db,'42','USD',3000)
  db.prepare('INSERT INTO risk_events(account_id,checks_json) VALUES (?,?)').run('42',JSON.stringify({account_id:'43',daily_cap_usd:999}))
  const before=state(db),saved=values(readAccountEvidence(db,{accountIds:['42']}))[0].savedEngine
  assert.equal(saved.status,'identity_conflict');assert.equal(saved.reason,'nested_account_conflict')
  assert.equal(saved.account_id,'42');assert.equal(saved.checks,null)
  assert.deepEqual(state(db),before)
})

test('same account/order pending or intent with conflicting symbol/side cannot supply a recorded policy link',t=>{
  const db=fixture(t)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,status) VALUES ('100','42','SpotCrude','BUY','working')").run()
  const risk=db.prepare("INSERT INTO risk_events(account_id,symbol,side,approved,checks_json) VALUES ('42','SpotCrude','BUY',1,?)").run(JSON.stringify({account_id:'42',sl:60})).lastInsertRowid
  const pending=db.prepare("INSERT INTO pending_orders(account_id,order_id,symbol,dir,risk_event_id) VALUES ('42','100',?,?,?)")
  pending.run('EURUSD',-1,risk);pending.run('SpotCrude',-1,risk);pending.run('SpotCrude',2,risk)
  db.prepare(`INSERT INTO entry_intents(id,account_id,environment,symbol,side,producer_id,basis,mode_epoch,
    permit_id,permit_expires_at,state,broker_order_id,risk_event_id)
    VALUES ('iconflict','42','demo','SpotCrude','SELL','manual','manual',0,'pconflict',datetime('now'),'ACCEPTED','100',?)`).run(risk)
  const before=state(db),row=readAccountEvidence(db,{pendingTarget:{accountId:'42',symbol:'SpotCrude',orderId:'100'}}).records.find(r=>r.kind==='pending-order-evidence').value.row
  assert.deepEqual(row.pending.map(p=>p.identityReason).sort(),['side_conflict','side_unverified','symbol_conflict'].sort())
  assert.equal(row.pending.every(p=>p.identityStatus==='identity_conflict'),true)
  assert.equal(row.intents[0].identityStatus,'identity_conflict');assert.equal(row.intents[0].identityReason,'side_conflict')
  assert.equal(row.recordedPolicy.length,0);assert.equal(row.policyStatus,'recorded_policy_unavailable')
  assert.deepEqual(state(db),before)
})

test('owned order policy link cannot promote conflicting nested checks or proposal identity',t=>{
  const db=fixture(t)
  db.prepare("INSERT INTO broker_orders(order_id,account_id,symbol,side,status) VALUES ('100','42','SpotCrude','BUY','working')").run()
  const risk=db.prepare("INSERT INTO risk_events(account_id,symbol,side,approved,checks_json) VALUES ('42','SpotCrude','BUY',1,'{}')").run().lastInsertRowid
  db.prepare("INSERT INTO pending_orders(account_id,order_id,symbol,dir,risk_event_id) VALUES ('42','100','SpotCrude',1,?)").run(risk)
  const conflicts=[
    [{account_id:'43',sl:60},{symbol:'SpotCrude',side:'BUY'},'nested_account_conflict'],
    [{account_id:'42',sl:60},{symbol:'EURUSD',side:'BUY'},'nested_symbol_conflict'],
    [{account_id:'42',sl:60},{symbol:'SpotCrude',side:'SELL'},'nested_side_conflict'],
    [{account_id:'42',sl:60},{symbol:'SpotCrude',side:'BUY',orderId:'101'},'nested_order_conflict'],
  ]
  for(const [checks,proposal,reason] of conflicts){
    db.prepare('UPDATE risk_events SET checks_json=?,proposal_json=? WHERE id=?').run(JSON.stringify(checks),JSON.stringify(proposal),risk)
    const before=state(db),row=readAccountEvidence(db,{pendingTarget:{accountId:'42',symbol:'SpotCrude',orderId:'100'}}).records.find(r=>r.kind==='pending-order-evidence').value.row
    assert.equal(row.pending[0].identityStatus,'owned_order_candidate')
    assert.equal(row.recordedPolicy[0].status,'identity_conflict');assert.equal(row.recordedPolicy[0].reason,reason)
    assert.equal(row.recordedPolicy[0].checks,null);assert.equal(row.recordedPolicy[0].proposal,null)
    assert.deepEqual(state(db),before)
  }
})
