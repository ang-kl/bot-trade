// Codex · №12,046 · 2026-10-08; codex-footprint: collection-retention.
// Actual DB consumers; only the native HTTP boundary is substituted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { probeOneSidecar, pullEventsIntoDb } from './heartbeat.js'

for (const kind of ['decisions', 'events']) {
  test(`${kind}: an advertised sequence absent from the snapshot remains fetchable`, async t => {
    const db = initDB(':memory:'); t.after(() => db.close())
    const side = { name: 'cpp_exec_demo', base: 'http://native.test' }, now = new Date('2026-10-08T01:00:00Z')
    const health = { ok: true, mode: 'cpp', connected: true, hasCredentials: true,
      lastReconcileAt: now.getTime(), bootId: 'boot-a', decisionsSeq: 2 }
    const entries = [1, 2].map(seq => ({ seq, tsMs: now.getTime(), component: 'trail', kind: 'amend_ok',
      executionType: 'ORDER_FILLED', accountId: 11, symbolId: 9, positionId: 7 }))
    const calls = []; let first = true
    const pull = async ({ after }) => {
      calls.push(after)
      // The native dump copies entries before reading latestSeq: seq 2
      // arrives between those two locks, so only seq 1 is in this response.
      const snapshot = first ? entries.slice(0, 1) : entries; first = false
      return { bootId: 'boot-a', latestSeq: 2, entries: snapshot.filter(e => e.seq > after) }
    }
    const exec = { pingSidecar: async () => health, [kind === 'events' ? 'pullSidecarEvents' : 'pullSidecarDecisions']: pull }
    const run = () => kind === 'events' ? pullEventsIntoDb(db, exec, side, health) : probeOneSidecar(db, exec, side, { now })
    await run(); await run(); await run()
    assert.deepEqual(db.prepare(`SELECT seq FROM cpp_${kind} ORDER BY seq`).all().map(r => r.seq), [1, 2])
    assert.deepEqual(calls, [0, 1, 2])
    assert.equal(JSON.parse(getState(db, `cpp_${kind}_cursor_json`))[side.name].lastSeq, 2)
  })

  test(`${kind}: empty or malformed snapshots do not acknowledge records; new boots reset only their side`, async t => {
    const db=initDB(':memory:'); t.after(()=>db.close())
    const now=new Date('2026-10-08T01:00:00Z'), side={name:'cpp_exec_demo',base:'http://native.test'}
    const key=`cpp_${kind}_cursor_json`
    setState(db,key,JSON.stringify({cpp_exec:{bootId:'live',lastSeq:99},cpp_exec_demo:{bootId:'old',lastSeq:10}}))
    let entries=[]
    const health={ok:true,mode:'cpp',connected:true,hasCredentials:true,lastReconcileAt:now.getTime(),bootId:'new'}
    const exec={pingSidecar:async()=>health,[kind==='events'?'pullSidecarEvents':'pullSidecarDecisions']:
      async()=>({bootId:'new',latestSeq:500,entries})}
    const run=()=>kind==='events'?pullEventsIntoDb(db,exec,side,health):probeOneSidecar(db,exec,side,{now})
    await run()
    assert.equal(JSON.parse(getState(db,key))[side.name].lastSeq,0)
    entries=[null,...[null,'5',false,1.5,-1,Number.MAX_SAFE_INTEGER+1].map(seq=>({seq}))]
    await run()
    assert.equal(JSON.parse(getState(db,key))[side.name].lastSeq,0)
    entries=[{seq:1,tsMs:now.getTime(),component:'trail',kind:'amend_ok'}]
    await run(); await run()
    const cursors=JSON.parse(getState(db,key))
    assert.deepEqual(cursors[side.name],{bootId:'new',lastSeq:1})
    assert.deepEqual(cursors.cpp_exec,{bootId:'live',lastSeq:99})
    assert.equal(db.prepare(`SELECT count(*) n FROM cpp_${kind} WHERE seq>0`).get().n,1)
  })

  test(`${kind}: an insert failure leaves the cursor retryable and replay remains idempotent`, async t => {
    const db=initDB(':memory:'); t.after(()=>db.close())
    const now=new Date('2026-10-08T01:00:00Z'), side={name:'cpp_exec_demo',base:'http://native.test'}
    const health={ok:true,mode:'cpp',connected:true,hasCredentials:true,lastReconcileAt:now.getTime(),bootId:'boot'}
    const calls=[], entries=[1,2].map(seq=>({seq,tsMs:now.getTime(),component:'trail',kind:'amend_ok'}))
    const exec={pingSidecar:async()=>health,[kind==='events'?'pullSidecarEvents':'pullSidecarDecisions']:
      async({after})=>{calls.push(after);return{bootId:'boot',latestSeq:3,entries:entries.filter(e=>e.seq>after)}}}
    const prepare=db.prepare.bind(db); let fail=true
    db.prepare=sql=>{
      const stmt=prepare(sql)
      if(sql.includes(`INSERT OR IGNORE INTO cpp_${kind}`)) {
        const run=stmt.run.bind(stmt)
        stmt.run=(...args)=>{if(fail&&args[2]===2){fail=false;throw new Error('fixture insert failure')}return run(...args)}
      }
      return stmt
    }
    const run=()=>kind==='events'?pullEventsIntoDb(db,exec,side,health):probeOneSidecar(db,exec,side,{now})
    try{await run()}catch(e){assert.match(e.message,/fixture insert failure/)}
    assert.equal(getState(db,`cpp_${kind}_cursor_json`),null)
    await run()
    assert.deepEqual(calls,[0,0])
    assert.deepEqual(db.prepare(`SELECT seq FROM cpp_${kind} ORDER BY seq`).all().map(r=>r.seq),[1,2])
  })

  test(`${kind}: a legacy cursor ahead of durable rows cannot hide a still-available tail record`, async t => {
    const db=initDB(':memory:');t.after(()=>db.close())
    const now=new Date('2026-10-08T01:00:00Z'), side={name:'cpp_exec_demo',base:'http://native.test'}
    const health={ok:true,mode:'cpp',connected:true,hasCredentials:true,lastReconcileAt:now.getTime(),bootId:'boot'}
    const entries=[1,2].map(seq=>({seq,tsMs:now.getTime(),component:'trail',kind:'amend_ok'}))
    let partial=true; const afters=[]
    const exec={pingSidecar:async()=>health,[kind==='events'?'pullSidecarEvents':'pullSidecarDecisions']:
      async({after})=>{afters.push(after);return {bootId:'boot',latestSeq:partial?1:2,entries:(partial?entries.slice(0,1):entries).filter(e=>e.seq>after)}}}
    const run=()=>kind==='events'?pullEventsIntoDb(db,exec,side,health):probeOneSidecar(db,exec,side,{now})
    await run()
    // Emulate the old consumer's incorrectly acknowledged, unseen seq 2.
    setState(db,`cpp_${kind}_cursor_json`,JSON.stringify({[side.name]:{bootId:'boot',lastSeq:2}}))
    partial=false;await run()
    assert.deepEqual(afters,[0,1])
    assert.deepEqual(db.prepare(`SELECT seq FROM cpp_${kind} ORDER BY seq`).all().map(r=>r.seq),[1,2])
  })
}
