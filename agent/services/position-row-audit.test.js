// PR-X: is one symbol on four accounts, or four rows on one account?
//
// These tests encode BOTH readings of the owner's 15-09 log, because the log
// itself could not tell them apart and I diagnosed the wrong one from counts
// alone before writing this.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { duplicateActivePositions, activeRowsByAccount, duplicatePositionLine } from './position-row-audit.js'

// `monitored_positions.trade_id` is a real FK to trades(id), so a fixture has
// to create the trade it points at — the first draft did not and every test
// failed on the constraint rather than on anything it was testing.
const ins = (db, rows) => {
  const mkTrade = db.prepare(`INSERT OR IGNORE INTO trades (id, symbol, status) VALUES (?, ?, 'open')`)
  const st = db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, account_id, status, source) VALUES (?, ?, ?, 'active', ?)`)
  for (const r of rows) {
    if (r.tradeId != null) mkTrade.run(r.tradeId, r.symbol)
    st.run(r.symbol, r.tradeId ?? null, r.accountId ?? null, r.source ?? 'autopilot')
  }
}

test('THE BENIGN READING: one symbol held on four accounts is NOT flagged', () => {
  const db = initDB(':memory:')
  // This is what the momentum book produces: ABBV on each of four accounts,
  // UNH and COST on one each. The position manager evaluates four ABBV rows
  // and logs four FULL_EXITs — correctly. Nothing here is a defect.
  ins(db, [
    { symbol: 'ABBV.US', tradeId: 1, accountId: '47790949' },
    { symbol: 'ABBV.US', tradeId: 2, accountId: '46130058' },
    { symbol: 'ABBV.US', tradeId: 3, accountId: '43097342' },
    { symbol: 'ABBV.US', tradeId: 4, accountId: '46979908' },
    { symbol: 'UNH.US',  tradeId: 5, accountId: '47790949' },
    { symbol: 'COST.US', tradeId: 6, accountId: '47790949' },
  ])
  assert.deepEqual(duplicateActivePositions(db), [], 'four accounts, four groups of one')
  assert.equal(duplicatePositionLine(db), null, 'and no line — silence IS the answer "one per account"')
})

test('THE DEFECT READING: four rows on ONE account, all on the same trade, is flagged as duplicates', () => {
  const db = initDB(':memory:')
  ins(db, [
    { symbol: 'ABBV.US', tradeId: 9, accountId: '47790949' },
    { symbol: 'ABBV.US', tradeId: 9, accountId: '47790949' },
    { symbol: 'ABBV.US', tradeId: 9, accountId: '47790949' },
    { symbol: 'ABBV.US', tradeId: 9, accountId: '47790949' },
  ])
  const [d] = duplicateActivePositions(db)
  assert.equal(d.rows, 4)
  assert.equal(d.accountId, '47790949')
  assert.equal(d.distinctTradeIds, 1, 'one trade — these really are duplicates of one position')
  assert.match(duplicatePositionLine(db), /SAME trade — duplicate rows for one position/)
})

test('rows on one account but DIFFERENT trades are reported as do-not-merge', () => {
  const db = initDB(':memory:')
  // cTrader permits two real positions on one symbol. monitored_positions
  // carries no broker position id, so collapsing these would drop a live
  // position from management — the report says so instead of acting.
  ins(db, [
    { symbol: 'ABBV.US', tradeId: 11, accountId: '47790949' },
    { symbol: 'ABBV.US', tradeId: 12, accountId: '47790949' },
  ])
  const [d] = duplicateActivePositions(db)
  assert.equal(d.distinctTradeIds, 2)
  assert.match(duplicatePositionLine(db), /may be genuinely separate positions, do not merge/)
})

test('closed and paused rows are not counted — only what the PM actually evaluates', () => {
  const db = initDB(':memory:')
  ins(db, [{ symbol: 'ABBV.US', tradeId: 1, accountId: '111' }])
  db.prepare(`INSERT OR IGNORE INTO trades (id, symbol, status) VALUES (2, 'ABBV.US', 'closed'), (3, 'ABBV.US', 'open')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, account_id, status, source) VALUES ('ABBV.US', 2, '111', 'closed', 'autopilot')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, account_id, status, paused, source) VALUES ('ABBV.US', 3, '111', 'active', 1, 'autopilot')`).run()
  assert.deepEqual(duplicateActivePositions(db), [], 'the PM skips both, so neither is a duplicate of anything')
})

test('unscoped rows are grouped as their own bucket, never merged into a real account', () => {
  const db = initDB(':memory:')
  ins(db, [
    { symbol: 'ABBV.US', tradeId: 1, accountId: null },
    { symbol: 'ABBV.US', tradeId: 2, accountId: null },
  ])
  const [d] = duplicateActivePositions(db)
  assert.equal(d.accountId, '(unscoped)')
  assert.equal(d.rows, 2)
})

test('activeRowsByAccount shows the per-account spread behind the line counts', () => {
  const db = initDB(':memory:')
  ins(db, [
    { symbol: 'ABBV.US', tradeId: 1, accountId: '111' },
    { symbol: 'UNH.US',  tradeId: 2, accountId: '111' },
    { symbol: 'ABBV.US', tradeId: 3, accountId: '222' },
  ])
  assert.deepEqual(activeRowsByAccount(db), [{ accountId: '111', rows: 2 }, { accountId: '222', rows: 1 }])
})

test('the PM log line names the account, the row and the trade', () => {
  // The whole reason the 15-09 log could not answer the question.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  assert.match(src, /export function posTag\(pos\)/)
  assert.match(src, /String\(pos\.account_id\)\.slice\(-4\)/)
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert.doesNotMatch(stripped, /log\(`PM \$\{pos\.symbol\}:/,
    'no PM line may print the bare symbol — that is what made ABBV unreadable')
  assert.match(stripped, /duplicatePositionLine\(db\)/, 'and the loop reports real duplicates')
})

test('the duplicate report rides on a per-cycle phase, not the 8-hourly housekeeping band', () => {
  // PR-X SHIPPED THIS BLOCK INSIDE `if (housekeepingDue(...))`, whose cadence
  // is an EIGHT-HOUR persisted wall clock. The hourly throttle around it was
  // therefore a ceiling inside an eight-hour gate, and the comment above it
  // claimed "hourly" — a report that cannot arrive at the rate it advertises.
  // Measured 17-09 08:57 UTC on deploy 4f349da5: the arming-ratchet line (a
  // per-cycle phase, same throttle) printed three minutes after boot; this one
  // had not printed at all.
  //
  // The presence pin above stayed green through both placements, which is why
  // it needed this one: ORDER is the property, not existence.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const call = stripped.indexOf('duplicatePositionLine(db)')
  const band = stripped.indexOf('housekeepingDue(')
  assert.ok(call > 0, 'the loop still calls duplicatePositionLine')
  assert.ok(band > 0, 'the housekeeping band is still gated by housekeepingDue')
  assert.ok(call < band,
    'duplicatePositionLine must be called BEFORE the housekeeping gate — inside it the line is 8-hourly, not hourly')
})
