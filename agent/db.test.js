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
