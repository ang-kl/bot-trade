// PHASE 7 GATE (cockpit live-wiring prompt): "live, stale, empty and
// provider-not-configured tests pass." Events are seeded into the SAME
// agent_state cache the risk gate's news window reads.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { buildEnvironment } from './cockpit-environment.js'

const NOW = Date.parse('2026-07-31T12:00:00Z')

function seedNews(db, { fetchedAgoMs = 60_000, events }) {
  setState(db, 'news_calendar_json', JSON.stringify(events ?? [
    { title: 'CPI y/y', country: 'USD', impact: 'High', date: new Date(NOW + 30 * 60_000).toISOString() },
    { title: 'ECB press conference', country: 'EUR', impact: 'Medium', date: new Date(NOW + 3 * 3600_000).toISOString() },
    { title: 'BoJ outlook', country: 'JPY', impact: 'High', date: new Date(NOW + 60 * 60_000).toISOString() },
  ]))
  setState(db, 'news_calendar_fetched_ms', String(NOW - fetchedAgoMs))
}

let db
beforeEach(() => { db = initDB(':memory:') })

test('GATE live: fresh cache yields real events with title/currency/impact/time, currency-filtered', () => {
  seedNews(db, { fetchedAgoMs: 60_000 })
  const out = buildEnvironment(db, 'EURUSD', NOW)
  assert.equal(out.macroNews.status, 'live')
  assert.equal(out.macroNews.cacheAgeMs, 60_000)
  assert.equal(out.macroNews.fetchedAt, new Date(NOW - 60_000).toISOString())
  const titles = out.macroNews.events.map(e => e.title)
  // EURUSD = EUR + USD legs: the JPY event must NOT appear.
  assert.ok(titles.includes('CPI y/y'))
  assert.ok(titles.includes('ECB press conference'))
  assert.ok(!titles.includes('BoJ outlook'))
  const cpi = out.macroNews.events.find(e => e.title === 'CPI y/y')
  assert.equal(cpi.currency, 'USD')
  assert.equal(cpi.impact, 'High')
  assert.equal(cpi.minutesFromNow, 30)
  assert.equal(cpi.scheduledAt, new Date(NOW + 30 * 60_000).toISOString())
})

test('GATE stale: a cache older than the 6h TTL says STALE and keeps its real events', () => {
  seedNews(db, { fetchedAgoMs: 7 * 3600_000 })
  const out = buildEnvironment(db, 'EURUSD', NOW)
  assert.equal(out.macroNews.status, 'stale')
  assert.ok(out.macroNews.events.length >= 1, 'old events are old data, not no data')
  assert.equal(out.macroNews.cacheAgeMs, 7 * 3600_000)
})

test('GATE empty: no cache at all is no_data with an empty list — never fabricated calm', () => {
  const out = buildEnvironment(db, 'EURUSD', NOW)
  assert.equal(out.macroNews.status, 'no_data')
  assert.deepEqual(out.macroNews.events, [])
  assert.equal(out.macroNews.fetchedAt, null)
})

test('GATE provider-not-configured: fundamentals is not_ingested, always', () => {
  const out = buildEnvironment(db, 'EURUSD', NOW)
  assert.equal(out.fundamentals.status, 'not_ingested')
  assert.deepEqual(out.fundamentals.items, [])
  assert.match(out.fundamentals.detail, /allowlisted, cached, timestamped/)
})

test('the gate sub-block separates new-entry gating from managing the open position', () => {
  seedNews(db, { fetchedAgoMs: 60_000, events: [
    { title: 'NFP', country: 'USD', impact: 'High', date: new Date(NOW + 10 * 60_000).toISOString() },
  ] })
  setState(db, 'risk_config_json', JSON.stringify({ newsGateEnabled: true }))
  const out = buildEnvironment(db, 'EURUSD', NOW)
  // 10 minutes ahead is inside the default 15-minute window → the gate is hot.
  assert.equal(out.macroNews.gate.enabled, true)
  assert.equal(out.macroNews.gate.activeEvent.title, 'NFP')
  assert.match(out.macroNews.gate.appliesTo, /new entries only/)
  assert.equal(out.macroNews.events.find(e => e.title === 'NFP').inGateWindow, true)
})

test('regime: live from a fresh regimes row, stale past its bound, no_data without one', () => {
  const out0 = buildEnvironment(db, 'EURUSD', NOW)
  assert.equal(out0.regime.status, 'no_data')
  db.prepare("INSERT INTO regimes (symbol, regime, trend_direction, atr_pct, computed_at) VALUES ('EURUSD', 'trending', 'long', 0.4, datetime('now'))").run()
  const out1 = buildEnvironment(db, 'EURUSD', Date.now())
  assert.equal(out1.regime.status, 'live')
  assert.equal(out1.regime.label, 'trending')
  assert.equal(out1.regime.direction, 'long')
  db.prepare("UPDATE regimes SET computed_at = datetime('now', '-1 day') WHERE symbol = 'EURUSD'").run()
  const out2 = buildEnvironment(db, 'EURUSD', Date.now())
  assert.equal(out2.regime.status, 'stale')
})

test('session: heuristic fallback states itself and never invents a next-open time', () => {
  const out = buildEnvironment(db, 'EURUSD', NOW)
  assert.ok(['open', 'closed'].includes(out.session.state))
  assert.match(out.session.source, /heuristic/)
  assert.equal(out.session.nextOpenAt, null)   // only a BROKER schedule may state one
  assert.equal(out.session.exchange, 'fx')     // the honest fact we have: asset class
})
