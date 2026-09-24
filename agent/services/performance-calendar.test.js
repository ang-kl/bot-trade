import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarDay, calendarDate } from '../shared/performance-calendar.js'
import { buildPerformancePopulations, buildDecisionsDaily } from './performance-populations.js'
import { reportStats } from '../shared/performance-populations.js'
import { dayAnchorMs } from '../shared/formulas.js'
import { initDB } from '../db.js'

test('Performance midnight follows the requested timezone without changing broker day', () => {
  const now = Date.parse('2026-09-24T22:00:00Z')
  assert.equal(calendarDay(now, 'Asia/Singapore'), Date.parse('2026-09-24T16:00:00Z'))
  assert.equal(calendarDate(now, 'Asia/Singapore'), '2026-09-25')
  assert.equal(calendarDay(now, 'UTC'), Date.parse('2026-09-24T00:00:00Z'))
  assert.equal(dayAnchorMs(now), Date.parse('2026-09-24T21:00:00Z'))
  assert.throws(() => calendarDay(now, 'unknown-zone'), RangeError)
})

test('local calendar days handle 23-hour and 25-hour DST days', () => {
  for (const [day, next, hours] of [['2026-03-08', '2026-03-09', 23], ['2026-11-01', '2026-11-02', 25]]) {
    const start = calendarDay(Date.parse(`${day}T18:00:00Z`), 'America/New_York')
    const end = calendarDay(Date.parse(`${next}T18:00:00Z`), 'America/New_York')
    assert.equal((end - start) / 3600000, hours)
  }
})

test('local report includes midnight exactly, excludes prior day and now, retains account scope', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const now = Date.parse('2026-09-24T22:00:00Z'), start = Date.parse('2026-09-24T16:00:00Z')
  const add = db.prepare("INSERT INTO trades(symbol, side, status, account_id, net_pnl, closed_at_ms) VALUES('ETHUSD','BUY','closed',?,?,?)")
  add.run('11', 8, start - 1); add.run('11', 3, start); add.run('22', 40, start); add.run('11', 7, now)
  const r = buildPerformancePopulations(db, { now, timeZone: 'Asia/Singapore' })
  assert.equal(reportStats(r, 'day', '11').pnl, 3)
  assert.equal(reportStats(r, 'day', '22').pnl, 40)
  assert.equal(reportStats(r, 'session:ALL', '11').pnl, 3)
  assert.equal(r.daily.find(d => d.accountId === '11' && d.day === '2026-09-25').stats.net, 3)
  assert.equal(r.timeZone, 'Asia/Singapore')
  assert.equal(r.windows.find(w => w.key === 'yesterday').to, start)
  assert.equal(reportStats(buildPerformancePopulations(db, { now }), 'day', '11').pnl, 0)
})

// Relative to the current UTC date so the retained-history predicate stays
// in range, but exact local-midnight and account membership are deterministic.
test('daily decisions group at local midnight and never inherit unstamped decisions', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const start = `${day}T16:00:00Z`, prior = `${day}T15:59:59Z`
  const add = db.prepare('INSERT INTO risk_events(account_id,approved,repeat_count,created_at) VALUES(?,?,?,?)')
  const sql = value => value.replace('T', ' ').replace('Z', '')
  add.run('11', 1, 1, sql(prior)); add.run('11', 0, 4, sql(start))
  add.run('22', 1, 1, sql(start)); add.run(null, 1, 1, sql(start))
  const rows = buildDecisionsDaily(db, { accountId: '11', timeZone: 'Asia/Singapore' })
  assert.deepEqual(rows, [
    { day, approved: 1, vetoed: 0, vetoed_distinct: 0 },
    { day: calendarDate(Date.parse(start), 'Asia/Singapore'), approved: 0, vetoed: 4, vetoed_distinct: 1 },
  ])
})
