// resolveSymbolId — the broker symbol id for a symbol ON ONE ACCOUNT
// (03-09-2026). Measured on ACCT-LIVE-1: the shared symbol_id_map's ids for
// LLY.US and GD.US were other instruments (read at 6.56 and 11.52 against
// 1,159.32 and 363.69 on the demos) and a live buy limit went out at 6.56.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  resolveSymbolId, getAccountSymbolMap, accountSymbolMapKey, ACCOUNT_SYMBOL_MAP_TTL_MS, fetchAccountSymbolMap,
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

// V3 K2 — the one writer of symbol_id_map:<accountId>.
test("the one writer reads the account's own list, stamps it as that account's, and dates it by deps.now", async () => {
  const db = initDB(':memory:')
  const seen = []
  const own = { wsGetSymbolsList: async (...a) => { seen.push(a); return { ctidTraderAccountId: 200, symbol: [{ symbolName: 'lly.us', symbolId: 9001 }] } } }
  const m = await fetchAccountSymbolMap(db, creds('200'), { ...own, now: Date.parse('2026-09-25T15:00:00Z') })
  assert.deepEqual(m, { 'LLY.US': 9001 })
  assert.deepEqual(seen[0].slice(4), ['200', undefined, { perAccount: true }], 'RED if the read may be served from the host-shared cache')
  assert.deepEqual(JSON.parse(getState(db, accountSymbolMapKey('200'))), { builtAt: '2026-09-25T15:00:00.000Z', accountId: '200', map: { 'LLY.US': 9001 } })
  assert.deepEqual(getAccountSymbolMap(db, '200'), { map: { 'LLY.US': 9001 }, builtAt: '2026-09-25T15:00:00.000Z' }, 'readers see the same { map, builtAt }')
})

test("a symbol list that names another account is refused: nothing is written, and an order gets a refusal, never that account's id", async () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', '100')
  const foreign = { wsGetSymbolsList: async () => ({ ctidTraderAccountId: 100, symbol: [{ symbolName: 'LLY.US', symbolId: 5 }] }) }
  await assert.rejects(fetchAccountSymbolMap(db, creds('200'), foreign), /account_identity_mismatch: the symbol list for …200 names …100/)
  assert.equal(getState(db, accountSymbolMapKey('200')), null, "RED if another account's list is stored under this key")
  const r = await resolveSymbolId(db, creds('200'), 'LLY.US', foreign)
  assert.equal(r.id, null)
  assert.equal(r.source, 'unverified')
  assert.match(r.reason, /account_identity_mismatch/)
  // A stored (stale) map of its own is kept and still serves, as before.
  const old = new Date(Date.now() - ACCOUNT_SYMBOL_MAP_TTL_MS - 1000).toISOString()
  setState(db, accountSymbolMapKey('200'), JSON.stringify({ builtAt: old, map: { 'LLY.US': 9001 } }))
  assert.deepEqual(await resolveSymbolId(db, creds('200'), 'LLY.US', foreign), { id: 9001, source: 'account-stale' })
  assert.equal(getAccountSymbolMap(db, '200').builtAt, old)
})
