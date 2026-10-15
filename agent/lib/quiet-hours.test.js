// node --test agent/lib/quiet-hours.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekendQuietNow, quietUntilMs, recommendableToday, scanSymbolsNow } from './quiet-hours.js'

// SGT = UTC+8. Helper: an SGT wall-clock instant as ms epoch.
const sgt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

test('weekend quiet spans Saturday 00:00 SGT to Monday 01:00 SGT', () => {
  assert.equal(weekendQuietNow(sgt(2026, 7, 31, 23, 59)), false) // Friday night
  assert.equal(weekendQuietNow(sgt(2026, 8, 1, 0, 0)), true)     // Saturday 00:00
  assert.equal(weekendQuietNow(sgt(2026, 8, 1, 12, 0)), true)    // Saturday noon
  assert.equal(weekendQuietNow(sgt(2026, 8, 2, 23, 0)), true)    // Sunday evening
  assert.equal(weekendQuietNow(sgt(2026, 8, 3, 0, 59)), true)    // Monday 00:59
  assert.equal(weekendQuietNow(sgt(2026, 8, 3, 1, 0)), false)    // Monday 01:00 — Sydney prep
  assert.equal(weekendQuietNow(sgt(2026, 8, 5, 12, 0)), false)   // Wednesday
})

test('quietUntilMs answers Monday 01:00 SGT from anywhere in the window', () => {
  const mondayOne = sgt(2026, 8, 3, 1, 0)
  assert.equal(quietUntilMs(sgt(2026, 8, 1, 5, 0)), mondayOne)   // from Saturday
  assert.equal(quietUntilMs(sgt(2026, 8, 2, 22, 0)), mondayOne)  // from Sunday
  assert.equal(quietUntilMs(sgt(2026, 8, 3, 0, 30)), mondayOne)  // from Monday 00:30
  assert.equal(quietUntilMs(sgt(2026, 8, 4, 10, 0)), null)       // Tuesday: not quiet
})

test('recommendableToday: open now, opens today, opens tomorrow, unknown', () => {
  const now = sgt(2026, 8, 3, 9, 0) // Monday 09:00 SGT
  assert.equal(recommendableToday({ open: true }, now), true)
  // NYSE-style: opens Monday 21:30 SGT — same SGT day → recommendable.
  assert.equal(recommendableToday({ open: false, next_open_at: sgt(2026, 8, 3, 21, 30) }, now), true)
  // Market shut until Tuesday → not recommendable today.
  assert.equal(recommendableToday({ open: false, next_open_at: sgt(2026, 8, 4, 9, 0) }, now), false)
  // Unknown hours fail OPEN — never silently mute a symbol forever.
  assert.equal(recommendableToday(null, now), true)
  assert.equal(recommendableToday({ open: false }, now), true)
  assert.equal(recommendableToday({ open: false, nextOpenAt: '2026-08-03T13:30:00Z' }, now), true) // ISO string, 21:30 SGT
})

// ---------------------------------------------------------------------------
// PRE-OPEN WINDOW (owner 09-08-2026): "some markets which open on Monday
// should start monitoring and set pre-trade 6 hours before and reacts to the
// market." The blanket weekend rule and that instruction were in direct
// conflict — six hours before the Sydney open it is still Sunday, so the
// symbols about to open were the ones the bot was not looking at.
// ---------------------------------------------------------------------------

import { inPreOpenWindow, preOpenHoursFrom, PRE_OPEN_HOURS_DEFAULT } from './quiet-hours.js'

const SUN = Date.parse('2026-08-09T12:00:00Z')   // Sunday 20:00 SGT — deep in quiet
const hrs = (h) => new Date(SUN + h * 3_600_000).toISOString()

test('a symbol opening inside the window is pre-open; outside it is not', () => {
  // Claude · № 15,054 16-Oct: the default window is the owner's two hours.
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(1) }, SUN), true)
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(2) }, SUN), true, 'boundary is inclusive')
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(3) }, SUN), false)
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(5) }, SUN, 6), true, 'a wider override still works')
})

test('already open is NOT pre-open', () => {
  assert.equal(inPreOpenWindow({ open: true, next_open_at: hrs(1) }, SUN), false)
})

test('unknown hours stay QUIET here — the opposite of recommendableToday', () => {
  // recommendableToday fails OPEN because muting a symbol forever is worse
  // there. This function ADDS symbols to a deliberately silenced window, so
  // "we do not know when it opens" must never become "scan it".
  assert.equal(inPreOpenWindow(null, SUN), false)
  assert.equal(inPreOpenWindow({ open: false, next_open_at: null }, SUN), false)
  assert.equal(inPreOpenWindow({ open: false, next_open_at: 'not a date' }, SUN), false)
})

test('a next-open in the PAST is stale schedule data, not an imminent open', () => {
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(-1) }, SUN), false)
})

test('the window size rejects the empty values before coercing', () => {
  // Number(null) and Number('') are both 0, and 0 would switch the feature off
  // while looking configured.
  assert.equal(preOpenHoursFrom(null), PRE_OPEN_HOURS_DEFAULT)
  assert.equal(preOpenHoursFrom(''), PRE_OPEN_HOURS_DEFAULT)
  assert.equal(preOpenHoursFrom(0), PRE_OPEN_HOURS_DEFAULT)
  assert.equal(preOpenHoursFrom(-3), PRE_OPEN_HOURS_DEFAULT)
  assert.equal(preOpenHoursFrom('nonsense'), PRE_OPEN_HOURS_DEFAULT)
  assert.equal(preOpenHoursFrom(3), 3)
  assert.equal(preOpenHoursFrom(999), 48, 'clamped, not unbounded')
})

