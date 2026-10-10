// Codex · №12,410 · 2026-10-09; codex-footprint: bounded-node-diagnostic.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readHybridVerdicts, readDiagnosticPopulation, readTradingAssessment } from './diagnostic-readout.js'

test('actual stored verdicts retain account/refusal/timestamps but never arbitrary keys or error payloads', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  const put = (k, v) => db.prepare('INSERT INTO agent_state VALUES (?,?)').run(k, JSON.stringify(v))
  put('momentum_partial_pass_json', { at: '2026-10-09T00:00:00.000Z', ok: true, activePlans: 0,
    secret: 'test-secret', cappedHybrid: { examined: 2, enrolled: [],
      deferred: [{ accountId: '42', tradeId: 1, reason: 'half_and_runner_not_representable', accessToken: 'test-secret' }],
      errors: [{ tradeId: 2, reason: 'INCORRECT_BOUNDARIES body=test-secret' }] } })
  put('hybrid_tick_controller_json', { at: 100, startedAt: 50, hosts: {
    'owned.example': { plans: 0, processed: 0, lastReadAt: 98, errors: 1, error: 'timeout secret=test-secret' } } })
  const changes = () => db.prepare('SELECT total_changes() n').get().n
  const before = changes()
  const r = readHybridVerdicts(db), out = JSON.stringify(r)
  assert.equal(r.momentum_partial_pass_json.cappedHybrid.deferred.rows[0].accountId, '42')
  assert.equal(r.momentum_partial_pass_json.cappedHybrid.errors.rows[0].reason, 'INCORRECT_BOUNDARIES')
  assert.equal(r.hybrid_tick_controller_json.hosts[0].error, 'timeout_or_deadline')
  assert.ok(!out.includes('test-secret')); assert.ok(!out.includes('accessToken'))
  assert.equal(changes(), before)
  db.close()
})

test('independent per-position readback remains account-owned and redacted; missing money schema is not zero profit', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  db.prepare('INSERT INTO agent_state VALUES (?,?)').run('independent_protection_json', JSON.stringify({
    readAt: '2026-10-09T00:00:00Z', accounts: [{ accountId: '42', ok: true, checkedAtMs: 100, openCount: 1,
      positions: [{ positionId: 77, symbolId: 3, stopLoss: 12, takeProfit: 15, trailingStopLoss: true,
        stopLossTriggerMethod: 3, accessToken: 'test-private' }] }] }))
  const r = readTradingAssessment(db)
  assert.equal(r.protection.accounts[0].accountId, '42')
  assert.equal(r.protection.accounts[0].positions[0].stopLoss, 12)
  assert.equal(r.protection.accounts[0].positions[0].trailingStopLoss, true)
  assert.equal(r.targets.available, false)
  assert.ok(!JSON.stringify(r).includes('test-private'))
  db.close()
})

test('missing, malformed, capped and partial-schema reads are explicit rather than empty success', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE accounts(account_id TEXT,mode TEXT,enabled INTEGER)')
  db.prepare('INSERT INTO agent_state VALUES (?,?)').run('momentum_partial_pass_json', '{')
  for (let i = 0; i < 70; i++) db.prepare('INSERT INTO accounts VALUES (?, ?, ?)').run(String(i), 'manage_only', 1)
  const r = readHybridVerdicts(db), pop = readDiagnosticPopulation(db)
  assert.equal(r.momentum_partial_pass_json.reason, 'invalid_json')
  assert.equal(r.hybrid_tick_controller_json.reason, 'missing')
  assert.equal(pop.accounts.rows.length, 64); assert.equal(pop.accounts.truncated, true)
  assert.equal(pop.trades.reason, 'missing_table')
  db.close()
})

