// node --test agent/services/fast-monitor-hold-checkpoint.test.js
//
// Owner (2026-07-20): "Eurusd and Audusd have plunged to >$150 -ve after
// more than 2 or four hours of trading? Why are you monitoring" — traced to
// a HOLD verdict never writing last_check_action/last_check_at, so a
// position checked every cycle for hours looked identical in the UI to one
// that was never touched at all. This locks in the fix: a HOLD tick now
// always stamps a checkpoint.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { runFastMonitor } from './fast-monitor.js'

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

function mkDb() {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, status, source, strategy, created_at)
    VALUES ('EURUSD', 'BUY', 1.1000, 1.0950, 1.1200, 0.0050, 'active', 'autopilot', 'fib_618_fade', datetime('now'))
  `).run()
  return db
}

function deps() {
  return {
    ws: {
      wsGetTrendbarsBatch: async () => ({ '1m': [] }), // too few bars → relVol NaN, middle pace — fine
      wsGetSpotOnce: async () => ({ bid: 1.1005, ask: 1.1007 }), // price near entry — well below any trigger R
    },
    now: () => Date.now(),
  }
}

test('a HOLD verdict still stamps last_check_action/last_check_at — not a silent no-op', async () => {
  const db = mkDb()
  const before = db.prepare(`SELECT last_check_action, last_check_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.equal(before.last_check_action, null, 'sanity: nothing recorded yet')

  const out = await runFastMonitor(db, CREDS, deps())
  assert.equal(out.checked, 1)
  assert.equal(out.acted, 0)

  const after = db.prepare(`SELECT last_check_action, last_check_reasoning, last_check_at FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.equal(after.last_check_action, 'FAST:HOLD')
  assert.ok(after.last_check_reasoning?.startsWith('hold ('), `reasoning should carry the real R/mfe/mae, got: ${after.last_check_reasoning}`)
  assert.ok(after.last_check_at, 'last_check_at must be stamped — this is exactly what read as "not checked yet" before the fix')
})

test('external positions are skipped entirely (observe-only) — no checkpoint from fast-monitor', async () => {
  const db = mkDb()
  db.prepare(`UPDATE monitored_positions SET source = 'external' WHERE symbol = 'EURUSD'`).run()
  const out = await runFastMonitor(db, CREDS, deps())
  assert.equal(out.checked, 0)
  const after = db.prepare(`SELECT last_check_action FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.equal(after.last_check_action, null)
})
