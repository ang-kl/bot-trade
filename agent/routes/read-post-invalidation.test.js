// node --test agent/routes/read-post-invalidation.test.js
//
// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// Every successful POST /actions/* empties the whole GET /state/* response
// cache (lib/state-cache.js) — right for writes. The Desk POSTed
// /actions/broker-history on every 5-second cycle and /actions/broker-positions
// through the shared overview reader, so each open Desk emptied the whole
// cache every five seconds and every tab's next reads recomputed on the
// trading thread (measured 10-10).
//
// Read in code: neither route is read-only.
//   broker-history   writes acct:<id>:broker_history_cache_json — read by GET
//                    /state/broker-cache alone — so it invalidates THAT path.
//   broker-positions writes account money, deposit currency, account_history
//                    and the snapshot caches — read by many routes — so it
//                    invalidates everything, but once per real broker round.
// Both coalesce through brokerReadCache: a POST answered from the shared slot
// wrote nothing and invalidates nothing. Every other write is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import { upsertAccount } from '../services/account-registry.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'

const MIN = 60_000
const token = 'sess_cccccccccccccccccccccccccccccccccccccccccccccccccc'
const closingDeal = () => ({
  dealId: 9, positionId: '7', symbolId: 10, volume: 100, tradeSide: 2, executionPrice: 1.1, executionTimestamp: Date.now() - MIN,
  closePositionDetail: { entryPrice: 1.0, grossProfit: 4200, swap: 0, commission: 0, moneyDigits: 2 },
})

async function server(t, { deals = () => ({ deal: [closingDeal()] }) } = {}) {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_account_id', '22')
  setState(db, 'ctrader_access_token', 'test-access')
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const previous = process.env[key]; process.env[key] = 'test-only'
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  upsertAccount(db, { accountId: '22', isLive: false })
  const rounds = { history: 0, positions: 0 }
  const app = express(); app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db, {
    brokerHistoryTransport: {
      wsGetDeals: async () => { rounds.history++; return deals() },
      wsSymbolsByIds: async () => ({ symbol: [{ symbolId: 10, lotSize: 100 }] }),
      wsGetSymbolsList: async () => ({ symbol: [{ symbolId: 10, symbolName: 'EURUSD' }] }),
      wsGetTrader: async () => ({}), wsGetAssets: async () => ({ asset: [] }),
    },
    listCtraderAccounts: async () => [{ accountId: '22' }],
    snapshotBrokerAccount: async a => {
      rounds.positions++
      return { ...a, host: 'demo.ctraderapi.com', currency: 'USD', error: null, health: { balance: 1000 }, positions: [], orders: [] }
    },
  }))
  const s = app.listen(0)
  t.after(() => { s.close(); db.close() })
  const url = p => `http://127.0.0.1:${s.address().port}${p}`
  const get = async p => { const r = await fetch(url(p)); return { cache: r.headers.get('x-cache'), body: await r.json() } }
  const post = async (p, body = {}) => {
    const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  return { db, get, post, rounds }
}

test('POST /actions/broker-history invalidates only GET /state/broker-cache — the rest of the cache survives', async t => {
  const s = await server(t)
  assert.equal((await s.get('/state/config')).cache, 'miss')
  assert.equal((await s.get('/state/config')).cache, 'hit')
  const before = await s.get('/state/broker-cache?account=22')
  assert.equal(before.body.history, null, 'nothing cached yet')
  assert.equal((await s.get('/state/broker-cache?account=22')).cache, 'hit')

  const r = await s.post('/actions/broker-history', { accountId: '22', days: 7 })
  assert.equal(r.status, 200)
  assert.equal(r.body.rows.length, 1)
  assert.equal(s.rounds.history, 1)

  assert.equal((await s.get('/state/config')).cache, 'hit', 'an unrelated cached read is not thrown away by a broker READ')
  const after = await s.get('/state/broker-cache?account=22')
  assert.equal(after.cache, 'miss', 'the one route that serves what broker-history wrote is recomputed')
  assert.equal(after.body.history.rows.length, 1, 'and it serves the history just written — never the pre-write answer')
})

