// Codex · №12,922 · 2026-10-10; codex-footprint: pre02-complete-population.
// Real file-backed reader, classifier, worker, schema migration and controller.
// The withdrawn full-index path is a negative control, never the baseline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { initDB, getState } from '../db.js'
import { tempDir } from '../test-support/temp-dir.js'
import { RULES, buildOrderLifecycle, SNAPSHOT_KEY } from './order-lifecycle.js'
import { readOrderLifecycle } from './performance-populations.js'
import { runOrderLifecyclePass } from './order-lifecycle-ticker.js'

const legacy = RULES.find(r => r.id === 'PRE-02').sql
const index = 'idx_refusal_scores_pre02_complete'
const nowMs = Date.parse('2026-10-10T00:00:00Z')
const low = '2026-09-10 00:00:00'
const options = { nowMs, sinceIso:'2026-09-11T00:00:00Z', account:'all' }
const rule = report => report.rules.find(r => r.id === 'PRE-02')
const plan = (db, sql, limit=17) => db.prepare('EXPLAIN QUERY PLAN '+sql).all(low,limit).map(r=>r.detail)
const originalRows = (db, limit) => db.prepare(legacy).all(low,limit)

function fixture(t, prefix) {
  const path=join(tempDir(prefix),'report.db'), handles=[]
  const open=()=>{const db=initDB(path);handles.push(db);return db}
  t.after(()=>{for(const db of handles) if(db.open) db.close()})
  return {path,open}
}
function seedCounterexample(db) {
  db.prepare('INSERT INTO accounts(account_id) VALUES (?)').run('99001')
  db.prepare('INSERT INTO accounts(account_id) VALUES (?)').run('99002')
  const insert=db.prepare(`INSERT INTO refusal_scores(opportunity_key,account_id,symbol,reason,scored_at,outcome)
    VALUES(?,?,?,?,?,?)`)
  db.transaction(()=>{
    for(let i=0;i<10000;i++) insert.run(`synthetic-${String(10000-i).padStart(6,'0')}`,
      ['99001','99002',null][i%3],`SYNTHETIC-${i%7}`,'r'.repeat(1024),
      i%100===0?'2026-08-01T00:00:00Z':`2026-10-0${9-i%5}T12:00:00Z`,['no_bars','unscorable','stop'][i%3])
  })()
}
function observeReads(db) {
  const prepare=db.prepare.bind(db), reads=[]
  db.prepare=sql=>{
    const stmt=prepare(sql)
    if(sql.includes('FROM refusal_scores') && /^SELECT/.test(sql.trim())) {
      const all=stmt.all.bind(stmt), get=stmt.get.bind(stmt)
      stmt.all=(...args)=>{const rows=all(...args);reads.push({sql,op:'all',args,rows});return rows}
      stmt.get=(...args)=>{const row=get(...args);reads.push({sql,op:'get',args,row});return row}
    }
    return stmt
  }
  return {reads,restore:()=>{delete db.prepare}}
}

