// The Go-Live Gate card showed the same pooled history under six per-account
// headings — including "LIVE" — because every closed trade carried a NULL
// account_id and the scoped-read convention hands NULL rows to whoever asks.
// These pin the repair AND the refusal to guess.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillTradeAccounts, accountStampCoverage } from './trade-account-backfill.js'

function trade(db, { status = 'closed', acct = null } = {}) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, status, opened_at, account_id) VALUES ('EURUSD','BUY',?,datetime('now'),?)`
  ).run(status, acct).lastInsertRowid
}
function position(db, tradeId, acct) {
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, status, account_id) VALUES ('EURUSD',?,'long','active',?)`
  ).run(tradeId, acct)
}

test('a trade learns its account from its monitored_positions row', () => {
  const db = initDB(':memory:')
  const id = trade(db)
  position(db, id, '43097342')
  const r = backfillTradeAccounts(db)
  assert.equal(r.stamped, 1)
  assert.equal(db.prepare('SELECT account_id FROM trades WHERE id = ?').get(id).account_id, '43097342')
})

test('a trade with no position row is left NULL — a wrong id is worse than unknown', () => {
  const db = initDB(':memory:')
  const id = trade(db)
  const r = backfillTradeAccounts(db)
  assert.equal(r.stamped, 0)
  assert.equal(r.unknowable, 1, 'reported as unknowable, not as pending work forever')
  assert.equal(db.prepare('SELECT account_id FROM trades WHERE id = ?').get(id).account_id, null)
})

test('an already-stamped trade is never overwritten', () => {
  const db = initDB(':memory:')
  const id = trade(db, { acct: 'ORIGINAL' })
  position(db, id, 'DIFFERENT')
  backfillTradeAccounts(db)
  assert.equal(db.prepare('SELECT account_id FROM trades WHERE id = ?').get(id).account_id, 'ORIGINAL',
    'the ledger row is the record; a later position row must not rewrite it')
})

test('idempotent — a second pass changes nothing', () => {
  const db = initDB(':memory:')
  const id = trade(db)
  position(db, id, '46130058')
  assert.equal(backfillTradeAccounts(db).stamped, 1)
  assert.equal(backfillTradeAccounts(db).stamped, 0, 'running every cycle must cost nothing once drained')
})

test('coverage reports how much of the ledger can answer "which account"', () => {
  const db = initDB(':memory:')
  const a = trade(db); position(db, a, 'X')
  trade(db)                       // unknowable
  trade(db, { acct: 'Y' })        // already stamped
  assert.equal(accountStampCoverage(db).pct, 33.3)
  backfillTradeAccounts(db)
  const c = accountStampCoverage(db)
  assert.equal(c.stamped, 2)
  assert.equal(c.unstamped, 1)
  assert.equal(c.pct, 66.7, 'a low number is information; a per-account panel that is not per-account is not')
})

test('open trades are counted too — the gap is not only historical', () => {
  const db = initDB(':memory:')
  const id = trade(db, { status: 'open' })
  position(db, id, 'Z')
  assert.equal(backfillTradeAccounts(db).stamped, 1)
})