test('a broker-history POST answered from the coalescing slot wrote nothing and invalidates nothing', async t => {
  const s = await server(t)
  await s.post('/actions/broker-history', { accountId: '22', days: 7 })
  await s.get('/state/broker-cache?account=22')
  assert.equal((await s.get('/state/broker-cache?account=22')).cache, 'hit')
  const again = await s.post('/actions/broker-history', { accountId: '22', days: 7 })
  assert.equal(again.status, 200)
  assert.equal(s.rounds.history, 1, 'served from the shared slot: no broker round, no write')
  assert.equal((await s.get('/state/broker-cache?account=22')).cache, 'hit')
})

test('POST /actions/broker-positions empties the whole cache once per real broker round, not once per POST', async t => {
  const s = await server(t)
  await s.get('/state/config')
  assert.equal((await s.get('/state/config')).cache, 'hit')
  const first = await s.post('/actions/broker-positions', { accountId: 'all' })
  assert.equal(first.status, 200)
  assert.equal(s.rounds.positions, 1)
  assert.equal((await s.get('/state/config')).cache, 'miss', 'a real round wrote money/history/snapshot caches many routes read')
  assert.equal((await s.get('/state/config')).cache, 'hit')
  const second = await s.post('/actions/broker-positions', { accountId: 'all' })
  assert.equal(second.status, 200)
  assert.equal(s.rounds.positions, 1, 'answered from the shared slot')
  assert.equal((await s.get('/state/config')).cache, 'hit', 'nothing was written, so nothing is invalidated')
})

test('a failed broker read invalidates nothing; every other successful write still empties the cache', async t => {
  const s = await server(t, { deals: () => { throw new Error('broker down') } })
  await s.get('/state/config')
  const failed = await s.post('/actions/broker-history', { accountId: '22', days: 7 })
  assert.equal(failed.status, 502)
  assert.equal((await s.get('/state/config')).cache, 'hit')
  const w = await s.post('/actions/symbols', { symbols: [{ symbol: 'EURUSD' }] })
  assert.equal(w.status, 200)
  assert.equal((await s.get('/state/config')).cache, 'miss', 'an ordinary write keeps the whole-cache rule')
})

// Claude · № 12,975 10-Oct (Codex P2 on #1301): index.js inserts an action_log
// row for EVERY POST before the actions router runs, so even a coalesced
// broker read (no broker round, no global invalidation) leaves a new audit row
// that GET /state/action-log and /state/workspace-log must show at once.
test('the exempt broker POSTs still refresh the two audit-log reads — nothing else', async t => {
  const s = await server(t)
  await s.post('/actions/broker-history', { accountId: '22', days: 7 }) // first, real round
  for (const p of ['/state/action-log', '/state/workspace-log', '/state/config']) {
    await s.get(p)
    assert.equal((await s.get(p)).cache, 'hit', `${p} cached before the coalesced POST`)
  }
  const again = await s.post('/actions/broker-history', { accountId: '22', days: 7 })
  assert.equal(again.status, 200)
  assert.equal(s.rounds.history, 1, 'served from the shared slot: no broker round')
  assert.equal((await s.get('/state/action-log')).cache, 'miss', 'the audit row index.js wrote is visible at once')
  assert.equal((await s.get('/state/workspace-log')).cache, 'miss')
  assert.equal((await s.get('/state/config')).cache, 'hit', 'an unrelated read is still not thrown away')
  const pos = await s.post('/actions/broker-positions', { accountId: 'all' })
  assert.equal(pos.status, 200)
  await s.get('/state/action-log')
  assert.equal((await s.get('/state/action-log')).cache, 'hit')
  const pos2 = await s.post('/actions/broker-positions', { accountId: 'all' })
  assert.equal(pos2.status, 200)
  assert.equal((await s.get('/state/action-log')).cache, 'miss', 'a coalesced broker-positions POST refreshes the audit read too')
})
