// Tests for the per-guard veto breakdown (owner 2026-08-01: the data-backed
// version of "which guard eats how many entries").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { vetoBreakdown } from './veto-breakdown.js'

function mkDb() {
  const db = new Database(':memory:')
  db.exec(`
    -- account_id was missing from this fixture, which is how the claim that
    -- "risk_events carries no account column" survived after M1a added it:
    -- the test agreed with the stale comment instead of with the schema.
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, approved INTEGER, veto_reason TEXT,
      checks_json TEXT, proposal_json TEXT, account_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT, symbol TEXT, timeframe TEXT, strategy TEXT,
      stage TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
      detail_json TEXT, loop_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

test('groups vetoes by the machine-readable reason head, newest example kept', () => {
  const db = mkDb()
  // RELATIVE, not hardcoded. These were fixed at '2026-08-01 00:1x' against a
  // 7-day window, so the test passed for exactly one week and then began
  // dropping a row per minute as 08-08 caught up with it — vetoedCount went
  // 3 -> 1 with no code change. Same rot as the cockpit news cache (#688):
  // a fixture pinned to a wall-clock date inside a relative window is a timer,
  // not a test. Ordering is what the assertions care about, so express that.
  const ago = (mins) => `datetime('now', '-${mins} minutes')`
  const insAt = (sym, ok, reason, mins) => db.prepare(
    `INSERT INTO risk_events (symbol, approved, veto_reason, created_at) VALUES (?,?,?,${ago(mins)})`
  ).run(sym, ok, reason)
  insAt('INTC.US', 0, 'unknown_daily_pnl (account): 7 closed trade(s) today have no realised P&L', 60)
  insAt('EURUSD', 0, 'unknown_daily_pnl (account): 3 closed trade(s) today have no realised P&L', 10) // newest of the pair
  insAt('BTCUSD', 0, 'tp_required — order has no take profit', 50)
  insAt('ETHUSD', 1, null, 40)

  const out = vetoBreakdown(db, { days: 7 })
  assert.equal(out.summary.proposalsApproved, 1)
  assert.equal(out.summary.proposalsVetoed, 3)
  const top = out.guards[0]
  assert.equal(top.guard, 'unknown_daily_pnl (account)')
  assert.equal(top.count, 2)
  // Newest full string is the example, not the oldest.
  assert.match(top.example, /3 closed trade/)
  assert.equal(out.guards.find(g => g.guard.startsWith('tp_required')).count, 1)
})

test('upstream decision_log skips are counted per stage and account-filtered', () => {
  const db = mkDb()
  const ins = db.prepare(`INSERT INTO decision_log (account_id, symbol, stage, decision, reason) VALUES (?,?,?,?,?)`)
  ins.run('46130058', 'EURUSD', 'style_filter', 'skip', 'style mismatch: ranging')
  ins.run('46130058', 'GBPUSD', 'style_filter', 'skip', 'style mismatch: ranging')
  ins.run('47790949', 'USDJPY', 'lesson_decay', 'skip', 'decay below floor')
  ins.run(null, 'XAUUSD', 'dispatch', 'veto', 'market closed')
  ins.run('46130058', 'AUDUSD', 'news_gate', 'proceed', 'clear') // not a skip — excluded

  const all = vetoBreakdown(db, { days: 7 })
  assert.equal(all.summary.upstreamSkips, 4)

  const scoped = vetoBreakdown(db, { days: 7, account: '46130058' })
  // Two own rows + the NULL-account dispatch row; the other account's row is out.
  assert.equal(scoped.summary.upstreamSkips, 3)
  const style = scoped.guards.find(g => g.source === 'upstream:style_filter')
  assert.equal(style.count, 2)
  assert.equal(style.topSymbols.length, 2)
  assert.ok(scoped.note)
})

test('window bounds respected and empty db is a calm empty report', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at) VALUES (?,?,?,?)`)
    .run('OLD', 0, 'stale_reason', '2020-01-01 00:00:00')
  const out = vetoBreakdown(db, { days: 7 })
  assert.equal(out.summary.proposalsVetoed, 0)
  assert.deepEqual(out.guards, [])
  assert.equal(out.summary.approvalRate, null)
})

