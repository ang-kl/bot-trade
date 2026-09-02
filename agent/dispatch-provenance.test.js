// node --test agent/dispatch-provenance.test.js
//
// 02-09-2026 (predict-vs-actual audit). Three facts the dispatch threw away
// and now keeps: the intended entry (so slippage is computable after the
// broker fill is reconciled over entry_price), the analysis that produced the
// order (3,935 auto-trade predictions in 25 h had no outcome link), and the
// stop the broker holds at the fill. Pinned in source with comments stripped
// — the dispatch has no injection point short of a broker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from './db.js'

const strip = (s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')

test('the intent row carries proposal_entry_price and analysis_id; the fill stamps broker_sl_initial', () => {
  const src = strip(readFileSync(new URL('./loop.js', import.meta.url), 'utf8'))
  const intent = src.slice(src.indexOf('const intentId = db.prepare('), src.indexOf('const intentId = db.prepare(') + 900)
  assert.match(intent, /origin, origin_source, proposal_entry_price, analysis_id\)/)
  assert.match(intent, /Number\.isFinite\(Number\(synth\.entry\)\) \? Number\(synth\.entry\) : null/)
  assert.match(intent, /Number\.isFinite\(Number\(synth\.analysisId\)\) \? Number\(synth\.analysisId\) : null/)
  assert.match(src, /synth\.analysisId = Number\(analysisIns\?\.lastInsertRowid\) \|\| null/, 'the analysis id is carried on the synthesis')
  assert.match(src, /broker_sl_initial = COALESCE\(\?, broker_sl_initial\)/)
  assert.match(src, /Number\(exec\?\.position\?\.stopLoss\) > 0 \? Number\(exec\.position\.stopLoss\) : null/)
})

test('the columns exist on a fresh database and on an upgraded one', () => {
  const db = initDB(':memory:')
  const cols = new Set(db.prepare('PRAGMA table_info(trades)').all().map(c => c.name))
  for (const c of ['proposal_entry_price', 'broker_sl_initial', 'analysis_id', 'slippage_price']) assert.ok(cols.has(c), c)
})
