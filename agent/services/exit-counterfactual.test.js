// node --test agent/services/exit-counterfactual.test.js
//
// Phase 7 against a real database. The load-bearing assertions are that it
// EXCLUDES what the repair prompt forbids counting, and REFUSES to report at
// all on a sample too small to mean anything — which is the state production
// was actually in on 2026-08-06 (37 clean rows, all from one day).
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { exitCounterfactual, replayablePopulation, MIN_SAMPLE } from './exit-counterfactual.js'

const MIN = 60_000
// Anchored to NOW, not to a literal date: the service filters on a rolling
// `days` window, so a hardcoded 2026 timestamp would make these tests pass
// today and fail silently a month from now.
const t0 = Date.now() - 3 * 3_600_000
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]

/** A long that stops out on its first bar — the simplest replayable trade. */
const STOPPED = [bar(0, 100, 100.2, 98.9, 99)]
/** A long that drifts up, never reaching the 1.6R target inside the window. */
const DRIFTED = [bar(0, 100, 100.3, 99.9, 100.2), bar(30, 100.2, 100.6, 100.1, 100.4)]

function seed(db, { n, origin = 'bot_market_dispatch', bars = STOPPED, actualR = -1, withBars = true } = {}) {
  for (let i = 0; i < n; i++) {
    // Entry must coincide with the bar window — bars before entry are context,
    // not part of the trade, so a mismatched opened_at truncates every replay.
    const openedAt = new Date(t0).toISOString()
    const closedAt = new Date(t0 + 30 * MIN).toISOString()
    const info = db.prepare(
      `INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price,
                           opened_at, closed_at, net_pnl, origin, account_id)
       VALUES ('JPN225', 'long', 'closed', 100, 99, 101.6, ?, ?, -100, ?, '43097342')`
    ).run(openedAt, closedAt, origin)
    db.prepare(
      `INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json)
       VALUES (?, 'JPN225', 'long', 100, 99, ?, 'stop_hunt', ?)`
    ).run(info.lastInsertRowid, actualR, withBars ? JSON.stringify(bars) : null)
  }
  return db
}

const fresh = () => initDB(':memory:')

test('only CLEAN bot origins are replayable by default', () => {
  const db = fresh()
  seed(db, { n: 3, origin: 'bot_market_dispatch' })
  seed(db, { n: 5, origin: 'reconciler_adopted' })
  seed(db, { n: 2, origin: 'manual_broker' })
  seed(db, { n: 4, origin: 'legacy_unattributed' })

  const pop = replayablePopulation(db)
  assert.equal(pop.considered, 14)
  assert.equal(pop.eligible.length, 3, 'adopted, manual and unattributed are not evidence of edge')
  assert.equal(pop.skipped.not_clean_origin, 11)
})

test('--all-origins widens it, and the caller must ask for that explicitly', () => {
  const db = fresh()
  seed(db, { n: 3, origin: 'bot_market_dispatch' })
  seed(db, { n: 5, origin: 'reconciler_adopted' })
  assert.equal(replayablePopulation(db, { cleanOnly: false }).eligible.length, 8)
})

test('a trade with no stored bar window is skipped and counted', () => {
  const db = fresh()
  seed(db, { n: 2, withBars: true })
  seed(db, { n: 3, withBars: false })
  const pop = replayablePopulation(db)
  assert.equal(pop.eligible.length, 2)
  assert.equal(pop.skipped.no_bars, 3)
})

test('THE 2026-08-06 STATE: too few clean trades reports INSUFFICIENT, not a number', () => {
  // Production had 37 clean rows, all from a single day. A profit factor over
  // those would have read exactly as authoritative as one that had earned it.
  const db = fresh()
  seed(db, { n: 5, origin: 'bot_market_dispatch' })
  const r = exitCounterfactual(db)
  assert.equal(r.verdict, 'INSUFFICIENT')
  assert.equal(r.eligible, 5)
  assert.equal(r.minSample, MIN_SAMPLE)
  assert.match(r.note, /none of the \d+ rules reached the 30-trade floor/)
  assert.match(r.note, /would read exactly as authoritative as one that had earned it/)
})

test('above the floor it reports, and every rule carries its own sample size', () => {
  const db = fresh()
  seed(db, { n: 40, origin: 'bot_market_dispatch' })
  const r = exitCounterfactual(db)
  assert.equal(r.verdict, 'OK')
  assert.equal(r.eligible, 40)
  const stopped = r.rules.find(x => x.rule === 'as_traded')
  assert.equal(stopped.usable, 40)
  assert.equal(stopped.winRate, 0)
  assert.equal(stopped.expectancyR, -1)
  for (const rule of r.rules) {
    assert.equal(typeof rule.usable, 'number', `${rule.rule} must report its own denominator`)
  }
})

test('the actual result is measured over the SAME population, not the whole book', () => {
  // Comparing a replayed rule against a book-wide historical figure compares
  // two different trade sets — the multi-day-aggregate error this repo has
  // already made three times.
  const db = fresh()
  seed(db, { n: 40, origin: 'bot_market_dispatch', actualR: -1 })
  seed(db, { n: 60, origin: 'reconciler_adopted', actualR: 3 })   // must NOT lift the baseline
  const r = exitCounterfactual(db)
  assert.equal(r.actual.usable, 40)
  assert.equal(r.actual.expectancyR, -1)
})

test('THE AUDIT QUESTION, end to end: the 30-minute cap versus letting it run', () => {
  const db = fresh()
  seed(db, { n: 35, origin: 'bot_market_dispatch', bars: DRIFTED })
  const r = exitCounterfactual(db)
  assert.equal(r.verdict, 'OK')

  const cap = r.rules.find(x => x.rule === 'cap_30m')
  assert.equal(cap.usable, 35)
  assert.equal(cap.expectancyR, 0.4, 'the clock banks +0.4R against a 1.6R target')
  assert.deepEqual(cap.byReason, { time_cap: 35 })

  const uncapped = r.rules.find(x => x.rule === 'no_cap')
  assert.equal(uncapped.usable, 0, 'without the clock these are still open when the window ends')
  assert.equal(uncapped.truncated, 35)
  assert.equal(uncapped.expectancyR, null, 'and that is reported as unknown, never as zero')
})

test('an empty database is INSUFFICIENT rather than a clean sweep', () => {
  const r = exitCounterfactual(fresh())
  assert.equal(r.verdict, 'INSUFFICIENT')
  assert.equal(r.considered, 0)
  assert.equal(r.eligible, 0)
  assert.equal(r.actual, null)
})

test('the window is honoured — older closes are outside the question asked', () => {
  const db = fresh()
  seed(db, { n: 3 })
  db.prepare("UPDATE trades SET closed_at = '2020-01-01T00:00:00Z'").run()
  assert.equal(replayablePopulation(db, { days: 30 }).considered, 0)
})

test('it writes nothing', () => {
  const db = fresh()
  seed(db, { n: 40, origin: 'bot_market_dispatch' })
  const before = db.prepare('SELECT COUNT(*) n FROM trades').get().n
  const pmBefore = db.prepare('SELECT COUNT(*) n FROM trade_postmortems').get().n
  exitCounterfactual(db)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n, before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trade_postmortems').get().n, pmBefore)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trades WHERE origin != 'bot_market_dispatch'").get().n, 0)
})