// ── Claude · № 15,054 16-Oct (owner: "Build the scan only if market is opened thus don't need the switch to indicate weekend or weekdays … the pre-order activities are conducted two hours before market-open"; claude-builder) ──
// Expected outcomes: the broker schedule shape nextOpenInfo returns
// ({open, next_open_at, source}); fixture times are self-derived.
test('the pre-open window defaults to the owner\'s two hours', () => {
  assert.equal(PRE_OPEN_HOURS_DEFAULT, 2)
})

test('scanSymbolsNow: open and pre-open (within 2h) symbols stay, unknown hours stay and are counted, closed-not-soon leaves the rotation', () => {
  const now = Date.UTC(2026, 9, 15, 3, 0) // Thursday 11:00 SGT: Asian session, US shares closed
  const H = 3_600_000
  const hours = {
    EURUSD: { open: true, next_open_at: null, source: 'broker' },
    'AAPL.US': { open: false, next_open_at: now + 10.5 * H, source: 'broker' },   // opens 13:30 UTC
    GER40: { open: false, next_open_at: now + 1.5 * H, source: 'broker' },        // pre-open: within 2 h
    JPN225: { open: false, next_open_at: now + 2 * H + 60_000, source: 'broker' }, // 2 h 1 min out: not yet
    NEWSYM: { open: false, next_open_at: null, source: 'heuristic' },              // no broker schedule yet
  }
  const watch = Object.keys(hours).map(symbol => ({ symbol }))
  const pick = scanSymbolsNow(watch, now, { hoursFor: (s) => hours[s] })
  assert.deepEqual(pick.symbols.map(w => w.symbol), ['EURUSD', 'GER40', 'NEWSYM'])
  assert.deepEqual(pick.skippedClosed, ['AAPL.US', 'JPN225'], 'RED before: every enabled symbol stayed in the weekday rotation')
  assert.deepEqual(pick.preOpen, ['GER40']); assert.equal(pick.unknown, 1)
  // a resolver that throws counts as unknown and keeps the symbol: closure needs evidence
  const boom = scanSymbolsNow(watch, now, { hoursFor: () => { throw new Error('boom') } })
  assert.equal(boom.symbols.length, watch.length); assert.equal(boom.unknown, watch.length)
  // no resolver at all: nothing is skipped
  assert.equal(scanSymbolsNow(watch, now).skippedClosed.length, 0)
  // the window override is honoured: JPN225 is inside a 6 h window
  const wide = scanSymbolsNow(watch, now, { hoursFor: (s) => hours[s], preOpenHours: 6 })
  assert.deepEqual(wide.preOpen, ['GER40', 'JPN225'])
})

test('scanSymbolsNow: a weekend needs no switch — on a Saturday only the 24/7 market is open by its own schedule', () => {
  const SAT = sgt(2026, 8, 1, 12, 0) // Saturday noon SGT
  const H = 3_600_000
  const hours = {
    BTCUSD: { open: true, next_open_at: null, source: 'broker' },
    EURUSD: { open: false, next_open_at: SAT + 41 * H, source: 'broker' }, // Monday 05:00 SGT
    NAS100: { open: false, next_open_at: SAT + 41 * H, source: 'broker' },
  }
  const watch = Object.keys(hours).map(symbol => ({ symbol }))
  const sat = scanSymbolsNow(watch, SAT, { hoursFor: (s) => hours[s] })
  assert.deepEqual(sat.symbols.map(w => w.symbol), ['BTCUSD'], 'the old crypto exemption falls out of the schedule')
  // Monday 03:00 SGT: EURUSD opens in 2 h and rejoins through the window — the old Monday-01:00 rule is not needed
  const MON3 = SAT + 39 * H
  const mon = scanSymbolsNow(watch, MON3, { hoursFor: (s) => hours[s] })
  assert.deepEqual(mon.symbols.map(w => w.symbol), ['BTCUSD', 'EURUSD', 'NAS100'])
  assert.deepEqual(mon.preOpen, ['EURUSD', 'NAS100'])
  const MON0 = SAT + 36 * H // Monday 00:00 SGT: 5 h out, still closed
  assert.deepEqual(scanSymbolsNow(watch, MON0, { hoursFor: (s) => hours[s] }).symbols.map(w => w.symbol), ['BTCUSD'])
})

test('the loop builds its scan list through scanSymbolsNow with the broker schedule and no weekend switch', async () => {
  const { readFileSync } = await import('node:fs')
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /const pick = scanSymbolsNow\(allSymbols, nowForHours\.getTime\(\), \{\s*preOpenHours,\s*hoursFor: \(sym\) => nextOpenInfo\(db, sym, nowForHours\),\s*\}\)/)
  assert.match(loop, /const symbols = pick\.symbols/)
  assert.doesNotMatch(loop, /quietScanSymbols|weekdayScanSymbols/)
  assert.doesNotMatch(loop, /const symbols = weekendQuiet \?/)
})