test('readout refuses oversized filtered populations and scans newest inserted receipt rows without a sort', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY, status TEXT);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001)
      INSERT INTO trades SELECT i,'closed' FROM n;
    CREATE TABLE hybrid_tick_receipts(host TEXT,event_id TEXT,received_at INTEGER,PRIMARY KEY(host,event_id));
    INSERT INTO hybrid_tick_receipts VALUES ('owned.example','old',999),('owned.example','new',1)`)
  const r = readDiagnosticPopulation(db)
  assert.equal(r.trades.reason, 'population_cap')
  assert.equal(r.hybrid_tick_receipts.rows[0].event_id, 'new', 'declared insertion order, not a false newest-source-time claim')
  assert.equal(r.hybrid_tick_receipts.order, 'rowid DESC')
  assert.ok(!db.prepare('EXPLAIN QUERY PLAN SELECT host,event_id,received_at FROM hybrid_tick_receipts ORDER BY rowid DESC LIMIT 65').all()
    .some(r => /TEMP B-TREE/.test(r.detail)))
  db.close()
})

// Codex · №12,972 · 2026-10-10; codex-footprint: scoped-verdict-before-cap.
function scopedFixture(t,rows) {
  const db=new Database(':memory:');t.after(()=>db.close())
  db.exec('CREATE TABLE agent_state(key TEXT PRIMARY KEY,value TEXT)')
  const put=(key,value)=>db.prepare('INSERT INTO agent_state VALUES (?,?)').run(key,JSON.stringify(value))
  put('momentum_partial_pass_json',{at:'2026-10-10T12:00:00Z',ok:true,cappedHybrid:{
    enrolled:rows,excluded:rows,delegated:rows,deferred:rows,errors:rows}})
  put('hybrid_tick_controller_json',{at:100,hosts:{'demo.ctraderapi.com':{configuration:{excluded:rows}}}})
  return db
}
function scopedLists(result) {
  const h=result.momentum_partial_pass_json.cappedHybrid
  return [...['enrolled','excluded','delegated','deferred','errors'].map(key=>h[key]),
    result.hybrid_tick_controller_json.hosts[0].configuration.excluded]
}

test('canonical scoped verdict filters foreign prefix before every64-row cap and retains requested tail',t=>{
  const rows=[...Array.from({length:65},(_,i)=>({accountId:'99',tradeId:i+1,reason:'candidate_not_selected'})),
    {accountId:'42',tradeId:66,reason:'half_and_runner_not_representable',accessToken:'DO_NOT_EMIT'}]
  const db=scopedFixture(t,rows),before=db.prepare('SELECT total_changes() n').get().n
  for(const list of scopedLists(readHybridVerdicts(db,{accountIds:['42']}))){
    assert.equal(list.rows.length,1,'foreign prefix must not consume selected-account budget')
    assert.equal(list.rows[0].accountId,'42');assert.equal(list.rows[0].tradeId,66)
    assert.equal(list.total,66);assert.equal(list.totalScope,'stored_global')
    assert.equal(list.scopeTotal,1);assert.equal(list.rowsScope,'requested_accounts')
    assert.equal(list.truncated,false);assert.equal(list.rows.length,1)
    assert.equal(list.rows[0].accountId,'42');assert.equal(list.rows[0].tradeId,66)
  }
  assert.equal(JSON.stringify(readHybridVerdicts(db,{accountIds:['42']})).includes('DO_NOT_EMIT'),false)
  assert.equal(db.prepare('SELECT total_changes() n').get().n,before)
})

test('canonical scoped verdict caps selected population and distinguishes global from selected counts',t=>{
  const rows=[...Array.from({length:5},(_,i)=>({accountId:'99',tradeId:i+1})),
    ...Array.from({length:70},(_,i)=>({accountId:'42',tradeId:i+6,reason:'candidate_not_selected'}))]
  const db=scopedFixture(t,rows)
  for(const list of scopedLists(readHybridVerdicts(db,{accountIds:['42']}))){
    assert.equal(list.rows.every(row=>row.accountId==='42'),true,'foreign rows must be removed before the cap')
    assert.equal(list.total,75);assert.equal(list.scopeTotal,70)
    assert.equal(list.truncated,true);assert.equal(list.rows.length,64)
    assert.equal(list.rows[0].tradeId,6);assert.equal(list.rows.at(-1).tradeId,69)
    assert.equal(list.rows.every(row=>row.accountId==='42'),true)
  }
  const original=readHybridVerdicts(db)
  assert.deepEqual(readHybridVerdicts(db,{accountIds:null}),original)
  for(const list of scopedLists(original)){
    assert.equal(list.total,75);assert.equal(list.rows.length,64);assert.equal(list.truncated,true)
    assert.equal(Object.hasOwn(list,'scopeTotal'),false);assert.equal(Object.hasOwn(list,'rowsScope'),false)
  }
})

test('scoped verdict empty selection and20-digit protocol IDs retain exact identity without coercion',t=>{
  const account='18446744073709551615',db=scopedFixture(t,[{accountId:account,tradeId:1},{accountId:'42',tradeId:2}])
  for(const list of scopedLists(readHybridVerdicts(db,{accountIds:[]}))){
    assert.deepEqual(list.rows,[],'an explicit empty scope must not return foreign records')
    assert.equal(list.total,2);assert.equal(list.scopeTotal,0);assert.deepEqual(list.rows,[]);assert.equal(list.truncated,false)
  }
  for(const list of scopedLists(readHybridVerdicts(db,{accountIds:[account]}))){
    assert.equal(list.scopeTotal,1);assert.equal(list.rows[0].accountId,account)
  }
  for(const accountIds of ['42',[42],['0'],['042'],['-1'],['1.1'],['1'.repeat(21)],Array(9).fill('42'),[true]])
    assert.throws(()=>readHybridVerdicts(db,{accountIds}),/invalid_account_scope/)
})
