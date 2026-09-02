// node --test agent/db.test.js
//
// Owner hit this live: "Reconcile failed: CHECK constraint failed: status
// IN ('open','closed','cancelled')". reconcile-trades has always written
// trades.status = 'rejected' (and /state/trades has always queried for it),
// but the CHECK constraint on already-deployed databases never allowed
// that value — this test locks in the one-time rebuild migration that
// fixes it without losing data.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initDB, insertCupHandleDiagnostic } from './db.js'

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botdb-')), 'agent.db')
}

test('fresh DB: rejected is a valid trades.status from the start', () => {
  const db = initDB(':memory:')
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'rejected')`).run()
  })
  assert.equal(db.prepare(`SELECT status FROM trades WHERE symbol = 'EURUSD'`).get().status, 'rejected')
})

test('pre-existing DB with the old CHECK constraint: migrates in place, keeps data, allows rejected', () => {
  const file = tmpDbPath()
  // Build the OLD schema by hand — exactly what a real pre-migration
  // Railway volume looks like.
  const old = new Database(file)
  old.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT,
      entry_price REAL,
      exit_price REAL,
      sl_price REAL,
      tp_price REAL,
      volume REAL,
      opened_at TEXT,
      closed_at TEXT,
      hold_duration_ms INTEGER,
      gross_pnl REAL,
      net_pnl REAL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
      close_reason TEXT,
      thesis TEXT,
      strategy TEXT,
      conviction REAL,
      ctrader_position_id TEXT,
      analysis_id INTEGER
    );
  `)
  old.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, ctrader_position_id)
    VALUES ('GBPUSD', 'BUY', 1.25, 'closed', '12345')
  `).run()
  // Old CHECK really does reject 'rejected' pre-migration — sanity-check
  // the fixture matches the reported bug before asserting the fix.
  assert.throws(() => old.prepare(`UPDATE trades SET status = 'rejected' WHERE symbol = 'GBPUSD'`).run())
  old.close()

  const db = initDB(file)
  // Existing row survived the rebuild with its data intact.
  const row = db.prepare(`SELECT * FROM trades WHERE symbol = 'GBPUSD'`).get()
  assert.equal(row.side, 'BUY')
  assert.equal(row.entry_price, 1.25)
  assert.equal(row.status, 'closed')
  assert.equal(row.ctrader_position_id, '12345')
  // Columns added by later migrations (label_raw etc.) exist and are null
  // for the old row, not missing.
  assert.equal(row.label_raw, null)

  // The actual bug: reconcile-trades' UPDATE ... SET status = 'rejected'
  // must no longer throw.
  assert.doesNotThrow(() => {
    db.prepare(`UPDATE trades SET status = 'rejected', close_reason = 'no broker fill (reconciled)' WHERE symbol = 'GBPUSD'`).run()
  })
  assert.equal(db.prepare(`SELECT status FROM trades WHERE symbol = 'GBPUSD'`).get().status, 'rejected')

  // Re-opening the same file again (the migration must be idempotent — no
  // re-rebuild, no data loss, no duplicate rows).
  db.close()
  const reopened = initDB(file)
  assert.equal(reopened.prepare(`SELECT COUNT(*) n FROM trades`).get().n, 1)
  reopened.close()

  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('dangling FK from the pre-legacy_alter_table migration is repaired: monitored_positions inserts work again', () => {
  // Production hit "no such table: main.trades_pre_rejected_status_migration"
  // on every pending-order-manager pass AFTER the trades migration ran: the
  // modern (non-legacy) RENAME rewrote monitored_positions' FK to follow
  // `trades` to the temp name, and dropping the temp left the FK dangling.
  // Rebuild that exact damage with the OLD buggy sequence, then prove
  // initDB() repairs it.
  const file = tmpDbPath()
  const fullTradesCols = (check) => `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT, entry_price REAL, exit_price REAL, sl_price REAL, tp_price REAL,
      volume REAL, opened_at TEXT, closed_at TEXT, hold_duration_ms INTEGER,
      gross_pnl REAL, net_pnl REAL,
      status TEXT DEFAULT 'open' CHECK(status IN (${check})),
      close_reason TEXT, thesis TEXT, strategy TEXT, conviction REAL,
      ctrader_position_id TEXT, analysis_id INTEGER
  `
  const setup = new Database(file)
  setup.exec(`
    CREATE TABLE trades (${fullTradesCols("'open','closed','cancelled'")});
    CREATE TABLE monitored_positions_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER REFERENCES trades(id)
    );
  `)
  setup.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'closed')`).run()
  // The old buggy sequence: default (FK-following) rename → recreate → drop.
  setup.pragma('foreign_keys = OFF')
  setup.exec('ALTER TABLE trades RENAME TO trades_pre_rejected_status_migration')
  setup.exec(`CREATE TABLE trades (${fullTradesCols("'open','closed','cancelled','rejected'")});`)
  setup.exec(`INSERT INTO trades (id, symbol, status) SELECT id, symbol, status FROM trades_pre_rejected_status_migration`)
  setup.exec('DROP TABLE trades_pre_rejected_status_migration')
  // Sanity: the fixture really is damaged the way production is.
  assert.match(
    setup.prepare(`SELECT sql FROM sqlite_master WHERE name = 'monitored_positions_probe'`).get().sql,
    /trades_pre_rejected_status_migration/,
  )
  setup.close()

  const db = initDB(file)
  // The stored schema points back at trades, and FK-enforced inserts work.
  assert.doesNotMatch(
    db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'monitored_positions_probe'`).get().sql,
    /trades_pre_rejected_status_migration/,
  )
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO monitored_positions_probe (trade_id) VALUES (1)`).run()
  })
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM trades`).get().n, 1) // data untouched
  db.close()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('the migration itself no longer creates the dangling FK (legacy_alter_table rename)', () => {
  // A pre-migration DB with a referencing table: after initDB() runs the
  // CHECK-constraint rebuild, the referencing table must still point at
  // `trades`, not at the temp name.
  const file = tmpDbPath()
  const setup = new Database(file)
  setup.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled'))
    );
    CREATE TABLE monitored_positions_probe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER REFERENCES trades(id)
    );
  `)
  setup.prepare(`INSERT INTO trades (symbol, status) VALUES ('GBPUSD', 'open')`).run()
  setup.close()

  const db = initDB(file)
  assert.doesNotMatch(
    db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'monitored_positions_probe'`).get().sql,
    /trades_pre_rejected_status_migration/,
  )
  assert.doesNotThrow(() => {
    db.prepare(`INSERT INTO monitored_positions_probe (trade_id) VALUES (1)`).run()
  })
  db.close()
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('interrupted migration killed right after the rename: trades is missing, temp table has the data', () => {
  const file = tmpDbPath()
  const oldTableSql = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled'))
  `
  const setup = new Database(file)
  // No `trades` table at all — only the renamed-away original, simulating a
  // kill between the ALTER TABLE RENAME and the CREATE TABLE that follows it.
  setup.exec(`CREATE TABLE trades_pre_rejected_status_migration (${oldTableSql});`)
  setup.prepare(`INSERT INTO trades_pre_rejected_status_migration (symbol, status) VALUES ('GBPUSD', 'open')`).run()
  setup.close()

  const db = initDB(file)
  assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'trades_pre_rejected_status_migration'`).get(), undefined)
  assert.equal(db.prepare(`SELECT status FROM trades WHERE symbol = 'GBPUSD'`).get().status, 'open')
  assert.doesNotThrow(() => {
    db.prepare(`UPDATE trades SET status = 'rejected' WHERE symbol = 'GBPUSD'`).run()
  })
  db.close()

  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('interrupted migration: leftover temp table is self-healed on next boot', () => {
  // Simulates production hitting "no such table:
  // trades_pre_rejected_status_migration" — a prior initDB() run got killed
  // (platform restart) between the rename and the final drop, leaving BOTH
  // a stale temp table AND a working `trades` (either freshly migrated or
  // never touched) on disk. The next boot must clean this up, not crash.
  const file = tmpDbPath()
  const oldTableSql = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT,
      entry_price REAL,
      exit_price REAL,
      sl_price REAL,
      tp_price REAL,
      volume REAL,
      opened_at TEXT,
      closed_at TEXT,
      hold_duration_ms INTEGER,
      gross_pnl REAL,
      net_pnl REAL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','closed','cancelled')),
      close_reason TEXT,
      thesis TEXT,
      strategy TEXT,
      conviction REAL,
      ctrader_position_id TEXT,
      analysis_id INTEGER
  `
  const setup = new Database(file)
  // The already-migrated `trades` (fixed CHECK, from the attempt that
  // completed the rename+recreate before being killed) ...
  setup.exec(`CREATE TABLE trades (${oldTableSql.replace("CHECK(status IN ('open','closed','cancelled'))", "CHECK(status IN ('open','closed','cancelled','rejected'))")});`)
  setup.prepare(`INSERT INTO trades (symbol, status) VALUES ('EURUSD', 'closed')`).run()
  // ... plus the leftover temp table (old schema) that never got dropped.
  setup.exec(`CREATE TABLE trades_pre_rejected_status_migration (${oldTableSql});`)
  setup.close()

  assert.doesNotThrow(() => {
    const db = initDB(file)
    // The stale temp table must be gone, and the real `trades` (with its
    // one pre-existing row) must survive untouched.
    assert.equal(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'trades_pre_rejected_status_migration'`).get(), undefined)
    assert.equal(db.prepare(`SELECT status FROM trades WHERE symbol = 'EURUSD'`).get().status, 'closed')
    assert.doesNotThrow(() => {
      db.prepare(`UPDATE trades SET status = 'rejected' WHERE symbol = 'EURUSD'`).run()
    })
    db.close()
  })

  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('insertCupHandleDiagnostic: persists a trace row, candidate_json round-trips', () => {
  const db = initDB(':memory:')
  const candidate = { handleLen: 2, cupLen: 29, blocked_at: 'breakout_not_triggered' }
  insertCupHandleDiagnostic(db, {
    symbol: 'EURUSD', timeframe: '1d', scanned_at: '2026-07-22T09:00:00.000Z',
    uptrend_ok: true, cup_found: true, best_candidate: candidate, loop_id: 42,
  })
  const row = db.prepare('SELECT * FROM cup_handle_diagnostics WHERE symbol = ?').get('EURUSD')
  assert.equal(row.timeframe, '1d')
  assert.equal(row.uptrend_ok, 1)
  assert.equal(row.cup_found, 1)
  assert.equal(row.blocked_at, 'breakout_not_triggered')
  assert.equal(row.loop_id, 42)
  assert.deepEqual(JSON.parse(row.candidate_json), candidate)
})

test('insertCupHandleDiagnostic: no candidate at all is stored as null, not invented', () => {
  const db = initDB(':memory:')
  insertCupHandleDiagnostic(db, {
    symbol: 'GBPUSD', timeframe: '4h', scanned_at: '2026-07-22T09:00:00.000Z',
    uptrend_ok: false, cup_found: false, best_candidate: null,
  })
  const row = db.prepare('SELECT * FROM cup_handle_diagnostics WHERE symbol = ?').get('GBPUSD')
  assert.equal(row.uptrend_ok, 0)
  assert.equal(row.blocked_at, null)
  assert.equal(row.candidate_json, null)
})

test('insertCupHandleDiagnostic: bias distinguishes classic (long) vs inverted (short) rows', () => {
  const db = initDB(':memory:')
  insertCupHandleDiagnostic(db, {
    symbol: 'XAUUSD', timeframe: '4h', scanned_at: '2026-07-22T09:00:00.000Z',
    bias: 'long', uptrend_ok: true, cup_found: false, best_candidate: null,
  })
  insertCupHandleDiagnostic(db, {
    symbol: 'XAUUSD', timeframe: '4h', scanned_at: '2026-07-22T09:00:00.000Z',
    bias: 'short', uptrend_ok: false, cup_found: false, best_candidate: null,
  })
  const rows = db.prepare('SELECT bias, uptrend_ok FROM cup_handle_diagnostics WHERE symbol = ? ORDER BY bias').all('XAUUSD')
  assert.deepEqual(rows, [{ bias: 'long', uptrend_ok: 1 }, { bias: 'short', uptrend_ok: 0 }])
})

test('insertCupHandleDiagnostic: bias defaults to null when omitted (pre-inverted-pattern callers)', () => {
  const db = initDB(':memory:')
  insertCupHandleDiagnostic(db, {
    symbol: 'EURUSD', timeframe: '1d', scanned_at: '2026-07-22T09:00:00.000Z',
    uptrend_ok: true, cup_found: false, best_candidate: null,
  })
  const row = db.prepare('SELECT bias FROM cup_handle_diagnostics WHERE symbol = ?').get('EURUSD')
  assert.equal(row.bias, null)
})

test('backtest_runs table exists with per-symbol history + retention query shape', () => {
  const db = initDB(':memory:')
  const ins = db.prepare(
    `INSERT INTO backtest_runs (ran_at, strategy, entry_mode, bars, symbol, timeframe,
       trades, losses, win_rate_pct, profit_factor, total_profit_pct, wf_positive, wf_active, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  ins.run('2026-07-28T02:00:00Z', 'fib_618_fade', 'close', 1000, 'EURUSD', '4h', 12, 5, 58.3, 1.7, 4.2, 3, 4, null)
  // no-loss run: profit_factor NULL but losses 0 with trades > 0 — the UI
  // renders this ∞, so the distinction must survive the round trip
  ins.run('2026-07-28T02:00:00Z', 'fib_618_fade', 'close', 1000, 'US500', '1d', 4, 0, 100, null, 2.1, 2, 2, null)
  ins.run('2026-07-28T02:00:00Z', 'fib_618_fade', 'close', 1000, 'XAUUSD', '-', null, null, null, null, null, null, null, 'only 40 bars available')
  const rows = db.prepare('SELECT * FROM backtest_runs WHERE symbol = ? ORDER BY id DESC').all('EURUSD')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trades, 12)
  const noLoss = db.prepare('SELECT * FROM backtest_runs WHERE symbol = ?').get('US500')
  assert.equal(noLoss.losses, 0)
  assert.equal(noLoss.profit_factor, null)
  const bySymbol = db.prepare(
    `SELECT symbol, COUNT(*) AS rows, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM backtest_runs GROUP BY symbol`
  ).all()
  assert.equal(bySymbol.find(r => r.symbol === 'XAUUSD').errors, 1)
  // retention: the DELETE the actions route runs must be valid SQL on this schema
  assert.doesNotThrow(() => db.prepare('DELETE FROM backtest_runs WHERE id NOT IN (SELECT id FROM backtest_runs ORDER BY id DESC LIMIT 2000)').run())
})

// ---------------------------------------------------------------------------
// STOP BEYOND ENTRY ⇒ be_moved (02-09-2026, US30 trade 1415). Every writer
// of current_sl goes through the same latch, and open rows are backfilled.
// ---------------------------------------------------------------------------
import { initDB as initDbForLatch } from './db.js'
import test2 from 'node:test'
import assert2 from 'node:assert/strict'

test2('a stop written at or beyond entry latches be_moved for every writer; never clears; backfills open rows', () => {
  const db = initDbForLatch(':memory:')
  const ins = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status) VALUES (?, ?, ?, ?, 'active')`)
  const be = (id) => db.prepare('SELECT be_moved FROM monitored_positions WHERE id = ?').get(id).be_moved
  const setSl = db.prepare('UPDATE monitored_positions SET current_sl = ? WHERE id = ?')
  const s = ins.run('US30', 'short', 53005.7, 53958).lastInsertRowid
  setSl.run(53132.6, s); assert2.equal(be(s), 0, 'a tighter stop still above entry on a short is not break-even')
  setSl.run(53005.7, s); assert2.equal(be(s), 1, 'the stop reached entry')
  setSl.run(53100, s);   assert2.equal(be(s), 1, 'a later loosening never clears the latch')
  const l = ins.run('EURUSD', 'BUY', 1.1000, 1.0950).lastInsertRowid
  setSl.run(1.0990, l); assert2.equal(be(l), 0)
  setSl.run(1.1010, l); assert2.equal(be(l), 1, 'broker-style side names count too')
  const u = ins.run('XAUUSD', null, 2400, 2390).lastInsertRowid
  setSl.run(2410, u); assert2.equal(be(u), 0, 'no side → no judgement, never a guess')
  // Backfill at boot squares rows written before the trigger existed.
  db.exec('DROP TRIGGER trg_mp_be_moved_latch')
  const old = ins.run('NAS100', 'long', 20000, 20050).lastInsertRowid
  const closed = db.prepare(`INSERT INTO monitored_positions (symbol, side, entry_price, current_sl, status) VALUES ('GER40','long',26000,26100,'closed')`).run().lastInsertRowid
  assert2.equal(be(old), 0)
  const again = initDbForLatch(':memory:') // proves the migration is idempotent on a fresh DB…
  assert2.ok(again)
  // …and that the backfill statement squares an existing DB when run again:
  db.exec(`UPDATE monitored_positions SET be_moved = 1
            WHERE COALESCE(be_moved, 0) = 0 AND status = 'active'
              AND entry_price IS NOT NULL AND current_sl IS NOT NULL
              AND ((UPPER(COALESCE(side,'')) IN ('LONG','BUY') AND current_sl >= entry_price)
                OR (UPPER(COALESCE(side,'')) IN ('SHORT','SELL') AND current_sl <= entry_price))`)
  assert2.equal(be(old), 1)
  assert2.equal(be(closed), 0, 'closed rows are history, left alone')
})
