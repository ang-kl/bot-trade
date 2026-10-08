// Codex · №12,171 · 2026-10-08; codex-footprint: real DB/caller ownership regressions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { ensureSymbolMap, resolveSymbolId, accountSymbolMapKey, getAccountSymbolMap, getSymbolMap } from './ctrader-creds.js'
import { makeTargetSuggester } from '../services/tp-suggest.js'
import express from 'express'
import actionsRouter from '../routes/actions.js'

const creds = accountId => ({ ready: true, accountId, host: 'demo.ctraderapi.com', clientId: 'fixture-client', clientSecret: 'fixture-secret', accessToken: 'fixture-token' })
function fixture(t, primary = '100') {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'ctrader_account_id', primary)
  setState(db, 'symbol_id_map', JSON.stringify({ ETHUSD: 11 }))
  return db
}
function owned(db, accountId, id) {
  setState(db, accountSymbolMapKey(accountId), JSON.stringify({ accountId, builtAt: new Date().toISOString(), map: { ETHUSD: id } }))
}
function position(accountId, symbolId) {
  return { positionId: `${accountId}-position`, ctidTraderAccountId: accountId, tradeData: { symbolId, openPrice: 1800, tradeSide: 'BUY' } }
}
const finding = accountId => ({ positionId: `${accountId}-position`, symbol: 'ETHUSD', brokerSl: 1700 })

test('targetless protection fetches each account snapshot instrument, never the selected account shared ID', async t => {
  const db = fixture(t)
  owned(db, '100', 11); owned(db, '200', 22)
  const reads = []
  for (const [accountId, id] of [['100', 11], ['200', 22]]) {
    const suggest = makeTargetSuggester(db, creds(accountId), [position(accountId, id)], {
      fetchBars: async (_host, _client, _secret, _token, account, symbolId) => { reads.push({ account, symbolId }); return { '15m': [] } },
    })
    assert.equal((await suggest(finding(accountId))).tp, 1950, 'existing floor remains valid')
  }
  assert.deepEqual(reads, [{ account: '100', symbolId: 11 }, { account: '200', symbolId: 22 }])
})

test('unknown/malformed snapshot symbol never borrows the shared map for target bars', async t => {
  const db = fixture(t)
  for (const symbolId of [undefined, null, '', ' ', true, 0, -1, 1.5, 'abc']) {
    let fetched = 0
    const suggest = makeTargetSuggester(db, creds('200'), [position('200', symbolId)], { fetchBars: async () => { fetched++; return {} } })
    assert.equal((await suggest(finding('200'))).tp, 1950, 'no bars still keeps the established floor')
    assert.equal(fetched, 0, `unverified snapshot ID ${String(symbolId)}`)
  }
})

test('a target suggestion refuses an explicitly foreign-account position snapshot', async t => {
  const db = fixture(t)
  let fetched = 0
  const p = { ...position('200', 22), ctidTraderAccountId: '100' }
  const suggest = makeTargetSuggester(db, creds('200'), [p], { fetchBars: async () => { fetched++; return {} } })
  assert.equal(await suggest(finding('200')), null)
  assert.equal(fetched, 0)
})

test('symbol-list helper reads this account even while the selected account shared map is populated', async t => {
  const db = fixture(t)
  const reads = []
  const map = await ensureSymbolMap(db, creds('200'), {
    wsGetSymbolsList: async (...args) => {
      reads.push(args)
      return { ctidTraderAccountId: '200', symbol: [{ symbolName: 'ETHUSD', symbolId: 22 }] }
    },
  })
  assert.deepEqual(map, { ETHUSD: 22 })
  assert.equal(reads.length, 1)
  assert.deepEqual(reads[0].slice(4), ['200', undefined, { perAccount: true }])
  assert.equal(JSON.parse(getState(db, 'symbol_id_map')).ETHUSD, 11, 'other-account reads cannot overwrite the selected mirror')
  assert.equal(getAccountSymbolMap(db, '200').map.ETHUSD, 22)
})

test('symbol-list helper preserves an already verified selected-account list without fetching', async t => {
  const db = fixture(t)
  owned(db, '100', 33)
  assert.deepEqual(await ensureSymbolMap(db, creds('100'), { wsGetSymbolsList: async () => { throw Error('unexpected fetch') } }), { ETHUSD: 33 })
  assert.equal(JSON.parse(getState(db, 'symbol_id_map')).ETHUSD, 33, 'legacy selected controllers receive the same verified ID')
})

