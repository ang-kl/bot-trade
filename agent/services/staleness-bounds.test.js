// node --test agent/services/staleness-bounds.test.js
//
// P8 / AUDIT F-L1-09, F-L2-04, F-L7-02 — "staleness ceilings that are not
// ceilings".
//
// The audit's plain statement was: the system will act on a regime datum of
// ANY age, and on a news calendar of any age. Both reads had no age bound at
// all, so a verdict computed days ago gated today's entries exactly as if it
// had been computed a minute ago.
//
// Both fixes here degrade to the SAME answer each module already gives when
// the datum is missing — unknown regime → no block (regime-gate's documented
// fail-open), no calendar → no block (news-calendar's documented degrade). So
// neither adds a new way to stop trading; they stop a fossil being read as a
// current reading. The one stricter posture (blockOnStaleRegime) ships OFF.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  latestRegime, checkRegimeGate, loadRegimeGateConfig,
  DEFAULT_MAX_REGIME_AGE_MIN, DEFAULT_REGIME_GATE,
} from './regime-gate.js'
import { cachedEventsSync } from './news-calendar.js'

function mkDb() { return initDB(':memory:') }

function putRegime(db, { symbol = 'EURUSD', regime = 'trending', dir = 'long', minutesAgo = 0 } = {}) {
  db.prepare(
    `INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at)
     VALUES (?, ?, ?, 0.5, datetime('now', ?))`
  ).run(symbol, regime, dir, `-${minutesAgo} minutes`)
}

// ---------------------------------------------------------------------------
// Regime.
// ---------------------------------------------------------------------------

test('a fresh regime row is returned unmarked', () => {
  const db = mkDb()
  putRegime(db, { minutesAgo: 10 })
  const r = latestRegime(db, 'EURUSD')
  assert.equal(r.regime, 'trending')
  assert.equal(r.stale, undefined)
})

test('a row past the bound is marked stale, with its age', () => {
  const db = mkDb()
  putRegime(db, { minutesAgo: DEFAULT_MAX_REGIME_AGE_MIN + 60 })
  const r = latestRegime(db, 'EURUSD')
  assert.equal(r.stale, true)
  assert.ok(r.ageMin >= DEFAULT_MAX_REGIME_AGE_MIN)
})

test('the bound can be disabled, which is the pre-P8 read', () => {
  const db = mkDb()
  putRegime(db, { minutesAgo: 60 * 24 * 7 })
  assert.equal(latestRegime(db, 'EURUSD', { maxAgeMin: 0 }).stale, undefined)
})

test('an unparseable computed_at is treated as stale, not as fresh', () => {
  const db = mkDb()
  db.prepare(
    `INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at)
     VALUES ('EURUSD', 'trending', 'long', 0.5, 'not-a-timestamp')`
  ).run()
  assert.equal(latestRegime(db, 'EURUSD').stale, true)
})

test('THE DEFECT: a week-old trending row no longer blocks a fade as if current', () => {
  const db = mkDb()
  putRegime(db, { regime: 'trending', dir: 'long', minutesAgo: 60 * 24 * 7 })
  // fib_618_fade is meanrev; a short fade into a long trend is the classic
  // block — and it used to fire off this fossil.
  const v = checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD')
  assert.equal(v.block, false)
  assert.equal(v.staleRegime, true)
})

test('a FRESH trending row still blocks the fade — the gate itself is unchanged', () => {
  const db = mkDb()
  putRegime(db, { regime: 'trending', dir: 'long', minutesAgo: 5 })
  const v = checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD')
  assert.equal(v.block, true)
  assert.match(v.reason, /fade-vs-trend/)
})

test('blockOnStaleRegime flips a fossil to a block, and ships OFF', () => {
  assert.equal(DEFAULT_REGIME_GATE.blockOnStaleRegime, false)
  const db = mkDb()
  setState(db, 'regime_gate_json', JSON.stringify({ blockOnStaleRegime: true }))
  putRegime(db, { minutesAgo: 60 * 24 })
  const v = checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD')
  assert.equal(v.block, true)
  assert.match(v.reason, /stale-regime/)
})

test('the age bound is configurable and the rest of the config survives', () => {
  const db = mkDb()
  setState(db, 'regime_gate_json', JSON.stringify({ maxRegimeAgeMin: 30 }))
  const cfg = loadRegimeGateConfig(db)
  assert.equal(cfg.maxRegimeAgeMin, 30)
  assert.equal(cfg.on, true, 'on must stay true when the owner only set the age bound')

  putRegime(db, { minutesAgo: 45 })
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD').staleRegime, true)
})

test('a disabled gate is still disabled', () => {
  const db = mkDb()
  setState(db, 'regime_gate_json', JSON.stringify({ on: false, blockOnStaleRegime: true }))
  putRegime(db, { minutesAgo: 60 * 24 })
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD').block, false)
})

test('no regime at all still fails open, unchanged', () => {
  const db = mkDb()
  assert.equal(checkRegimeGate(db, 'fib_618_fade', 'short', 'EURUSD').block, false)
})

// ---------------------------------------------------------------------------
// News calendar.
// ---------------------------------------------------------------------------

const oneEvent = JSON.stringify([{ title: 'CPI', country: 'USD', impact: 'High', date: '2026-07-26T12:30:00Z' }])

test('a recent calendar cache is served', () => {
  const db = mkDb()
  setState(db, 'news_calendar_json', oneEvent)
  setState(db, 'news_calendar_fetched_ms', String(Date.now() - 3600_000))
  assert.equal(cachedEventsSync(db).length, 1)
})

test('THE DEFECT: a calendar older than a week is no longer served as current', () => {
  const db = mkDb()
  setState(db, 'news_calendar_json', oneEvent)
  setState(db, 'news_calendar_fetched_ms', String(Date.now() - 8 * 24 * 3600_000))
  assert.deepEqual(cachedEventsSync(db), [], 'the feed publishes one week at a time — an older cache is a different week')
})

test('a missing fetch timestamp is treated as no data', () => {
  const db = mkDb()
  setState(db, 'news_calendar_json', oneEvent)
  assert.deepEqual(cachedEventsSync(db), [])
})

test('the memo cannot serve a cache that has since aged out', () => {
  const db = mkDb()
  setState(db, 'news_calendar_json', oneEvent)
  const at = Date.now() - 3600_000
  setState(db, 'news_calendar_fetched_ms', String(at))
  assert.equal(cachedEventsSync(db).length, 1, 'populate the memo while fresh')

  // Same key, but the cache is now ancient. Memoising on the timestamp alone
  // would keep serving the populated value forever.
  setState(db, 'news_calendar_fetched_ms', String(Date.now() - 30 * 24 * 3600_000))
  assert.deepEqual(cachedEventsSync(db), [])
})
