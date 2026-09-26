// V3 WEB-6: the "Today by market session" buckets are each exchange's regular
// cash hours in its own IANA zone. These tests pin every DST change in the
// coming year (ASX 4 Oct 2026 / 4 Apr 2027, LSE 25 Oct 2026 / 28 Mar 2027,
// NYSE 1 Nov 2026 / 14 Mar 2027), TSE's 15:30 close, both lunch breaks, the
// UTC-midnight wrap of ASX's AEDT session and local-weekday judgement. The
// property test checks the interval derivation against an independent
// per-instant reading of each exchange's wall clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { REPORT_SESSIONS, SESSION_SOURCE, SESSION_EXCEPTIONS, sessionIntervals, sessionOpenAt, sessionHint, wallClockToUtc, closureIntervals, subtractIntervals, holidayWindowSeconds } from './report-sessions.js'

const S = Object.fromEntries(REPORT_SESSIONS.map(s => [s.key, s]))
const at = iso => Date.parse(iso)
const shape = list => list.map(i => ({ date: i.date, from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString() }))

test('the table is exchange cash hours in IANA zones, and says what it does not apply', () => {
  assert.deepEqual(REPORT_SESSIONS.map(s => [s.key, s.tz]), [
    ['SYD (ASX)', 'Australia/Sydney'], ['SG', 'Asia/Singapore'], ['HK', 'Asia/Hong_Kong'],
    ['JPN', 'Asia/Tokyo'], ['EUR', 'Europe/London'], ['NY', 'America/New_York']])
  assert.deepEqual(S.JPN.hours, [['09:00', '11:30'], ['12:30', '15:30']])
  assert.equal(SESSION_SOURCE, 'exchange_cash_hours_iana_dst')
  assert.equal(SESSION_EXCEPTIONS, 'holidays_and_early_closes_not_applied')
  assert.throws(() => { REPORT_SESSIONS[0].hours.push(['00:00', '01:00']) }, TypeError)
})

test('ASX moves to AEDT on Sun 4 Oct 2026: the Monday session opens at 23:00 UTC on Sunday and crosses UTC midnight', () => {
  assert.deepEqual(shape(sessionIntervals(S['SYD (ASX)'], at('2026-10-02T00:00:00Z'), at('2026-10-06T00:00:00Z'))), [
    { date: '2026-10-02', from: '2026-10-02T00:00:00.000Z', to: '2026-10-02T06:00:00.000Z' },
    { date: '2026-10-05', from: '2026-10-04T23:00:00.000Z', to: '2026-10-05T05:00:00.000Z' },
    { date: '2026-10-06', from: '2026-10-05T23:00:00.000Z', to: '2026-10-06T05:00:00.000Z' },
  ])
  assert.equal(sessionOpenAt(S['SYD (ASX)'], at('2026-10-04T23:30:00Z')), true, 'Sunday in UTC, Monday 10:30 in Sydney')
  assert.equal(sessionOpenAt(S['SYD (ASX)'], at('2026-10-05T05:30:00Z')), false, '16:30 AEDT is after the close')
  assert.equal(sessionOpenAt(S['SYD (ASX)'], at('2026-10-02T05:30:00Z')), true, 'Friday 15:30 AEST, before the change')
  assert.equal(sessionOpenAt(S['SYD (ASX)'], at('2026-10-03T23:30:00Z')), false, 'Sunday 10:30 in Sydney is a weekend')
})

test('ASX returns to AEST on Sun 4 Apr 2027', () => {
  assert.deepEqual(shape(sessionIntervals(S['SYD (ASX)'], at('2027-04-01T00:00:00Z'), at('2027-04-05T12:00:00Z'))), [
    { date: '2027-04-01', from: '2027-03-31T23:00:00.000Z', to: '2027-04-01T05:00:00.000Z' },
    { date: '2027-04-02', from: '2027-04-01T23:00:00.000Z', to: '2027-04-02T05:00:00.000Z' },
    { date: '2027-04-05', from: '2027-04-05T00:00:00.000Z', to: '2027-04-05T06:00:00.000Z' },
  ])
})

