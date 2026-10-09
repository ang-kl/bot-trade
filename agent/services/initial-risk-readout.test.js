// Codex · №12,611 · 2026-10-09; codex-footprint: stored-initial-risk-evidence.
// Real SQLite and the existing private readout exercise stored joins end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { readStoredInitialRisk } from './initial-risk-readout.js'
import { readTargetedEvidence, startTargetedEvidenceReadout } from './targeted-evidence-readout.js'

const NOW=Date.parse('2026-10-09T10:00:00Z')
function scene(t) {
  const db=initDB(':memory:');t.after(()=>db.close())
  db.exec(`INSERT INTO trades(id,symbol,side,account_id,ctrader_position_id,status,origin,origin_source,source,entry_price,sl_price,broker_sl_initial,opened_at,intent_id)
    VALUES(1780,'NAS100','BUY','43097342','247698829','open','reconciler_adopted','write','external',20000,19990,19980,'2026-10-09 06:00:00','owned-intent'),
    (1781,'NAS100','BUY','42993489','247698829','open','manual_broker','write','manual',20000,19900,19900,'2026-10-09 06:00:00',NULL)`)
  const put=(id,account='43097342',position='247698829',extra={})=>db.prepare(`INSERT INTO entry_intents
    (id,account_id,environment,symbol,symbol_id,side,volume,sl,sl_units,producer_id,basis,mode_epoch,permit_id,permit_expires_at,state,broker_position_id,broker_order_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,account,'demo',extra.symbol||'NAS100',12,extra.side||'BUY',200,extra.sl??1000000,'relative_points',
      'manual_order','must-not-leak',1,id,'2026-10-09T10:00:00Z','FILLED',position,extra.order||'123','2026-10-09T05:59:59Z')
  put('owned-intent');put('foreign-intent','42993489','247698829',{sl:987654321})
  db.exec(`INSERT INTO trade_plans(trade_id,account_id,symbol,side,planned_entry,planned_sl,planned_tp,risk_dist,source,created_at)
    VALUES(1780,'43097342','NAS100','BUY',20000,19950,20150,50,'manual_order','2026-10-09T05:59:59Z');
    INSERT INTO position_events(trade_id,account_id,position_id,symbol,kind,from_value,to_value,source,detail_json)
    VALUES(1780,'43097342','247698829','NAS100','sl_moved',19950,19980,'manual','{"secret":"must-not-leak"}'),
    (1780,'42993489','247698829','NAS100','sl_moved',987654321,987654321,'manual','{}')`)
  return {db,put}
}

test('explicit stored target joins real account/position intent and plan without upgrading adopted stops or writing',t=>{
  const {db}=scene(t),before=db.prepare('SELECT total_changes() n').get().n
  db.pragma('query_only = ON')
  assert.ok(readTargetedEvidence(db,NOW).trades.every(row=>!Object.hasOwn(row,'initialRisk')))
  const read=readTargetedEvidence(db,NOW,[1780]),risk=read.trades.find(row=>row.owner.id===1780).initialRisk
  assert.equal(risk.status,'unverified');assert.equal(risk.intents.status,'owned_record_candidate')
  assert.equal(risk.intents.rows[0].sl,1000000);assert.equal(risk.intents.rows[0].sl_units,'relative_points')
  assert.equal(risk.intents.rows[0].broker_position_id,'247698829')
  assert.equal(risk.plan.row.planned_sl,19950);assert.equal(risk.plan.recordNature,'replaceable_plan_not_immutable_opening_proof')
  assert.equal(risk.observedStops.broker_sl_initial,19980);assert.equal(risk.observedStops.classification,'observed_not_original_proof')
  assert.equal(risk.chronology.openedAtMeaning,'local_adoption_time')
  assert.equal(risk.earliestEvents.rows.length,1);assert.equal(risk.earliestEvents.identityConflicts,1)
  assert.ok(!JSON.stringify(risk).includes('987654321'));assert.ok(!JSON.stringify(read).includes('must-not-leak'))
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before)
})

test('ambiguous or foreign linked identity is explicit and never discloses the foreign requested risk',t=>{
  const {db,put}=scene(t)
  put('second-owned');assert.equal(readStoredInitialRisk(db,1780).intents.status,'ambiguous')
  db.exec("UPDATE trades SET intent_id='foreign-intent' WHERE id=1780; UPDATE trade_plans SET account_id='42993489',planned_sl=987654321 WHERE trade_id=1780")
  let read=readStoredInitialRisk(db,1780)
  assert.equal(read.intents.status,'identity_conflict');assert.equal(read.intents.linkedStatus,'account_conflict')
  assert.equal(read.plan.status,'identity_conflict');assert.equal(read.plan.row,null)
  assert.ok(!JSON.stringify(read).includes('987654321'))
  db.exec("UPDATE trades SET intent_id='missing-intent' WHERE id=1780; DELETE FROM entry_intents WHERE account_id='43097342'")
  read=readStoredInitialRisk(db,1780)
  assert.equal(read.intents.linkedStatus,'linked_intent_missing');assert.equal(read.intents.status,'missing')
  assert.equal(readStoredInitialRisk(db,9999).reason,'trade_missing')
  assert.throws(()=>readStoredInitialRisk(db,'1780'),/invalid_target/)
})

test('bounded indexed sources and opt-in emitter preserve unavailable fields and a terminal receipt',t=>{
  const {db,put}=scene(t)
  db.transaction(()=>{for(let i=0;i<10;i++)put(`many-${i}`)})()
  db.exec("UPDATE entry_intents SET sl=NULL,sl_units=NULL WHERE id='owned-intent'")
  const prepare=db.prepare.bind(db),plans=[]
  db.prepare=sql=>{
    const stmt=prepare(sql)
    if(/FROM (trades WHERE id|entry_intents|trade_plans WHERE trade_id|position_events WHERE trade_id)/.test(sql)) {
      const get=stmt.get.bind(stmt),all=stmt.all.bind(stmt)
      stmt.get=(...args)=>{plans.push(...prepare('EXPLAIN QUERY PLAN '+sql).all(...args));return get(...args)}
      stmt.all=(...args)=>{plans.push(...prepare('EXPLAIN QUERY PLAN '+sql).all(...args));return all(...args)}
    }
    return stmt
  }
  const read=readStoredInitialRisk(db,1780);db.prepare=prepare
  assert.equal(read.intents.status,'truncated');assert.equal(read.intents.rows.length,4)
  assert.equal(read.intents.rows[0].sl,null);assert.equal(read.intents.rows[0].sl_units,null)
  assert.ok(plans.length>=5);assert.ok(plans.every(row=>/SEARCH /.test(row.detail)),JSON.stringify(plans))
  const lines=[];let callback
  startTargetedEvidenceReadout(db,{env:{OWNED_EVIDENCE_RUN_ID:'initial-risk-12611',OWNED_EVIDENCE_TRADE_IDS:'1780',
    OWNED_EVIDENCE_EXPIRES_AT:new Date(NOW+600000).toISOString()},now:()=>NOW,log:line=>lines.push(JSON.parse(line)),setTimer:cb=>{callback=cb},clearTimer:()=>{}})
  callback()
  const emitted=lines.filter(row=>row.kind==='initial-risk')
  assert.equal(emitted.length,1);assert.equal(emitted[0].value.tradeId,1780)
  assert.equal(lines.at(-1).kind,'exit');assert.equal(lines.at(-1).value.done,true);assert.equal(lines.at(-1).value.dropped,0)
})