test('selected-account resolution refuses a foreign broker list instead of falling back to a shared ID', async t => {
  const db = fixture(t, '200')
  const result = await resolveSymbolId(db, creds('200'), 'ETHUSD', {
    wsGetSymbolsList: async () => ({ ctidTraderAccountId: '100', symbol: [{ symbolName: 'ETHUSD', symbolId: 11 }] }),
  })
  assert.equal(result.id, null)
  assert.equal(result.source, 'unverified')
  assert.match(result.reason, /account_identity_mismatch/)
  assert.equal(getState(db, accountSymbolMapKey('200')), null)
})

test('a stored list naming another account is not a verified cache hit', async t => {
  const db = fixture(t)
  setState(db, accountSymbolMapKey('200'), JSON.stringify({ accountId: '100', builtAt: new Date().toISOString(), map: { ETHUSD: 11 } }))
  assert.equal(getAccountSymbolMap(db, '200'), null)
  const result = await resolveSymbolId(db, creds('200'), 'ETHUSD', { wsGetSymbolsList: async () => ({ ctidTraderAccountId: '200', symbol: [{ symbolName: 'ETHUSD', symbolId: 22 }] }) })
  assert.deepEqual(result, { id: 22, source: 'account' })
})

test('symbol-list helper cannot resolve unknown account identity or borrow a map while disconnected', async t => {
  const db = fixture(t)
  assert.deepEqual(await ensureSymbolMap(db, { ready: false, accountId: '200' }), {})
  assert.deepEqual(await ensureSymbolMap(db, { ready: true }), {})
})

test('a legacy unstamped account cache must be verified before it can resolve a linked broker instrument', async t => {
  const db = fixture(t)
  setState(db, accountSymbolMapKey('200'), JSON.stringify({ builtAt: new Date().toISOString(), map: { ETHUSD: 11 } }))
  assert.equal(getAccountSymbolMap(db, '200'), null)
  assert.deepEqual(await resolveSymbolId(db, creds('200'), 'ETHUSD', { wsGetSymbolsList: async () => ({ ctidTraderAccountId: '200', symbol: [{ symbolName: 'ETHUSD', symbolId: 22 }] }) }), { id: 22, source: 'account' })
})

test('real account selection cannot expose the previous account ID while its broker list is in flight', async t => {
  const db = fixture(t)
  owned(db, '100', 11)
  setState(db, 'ctrader_access_token', 'fixture-token')
  const device = 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  setState(db, 'device_sessions', JSON.stringify({ [device]: Date.now() + 60_000 }))
  let release
  const pending = new Promise(resolve => { release = resolve })
  let called
  const requested = new Promise(resolve => { called = resolve })
  const app = express(); app.use(express.json())
  app.use('/actions', actionsRouter(db, {
    wsGetSymbolsList: async (...args) => {
      called(args)
      await pending
      return { ctidTraderAccountId: '200', symbol: [{ symbolName: 'ETHUSD', symbolId: 22 }] }
    },
    wsGetTrader: async () => ({ balance: 100000, moneyDigits: 2, leverageInCents: 10000 }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { release(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) })
  const responsePromise = fetch(`http://127.0.0.1:${server.address().port}/actions/ctrader-select-account`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device}` },
    body: JSON.stringify({ accountId: '200', isLive: false, traderLogin: 'fixture' }),
  })
  const requestArgs = await requested
  try {
    assert.equal(getState(db, 'ctrader_account_id'), '200')
    assert.deepEqual(getSymbolMap(db), {}, 'the broker has not established the new selected instrument yet')
    assert.deepEqual(getSymbolMap(db, creds('100')), { ETHUSD: 11 }, 'an existing account snapshot keeps its own map')
    assert.deepEqual(requestArgs.slice(4), ['200', undefined, { perAccount: true }])
  } finally { release() }
  const response = await responsePromise
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  assert.deepEqual(getSymbolMap(db), { ETHUSD: 22 })
})

test('an awaited list completion cannot overwrite the mirror after selection changes', async t => {
  const db = fixture(t)
  let release
  const pending = new Promise(resolve => { release = resolve })
  const first = ensureSymbolMap(db, creds('100'), { wsGetSymbolsList: async () => { await pending; return { ctidTraderAccountId: '100', symbol: [{ symbolName: 'ETHUSD', symbolId: 11 }] } } })
  setState(db, 'ctrader_account_id', '200')
  const second = await ensureSymbolMap(db, creds('200'), { wsGetSymbolsList: async () => ({ ctidTraderAccountId: '200', symbol: [{ symbolName: 'ETHUSD', symbolId: 22 }] }) })
  release()
  assert.deepEqual(await first, { ETHUSD: 11 })
  assert.deepEqual(second, { ETHUSD: 22 })
  assert.equal(JSON.parse(getState(db, 'symbol_id_map')).ETHUSD, 22)
  assert.deepEqual(getSymbolMap(db), { ETHUSD: 22 })
})