test('LSE leaves BST on Sun 25 Oct 2026 and re-enters it on Sun 28 Mar 2027', () => {
  assert.deepEqual(shape(sessionIntervals(S.EUR, at('2026-10-23T00:00:00Z'), at('2026-10-27T00:00:00Z'))), [
    { date: '2026-10-23', from: '2026-10-23T07:00:00.000Z', to: '2026-10-23T15:30:00.000Z' },
    { date: '2026-10-26', from: '2026-10-26T08:00:00.000Z', to: '2026-10-26T16:30:00.000Z' },
  ])
  assert.deepEqual(shape(sessionIntervals(S.EUR, at('2027-03-26T00:00:00Z'), at('2027-03-30T00:00:00Z'))), [
    { date: '2027-03-26', from: '2027-03-26T08:00:00.000Z', to: '2027-03-26T16:30:00.000Z' },
    { date: '2027-03-29', from: '2027-03-29T07:00:00.000Z', to: '2027-03-29T15:30:00.000Z' },
  ])
})

test('NYSE leaves EDT on Sun 1 Nov 2026 and re-enters it on Sun 14 Mar 2027; the week between shifts only London', () => {
  assert.deepEqual(shape(sessionIntervals(S.NY, at('2026-10-30T00:00:00Z'), at('2026-11-03T00:00:00Z'))), [
    { date: '2026-10-30', from: '2026-10-30T13:30:00.000Z', to: '2026-10-30T20:00:00.000Z' },
    { date: '2026-11-02', from: '2026-11-02T14:30:00.000Z', to: '2026-11-02T21:00:00.000Z' },
  ])
  assert.deepEqual(shape(sessionIntervals(S.NY, at('2027-03-12T00:00:00Z'), at('2027-03-16T00:00:00Z'))), [
    { date: '2027-03-12', from: '2027-03-12T14:30:00.000Z', to: '2027-03-12T21:00:00.000Z' },
    { date: '2027-03-15', from: '2027-03-15T13:30:00.000Z', to: '2027-03-15T20:00:00.000Z' },
  ])
  // Wed 28 Oct 2026: London on GMT, New York still on EDT.
  assert.equal(sessionOpenAt(S.EUR, at('2026-10-28T07:30:00Z')), false)
  assert.equal(sessionOpenAt(S.EUR, at('2026-10-28T16:15:00Z')), true)
  assert.equal(sessionOpenAt(S.NY, at('2026-10-28T13:45:00Z')), true)
  assert.equal(sessionOpenAt(S.NY, at('2026-10-28T20:15:00Z')), false)
})

test('TSE closes at 15:30 with an 11:30–12:30 lunch; HKEX breaks 12:00–13:00; intervals are half-open', () => {
  assert.deepEqual(shape(sessionIntervals(S.JPN, at('2026-09-25T00:00:00Z'), at('2026-09-25T12:00:00Z'))), [
    { date: '2026-09-25', from: '2026-09-25T00:00:00.000Z', to: '2026-09-25T02:30:00.000Z' },
    { date: '2026-09-25', from: '2026-09-25T03:30:00.000Z', to: '2026-09-25T06:30:00.000Z' },
  ])
  assert.equal(sessionOpenAt(S.JPN, at('2026-09-25T06:15:00Z')), true, '15:15 JST, inside the extended close')
  assert.equal(sessionOpenAt(S.JPN, at('2026-09-25T06:30:00Z')), false, '15:30 JST is the close, not in the session')
  assert.equal(sessionOpenAt(S.JPN, at('2026-09-25T02:45:00Z')), false, '11:45 JST is lunch')
  assert.equal(sessionOpenAt(S.HK, at('2026-09-25T04:30:00Z')), false, '12:30 HKT is lunch')
  assert.equal(sessionOpenAt(S.HK, at('2026-09-25T01:30:00Z')), true, '09:30 HKT is the open')
  assert.equal(sessionOpenAt(S.HK, at('2026-09-25T08:00:00Z')), false, '16:00 HKT is the close')
  assert.equal(sessionOpenAt(S.SG, at('2026-09-25T04:30:00Z')), true, 'SGX trades through midday')
})

