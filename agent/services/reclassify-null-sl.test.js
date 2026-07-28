import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { initDB } from '../db.js'
import { reclassifyBrokerCloses } from './reconciler.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'recl-')),'agent.db'))
const ins = (db, o) => {
  const c = ['symbol','side','status','entry_price','exit_price','sl_price','tp_price','close_reason','opened_at','closed_at']
  db.prepare(`INSERT INTO trades (${c.join(',')}) VALUES (${c.map(()=>'?').join(',')})`)
    .run(o.symbol,o.side,'closed',o.entry,o.exit,o.sl??null,o.tp??null,o.reason,'2026-07-28 00:00:00','2026-07-28 12:00:00')
  return db.prepare('SELECT last_insert_rowid() id').get().id
}
const reason = (db,id) => db.prepare('SELECT close_reason r FROM trades WHERE id=?').get(id).r

test('THE BUG: a SHORT with no stop is no longer stamped "stopped beyond the SL"', () => {
  const db = tmpDb()
  const id = ins(db,{symbol:'ETHUSD',side:'SELL',entry:1878.63,exit:1923.15,sl:null,tp:null,
    reason:'closed at the broker (manual close or broker-side SL/TP fill)'})
  reclassifyBrokerCloses(db)
  const r = reason(db,id)
  assert.doesNotMatch(r,/stopped beyond the SL/,'Number(null)===0 made exit>0 true for every short')
  assert.match(r,/NO STOP LOSS/)
  assert.match(r,/unprotected/)
})

test('BACKFILL: rows already carrying the false stamp are corrected', () => {
  const db = tmpDb()
  const id = ins(db,{symbol:'ETHUSD',side:'SELL',entry:1878.63,exit:1923.15,sl:null,
    reason:'stopped beyond the SL — gap/slippage through the stop or a margin-level liquidation (reclassified from the broker exit price)'})
  reclassifyBrokerCloses(db)
  assert.match(reason(db,id),/NO STOP LOSS/)
})

test('a REAL gap through a real stop still classifies as before', () => {
  const db = tmpDb()
  const id = ins(db,{symbol:'ETHUSD',side:'SELL',entry:1878.63,exit:1990,sl:1950,
    reason:'closed at the broker (manual close or broker-side SL/TP fill)'})
  reclassifyBrokerCloses(db)
  assert.match(reason(db,id),/stopped beyond the SL/)
})

test('a real SL fill and a real TP fill are untouched by the change', () => {
  const db = tmpDb()
  const a = ins(db,{symbol:'X',side:'BUY',entry:100,exit:95,sl:95,reason:'closed at the broker (x)'})
  const b = ins(db,{symbol:'Y',side:'BUY',entry:100,exit:110,sl:95,tp:110,reason:'closed at the broker (x)'})
  reclassifyBrokerCloses(db)
  assert.match(reason(db,a),/stop loss hit/)
  assert.match(reason(db,b),/take profit hit/)
})

test('a genuinely manual close keeps the honest generic sentence', () => {
  const db = tmpDb()
  const id = ins(db,{symbol:'Z',side:'BUY',entry:100,exit:103,sl:95,tp:120,reason:'closed at the broker (manual close or broker-side SL/TP fill)'})
  reclassifyBrokerCloses(db)
  assert.match(reason(db,id),/^closed at the broker/)
})

test('a LONG with no stop is also caught — it escaped the old bug by accident', () => {
  const db = tmpDb()
  const id = ins(db,{symbol:'W',side:'BUY',entry:100,exit:90,sl:null,reason:'closed at the broker (x)'})
  reclassifyBrokerCloses(db)
  assert.match(reason(db,id),/NO STOP LOSS/)
})
