// node --test agent/lib/quiet-hours.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weekendQuietNow, quietUntilMs, quietScanSymbols, recommendableToday } from './quiet-hours.js'
import { categoriseSymbol } from './sessions.js'

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

test('quietScanSymbols: crypto-only inside the window, untouched outside', () => {
  const watch = [
    { symbol: 'EURUSD' }, { symbol: 'BTCUSD' }, { symbol: 'XAUUSD' },
    { symbol: 'ETHUSD' }, { symbol: 'NAS100' },
  ]
  // Friday night — not quiet: the whole list passes through, same reference.
  const friday = quietScanSymbols(watch, categoriseSymbol, sgt(2026, 7, 31, 23, 0))
  assert.equal(friday.quiet, false)
  assert.equal(friday.symbols, watch)
  // Sunday — quiet: only crypto survives (owner-approved exemption).
  const sunday = quietScanSymbols(watch, categoriseSymbol, sgt(2026, 8, 2, 12, 0))
  assert.equal(sunday.quiet, true)
  assert.deepEqual(sunday.symbols.map(w => w.symbol), ['BTCUSD', 'ETHUSD'])
  // No crypto on the watchlist → quiet stays fully quiet.
  const noCrypto = quietScanSymbols([{ symbol: 'EURUSD' }], categoriseSymbol, sgt(2026, 8, 1, 9, 0))
  assert.equal(noCrypto.quiet, true)
  assert.deepEqual(noCrypto.symbols, [])
  // A throwing categoriser counts as NOT crypto — quiet fails quiet.
  const boom = quietScanSymbols(watch, () => { throw new Error('boom') }, sgt(2026, 8, 2, 12, 0))
  assert.deepEqual(boom.symbols, [])
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
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(5) }, SUN), true)
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(6) }, SUN), true, 'boundary is inclusive')
  assert.equal(inPreOpenWindow({ open: false, next_open_at: hrs(7) }, SUN), false)
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

test('THE POINT: quiet-hours now admits a symbol six hours before ITS open', () => {
  const watch = [
    { symbol: 'BTCUSD' },   // crypto — already exempt
    { symbol: 'JPN225' },   // opens in 4h  → pre-open, admitted
    { symbol: 'GER40' },    // opens in 20h → still quiet
    { symbol: 'NAS100' },   // no schedule  → still quiet
  ]
  const categorise = (s) => (s === 'BTCUSD' ? 'crypto' : 'index')
  const hoursFor = (s) => ({
    JPN225: { open: false, next_open_at: hrs(4) },
    GER40: { open: false, next_open_at: hrs(20) },
  }[s] ?? null)

  const before = quietScanSymbols(watch, categorise, SUN)
  assert.deepEqual(before.symbols.map(w => w.symbol), ['BTCUSD'], 'no resolver → today\'s behaviour, unchanged')

  const after = quietScanSymbols(watch, categorise, SUN, { hoursFor })
  assert.deepEqual(after.symbols.map(w => w.symbol), ['BTCUSD', 'JPN225'])
  assert.deepEqual(after.preOpen, ['JPN225'], 'and it says WHICH ones it let through')
})

test('a resolver that throws leaves the symbol quiet — quiet hours fail quiet', () => {
  const watch = [{ symbol: 'GER40' }]
  const boom = () => { throw new Error('SQLITE_BUSY') }
  const r = quietScanSymbols(watch, () => 'index', SUN, { hoursFor: boom })
  assert.deepEqual(r.symbols, [])
})

test('outside quiet hours the list still passes through untouched', () => {
  const MON = Date.parse('2026-08-10T02:00:00Z') // Monday 10:00 SGT
  const watch = [{ symbol: 'GER40' }, { symbol: 'BTCUSD' }]
  const r = quietScanSymbols(watch, () => 'index', MON, { hoursFor: () => null })
  assert.equal(r.quiet, false)
  assert.equal(r.symbols.length, 2)
})
