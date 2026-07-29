// node --test agent/services/watchlists.test.js
//
// The property that matters most here is the INERT one: arming per-account
// watchlists must not change what any account trades until someone
// deliberately writes a list. These symbols feed the dispatch path, so a
// migration that silently re-scoped a live trading universe would be a much
// bigger event than the UI feature it exists to serve.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { upsertAccount, setAccountEnabled } from './account-registry.js'
import {
  readWatchlist, writeWatchlist, hasOwnWatchlist, diffWatchlists, copyWatchlist,
  acctWatchlistKey, normalizeItem, readTradableUnion, accountMayTrade,
} from './watchlists.js'

const db = () => initDB(':memory:')
const GLOBAL = [
  { symbol: 'EURUSD', enabled: true, group: 'FOREX', maxVolume: 0.5 },
  { symbol: 'NAS100', enabled: true, group: 'US Indices' },
]

test('with no per-account list, every account sees the global one', () => {
  const d = db()
  setState(d, 'autopilot_symbols_json', JSON.stringify(GLOBAL))
  for (const acct of ['43097342', '46130058', '46979908']) {
    assert.deepEqual(readWatchlist(d, acct).map(i => i.symbol), ['EURUSD', 'NAS100'])
    assert.equal(hasOwnWatchlist(d, acct), false, 'inheriting is not the same as owning')
  }
  // …and identical to the un-scoped read, which is what the old code did.
  assert.deepEqual(readWatchlist(d, null).map(i => i.symbol), ['EURUSD', 'NAS100'])
})

test('the legacy watchlist_json key is still honoured when nothing else is set', () => {
  const d = db()
  setState(d, 'watchlist_json', JSON.stringify(['XAUUSD']))
  assert.deepEqual(readWatchlist(d, '43097342'), [{ symbol: 'XAUUSD', enabled: true }])
})

test('writing an account list ENDS inheritance for that account only', () => {
  const d = db()
  setState(d, 'autopilot_symbols_json', JSON.stringify(GLOBAL))
  writeWatchlist(d, '43097342', [{ symbol: 'BTCUSD' }])
  assert.deepEqual(readWatchlist(d, '43097342').map(i => i.symbol), ['BTCUSD'])
  assert.equal(hasOwnWatchlist(d, '43097342'), true)
  // The other two are untouched — this is the contamination guard.
  assert.deepEqual(readWatchlist(d, '46130058').map(i => i.symbol), ['EURUSD', 'NAS100'])
  assert.deepEqual(readWatchlist(d, '46979908').map(i => i.symbol), ['EURUSD', 'NAS100'])
  assert.deepEqual(readWatchlist(d, null).map(i => i.symbol), ['EURUSD', 'NAS100'])
})

test('a bare string entry means enabled, and symbols are upper-cased', () => {
  assert.deepEqual(normalizeItem(' eurusd '), { symbol: 'EURUSD', enabled: true })
  assert.equal(normalizeItem({ symbol: 'nas100', enabled: false }).enabled, false)
})

test('diff separates present-in-both from same-in-both', () => {
  const a = [
    { symbol: 'EURUSD', enabled: true, maxVolume: 0.5 },
    { symbol: 'NAS100', enabled: true },
    { symbol: 'BTCUSD', enabled: true },
  ]
  const b = [
    { symbol: 'EURUSD', enabled: true, maxVolume: 0.1 },   // same symbol, DIFFERENT cap
    { symbol: 'NAS100', enabled: true },                    // identical
    { symbol: 'XAUUSD', enabled: true },
  ]
  const d = diffWatchlists(a, b)
  assert.deepEqual(d.onlyA.map(i => i.symbol), ['BTCUSD'])
  assert.deepEqual(d.onlyB.map(i => i.symbol), ['XAUUSD'])
  assert.deepEqual(d.same.map(i => i.symbol), ['NAS100'])
  assert.deepEqual(d.differs.map(i => i.symbol), ['EURUSD'],
    'a symbol on both sides with a different lot cap is NOT "the same" — that is the whole point of the compare')
  assert.equal(d.differs[0].source.maxVolume, 0.5)
  assert.equal(d.differs[0].destination.maxVolume, 0.1)
})

