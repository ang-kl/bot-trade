import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'
import stateRouter from './state.js'
import { brokerReadCache } from '../lib/broker-read-scope.js'
import { upsertAccount } from '../services/account-registry.js'

async function serve(t, deps = {}) {
  const db = initDB(':memory:')
  const token = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [token]: Date.now() + 60_000 }))
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'ctrader_access_token', 'test-access')
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, deps)); app.use('/state', stateRouter(db))
  const server = app.listen(0)
  t.after(() => { server.close(); db.close() })
  const request = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: r.status, data: await r.json() }
  }
  return { db, request }
}

test('viewed broker reads and cached responses remain isolated from trading selection', async t => {
  const calls = []
  const { db, request } = await serve(t, {
    listCtraderAccounts: async () => [{ accountId: '11' }, { accountId: '22' }],
    snapshotBrokerAccount: async a => { calls.push(a.accountId); return { ...a, positions: [{ positionId: 'same', takeProfit: Number(a.accountId) }] } },
  })
  const a = await request('/actions/broker-positions', { selectedOnly: true })
  const b = await request('/actions/broker-positions', { accountId: '22' })
  assert.equal(a.data.accounts[0].accountId, '11')
  assert.equal(b.data.accounts[0].accountId, '22')
  assert.deepEqual(calls, ['11', '22'])
  assert.equal(getState(db, 'ctrader_account_id'), '11')
  assert.equal((await request('/state/broker-cache?account=22')).data.snapshot.account.accountId, '22')
  assert.equal((await request('/state/broker-cache?account=33')).data.snapshot, null)
  assert.equal((await request('/actions/broker-positions', { accountId: '33' })).status, 404)
  assert.equal((await request('/actions/broker-positions', { accountId: 'typo' })).status, 400)
  setState(db, 'ctrader_account_id', '22')
  assert.equal((await request('/actions/broker-positions', { selectedOnly: true })).data.accounts[0].accountId, '22')
  assert.deepEqual(calls, ['11', '22'], 'same account reuses its own result only')
})

test('broker cache rejects mismatched identity and never borrows global history', async t => {
  const { db, request } = await serve(t)
  setState(db, 'broker_history_cache_json', JSON.stringify({ ok: true, rows: ['foreign'] }))
  setState(db, 'acct:22:broker_snapshot_cache_json', JSON.stringify({ account: { accountId: '11' } }))
  setState(db, 'acct:22:broker_history_cache_json', JSON.stringify({ accountId: '11', rows: ['foreign'] }))
  const r = await request('/state/broker-cache?account=22')
  assert.equal(r.data.snapshot, null)
  assert.equal(r.data.history, null)
  assert.equal((await request('/state/broker-cache?account=all')).status, 400)
  assert.equal((await request('/actions/broker-history', { accountId: 'all' })).status, 400)
  assert.equal((await request('/actions/broker-history', { accountId: '999' })).status, 404)
})

test('slow broker reads coalesce past TTL, keep account boundaries, and retry failed reads', async () => {
  let now = 0; let finish; let calls = 0
  const read = brokerReadCache({ ttlMs: 12, now: () => now })
  const pending = read('11', () => { calls++; return new Promise(resolve => { finish = resolve }) })
  await Promise.resolve()
  now = 30
  assert.equal(read('11', () => { calls++; return 'wrong' }), pending)
  assert.equal(await read('22', () => 'other-account'), 'other-account')
  finish('right'); assert.equal(await pending, 'right')
  now = 35
  assert.equal(await read('11', () => 'too-early'), 'right')
  now = 50
  await assert.rejects(read('11', () => { throw new Error('offline') }), /offline/)
  assert.equal(await read('11', () => 'recovered'), 'recovered')
  assert.equal(calls, 1)
})

test('history uses the requested account host, isolates equal position ids and caches its identity', async t => {
  for (const key of ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET']) {
    const previous = process.env[key]; process.env[key] = 'test-only'
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const seen = []
  const { db, request } = await serve(t, { brokerHistoryTransport: {
    wsGetDeals: async (host, _id, _secret, _token, accountId) => {
      seen.push({ host, accountId })
      return { deal: [{ positionId: '7', dealId: '9', symbolId: 1, tradeSide: 2, volume: 100,
        executionPrice: 120, executionTimestamp: Date.now(), closePositionDetail: { grossProfit: 100, moneyDigits: 2 } }] }
    },
    wsSymbolsByIds: async () => ({ symbol: [{ symbolId: 1, lotSize: 100 }] }),
    wsGetSymbolsList: async () => ({ symbol: [{ symbolId: 1, symbolName: 'X' }] }),
    wsGetTrader: async () => ({}), wsGetAssets: async () => ({ asset: [] }),
  } })
  upsertAccount(db, { accountId: '11', isLive: false })
  upsertAccount(db, { accountId: '22', isLive: true })
  for (const id of ['11', '22']) db.prepare("INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, source) VALUES ('X', 'long', 'closed', ?, '7', ?)").run(id, `owner-${id}`)
  const r = await request('/actions/broker-history', { accountId: '22', days: 1 })
  assert.equal(r.status, 200)
  assert.equal(r.data.accountId, '22')
  assert.equal(r.data.rows[0].source, 'owner-22')
  assert.equal(seen[0].host, 'live.ctraderapi.com')
  assert.ok(seen.every(x => x.accountId === '22'))
  assert.equal((await request('/state/broker-cache?account=22')).data.history.accountId, '22')
  assert.equal((await request('/state/broker-cache?account=11')).data.history, null)
  assert.equal(getState(db, 'ctrader_account_id'), '11')
})
