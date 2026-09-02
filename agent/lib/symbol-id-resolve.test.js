// resolveSymbolId — the broker symbol id for a symbol ON ONE ACCOUNT
// (03-09-2026). Measured on ACCT-LIVE-1: the shared symbol_id_map's ids for
// LLY.US and GD.US were other instruments (read at 6.56 and 11.52 against
// 1,159.32 and 363.69 on the demos) and a live buy limit went out at 6.56.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  resolveSymbolId, getAccountSymbolMap, accountSymbolMapKey, ACCOUNT_SYMBOL_MAP_TTL_MS,
} from './ctrader-creds.js'

const creds = (accountId, extra = {}) => ({ host: 'demo', clientId: 'c', clientSecret: 's', accessToken: 't', accountId, ready: true, ...extra })
const list = (rows) => async () => ({ symbol: rows.map(([symbolName, symbolId]) => ({ symbolName, symbolId })) })

test('an account with no stored list fetches ITS OWN list, persists it, and resolves from it — not from the shared map', async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '100')
  setState(db, 'symbol_id_map', JSON.stringify({ 'LLY.US': 5, 'GD.US': 6 }))
  let fetched = 0
  const deps = { wsGetSymbolsList: async (...a) => { fetched++; assert.equal(a[4], '200', 'fetched with the account in the creds'); return list([['LLY.US', 9001], ['JPM.US', 9002]])() } }
  const r = await resolveSymbolId(db, creds('200'), 'lly.us', deps)
  assert.deepEqual(r, { id: 9001, source: 'account' })
  assert.equal(fetched, 1)
  assert.equal(getAccountSymbolMap(db, '200').map['LLY.US'], 9001, 'persisted under symbol_id_map:<accountId>')
  // a second resolve reads the stored list, no refetch
  const r2 = await resolveSymbolId(db, creds('200'), 'JPM.US', deps)
  assert.deepEqual(r2, { id: 9002, source: 'account' })
  assert.equal(fetched, 1)
  // a name the ACCOUNT does not list is a refusal, even though the shared map has it
  const r3 = await resolveSymbolId(db, creds('200'), 'GD.US', deps)
  assert.equal(r3.id, null)
  assert.match(r3.reason, /^symbol_not_on_account: GD\.US is not in …200's symbol list/)
})

test('a non-primary account whose list cannot be fetched is REFUSED with symbol_map_unverified — never the shared map', async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '100')
  setState(db, 'symbol_id_map', JSON.stringify({ 'LLY.US': 5 }))
  const r = await resolveSymbolId(db, creds('200'), 'LLY.US', { wsGetSymbolsList: async () => { throw new Error('timeout') } })
  assert.equal(r.id, null)
  assert.equal(r.source, 'unverified')
  assert.match(r.reason, /^symbol_map_unverified: no symbol list for …200 \(timeout\) and the global map belongs to …100/)
  // an empty list is the same refusal
  const e = await resolveSymbolId(db, creds('200'), 'LLY.US', { wsGetSymbolsList: async () => ({ symbol: [] }) })
  assert.equal(e.source, 'unverified')
})

test('the shared map serves the PRIMARY account (the one it was built from) and the no-primary fixture case', async () => {
  const db = initDB(':memory:')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  const noFetch = { wsGetSymbolsList: async () => { throw new Error('must not be called') } }
  // no primary recorded (tests): shared map, no fetch
  const a = await resolveSymbolId(db, { accountId: '42' }, 'US30', noFetch)
  assert.deepEqual(a, { id: 7, source: 'global' })
  // primary recorded and matches: shared map after the fetch fails
  setState(db, 'ctrader_account_id', '42')
  const b = await resolveSymbolId(db, creds('42'), 'US30', { wsGetSymbolsList: async () => { throw new Error('down') } })
  assert.deepEqual(b, { id: 7, source: 'global' })
  const c = await resolveSymbolId(db, creds('42'), 'NAS100', { wsGetSymbolsList: async () => { throw new Error('down') } })
  assert.equal(c.id, null)
  assert.match(c.reason, /^symbol_id_unknown: NAS100 is not in symbol_id_map/)
})

test('a stale stored list is refetched; when the refetch fails the stale list still serves (source account-stale)', async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '100')
  const old = new Date(Date.now() - ACCOUNT_SYMBOL_MAP_TTL_MS - 1000).toISOString()
  setState(db, accountSymbolMapKey('200'), JSON.stringify({ builtAt: old, map: { 'LLY.US': 9001 } }))
  const fresh = await resolveSymbolId(db, creds('200'), 'LLY.US', { wsGetSymbolsList: list([['LLY.US', 9009]]) })
  assert.deepEqual(fresh, { id: 9009, source: 'account' }, 'the refetched id wins')
  assert.notEqual(getAccountSymbolMap(db, '200').builtAt, old)
  setState(db, accountSymbolMapKey('200'), JSON.stringify({ builtAt: old, map: { 'LLY.US': 9001 } }))
  const stale = await resolveSymbolId(db, creds('200'), 'LLY.US', { wsGetSymbolsList: async () => { throw new Error('down') } })
  assert.deepEqual(stale, { id: 9001, source: 'account-stale' })
  assert.equal(getState(db, 'symbol_id_map'), null, 'nothing here ever wrote the shared map')
})

test('no symbol, no account: honest nulls', async () => {
  const db = initDB(':memory:')
  assert.equal((await resolveSymbolId(db, creds('1'), '')).source, 'none')
  setState(db, 'symbol_id_map', JSON.stringify({ US30: 7 }))
  assert.deepEqual(await resolveSymbolId(db, {}, 'US30'), { id: 7, source: 'global' }, 'no account at all → the shared map (legacy single-account callers)')
})
