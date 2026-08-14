// node --test agent/lib/strategy-attribution.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { strategyOf, strategyAttrSql } from './strategy-attribution.js'

test('strategyOf: a real strategy is not shadowed by a label that says "other"', () => {
  assert.equal(strategyOf({ label_strategy: 'other', strategy: 'va_breakout' }), 'va_breakout')
  assert.equal(strategyOf({ label_strategy: null, strategy: 'fvg_retrace' }), 'fvg_retrace')
  assert.equal(strategyOf({ label_strategy: 'vp_value', strategy: 'other' }), 'vp_value')
  assert.equal(strategyOf({ label_strategy: 'OTHER', strategy: '  ' }), null)
  assert.equal(strategyOf({ label_strategy: 'other', strategy: 'other' }), null)
  assert.equal(strategyOf({}), null)
  assert.equal(strategyOf(null), null)
})

// The SQL expression must agree with the JS function on every case — a
// caller has no way to tell the two apart, and a query is exactly where the
// original bug lived.
test('strategyAttrSql mirrors strategyOf, in an actual SQLite query', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, label_strategy TEXT, strategy TEXT)`)
  const rows = [
    { label_strategy: 'other', strategy: 'va_breakout' },   // recoverable via strategy
    { label_strategy: null, strategy: 'fvg_retrace' },
    { label_strategy: 'vp_value', strategy: 'other' },
    { label_strategy: 'OTHER', strategy: '  ' },             // genuinely absent
    { label_strategy: 'other', strategy: 'other' },
    { label_strategy: null, strategy: null },
  ]
  const ins = db.prepare(`INSERT INTO t (label_strategy, strategy) VALUES (?, ?)`)
  for (const r of rows) ins.run(r.label_strategy, r.strategy)

  const got = db.prepare(`SELECT ${strategyAttrSql()} AS k FROM t ORDER BY id`).all().map(r => r.k)
  const want = rows.map(strategyOf)
  assert.deepEqual(got, want)

  // A WHERE match must find the row whose real column has the answer, even
  // though its label_strategy says 'other' — this is the exact shape of the
  // bug: COALESCE(label_strategy, strategy) = 'va_breakout' never matched it.
  const hit = db.prepare(`SELECT COUNT(*) AS n FROM t WHERE ${strategyAttrSql()} = ?`).get('va_breakout')
  assert.equal(hit.n, 1)
})

test('strategyAttrSql accepts table-qualified column names', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE t (label_strategy TEXT, strategy TEXT)`)
  db.prepare(`INSERT INTO t VALUES ('other', 'rsi2_reversion')`).run()
  const row = db.prepare(
    `SELECT ${strategyAttrSql('t.label_strategy', 't.strategy')} AS k FROM t`
  ).get()
  assert.equal(row.k, 'rsi2_reversion')
})
