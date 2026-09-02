// node --test agent/position-flag-race.test.js
//
// THE SNAPSHOT RACE (codebase audit, 02-09-2026). The loop reads its open
// positions once, before scan/analyze, and minutes later writes be_moved /
// scaled_out back from that snapshot. The fast monitor's trade guards run
// every 60 s in between and SET those flags (break-even moved, partial taken).
// A plain `SET be_moved = ?` from the stale snapshot wrote the 0 back over the
// guard's 1, and decideGuardActions (`!beMoved`) could re-arm break-even on a
// stop that had already moved. Reproduced here against the loop's own
// prepared statement; the fix is MAX() — nothing ever resets either flag on
// purpose (grepped: no `be_moved = 0` / `scaled_out = 0` writer exists).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
import { prepareStatements } from './loop.js'

function seed(db) {
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, sl_price, status, ctrader_position_id) VALUES ('EURUSD','BUY',1.1,1.09,'open','77')`).run().lastInsertRowid
  return db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, initial_risk, status, be_moved, scaled_out)
    VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 0.01, 'active', 0, 0)`).run(tradeId).lastInsertRowid
}

test('a break-even flag set by the guard between the loop\'s read and its write SURVIVES the write', () => {
  const db = initDB(':memory:')
  const s = prepareStatements(db)
  const id = seed(db)
  // 1. The loop takes its snapshot.
  const pos = db.prepare('SELECT * FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(pos.be_moved, 0)
  // 2. The 60-second guard moves break-even and takes a partial (trade-guard.js updSl / updGuard).
  db.prepare(`UPDATE monitored_positions SET be_moved = 1, scaled_out = 1, current_sl = 1.1 WHERE id = ?`).run(id)
  // 3. The loop's monitor phase writes metrics from the STALE snapshot — the
  //    evaluator had nothing to say about the flags, so it forwards pos.*.
  const eval_ = { updates: {} }
  s.updatePositionMetrics.run(
    eval_.updates.mfe_r ?? pos.mfe_r ?? 0,
    eval_.updates.mae_r ?? pos.mae_r ?? 0,
    eval_.updates.be_moved ?? pos.be_moved ?? 0,
    eval_.updates.scaled_out ?? pos.scaled_out ?? 0,
    id,
  )
  const after = db.prepare('SELECT be_moved, scaled_out FROM monitored_positions WHERE id = ?').get(id)
  assert.equal(after.be_moved, 1, 'the guard\'s break-even must not be reset by the loop\'s stale snapshot')
  assert.equal(after.scaled_out, 1, 'nor its partial')
  // And a genuine latch from the evaluator still lands.
  s.updatePositionMetrics.run(0, 0, 1, 0, id)
  assert.equal(db.prepare('SELECT be_moved FROM monitored_positions WHERE id = ?').get(id).be_moved, 1)
})

test('the statement is MAX(), by source, so a refactor back to `= ?` fails here', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const stmt = src.slice(src.indexOf('updatePositionMetrics: db.prepare('), src.indexOf('updatePositionMetrics: db.prepare(') + 400)
  assert.match(stmt, /be_moved = MAX\(COALESCE\(be_moved, 0\), COALESCE\(\?, 0\)\)/)
  assert.match(stmt, /scaled_out = MAX\(COALESCE\(scaled_out, 0\), COALESCE\(\?, 0\)\)/)
  assert.doesNotMatch(stmt, /be_moved = \?,/)
})