for(const analysed of [false,true]) test(`PRE-02 real report preserves capped and complete populations with ${analysed?'analysed table-scan':'unanalysed indexed'} plans`,async t=>{
  const {open}=fixture(t,'pre02-parity-')
  let db=open();seedCounterexample(db);db.exec(`DROP INDEX ${index}`)
  if(analysed) db.exec('ANALYZE')
  db.close();db=open();db.exec(`DROP INDEX ${index}`);db.close();db=open()
  // initDB recreates the opt-in index. Remove it on the already-open handle
  // without changing statistics to collect the original SQL oracle.
  db.exec(`DROP INDEX ${index}`)
  const originalPlan=plan(db,legacy)
  assert.ok(originalPlan.some(x=>analysed?x==='SCAN refusal_scores':x.includes('USING INDEX idx_refusal_scores_scored')))
  const cases=[
    {populationLimit:1},{populationLimit:17},{populationLimit:17,account:'99001'},
    {populationLimit:17,account:'99002'},{populationLimit:9900},{populationLimit:9901},
    {populationLimit:200000},{populationLimit:200000,account:'99001'},
    {populationLimit:200000,account:'99002'}, {populationLimit:17,limit:0},
    {populationLimit:200000,account:'99001',rule:'PRE-02',limit:7,offset:3},
    {populationLimit:17,sinceIso:'2026-10-08T00:00:00Z'},
  ]
  const before=cases.map(c=>buildOrderLifecycle(db,{...options,...c}))
  const cappedRows=originalRows(db,17), retained=db.prepare('SELECT * FROM refusal_scores ORDER BY rowid').all()
  assert.equal(rule(before[1]).violations,analysed?11:17,'retained statistics-sensitive counterexample')
  assert.deepEqual(await readOrderLifecycle(db,{...options,populationLimit:17}),before[1])
  db.close();db=open()
  assert.deepEqual(plan(db,legacy),originalPlan,'original SQL remains ineligible for the opt-in index')
  assert.deepEqual(db.prepare('SELECT * FROM refusal_scores ORDER BY rowid').all(),retained,'index migration cannot rewrite report inputs')
  const observation=observeReads(db)
  for(let i=0;i<cases.length;i++) {
    const next=buildOrderLifecycle(db,{...options,...cases[i]})
    assert.deepEqual(next,before[i],`all fields, samples, scope, NULL attribution, verdicts: ${JSON.stringify(cases[i])}`)
  }
  observation.restore()
  const capped=observation.reads.filter(r=>r.op==='all' && r.sql===legacy && r.args.at(-1)===17)
  assert.ok(capped.length>0)
  assert.deepEqual(capped[0].rows,cappedRows,'exact capped membership AND ordering remain unchanged')
  const covering=observation.reads.find(r=>r.op==='all' && r.sql.includes(`INDEXED BY ${index}`))
  assert.ok(covering,'complete population must use the optimisation')
  assert.ok(plan(db,covering.sql,200000).some(x=>x.includes(`USING COVERING INDEX ${index}`)))
  const opcodes=db.prepare('EXPLAIN '+covering.sql).all(low,200000)
  const root=db.prepare("SELECT rootpage FROM sqlite_master WHERE type='table' AND name='refusal_scores'").get().rootpage
  assert.ok(!opcodes.some(r=>r.opcode==='OpenRead' && r.p2===root),'complete read removes the wide table cursor')
  assert.deepEqual(await readOrderLifecycle(db,{...options,populationLimit:17}),before[1],'actual worker preserves capped output')
  // Fresh handle avoids sharing the still-settling previous worker promise.
  const workerDb=open()
  assert.deepEqual(await readOrderLifecycle(workerDb,{...options,populationLimit:200000}),before[6],'actual worker preserves complete output')
  if(analysed) {
    db.exec('ANALYZE');db.close();db=open()
    assert.deepEqual(plan(db,legacy),originalPlan,'ANALYZE plus reopen cannot opt the legacy SQL into the new index')
    assert.deepEqual(buildOrderLifecycle(db,{...options,populationLimit:17}),before[1])
    // Repeat the rejected full-index approach only as a failing comparison.
    db.exec('CREATE INDEX idx_refusal_scores_lifecycle ON refusal_scores(scored_at,outcome,account_id,opportunity_key,symbol)')
    const rejected=legacy.replace('FROM refusal_scores','FROM refusal_scores INDEXED BY idx_refusal_scores_lifecycle')
      .replace('LIMIT ?','ORDER BY scored_at,outcome,account_id,rowid LIMIT ?')
    const prepare=db.prepare.bind(db)
    db.prepare=sql=>prepare(sql===legacy?rejected:sql)
    const negative=buildOrderLifecycle(db,{...options,populationLimit:17})
    delete db.prepare
    assert.equal(rule(negative).violations,17,'withdrawn candidate still changes 11 to 17')
    assert.notDeepEqual(negative,before[1])
  }
})