test('copy carries the SETTINGS, not just the ticker', () => {
  const d = db()
  writeWatchlist(d, 'SRC', [
    { symbol: 'EURUSD', enabled: true, group: 'FOREX', maxVolume: 0.5, autoTradeThreshold: 9 },
  ])
  copyWatchlist(d, { from: 'SRC', to: ['DST'] })
  const row = readWatchlist(d, 'DST').find(i => i.symbol === 'EURUSD')
  assert.ok(row, 'the copied symbol is on the destination')
  assert.equal(row.maxVolume, 0.5, 'a copy that dropped the lot cap would silently resize the trade')
  assert.equal(row.autoTradeThreshold, 9)
  assert.equal(row.group, 'FOREX')
})

test('merge leaves the destination\'s other symbols alone; replace does not', () => {
  const d = db()
  writeWatchlist(d, 'SRC', [{ symbol: 'EURUSD' }, { symbol: 'NAS100' }])
  writeWatchlist(d, 'DST', [{ symbol: 'XAUUSD' }])   // its OWN list, not inherited

  const merged = copyWatchlist(d, { from: 'SRC', to: ['DST'], symbols: ['EURUSD'] })
  assert.deepEqual(readWatchlist(d, 'DST').map(i => i.symbol).sort(), ['EURUSD', 'XAUUSD'])
  assert.deepEqual(merged.results[0].added, ['EURUSD'])
  assert.deepEqual(merged.results[0].removed, [])

  const replaced = copyWatchlist(d, { from: 'SRC', to: ['DST'], symbols: ['NAS100'], mode: 'replace' })
  assert.deepEqual(readWatchlist(d, 'DST').map(i => i.symbol), ['NAS100'])
  assert.deepEqual(replaced.results[0].removed.sort(), ['EURUSD', 'XAUUSD'],
    'replace must REPORT what it destroyed, not just do it')
})

test('the report names what changed per destination', () => {
  const d = db()
  writeWatchlist(d, 'SRC', [{ symbol: 'EURUSD', maxVolume: 1 }, { symbol: 'NAS100' }])
  writeWatchlist(d, 'D1', [{ symbol: 'EURUSD', maxVolume: 0.1 }])
  const r = copyWatchlist(d, { from: 'SRC', to: ['D1'] })
  assert.equal(r.copied, 2)
  const d1 = r.results[0]
  assert.deepEqual(d1.added, ['NAS100'])
  assert.deepEqual(d1.updated, ['EURUSD'], 'an overwrite is an update, not an add')
  assert.equal(d1.total, 2)
  assert.equal(d1.inherited, false, 'D1 already owned a list')
})

test('copying into an INHERITING account keeps what it trades, and says so', () => {
  // initDB seeds a default shared watchlist, so a fresh account is inheriting.
  // The merge must not drop those symbols — nothing an account is already
  // trading should silently disappear — but the operator has to be told that
  // the account now owns its list and will stop following shared edits.
  const d = db()
  const sharedBefore = readWatchlist(d, 'FRESH').map(i => i.symbol)
  assert.ok(sharedBefore.length > 0, 'precondition: the default shared list is non-empty')
  writeWatchlist(d, 'SRC', [{ symbol: 'EURUSD' }])

  const r = copyWatchlist(d, { from: 'SRC', to: ['FRESH'] })
  assert.equal(r.results[0].inherited, true, 'the report must flag that inheritance just ended')

  const after = readWatchlist(d, 'FRESH').map(i => i.symbol)
  for (const s of sharedBefore) {
    assert.ok(after.includes(s), `${s} was being traded before the copy and must survive it`)
  }
  assert.ok(after.includes('EURUSD'))

  // Proof the inheritance really is over: a later edit to the shared list
  // does NOT reach this account.
  setState(d, 'autopilot_symbols_json', JSON.stringify([{ symbol: 'ZZZZZZ' }]))
  assert.ok(!readWatchlist(d, 'FRESH').map(i => i.symbol).includes('ZZZZZZ'))
})

