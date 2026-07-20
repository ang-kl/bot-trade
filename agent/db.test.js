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
import { initDB } from './db.js'

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
