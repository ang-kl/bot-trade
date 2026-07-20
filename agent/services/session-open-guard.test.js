// node --test agent/services/session-open-guard.test.js
//
// Session-open guard: during the first minutes after a major session opens,
// a bot position already in decent profit gets its SL locked to breakeven —
// the +0.7R ladder hasn't reached it yet, and opens are where reversals hit
// hardest (owner: XAUUSD +$218 → −$261 across a session open).

import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  sessionJustOpened, runSessionOpenGuard, loadSessionOpenGuardConfig, DEFAULT_SESSION_OPEN_GUARD,
  resetSessionOpenGuardMemory,
} from './session-open-guard.js'

beforeEach(() => resetSessionOpenGuardMemory())

const CREDS = { ready: true, host: 'demo', clientId: 'id', clientSecret: 's', accessToken: 't', accountId: '1' }

// London opens 08:00 UTC (lib/sessions.js) — a fixed clock 10 minutes after.
const LONDON_OPEN_PLUS_10 = Date.UTC(2026, 6, 21, 8, 10)

function mkDb({ sl = 1.0950, entry = 1.1000, beMoved = 0, source = 'autopilot' } = {}) {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  db.prepare(`
    INSERT INTO monitored_positions
      (symbol, side, entry_price, current_sl, current_tp, initial_risk, be_moved, status, source, strategy, created_at)
    VALUES ('EURUSD', 'BUY', ?, ?, 1.1200, 0.0050, ?, 'active', ?, 'fib_618_fade', datetime('now'))
  `).run(entry, sl, beMoved, source)
  return db
}

// Price 1.1020 on entry 1.1000 / risk 0.0050 → +0.4R: above the 0.3R
// threshold, below the normal +0.7R breakeven ladder — the guard's zone.
function deps({ mid = 1.1020, brokerCalls = [] } = {}) {
  return {
    ws: { wsGetSpotOnce: async () => ({ bid: mid - 0.0001, ask: mid + 0.0001 }) },
    loop: {
      prepareStatements: (db) => ({
        updatePositionCheck: db.prepare(
          `UPDATE monitored_positions SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ? WHERE id = ?`
        ),
      }),
      executeBrokerAction: async (db, s, pos, eval_) => {
        brokerCalls.push({ symbol: pos.symbol, ...eval_ })
        db.prepare(`UPDATE monitored_positions SET current_sl = ? WHERE id = ?`).run(eval_.newSL, pos.id)
        return { summary: `SL → ${eval_.newSL}` }
      },
    },
    now: () => LONDON_OPEN_PLUS_10,
  }
}

test('sessionJustOpened: inside/outside the window, midnight wrap, nearest session wins', () => {
  const at = (h, m) => new Date(Date.UTC(2026, 6, 21, h, m))
  assert.equal(sessionJustOpened(at(8, 10), 30)?.id, 'london')
  assert.equal(sessionJustOpened(at(8, 29), 30)?.id, 'london')
  // London +31m is outside a 30m window; no other session opened within it.
  assert.equal(sessionJustOpened(at(8, 31), 30), null)
  // 00:05 → Tokyo (opens 00 UTC); 22:10 → Sydney (opens 22 UTC, wraps midnight).
  assert.equal(sessionJustOpened(at(0, 5), 30)?.id, 'tokyo')
  assert.equal(sessionJustOpened(at(22, 10), 30)?.id, 'sydney')
  assert.equal(sessionJustOpened(at(14, 5), 30)?.id, 'nyse')
})

test('config: defaults + clamped overrides', () => {
  const db = initDB(':memory:')
  assert.deepEqual(loadSessionOpenGuardConfig(db), DEFAULT_SESSION_OPEN_GUARD)
  setState(db, 'session_open_guard_json', JSON.stringify({ on: true, windowMin: 999, minR: 5 }))
  const cfg = loadSessionOpenGuardConfig(db)
  assert.equal(cfg.windowMin, 120)
  assert.equal(cfg.minR, 0.69) // must stay below the +0.7R ladder or it would shadow it
})

test('locks SL to breakeven on a +0.4R position during the open window, stamps a checkpoint', async () => {
  const db = mkDb()
  const brokerCalls = []
  const out = await runSessionOpenGuard(db, CREDS, deps({ brokerCalls }))
  assert.equal(out.locked, 1)
  assert.equal(brokerCalls.length, 1)
  assert.equal(brokerCalls[0].action, 'MOVE_SL')
  assert.equal(brokerCalls[0].newSL, 1.1000) // breakeven = entry
  assert.match(brokerCalls[0].reason, /London/)
  const row = db.prepare(`SELECT current_sl, last_check_action FROM monitored_positions WHERE symbol = 'EURUSD'`).get()
  assert.equal(row.current_sl, 1.1000)
  assert.equal(row.last_check_action, 'GUARD:BE')
})

test('acts once per position per session open — second pass is a no-op', async () => {
  const db = mkDb()
  const brokerCalls = []
  await runSessionOpenGuard(db, CREDS, deps({ brokerCalls }))
  await runSessionOpenGuard(db, CREDS, deps({ brokerCalls }))
  assert.equal(brokerCalls.length, 1)
})

test('below minR profit is left alone; a loss is never touched', async () => {
  const db = mkDb()
  const brokerCalls = []
  // +0.1R — below the 0.3R threshold.
  const out1 = await runSessionOpenGuard(db, CREDS, deps({ mid: 1.1005, brokerCalls }))
  assert.equal(out1.locked, 0)
  // −0.4R — losing.
  const out2 = await runSessionOpenGuard(db, CREDS, deps({ mid: 1.0980, brokerCalls }))
  assert.equal(out2.locked, 0)
  assert.equal(brokerCalls.length, 0)
})

test('never loosens: SL already above entry stays put; be_moved and external positions are skipped', async () => {
  // SL already trailed above entry — breakeven would LOOSEN it.
  const trailed = mkDb({ sl: 1.1010 })
  const calls1 = []
  await runSessionOpenGuard(trailed, CREDS, deps({ brokerCalls: calls1 }))
  assert.equal(calls1.length, 0)
  assert.equal(trailed.prepare(`SELECT current_sl FROM monitored_positions`).get().current_sl, 1.1010)

  const alreadyBe = mkDb({ beMoved: 1 })
  const calls2 = []
  const outBe = await runSessionOpenGuard(alreadyBe, CREDS, deps({ brokerCalls: calls2 }))
  assert.equal(outBe.skipped, 'no eligible positions')

  const external = mkDb({ source: 'external' })
  const calls3 = []
  const outExt = await runSessionOpenGuard(external, CREDS, deps({ brokerCalls: calls3 }))
  assert.equal(outExt.skipped, 'no eligible positions')
})

test('outside every open window: pure no-op, no price fetches', async () => {
  const db = mkDb()
  const d = deps()
  d.now = () => Date.UTC(2026, 6, 21, 12, 0) // 12:00 UTC — no session opened within 30m
  d.ws = { wsGetSpotOnce: async () => { throw new Error('must not fetch prices outside the window') } }
  const out = await runSessionOpenGuard(db, CREDS, d)
  assert.equal(out.skipped, 'no session opening')
})

test('off switch works', async () => {
  const db = mkDb()
  setState(db, 'session_open_guard_json', JSON.stringify({ on: false }))
  const out = await runSessionOpenGuard(db, CREDS, deps())
  assert.equal(out.skipped, 'off')
})
