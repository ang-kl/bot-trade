// node --test agent/keeper-integration.test.js
//
// Integration tests for the keeper = position-manager driven by the real
// monitor-phase prepared statements from loop.js. Unlike the unit tests in
// agent/services/position-manager.test.js which exercise the pure evaluator,
// these run against an in-memory SQLite DB so they catch wiring regressions:
//
//   - persisted flags (be_moved / scaled_out) actually flip between ticks
//   - MFE/MAE monotonically accumulate across the UPDATE round-trip
//   - MOVE_SL, PARTIAL_EXIT and FULL_EXIT mutate the row in the DB
//   - scoping invariants (source/paused/status) hold end-to-end
//
// The harness simulates exactly what agent/loop.js lines 549–620 do: fetch
// active rows, evaluate, persist metrics, log the action, and close on exit.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from './db.js'
import { evaluatePosition } from './services/position-manager.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function mkDb() {
  return initDB(':memory:')
}

function prep(db) {
  return {
    selectActive: db.prepare(
      `SELECT * FROM monitored_positions
       WHERE status = ?
         AND COALESCE(paused, 0) = 0
         AND (source IS NULL OR source = 'autopilot')`,
    ),
    updateMetrics: db.prepare(`
      UPDATE monitored_positions
      SET mfe_r = ?, mae_r = ?, be_moved = ?, scaled_out = ?
      WHERE id = ?
    `),
    updateSL: db.prepare(
      `UPDATE monitored_positions SET current_sl = ? WHERE id = ?`,
    ),
    updateCheck: db.prepare(`
      UPDATE monitored_positions
      SET last_check_action = ?, last_check_reasoning = ?, last_check_at = ?, thesis_status = ?
      WHERE id = ?
    `),
    closePos: db.prepare(
      `UPDATE monitored_positions SET status = ? WHERE id = ?`,
    ),
  }
}

/**
 * Seed a monitored position the way autoTrade() does. Defaults to a long
 * XAUUSD at 3400 with 20-point risk (SL 3380), 10 minutes old, autopilot.
 */