test('copy refuses the mistakes that would be expensive', () => {
  const d = db()
  writeWatchlist(d, 'SRC', [{ symbol: 'EURUSD' }])
  assert.throws(() => copyWatchlist(d, { from: 'SRC', to: ['SRC'] }), /onto itself/)
  assert.throws(() => copyWatchlist(d, { from: 'SRC', to: [] }), /destination/)
  assert.throws(() => copyWatchlist(d, { from: '', to: ['A'] }), /source/)
  assert.throws(() => copyWatchlist(d, { from: 'SRC', to: ['A'], mode: 'wipe' }), /unknown copy mode/)
  assert.throws(() => copyWatchlist(d, { from: 'SRC', to: ['A'], symbols: ['NOPE'] }), /no matching symbols/,
    'a copy that silently did nothing would read as success')
})

test('the scan universe is the UNION of every enabled account, not one account\'s list', () => {
  // The universe consumers — the guardian spot stream, the burn-in candidate
  // pool, the pending-signal retry sweep — have no account in scope. If they
  // read one account's list, the other accounts' instruments go unwatched
  // while those accounts are still trading them.
  const d = db()
  setState(d, 'autopilot_symbols_json', JSON.stringify(GLOBAL))
  upsertAccount(d, { accountId: 'A' }); setAccountEnabled(d, 'A', true, 'active')
  upsertAccount(d, { accountId: 'B' }); setAccountEnabled(d, 'B', true, 'manage_only')
  upsertAccount(d, { accountId: 'C' }); setAccountEnabled(d, 'C', false)

  writeWatchlist(d, 'A', [{ symbol: 'EURUSD' }, { symbol: 'BTCUSD' }])
  writeWatchlist(d, 'B', [{ symbol: 'XAUUSD' }])
  writeWatchlist(d, 'C', [{ symbol: 'NOBODY' }])

  const u = readTradableUnion(d).map(i => i.symbol).sort()
  assert.ok(u.includes('BTCUSD'), 'A trades it, so it needs ticks')
  assert.ok(u.includes('XAUUSD'), 'a manage_only account still holds positions that need feeding')
  assert.ok(u.includes('NAS100'), 'the shared list is always part of the universe')
  assert.ok(!u.includes('NOBODY'), 'a disabled account contributes nothing')
})

test('with no per-account lists the union is exactly the old global read', () => {
  // The drop-in property. If this ever fails, swapping the consumers over
  // changed what the system scans.
  const d = db()
  setState(d, 'autopilot_symbols_json', JSON.stringify(GLOBAL))
  assert.deepEqual(
    readTradableUnion(d).map(i => i.symbol),
    readWatchlist(d, null).map(i => i.symbol),
  )
})

test('the per-account gate says WHY, so the skip can be recorded', () => {
  const d = db()
  writeWatchlist(d, 'A', [{ symbol: 'EURUSD' }, { symbol: 'NAS100', enabled: false }])
  assert.equal(accountMayTrade(d, 'A', 'eurusd').ok, true, 'case is not a gate')
  const off = accountMayTrade(d, 'A', 'NAS100')
  assert.equal(off.ok, false)
  assert.match(off.reason, /disabled/)
  const absent = accountMayTrade(d, 'A', 'BTCUSD')
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /not on account A's watchlist/)
  // Every refusal carries a reason — the stage-matrix lesson: a gate that
  // skips without a record is a gate nobody can see working.
  for (const r of [off, absent]) assert.ok(r.reason && r.reason.length > 10)
})

test('an inheriting account is gated by the shared list, exactly as before', () => {
  const d = db()
  setState(d, 'autopilot_symbols_json', JSON.stringify(GLOBAL))
  assert.equal(accountMayTrade(d, '43097342', 'EURUSD').ok, true)
  assert.equal(accountMayTrade(d, '43097342', 'BTCUSD').ok, false)
})

test('the per-account key is the acct: convention the rest of the codebase uses', () => {
  assert.equal(acctWatchlistKey('43097342'), 'acct:43097342:autopilot_symbols_json')
  const d = db()
  writeWatchlist(d, '43097342', [{ symbol: 'EURUSD' }])
  assert.ok(getState(d, 'acct:43097342:autopilot_symbols_json'), 'written under the scoped key')
  assert.equal(getState(d, 'autopilot_symbols_json'), null, 'and never into the global one')
})