test('PRE-02 complete read retains NULL outcomes, unknown dates/accounts, empty populations and original unreadable errors',t=>{
  const {open}=fixture(t,'pre02-null-');const db=open()
  const insert=db.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  const values=[
    ['null-score',null,'NULL-SCORE',null,'no_bars'],['null-outcome','99001','NULL-OUTCOME','2026-10-09T12:00:00Z',null],
    ['unattributed',null,'NULL-ACCOUNT','2026-10-09T12:00:00Z','unscorable'],
    ['blank-account',' ','BLANK-ACCOUNT','2026-10-09T12:00:00Z','no_bars'],
    ['bad-time','99001','BAD-TIME','not-a-time','no_bars'],
    ['unknown-outcome','99002','UNKNOWN','2026-10-09T12:00:00Z','fetch_failed'],
    ['scored','99001','SCORED','2026-10-09T12:00:00Z','target'],
  ]
  db.transaction(()=>{for(const row of values) insert.run(...row)})()
  db.exec(`DROP INDEX ${index}`)
  const cases=[{}, {account:'99001'}, {account:'99002'}, {account:'not-recorded'}, {sinceIso:'2026-10-10T00:00:00Z'}]
  const before=cases.map(c=>buildOrderLifecycle(db,{...options,...c}))
  const restored=open()
  for(let i=0;i<cases.length;i++) assert.deepEqual(buildOrderLifecycle(restored,{...options,...cases[i]}),before[i])
  restored.exec('ALTER TABLE refusal_scores RENAME COLUMN outcome TO old_outcome')
  const broken=buildOrderLifecycle(restored,options)
  assert.equal(rule(broken).measurable,false)
  assert.match(rule(broken).reason,/no such column: outcome/)
  assert.ok(broken.summary.pre_order.unreadable.some(r=>r.id==='PRE-02'))
})

test('PRE-02 bounded count and complete read use one real snapshot across a concurrent writer',t=>{
  const {open}=fixture(t,'pre02-snapshot-'),db=open(),writer=open()
  const insert=writer.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  insert.run('first','99001','ONE','2026-10-09T12:00:00Z','no_bars')
  insert.run('second',null,'TWO','2026-10-09T12:00:00Z','target')
  const opts={...options,populationLimit:3},before=buildOrderLifecycle(db,opts)
  const prepare=db.prepare.bind(db);let interleaved=false
  db.prepare=sql=>{
    const stmt=prepare(sql)
    if(sql.startsWith('SELECT count(*) AS n FROM (') && sql.includes(index)) {
      const get=stmt.get.bind(stmt)
      stmt.get=(...args)=>{
        const row=get(...args)
        assert.equal(db.inTransaction,true,'direct builder must hold a snapshot before counting')
        if(!interleaved) {
          interleaved=true
          writer.transaction(()=>{
            insert.run('third','99002','THREE','2026-10-09T12:00:00Z','unscorable')
            insert.run('fourth','99001','FOUR','2026-10-09T12:00:00Z','no_bars')
          })()
        }
        return row
      }
    }
    return stmt
  }
  const concurrent=buildOrderLifecycle(db,opts)
  delete db.prepare
  assert.equal(interleaved,true)
  assert.deepEqual(concurrent,before,'newly over-cap data cannot enter the already-proven complete snapshot')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refusal_scores').get().n,4,'writer actually committed, not a fake result')
  const observation=observeReads(db),after=buildOrderLifecycle(db,opts);observation.restore()
  assert.equal(rule(after).population,3);assert.equal(rule(after).truncated,true)
  assert.ok(observation.reads.some(r=>r.op==='all' && r.sql===legacy),'new report keeps original capped selection')
})

test('PRE-02 complete read preserves original tie ordering for NULL keys and collation-equivalent subjects',t=>{
  const {open}=fixture(t,'pre02-order-'),db=open()
  const insert=db.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  // TEXT PRIMARY KEY permits multiple NULLs; localeCompare also equates
  // these distinct Unicode keys. The report's stable sort retains SQL order.
  for(const [key,symbol] of [[null,'Z-FIRST'],[null,'A-SECOND'],['é','Z-THIRD'],['e\u0301','A-FOURTH']]) {
    insert.run(key,'99001',symbol,'2026-10-09T12:00:00Z','no_bars')
  }
  db.exec(`DROP INDEX ${index}`)
  for(const analysed of [false,true]) {
    if(analysed) db.exec('ANALYZE')
    db.exec(`DROP INDEX IF EXISTS ${index}`)
    const before=buildOrderLifecycle(db,options)
    const restored=open()
    assert.deepEqual(buildOrderLifecycle(restored,options),before,'complete population must preserve stable sample tie order')
    restored.close()
  }
})

