// node --test agent/routes/watchlist-account-routes.test.js
//
// PER-ACCOUNT WATCHLISTS, end to end through the routes.
//
// Owner 02-08-2026: "I am confuse whether the ACCOUNT has how many symbols in
// watchlist" — and they were right to be. Every account read the SAME list:
// readWatchlist falls back to the shared key when an account has no list of
// its own, and the only writer (POST /actions/symbols) always wrote the shared
// key. So the per-account count shown in the UI was the shared count wearing
// an account's name, for every account.
//
// The engine was already per-account (loop.js gates dispatch through
// accountMayTrade, and the universe consumers take readTradableUnion), so what
// follows is about the read/write path telling the truth, not about changing
// what trades.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const cfg = (s, acct) =>
  fetch(s.url(`/state/config${acct ? `?account=${acct}` : ''}`)).then(r => r.json())

const save = (s, symbols, account) => fetch(s.url('/actions/symbols'), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(account ? { symbols, account } : { symbols }),
}).then(r => r.json())

const syms = (r) => (r.symbols || []).map(x => x.symbol)

test('an account with no list of its own INHERITS the shared one, and says so', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }])
    const a = await cfg(s, '5203012')
    assert.deepEqual(syms(a), ['EURUSD', 'XAUUSD'])
    assert.equal(a.watchlist_inherited, true, 'must be reported as inherited, not owned')
    assert.equal(a.watchlist_account, '5203012')
    assert.equal(a.watchlist_shared_count, 2)
  } finally { s.close() }
})

test('writing an account list FORKS it — the shared list is untouched', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }])
    const w = await save(s, [{ symbol: 'BTCUSD' }], '5203012')
    assert.equal(w.account, '5203012')
    assert.equal(w.forked, true, 'the first per-account write ends inheritance — the UI must be able to warn')

    assert.deepEqual(syms(await cfg(s, '5203012')), ['BTCUSD'])
    assert.equal((await cfg(s, '5203012')).watchlist_inherited, false)
    // The shared list, and therefore every OTHER account, is unaffected.
    assert.deepEqual(syms(await cfg(s)), ['EURUSD', 'XAUUSD'])
    assert.deepEqual(syms(await cfg(s, '5306502')), ['EURUSD', 'XAUUSD'])
  } finally { s.close() }
})

test('a second write to the same account is not a fork', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }])
    assert.equal((await save(s, [{ symbol: 'BTCUSD' }], '5203012')).forked, true)
    assert.equal((await save(s, [{ symbol: 'ETHUSD' }], '5203012')).forked, false)
  } finally { s.close() }
})

test('two accounts keep genuinely separate lists', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }], '5203012')
    await save(s, [{ symbol: 'GBPUSD' }, { symbol: 'US500' }], '5306502')
    assert.deepEqual(syms(await cfg(s, '5203012')), ['EURUSD'])
    assert.deepEqual(syms(await cfg(s, '5306502')), ['GBPUSD', 'US500'])
  } finally { s.close() }
})

test('a scoped write is visible on the very next scoped read', async () => {
  const s = await server()
  try {
    // The cache is keyed on originalUrl, so ?account=A and ?account=B and the
    // bare read are three entries — a scoped write must invalidate the one it
    // affects. Same failure the shared list had in state-cache.test.js.
    await save(s, [{ symbol: 'EURUSD' }], '5203012')
    assert.deepEqual(syms(await cfg(s, '5203012')), ['EURUSD'])
    await save(s, [{ symbol: 'EURUSD' }, { symbol: 'AUDPLN' }], '5203012')
    assert.deepEqual(syms(await cfg(s, '5203012')), ['EURUSD', 'AUDPLN'], 'stale cache served the pre-write list')
  } finally { s.close() }
})

test('the FORKING write records no removals — the account never owned those symbols', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }])   // shared list
    await save(s, [{ symbol: 'BTCUSD' }], '5203012')              // fork, drops both
    const hist = s.db.prepare("SELECT value FROM agent_state WHERE key = 'acct:5203012:watchlist_removed_json'").get()
    // EURUSD/XAUUSD were inherited, never chosen by this account. Listing them
    // as "previously watched, tap to re-add" would invent a history it has not
    // got — and on a real fork that card would fill with the whole shared list.
    assert.deepEqual(JSON.parse(hist?.value || '[]'), [])
  } finally { s.close() }
})

test('removal history is per-account, not shared', async () => {
  const s = await server()
  try {
    await save(s, [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }], '5203012')  // fork
    await save(s, [{ symbol: 'EURUSD' }], '5203012')          // XAUUSD removed here
    await save(s, [{ symbol: 'GBPUSD' }], '5306502')
    const own = JSON.parse(s.db.prepare("SELECT value FROM agent_state WHERE key = 'acct:5203012:watchlist_removed_json'").get()?.value || '[]')
    assert.deepEqual(own.map(r => r.symbol), ['XAUUSD'])
    // The other account's card must not show a removal it never made.
    const other = s.db.prepare("SELECT value FROM agent_state WHERE key = 'acct:5306502:watchlist_removed_json'").get()
    assert.equal(JSON.parse(other?.value || '[]').length, 0)
    // And the shared key is untouched by either.
    const shared = s.db.prepare("SELECT value FROM agent_state WHERE key = 'watchlist_removed_json'").get()
    assert.equal(JSON.parse(shared?.value || '[]').length, 0)
  } finally { s.close() }
})

test('no account param still writes the SHARED list — every old caller is unaffected', async () => {
  const s = await server()
  try {
    const w = await save(s, [{ symbol: 'EURUSD' }])
    assert.equal(w.account, null)
    assert.equal(w.forked, false)
    const bare = await cfg(s)
    assert.deepEqual(syms(bare), ['EURUSD'])
    assert.equal(bare.watchlist_account, null)
    assert.equal(bare.watchlist_inherited, null, 'unknown, not false — no account was asked about')
  } finally { s.close() }
})

test('the strategy-key guard still applies to a scoped write', async () => {
  const s = await server()
  try {
    const r = await fetch(s.url('/actions/symbols'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: '5203012', symbols: [{ symbol: 'EURUSD', strategies: ['cup_handel'] }] }),
    })
    assert.equal(r.status, 400, 'a typo\'d strategy key must be refused per-account too')
    // …and the bad request must not have created a list for the account.
    assert.equal((await cfg(s, '5203012')).watchlist_inherited, true)
  } finally { s.close() }
})