test('risk-gate vetoes are account-filtered too, and unstamped rows still count', () => {
  // Before this, a per-account veto breakdown reported EVERY account's
  // risk-gate vetoes under one account's heading, with a note in the payload
  // apologising for it. The note described a schema that had not been true
  // since M1a.
  const db = mkDb()
  const ins = db.prepare(
    `INSERT INTO risk_events (symbol, approved, veto_reason, account_id, created_at)
     VALUES (?,?,?,?,datetime('now'))`
  )
  ins.run('EURUSD', 0, 'daily_loss_cap: hit', 'A')
  ins.run('GBPUSD', 0, 'streak_breaker: 3 losses', 'B')
  ins.run('XAUUSD', 0, 'margin_floor: below', null)

  const a = vetoBreakdown(db, { days: 7, account: 'A' })
  const guards = a.guards.filter(g => g.source === 'risk_gate').map(g => g.guard)
  assert.ok(guards.includes('daily_loss_cap'), "A's own veto is counted")
  assert.ok(guards.includes('margin_floor'), 'an unstamped veto counts for whoever is asking')
  assert.ok(!guards.includes('streak_breaker'), "another account's veto must not leak in")
  assert.match(a.note, /filtered to this account/)

  const all = vetoBreakdown(db, { days: 7 })
  assert.equal(all.guards.filter(g => g.source === 'risk_gate').length, 3)
  assert.equal(all.note, null)
})

// ---------------------------------------------------------------------------
// #122 — the cap, and why it must announce itself.
//
// Measured 2026-08-04: this route returned 506,936 bytes, 537 KB of it the
// `guards` array — 1,548 rows. The row set is one per DISTINCT veto reason
// STRING, and those strings embed live numbers, so it grows with every
// distinct P&L the guard has ever seen. Unbounded by construction, and the
// browser polls it.
// ---------------------------------------------------------------------------

test('live numbers are normalised OUT of the guard key — the root cause of the 507 KB response', () => {
  const db = mkDb()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
                          VALUES (?,0,?,datetime('now'))`)
  // The exact shape production produced 1,548 rows of.
  ins.run('EURUSD', 'daily_loss_limit_hit pnl=-912.72 limit=16.16')
  ins.run('GBPUSD', 'daily_loss_limit_hit pnl=-1736.65 limit=1465.25')
  ins.run('USDJPY', 'portfolio_margin_exhausted used=26266.06 cap=14383.37 source=estimate')
  ins.run('AUDUSD', 'portfolio_margin_exhausted used=32545.44 cap=19408.71 source=broker')

  const out = vetoBreakdown(db)
  // THREE guards, not four: the two daily_loss_limit_hit rows merge into one,
  // while the two portfolio_margin_exhausted rows stay apart because they
  // differ by `source=`, which is not a number. That asymmetry is the whole
  // point — normalise the live values, keep the categorical ones.
  assert.equal(out.guards.length, 3)
  assert.equal(out.summary.distinctGuards, 3)
  const byCount = Object.fromEntries(out.guards.map(g => [g.guard, g.count]))
  assert.equal(byCount['daily_loss_limit_hit pnl=<n> limit=<n>'], 2)
  // source=estimate and source=broker stay DIFFERENT — only numbers are
  // normalised, so a genuinely different guard is not merged away.
  assert.equal(out.guards.filter(g => g.guard.startsWith('portfolio_margin_exhausted')).length, 2)

  // Nothing is lost: the untouched original survives as the example.
  const dl = out.guards.find(g => g.guard.startsWith('daily_loss_limit_hit'))
  assert.match(dl.example, /pnl=-\d+\.\d+/, 'the real numbers are still readable in the sample')
})

test('the guard list is still capped as a backstop, and says so rather than truncating quietly', () => {
  const db = mkDb()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
                          VALUES (?,0,?,datetime('now'))`)
  // 40 genuinely distinct guards — normalisation cannot collapse these, so
  // the cap is the only thing standing between this route and an unbounded
  // response if a future guard family misbehaves the way that one did.
  for (let i = 0; i < 40; i++) {
    for (let n = 0; n <= i; n++) ins.run('EURUSD', `guard_family_${i} tripped`)
  }
  const capped = vetoBreakdown(db, { limit: 10 })
  assert.equal(capped.guards.length, 10)
  assert.ok(capped.truncated, 'a silent cap on a "which guard is eating my entries" route reads as a complete answer')
  assert.equal(capped.truncated.dropped, 30)
  assert.ok(capped.truncated.droppedVetoes > 0)
  assert.match(capped.truncated.note, /raise \?limit=/)

  // The SUMMARY still reports the true distinct count — the cap must not
  // rewrite the number an operator reads to judge how fragmented the reasons
  // are.
  assert.equal(capped.summary.distinctGuards, 40)

  // Sorted by count, so what is dropped is the tail, not a random slice.
  const counts = capped.guards.map(g => g.count)
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a))
  assert.equal(counts[0], 40, 'the biggest guard survived the cap')
})

test('under the cap there is nothing to announce', () => {
  const db = mkDb()
  db.prepare(`INSERT INTO risk_events (symbol, approved, veto_reason, created_at)
              VALUES ('EURUSD',0,'one_reason',datetime('now'))`).run()
  assert.equal(vetoBreakdown(db).truncated, null)
})