test('PRE-02 keeps the actual original read when an alternate access plan has no proved ordering contract',t=>{
  const {open}=fixture(t,'pre02-alternate-'),db=open()
  db.exec(`DROP INDEX ${index}`)
  db.exec('CREATE INDEX alternate_refusal_cover ON refusal_scores(scored_at,opportunity_key,account_id,symbol,outcome)')
  const insert=db.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  db.transaction(()=>{for(let i=0;i<500;i++) insert.run(`key-${500-i}`,'99001','SYNTHETIC','2026-10-09T12:00:00Z',i%2?'target':'no_bars')})()
  assert.ok(plan(db,legacy,200000).some(r=>r.includes('USING COVERING INDEX alternate_refusal_cover')))
  const before=buildOrderLifecycle(db,options),restored=open(),observation=observeReads(restored)
  const after=buildOrderLifecycle(restored,options);observation.restore()
  assert.deepEqual(after,before)
  assert.ok(observation.reads.some(r=>r.op==='all' && r.sql===legacy))
  assert.ok(!observation.reads.some(r=>r.op==='all' && r.sql.includes(`INDEXED BY ${index}`)))
})

test('PRE-02 keeps original reads for reversed traversal and differently defined legacy indexes',t=>{
  const {open}=fixture(t,'pre02-plan-order-'),db=open()
  const insert=db.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  for(let i=0;i<200;i++) insert.run(`key-${200-i}`,'99001',`SYMBOL-${i}`,'2026-10-09T12:00:00Z',i%2?'no_bars':'unscorable')
  for(const variant of ['reverse','descending-index']) {
    db.exec(`DROP INDEX IF EXISTS ${index}`)
    if(variant==='reverse') db.pragma('reverse_unordered_selects=ON')
    else {
      db.pragma('reverse_unordered_selects=OFF')
      db.exec('DROP INDEX idx_refusal_scores_scored; CREATE INDEX idx_refusal_scores_scored ON refusal_scores(scored_at DESC,outcome DESC,account_id DESC)')
    }
    const before=buildOrderLifecycle(db,options),restored=open()
    if(variant==='reverse') restored.pragma('reverse_unordered_selects=ON')
    const observation=observeReads(restored),after=buildOrderLifecycle(restored,options);observation.restore()
    assert.deepEqual(after,before)
    assert.ok(observation.reads.some(r=>r.op==='all' && r.sql===legacy))
    assert.ok(!observation.reads.some(r=>r.op==='all' && r.sql.includes(`INDEXED BY ${index}`)))
    restored.close()
  }
})

test('PRE-02 optimised real worker reaches the durable controller snapshot and heartbeat',async t=>{
  const {open}=fixture(t,'pre02-delivery-'),db=open()
  const insert=db.prepare('INSERT INTO refusal_scores(opportunity_key,account_id,symbol,scored_at,outcome) VALUES(?,?,?,?,?)')
  const at=new Date(Date.now()-60000).toISOString()
  db.transaction(()=>{for(let i=0;i<500;i++) insert.run(`fixture-${i}`,i%3?'99001':null,'SYNTHETIC',at,i%2?'target':'no_bars')})()
  const result=await runOrderLifecyclePass(db)
  assert.equal(result.ok,true,result.error)
  const stored=JSON.parse(getState(db,SNAPSHOT_KEY)),pre=stored.rules.find(r=>r.id==='PRE-02')
  assert.equal(pre.population,500);assert.equal(pre.violations,250);assert.equal(pre.truncated,false)
  assert.match(stored.rulesetVersion,/helpers@7/)
  const beat=db.prepare("SELECT * FROM controller_heartbeats WHERE name='order_lifecycle'").get()
  assert.equal(beat.runs,1);assert.equal(beat.consecutive_failures,0)
})