function seedPosition(db, overrides = {}) {
  const row = {
    symbol: 'XAUUSD',
    side: 'long',
    entry_price: 3400,
    current_sl: 3380,
    current_tp: 3460,
    thesis: 'trend continuation',
    initial_risk: 20,
    invalidation_trigger: null,
    time_cap_at: null,
    strategy: 'trend',
    source: 'autopilot',
    label_raw: 'AP|v1|TREND|HI|LDN|H1|TREND',
    paused: 0,
    status: 'active',
    ...overrides,
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO monitored_positions (
      symbol, side, entry_price, current_sl, current_tp, thesis, initial_risk,
      invalidation_trigger, time_cap_at, strategy, source, label_raw, paused, status
    ) VALUES (
      @symbol, @side, @entry_price, @current_sl, @current_tp, @thesis, @initial_risk,
      @invalidation_trigger, @time_cap_at, @strategy, @source, @label_raw, @paused, @status
    )
  `).run(row)
  // Back-date created_at when supplied. Default DEFAULT (datetime('now')) is fine otherwise.
  if (overrides.created_at) {
    db.prepare(`UPDATE monitored_positions SET created_at = ? WHERE id = ?`)
      .run(overrides.created_at, lastInsertRowid)
  }
  return lastInsertRowid
}

/**
 * Run one monitor-phase tick against a given currentPrice for every active
 * position. Mirrors loop.js lines 549–620 but without the LLM fallback.
 * Returns the array of {pos, eval} pairs so tests can assert on actions.
 */
function tick(db, stmts, currentPrice, { now } = {}) {
  const rows = stmts.selectActive.all('active')
  const results = []
  for (const pos of rows) {
    const res = evaluatePosition(pos, { currentPrice, now })

    stmts.updateMetrics.run(
      res.updates.mfe_r ?? pos.mfe_r ?? 0,
      res.updates.mae_r ?? pos.mae_r ?? 0,
      res.updates.be_moved ?? pos.be_moved ?? 0,
      res.updates.scaled_out ?? pos.scaled_out ?? 0,
      pos.id,
    )

    if (res.action === 'MOVE_SL' && res.newSL != null) {
      stmts.updateSL.run(res.newSL, pos.id)
    }
    if (res.action === 'PARTIAL_EXIT' && res.newSL != null) {
      stmts.updateSL.run(res.newSL, pos.id)
    }
    if (res.action !== 'HOLD') {
      stmts.updateCheck.run(
        `PM:${res.action}`,
        res.reason,
        (now instanceof Date ? now : new Date()).toISOString(),
        res.action === 'FULL_EXIT' ? 'broken' : 'intact',
        pos.id,
      )
    }
    if (res.action === 'FULL_EXIT') {
      stmts.closePos.run('closed', pos.id)
    }
    results.push({ pos, eval: res })
  }
  return results
}

function readPos(db, id) {
  return db.prepare(`SELECT * FROM monitored_positions WHERE id = ?`).get(id)
}

// ---------------------------------------------------------------------------
// 1. Happy-path lifecycle: BE → partial → runner → stop-hit
// ---------------------------------------------------------------------------

test('lifecycle: long runs BE → partial → runner → stop-out', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db) // long XAU 3400, SL 3380, risk 20

  // Tick 1: price at 3414 → +0.7R → BE move to entry
  let res = tick(db, stmts, 3414)[0].eval
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3400, 'BE move parks SL at entry')
  let row = readPos(db, id)
  assert.equal(row.current_sl, 3400, 'DB reflects BE move')
  assert.equal(row.be_moved, 1, 'be_moved flag persisted')
  assert.ok(row.mfe_r >= 0.69 && row.mfe_r <= 0.71, `mfe_r≈0.7, got ${row.mfe_r}`)

  // Tick 2: price at 3430 → +1.5R → partial exit + trail SL to +0.5R (3410)
  res = tick(db, stmts, 3430)[0].eval
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.equal(res.exitFraction, 0.5)
  assert.equal(res.newSL, 3410, 'partial-exit trails SL to +0.5R')
  row = readPos(db, id)
  assert.equal(row.current_sl, 3410)
  assert.equal(row.scaled_out, 1)
  assert.equal(row.be_moved, 1, 'be_moved remains set after partial')

  // Tick 3: price at 3450 → +2.5R → runner trail (r - 1R = 1.5R → SL=3430)
  res = tick(db, stmts, 3450)[0].eval
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3430, 'runner trails 1R behind current (1.5R from entry)')
  row = readPos(db, id)
  assert.equal(row.current_sl, 3430)

  // Tick 4: price retraces to 3460 → +3R → runner trails further to +2R (3440)
  res = tick(db, stmts, 3460)[0].eval
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(res.newSL, 3440)
  row = readPos(db, id)
  assert.equal(row.current_sl, 3440)
  assert.ok(row.mfe_r >= 2.99 && row.mfe_r <= 3.01)

  // Tick 5: price collapses to 3435 → no further MOVE_SL (trail would loosen)
  // current_sl already 3440; new trail would be 3415 which is looser → HOLD.
  res = tick(db, stmts, 3435)[0].eval
  assert.equal(res.action, 'HOLD')
  row = readPos(db, id)
  assert.equal(row.current_sl, 3440, 'SL is not widened on retracement')

  // Row stays active — the keeper never auto-closes on "price below SL" in the
  // loop; the broker fires the stop. The DB should still be active here.
  assert.equal(row.status, 'active')
})

// ---------------------------------------------------------------------------
// 2. Time-cap expiry
// ---------------------------------------------------------------------------

test('time cap: expired position closes with FULL_EXIT', () => {
  const db = mkDb()
  const stmts = prep(db)
  const now = new Date('2026-04-18T12:00:00Z')
  const id = seedPosition(db, {
    time_cap_at: '2026-04-18T11:30:00Z', // 30 min past
  })

  const res = tick(db, stmts, 3405, { now })[0].eval
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /time_cap_expired/)

  const row = readPos(db, id)
  assert.equal(row.status, 'closed', 'DB row marked closed')
  assert.equal(row.thesis_status, 'broken')
  assert.equal(row.last_check_action, 'PM:FULL_EXIT')
})

test('time cap: future cap does not fire', () => {
  const db = mkDb()
  const stmts = prep(db)
  const now = new Date('2026-04-18T12:00:00Z')
  const id = seedPosition(db, {
    time_cap_at: '2026-04-18T14:00:00Z', // 2h away
  })

  const res = tick(db, stmts, 3405, { now })[0].eval
  assert.equal(res.action, 'HOLD')
  assert.equal(readPos(db, id).status, 'active')
})

// ---------------------------------------------------------------------------
// 3. Price-based invalidation trigger
// ---------------------------------------------------------------------------

test('invalidation: long with price<X trigger exits when breached', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db, { invalidation_trigger: 'price<3390' })

  // Above threshold → HOLD
  let res = tick(db, stmts, 3395)[0].eval
  assert.equal(res.action, 'HOLD')
  assert.equal(readPos(db, id).status, 'active')

  // Breach → FULL_EXIT
  res = tick(db, stmts, 3389)[0].eval
  assert.equal(res.action, 'FULL_EXIT')
  assert.match(res.reason, /invalidation_trigger/)
  assert.equal(readPos(db, id).status, 'closed')
})

test('invalidation: free-text trigger defers (no FULL_EXIT)', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db, {
    invalidation_trigger: 'close below 3390 on 15m with >1.5x volume',
  })

  const res = tick(db, stmts, 3385)[0].eval
  // Position-manager ignores free-text — should HOLD (LLM would handle it).
  assert.equal(res.action, 'HOLD')
  assert.equal(readPos(db, id).status, 'active')
})

// ---------------------------------------------------------------------------
// 4. Failed-trade path: never reaches BE, MAE accumulates
// ---------------------------------------------------------------------------

test('failed trade: never reaches BE, MAE monotonically tracks worst drawdown', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db) // SL 3380, entry 3400

  // Drift down through the risk bucket
  tick(db, stmts, 3395) // -0.25R
  let row = readPos(db, id)
  assert.ok(row.mae_r <= -0.24 && row.mae_r >= -0.26, `mae≈-0.25, got ${row.mae_r}`)

  tick(db, stmts, 3388) // -0.6R
  row = readPos(db, id)
  assert.ok(row.mae_r <= -0.59 && row.mae_r >= -0.61)
  assert.equal(row.be_moved, 0, 'never hit BE threshold')
  assert.equal(row.scaled_out, 0, 'never scaled out')

  // Partial recovery — MAE stays at worst seen
  tick(db, stmts, 3393)
  row = readPos(db, id)
  assert.ok(row.mae_r <= -0.59, 'MAE is monotonic — never improves')
  // MFE never went positive so stays at 0 (seeded default, not currentR(3393))
  assert.equal(row.mfe_r, 0, 'MFE remains at seeded floor when price never > entry')
})

// ---------------------------------------------------------------------------
// 5. Short-side mirror: confirms direction-aware math round-trips
// ---------------------------------------------------------------------------

test('short-side: EURUSD runs BE at 0.7R, partial at 1.5R', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db, {
    symbol: 'EURUSD',
    side: 'short',
    entry_price: 1.1000,
    current_sl: 1.1020,
    current_tp: 1.0940,
    initial_risk: 0.0020,
    label_raw: 'AP|v1|RANGE|MED|LDN|H1|RANGE',
  })

  // -0.7R for a short = entry - 0.7*risk = 1.0986
  let res = tick(db, stmts, 1.0986)[0].eval
  assert.equal(res.action, 'MOVE_SL')
  assert.ok(Math.abs(res.newSL - 1.1000) < 1e-9, 'BE at entry for short')
  let row = readPos(db, id)
  assert.ok(Math.abs(row.current_sl - 1.1000) < 1e-9)
  assert.equal(row.be_moved, 1)

  // -1.5R for a short = 1.0970 → partial + trail SL to entry - 0.5R = 1.0990
  res = tick(db, stmts, 1.0970)[0].eval
  assert.equal(res.action, 'PARTIAL_EXIT')
  assert.ok(Math.abs(res.newSL - 1.0990) < 1e-9, 'partial trails 0.5R favorably for short')
  row = readPos(db, id)
  assert.ok(Math.abs(row.current_sl - 1.0990) < 1e-9)
  assert.equal(row.scaled_out, 1)
})

// ---------------------------------------------------------------------------
// 6. Scoping invariants: keeper must not touch copilot/manual/paused
// ---------------------------------------------------------------------------

test('scoping: copilot position is invisible to the keeper even at BE trigger', () => {
  const db = mkDb()
  const stmts = prep(db)
  const copilotId = seedPosition(db, {
    source: 'copilot',
    label_raw: 'CP|v1|-|-|-|-|-',
  })
  const autopilotId = seedPosition(db, {
    symbol: 'GBPUSD',
    entry_price: 1.25,
    current_sl: 1.245,
    current_tp: 1.26,
    initial_risk: 0.005,
    source: 'autopilot',
    label_raw: 'AP|v1|TREND|HI|LDN|H1|TREND',
  })

  // Price at 3414 (+0.7R for the XAU copilot row). Keeper should ignore it.
  const results = tick(db, stmts, 3414)
  const touched = results.map(r => r.pos.id)
  assert.deepEqual(touched.sort(), [autopilotId].sort(), 'only the autopilot row is processed')

  const copilotRow = readPos(db, copilotId)
  assert.equal(copilotRow.current_sl, 3380, 'copilot SL untouched')
  assert.equal(copilotRow.be_moved, 0, 'copilot be_moved flag untouched')
  assert.equal(copilotRow.mfe_r, 0, 'copilot MFE untouched')
  assert.equal(copilotRow.last_check_action, null, 'copilot row never written to')
})

test('scoping: paused autopilot position is skipped', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db, { paused: 1 })

  const results = tick(db, stmts, 3450) // would be 2.5R
  assert.equal(results.length, 0, 'no rows returned to the keeper')

  const row = readPos(db, id)
  assert.equal(row.current_sl, 3380, 'paused row is frozen')
  assert.equal(row.be_moved, 0)
})

test('scoping: legacy NULL-source rows are processed (pre-migration autopilot)', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db, { source: null, label_raw: null })

  const res = tick(db, stmts, 3414)[0].eval
  assert.equal(res.action, 'MOVE_SL')
  assert.equal(readPos(db, id).be_moved, 1)
})

// ---------------------------------------------------------------------------
// 7. Idempotency: re-ticking at the same R past BE doesn't flip flags twice
// ---------------------------------------------------------------------------

test('idempotency: second tick past BE trigger does not re-fire MOVE_SL', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db)

  let res = tick(db, stmts, 3414)[0].eval
  assert.equal(res.action, 'MOVE_SL')

  // Second tick at the same price — be_moved is already 1, SL already at entry.
  res = tick(db, stmts, 3414)[0].eval
  assert.equal(res.action, 'HOLD', 'BE rule guarded by !be_moved')
  const row = readPos(db, id)
  assert.equal(row.current_sl, 3400)
  assert.equal(row.be_moved, 1)
})

test('idempotency: scaled_out blocks a second partial at 1.5R', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db)

  // Jump straight to 1.5R — keeper takes partial + trails
  let res = tick(db, stmts, 3430)[0].eval
  assert.equal(res.action, 'PARTIAL_EXIT')

  // Same price again — scaled_out already set; no second partial.
  res = tick(db, stmts, 3430)[0].eval
  assert.notEqual(res.action, 'PARTIAL_EXIT')
  const row = readPos(db, id)
  assert.equal(row.scaled_out, 1)
})

// ---------------------------------------------------------------------------
// 8. MFE monotonicity across a full roundtrip
// ---------------------------------------------------------------------------

test('MFE/MAE: persist monotonically across ticks', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db)

  tick(db, stmts, 3410) // +0.5R
  let row = readPos(db, id)
  assert.ok(row.mfe_r >= 0.49 && row.mfe_r <= 0.51)

  tick(db, stmts, 3420) // +1.0R
  row = readPos(db, id)
  assert.ok(row.mfe_r >= 0.99 && row.mfe_r <= 1.01)

  tick(db, stmts, 3405) // +0.25R — MFE should NOT regress
  row = readPos(db, id)
  assert.ok(row.mfe_r >= 0.99, 'MFE is monotonic — high-water mark held')

  tick(db, stmts, 3392) // -0.4R — MAE takes over
  row = readPos(db, id)
  assert.ok(row.mae_r <= -0.39 && row.mae_r >= -0.41)
  assert.ok(row.mfe_r >= 0.99, 'MFE still held')
})

// ---------------------------------------------------------------------------
// 9. No-price defensive path: HOLD + null metrics, no DB mutation
// ---------------------------------------------------------------------------

test('no current price: keeper HOLDs without mutating SL or flags', () => {
  const db = mkDb()
  const stmts = prep(db)
  const id = seedPosition(db)

  const res = tick(db, stmts, null)[0].eval
  assert.equal(res.action, 'HOLD')
  assert.equal(res.reason, 'no_current_price')

  const row = readPos(db, id)
  assert.equal(row.current_sl, 3380)
  assert.equal(row.be_moved, 0)
  assert.equal(row.scaled_out, 0)
  assert.equal(row.mfe_r, 0)
  assert.equal(row.mae_r, 0)
})
