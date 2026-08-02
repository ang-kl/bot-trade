import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { writeWatchlist } from './watchlists.js'
import { setState } from '../db.js'
import { accountWatchlistSummary, UNTESTED_SAMPLE } from './account-watchlist-summary.js'

const NOW = '2026-08-02T00:00:00Z'

function freshDb() {
  return initDB(':memory:')
}

function seedAccount(db, id, { isLive = 0, enabled = 1, label = null } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, broker_label, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(String(id), isLive, enabled, label, NOW)
}

function setGlobalWatchlist(db, symbols) {
  setState(db, 'autopilot_symbols_json', JSON.stringify(symbols))
}

function seedBacktest(db, { symbol, ranAt = NOW, error = null }) {
  db.prepare(
    `INSERT INTO backtest_runs (ran_at, strategy, symbol, timeframe, trades, error)
     VALUES (?, 'ema', ?, 'H1', 10, ?)`
  ).run(ranAt, symbol, error)
}

test('an account with no list of its own reports the shared list, marked inherited', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  setGlobalWatchlist(db, ['EURUSD', 'GBPUSD', 'XAUUSD'])
  const out = accountWatchlistSummary(db)
  const row = out.accounts.find(a => a.accountId === 'A')
  assert.equal(row.symbols, 3)
  assert.equal(row.inherited, true, 'the count is a view of the shared list, not this account own')
  assert.equal(out.global.inherited, false, 'the shared list inherits from nothing')
  assert.equal(out.global.symbols, 3)
})

test('an account with its own list is not marked inherited and does not follow the shared one', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  setGlobalWatchlist(db, ['EURUSD', 'GBPUSD', 'XAUUSD'])
  writeWatchlist(db, 'A', ['BTCUSD'])
  const out = accountWatchlistSummary(db)
  const row = out.accounts.find(a => a.accountId === 'A')
  assert.equal(row.symbols, 1)
  assert.equal(row.inherited, false)
  assert.equal(out.global.symbols, 3, 'the shared list is untouched by the fork')
})

test('disabled entries are counted separately, not silently included in the universe', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  writeWatchlist(db, 'A', [
    { symbol: 'EURUSD', enabled: true },
    { symbol: 'GBPUSD', enabled: false },
    { symbol: 'XAUUSD', enabled: false },
  ])
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.symbols, 3)
  assert.equal(row.enabled, 1)
  assert.equal(row.disabled, 2)
})

test('backtested is the intersection of THIS list with the runs on record', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  writeWatchlist(db, 'A', ['EURUSD', 'GBPUSD', 'XAUUSD'])
  seedBacktest(db, { symbol: 'EURUSD' })
  seedBacktest(db, { symbol: 'GBPUSD' })
  // A run for a symbol NOT on this list must not inflate the count.
  seedBacktest(db, { symbol: 'BTCUSD' })
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.backtested, 2)
  assert.equal(row.untested, 1)
  assert.deepEqual(row.untestedSample, ['XAUUSD'])
})

test('a failed run is not evidence: error rows do not count as backtested', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  writeWatchlist(db, 'A', ['EURUSD'])
  seedBacktest(db, { symbol: 'EURUSD', error: 'no bars from broker' })
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.backtested, 0, 'a run that failed to fetch data says nothing about the symbol')
  assert.equal(row.untested, 1)
  assert.equal(row.lastBacktestAt, null)
})

test('lastBacktestAt is the newest usable run across the list', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  writeWatchlist(db, 'A', ['EURUSD', 'GBPUSD'])
  seedBacktest(db, { symbol: 'EURUSD', ranAt: '2026-07-01T00:00:00Z' })
  seedBacktest(db, { symbol: 'GBPUSD', ranAt: '2026-07-29T00:00:00Z' })
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.lastBacktestAt, '2026-07-29T00:00:00Z')
})

test('symbol matching is case-insensitive on both sides', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  writeWatchlist(db, 'A', ['eurusd'])
  seedBacktest(db, { symbol: 'EURUSD' })
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.backtested, 1)
})

test('the untested list is capped but says so, and the true total is always exact', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  const many = Array.from({ length: UNTESTED_SAMPLE + 5 }, (_, i) => `SYM${i}`)
  writeWatchlist(db, 'A', many)
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.untested, UNTESTED_SAMPLE + 5, 'the count is never truncated')
  assert.equal(row.untestedSample.length, UNTESTED_SAMPLE)
  assert.equal(row.untestedTruncated, true)
})

test('an account the registry has never seen is still answerable', () => {
  const db = freshDb()
  setGlobalWatchlist(db, ['EURUSD', 'GBPUSD'])
  const out = accountWatchlistSummary(db, { accountIds: ['9999999'] })
  const row = out.accounts[0]
  assert.equal(row.accountId, '9999999')
  assert.equal(row.inRegistry, false, 'flagged as unknown to the registry rather than omitted')
  assert.equal(row.symbols, 2, 'it would trade the shared list, which is the honest answer')
  assert.equal(row.inherited, true)
})

test('registry metadata rides along for the live flag', () => {
  const db = freshDb()
  seedAccount(db, '1251247', { isLive: 1, enabled: 0, label: 'Live' })
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === '1251247')
  assert.equal(row.isLive, true)
  assert.equal(row.enabledAccount, false)
  assert.equal(row.label, 'Live')
  assert.equal(row.inRegistry, true)
})

test('an empty shared list reports zero rather than throwing', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  // initDB seeds a starter watchlist, so "empty" has to be made empty.
  setGlobalWatchlist(db, [])
  const row = accountWatchlistSummary(db).accounts.find(a => a.accountId === 'A')
  assert.equal(row.symbols, 0)
  assert.equal(row.backtested, 0)
  assert.equal(row.untested, 0)
})