test('a weekend in each exchange\'s own zone has no session', () => {
  for (const s of REPORT_SESSIONS) {
    assert.deepEqual(sessionIntervals(s, at('2026-09-26T00:00:00Z'), at('2026-09-27T23:00:00Z')), [], s.key)
  }
  assert.deepEqual(sessionIntervals(S.NY, 5, 5), [])
  assert.throws(() => sessionIntervals(S.NY, 0, 15 * 86400000), /report_session_window_bound/)
})

test('wall-clock conversion reads the offset of the target date, not the estimate\'s', () => {
  assert.equal(new Date(wallClockToUtc('2026-10-05', '10:00', 'Australia/Sydney')).toISOString(), '2026-10-04T23:00:00.000Z')
  assert.equal(new Date(wallClockToUtc('2026-10-02', '10:00', 'Australia/Sydney')).toISOString(), '2026-10-02T00:00:00.000Z')
  assert.equal(new Date(wallClockToUtc('2026-11-02', '09:30', 'America/New_York')).toISOString(), '2026-11-02T14:30:00.000Z')
  assert.equal(new Date(wallClockToUtc('2026-10-26', '08:00', 'Europe/London')).toISOString(), '2026-10-26T08:00:00.000Z')
})

// Independent oracle: read each exchange's wall clock AT the instant (a
// different Intl path from the wall-to-UTC conversion under test) and test the
// local weekday and minute against the table's hours.
const oracleFormatters = new Map()
function oracleOpen(session, t) {
  if (!oracleFormatters.has(session.tz)) oracleFormatters.set(session.tz, new Intl.DateTimeFormat('en-GB', { timeZone: session.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  const p = Object.fromEntries(oracleFormatters.get(session.tz).formatToParts(t).map(x => [x.type, x.value]))
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false
  const minute = Number(p.hour) * 60 + Number(p.minute)
  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
  return session.hours.some(([a, b]) => minute >= toMin(a) && minute < toMin(b))
}
test('interval membership agrees with each exchange\'s wall clock at every 5 minutes across all six DST changes', () => {
  const spans = [['2026-09-28T00:00:00Z', '2026-11-09T00:00:00Z'], ['2027-03-08T00:00:00Z', '2027-04-12T00:00:00Z']]
  let checked = 0, open = 0
  for (const [a, b] of spans) {
    for (let w = at(a); w < at(b); w += 7 * 86400000) {
      const end = Math.min(w + 7 * 86400000, at(b))
      for (const s of REPORT_SESSIONS) {
        const intervals = sessionIntervals(s, w, end)
        for (let t = w; t < end; t += 5 * 60000) {
          const mine = intervals.some(i => t >= i.from && t < i.to)
          assert.equal(mine, oracleOpen(s, t), `${s.key} at ${new Date(t).toISOString()}`)
          checked++; if (mine) open++
        }
      }
    }
  }
  assert.ok(checked > 60000 && open > 10000, `the sweep covered real sessions (${open} open of ${checked})`)
})

test('the row hint states the rule, the zone, the WEB-6b exception and the UTC intervals it produced', () => {
  const syd = S['SYD (ASX)']
  const hint = sessionHint(syd, sessionIntervals(syd, at('2026-10-04T13:00:00Z'), at('2026-10-05T04:00:00Z')))
  assert.match(hint, /ASX 10:00–16:00 Australia\/Sydney local time, Mon–Fri/)
  assert.match(hint, /public holidays and early closes not applied \(WEB-6b\)/)
  assert.match(hint, /2026-10-05 23:00–05:00 UTC/)
  assert.match(sessionHint(S.JPN, []), /09:00–11:30 and 12:30–15:30 .* no cash session overlaps today's window/)
  assert.doesNotMatch(sessionHint(S.NY), /intervals|no cash session/, 'without a report the hint claims no interval')
})

// V3 WEB-6b: the closure arithmetic the report applies.
test('WEB-6b: holiday rows become UTC closures in their own zone; 0/0 is the whole local day (OD-7); unreadable rows are counted, not applied', () => {
  const iso = c => [c.date, new Date(c.from).toISOString(), new Date(c.to).toISOString()]
  const rows = [
    { dateIso: '2026-10-01', startSecond: 0, endSecond: 0, scheduleTimeZone: 'Asia/Hong_Kong', isRecurring: false, name: 'National Day' },
    { dateIso: '2026-11-27', startSecond: 13 * 3600, endSecond: 86400, scheduleTimeZone: 'America/New_York', isRecurring: false },
    { dateIso: '2026-10-02', scheduleTimeZone: 'Asia/Hong_Kong', isRecurring: false },                 // omitted bounds
    { dateIso: '2026-10-03', startSecond: 5, endSecond: 5, scheduleTimeZone: 'Asia/Hong_Kong', isRecurring: false }, // invalid pair
    { dateIso: '2020-12-25', startSecond: 0, endSecond: 0, scheduleTimeZone: 'Europe/London', isRecurring: true },
  ]
  const { closures, unreadable } = closureIntervals(rows, at('2026-09-30T00:00:00Z'), at('2026-12-31T00:00:00Z'))
  assert.equal(unreadable, 2)
  assert.deepEqual(closures.map(iso), [
    ['2026-10-01', '2026-09-30T16:00:00.000Z', '2026-10-01T16:00:00.000Z'],
    ['2026-11-27', '2026-11-27T18:00:00.000Z', '2026-11-28T05:00:00.000Z'],
    ['2026-12-25', '2026-12-25T00:00:00.000Z', '2026-12-26T00:00:00.000Z'],
  ])
  assert.deepEqual(holidayWindowSeconds({ startSecond: 0, endSecond: 0 }), { start: 0, end: 86400 })
  assert.equal(holidayWindowSeconds({ startSecond: 0 }), null)
})

test('WEB-6b: closures cut session intervals, splitting a lunch-split session and keeping each piece\'s date', () => {
  const hk = sessionIntervals(S.HK, at('2026-10-01T00:00:00Z'), at('2026-10-02T00:00:00Z'))
  assert.equal(hk.length, 2)
  assert.deepEqual(subtractIntervals(hk, [{ from: at('2026-09-30T16:00:00Z'), to: at('2026-10-01T16:00:00Z') }]), [])
  const partial = subtractIntervals(hk, [{ from: at('2026-10-01T02:00:00Z'), to: at('2026-10-01T03:00:00Z') }])
  assert.deepEqual(shape(partial), [
    { date: '2026-10-01', from: '2026-10-01T01:30:00.000Z', to: '2026-10-01T02:00:00.000Z' },
    { date: '2026-10-01', from: '2026-10-01T03:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
    { date: '2026-10-01', from: '2026-10-01T05:00:00.000Z', to: '2026-10-01T08:00:00.000Z' },
  ])
  assert.equal(subtractIntervals(hk, []), hk)
})

test('WEB-6b: the hint states what the report applied, and claims nothing without a report', () => {
  assert.match(sessionHint(S.HK, [], { status: 'applied', identities: 2, closures: [] }), /broker-listed holidays and early closes applied \(2 HKEX calendars; none in today's window\)/)
  assert.match(sessionHint(S.JPN, [], { status: 'not_listed' }), /not applied: no broker calendar of a TSE stock \(WEB-6b\)/)
  assert.match(sessionHint(S.NY, [], { status: 'unavailable' }), /could not be read \(WEB-6b\)/)
  assert.match(sessionHint(S.NY), /public holidays and early closes not applied \(WEB-6b\)/)
})
