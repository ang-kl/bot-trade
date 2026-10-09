// Codex · №12,434 · 2026-10-09; codex-footprint: reporting-query.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDB } from '../db.js'
import { recordScannerMirrorPage, scannerMirrorStatus } from './scanner-candidates.js'

const NOW = 1791508672695
function seed(db) {
  recordScannerMirrorPage(db, 'cpp-scan-tick', { instanceId: 'a'.repeat(64), orderAuthority: false,
    candidates: [], oldestCursor: 1, latestCursor: 0 }, { now: NOW })
  const candidate = db.prepare('INSERT INTO scanner_mirror_candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const outcome = db.prepare('INSERT INTO scanner_mirror_outcomes VALUES(?,?,?,?,?,?)')
  for (let i = 0; i < 120; i++) {
    const source = i % 2 ? 'cpp-scan-tick' : 'cpp-scan-timeframe'
    candidate.run(String(i),source,i%3?'42':'43',i%4?'demo.ctraderapi.com':'live.ctraderapi.com',String(i%5),`s${i%7}`,'p','v',NOW,NOW+1000,NOW,'f','x'.repeat(1024))
    outcome.run(source,'instance',i,i%3?'mirror':'rejected',i%3?null:'unregistered',NOW)
  }
}
function inspect(db) {
  const prepare = db.prepare.bind(db), statements = []
  db.prepare = sql => { if (/FROM scanner_mirror_.*GROUP BY/.test(sql)) statements.push(sql); return prepare(sql) }
  let out
  try { out = scannerMirrorStatus(db, { now: NOW }) } finally { db.prepare = prepare }
  assert.equal(statements.length, 2)
  for (const sql of statements) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(x=>x.detail).join('\n')
    assert.match(plan, /USING COVERING INDEX scanner_mirror_.*_report/)
    assert.doesNotMatch(plan, /TEMP B-TREE/)
  }
  return out
}
test('real scanner summaries use covering group indexes and preserve all account/host populations', t => {
  const db = initDB(':memory:'); t.after(()=>db.close()); seed(db)
  const before = scannerMirrorStatus(db, { now: NOW })
  assert.deepEqual(inspect(db), before)
  assert.equal(before.candidates.reduce((n,r)=>n+r.count,0),120)
  assert.equal(before.outcomes.reduce((n,r)=>n+r.count,0),120)
  assert.equal(before.orderAuthority,false)
})
test('reopening a pre-index populated database adds report indexes without rewriting observations', t => {
  const dir=mkdtempSync(join(tmpdir(),'scanner-reporting-')); t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const path=join(dir,'db'); let db=initDB(path); t.after(()=>db.open&&db.close()); seed(db)
  db.exec('DROP INDEX IF EXISTS scanner_mirror_candidate_report; DROP INDEX IF EXISTS scanner_mirror_outcome_report')
  const before=scannerMirrorStatus(db,{now:NOW})
  const rows=db.prepare('SELECT * FROM scanner_mirror_candidates ORDER BY candidate_id').all()
  db.close(); db=initDB(path)
  assert.deepEqual(inspect(db),before)
  assert.deepEqual(db.prepare('SELECT * FROM scanner_mirror_candidates ORDER BY candidate_id').all(),rows)
})
