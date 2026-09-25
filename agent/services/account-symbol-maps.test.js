// node --test agent/services/account-symbol-maps.test.js
//
// V3 K2 — each registered account's OWN symbol map, read daily whether or not
// the account ever trades:
//   - an account that never trades gets its map from ITS OWN list (its host,
//     its id, the account-true read), stamped as its own, and the coverage
//     read stops naming it missing;
//   - the bound: one read per account per day on a healthy roster, across
//     restarts; a failing account backs off, is capped at three reads a UTC
//     day, keeps its stale map and does not starve the others;
//   - a list that names another account is refused and nothing is written;
//   - a map written before K2 (no proof it is the account's own) is re-read
//     once, then left alone;
//   - no read without routable credentials, a linked broker or an armed
//     environment; the timer is wired at boot and stoppable;
//   - no read for an account the broker token was refused for (B7): it waits,
//     shown token_refused, with nothing counted, and the others are read;
//   - no read for a disabled account (outside the sidecars' roster, so never
//     in B7's refused set): shown account_disabled, read once re-enabled.
// The broker is a fake at the transport seam (fetchAccountSymbolMap's
// wsGetSymbolsList), so the real one writer of the map runs in every test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState, getState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import {
  createAccountSymbolMapRefresh, startAccountSymbolMapRefresh, accountSymbolMapRefreshView,
  SYMBOL_MAP_RECEIPT_KEY, SYMBOL_MAP_PASS_MS, SYMBOL_MAP_REFRESH_AGE_MS,
} from './account-symbol-maps.js'
import { buildCalendarCoverage } from './calendar-coverage.js'

const DEMO = 'demo.ctraderapi.com', LIVE = 'live.ctraderapi.com'
const H = 3600_000, MIN = 60_000
const REGISTRY = { '46130058': DEMO, '46979908': DEMO, '43002148': LIVE, '43069009': LIVE }

function database(t, ids) {
  const db = initDB(':memory:'); t.after(() => db.close())
  for (const id of ids) db.prepare('INSERT INTO accounts (account_id,is_live,enabled) VALUES (?,?,1)').run(id, REGISTRY[id] === LIVE ? 1 : 0)
  setState(db, 'ctrader_account_id', '46130058')
  return db
}
const credentials = id => ({ ready: true, accountId: id, host: REGISTRY[id], clientId: 'c', clientSecret: 's', accessToken: 't' })
// Each account's own list: the same names under different ids per account.
const listOf = id => [['EURUSD', 1], ['US30', 2], ['LLY.US', 3]].map(([symbolName, n]) => ({ symbolName, symbolId: Number(id.slice(-3)) * 10 + n }))
function broker({ fail = () => false, answerAs = id => id, clock = null } = {}) {
  const calls = []
  return {
    calls,
    wsGetSymbolsList: async (host, _cid, _cs, _tok, accountId, _timeout, opts) => {
      calls.push({ host, accountId: String(accountId), perAccount: opts?.perAccount === true, ...(clock ? { at: new Date(clock()).toISOString().slice(11, 16) } : {}) })
      if (fail(String(accountId))) throw new Error('cTrader WS timeout after 30000ms')
      return { ctidTraderAccountId: Number(answerAs(String(accountId))), symbol: listOf(String(answerAs(String(accountId)))) }
    },
  }
}
const stored = (db, id) => JSON.parse(getState(db, accountSymbolMapKey(id)) || 'null')
const ownMap = (db, id, builtAtMs) => setState(db, accountSymbolMapKey(id), JSON.stringify({ builtAt: new Date(builtAtMs).toISOString(), accountId: id, map: { EURUSD: 1 } }))

test('an account that never trades gets its own map from its own list, stamped as its own, and coverage stops naming it missing', async t => {
  const now = Date.parse('2026-09-25T14:00:00Z')
  const db = database(t, ['46130058', '43002148', '43069009'])
  ownMap(db, '46130058', now - 2 * H) // the trading account: fresh, its own
  // K1's scope tier: the bar scan on the trading account, scoped to the two
  // accounts that never trade (a scan receipt is fresh for 6 min, so it is
  // re-stamped before each coverage read).
  const scan = at => setState(db, 'legacy_scanner_work_json', JSON.stringify({ accountId: '46130058', host: DEMO, completedAt: at - 1000, nextDue: at + 300_000,
    scopeAccounts: ['43002148', '43069009'], instruments: [{ symbol: 'EURUSD', symbolId: '1' }, { symbol: 'US30', symbolId: '2' }] }))
  scan(now)
  const before = buildCalendarCoverage(db, { now })
  const missing = before.accounts.find(a => a.accountId === '43002148')
  assert.equal(missing.symbolMap.status, 'missing')
  assert.deepEqual([missing.symbolMapRefresh.due, missing.symbolMapRefresh.dueReason, missing.symbolMapRefresh.lastResult], [true, 'missing', null])
  assert.deepEqual([missing.demand.byTier.scope, missing.demand.missingMap], [0, true], 'before: no scope demand, named a missing map')

  const fake = broker(); let at = now
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  const first = await refresh()
  assert.deepEqual([first.result, first.accountId, first.dueReason, first.brokerRead], ['refreshed', '43002148', 'missing', true])
  assert.deepEqual(fake.calls, [{ host: LIVE, accountId: '43002148', perAccount: true }], 'its own host, its own id, the account-true read')
  const map = stored(db, '43002148')
  assert.deepEqual(map, { builtAt: new Date(now).toISOString(), accountId: '43002148', map: { EURUSD: 1481, US30: 1482, 'LLY.US': 1483 } })
  at += SYMBOL_MAP_PASS_MS
  assert.equal((await refresh()).accountId, '43069009')
  at += SYMBOL_MAP_PASS_MS
  const idle = await refresh()
  assert.deepEqual([idle.result, idle.due], ['nothing_due', 0])
  assert.equal(fake.calls.length, 2, 'the fresh trading account was not re-read')

  scan(at)
  const after = buildCalendarCoverage(db, { now: at })
  const built = after.accounts.find(a => a.accountId === '43002148')
  assert.equal(built.symbolMap.status, 'present', 'RED without the refresher: the never-trading account stays missing')
  assert.equal(built.symbolMap.size, 3)
  // The point of the map: K1's scope tier now demands this account's OWN
  // identities for the bar scan's names (its ids, not the feed account's).
  assert.deepEqual([built.demand.byTier.scope, built.demand.missingMap], [2, false], "RED without the refresher: K1's scope tier stays empty for an account that never trades")
  assert.equal(after.accounts.find(a => a.accountId === '43069009').demand.byTier.scope, 2)
  assert.deepEqual([built.symbolMapRefresh.ownList, built.symbolMapRefresh.due, built.symbolMapRefresh.lastResult, built.symbolMapRefresh.readsToday], [true, false, 'built', 1])
  assert.equal(after.symbolMapRefresher.due, 0)
  assert.equal(after.symbolMapRefresher.pass.result, 'nothing_due')
  assert.equal(after.brokerCalls, 0, 'the coverage read itself still makes no broker call')
})

test('the bound: one read per account per day on a healthy roster, across restarts, an hour inside the 24 h TTL', async t => {
  const start = Date.parse('2026-09-25T13:00:00Z')
  const db = database(t, ['46130058', '43002148', '43069009'])
  const fake = broker(); let at = start
  let refresh = null
  for (let pass = 0; at <= start + 49 * H; pass++, at += SYMBOL_MAP_PASS_MS) {
    // Node restarts on every merge: a new refresher every 6 h keeps no memory.
    if (pass % 72 === 0) refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
    await refresh()
  }
  const readsOf = id => fake.calls.filter(c => c.accountId === id)
  for (const id of ['46130058', '43002148', '43069009']) assert.equal(readsOf(id).length, 3, `${id}: built at 0, re-read at ~23 h and ~46 h`)
  assert.equal(fake.calls.length, 9, 'RED if a fresh map is re-read: 3 accounts × 3 reads over 49 h')
  // Consecutive reads of one account are one refresh age apart, and the map
  // was never older than resolveSymbolId's 24 h TTL when an order would read it.
  const view = accountSymbolMapRefreshView(db, { now: at })
  for (const a of view.accounts) {
    assert.equal(a.due, false)
    assert.ok(a.map.ageMs < 24 * H, `${a.accountId} ${a.map.ageMs}`)
  }
  assert.equal(SYMBOL_MAP_REFRESH_AGE_MS, 23 * H)
})

test('a failing account backs off, is capped at three reads a UTC day, keeps its stale map, and does not starve the others', async t => {
  const day1 = Date.parse('2026-09-26T00:02:00Z')
  const db = database(t, ['46130058', '46979908', '43002148'])
  ownMap(db, '46130058', day1 - 2 * H)
  ownMap(db, '43002148', day1 - 30 * H) // stale, its own
  const staleRaw = getState(db, accountSymbolMapKey('43002148'))
  let at = day1
  const fake = broker({ fail: id => id === '43002148', clock: () => at })
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  const failedAt = []
  for (; at < Date.parse('2026-09-27T00:00:00Z'); at += SYMBOL_MAP_PASS_MS) {
    const r = await refresh()
    if (r.accountId === '43002148') failedAt.push((at - day1) / MIN)
  }
  const readsOf = id => fake.calls.filter(c => c.accountId === id).map(c => c.at)
  assert.deepEqual(failedAt, [5, 35, 95], 'backoff 30 min, then 60 min; RED if the daily cap or the backoff is dropped')
  // The others are not starved: the missing map led at 00:02 and was re-read
  // 23 h later; the trading account's map (built 22:02 the day before) at 21:02.
  assert.deepEqual(readsOf('46979908'), ['00:02', '23:02'])
  assert.deepEqual(readsOf('46130058'), ['21:02'])
  assert.equal(getState(db, accountSymbolMapKey('43002148')), staleRaw, 'a failed read never deletes or rewrites the stored map')
  const view = accountSymbolMapRefreshView(db, { now: at - SYMBOL_MAP_PASS_MS })
  const failing = view.accounts.find(a => a.accountId === '43002148')
  assert.deepEqual([failing.due, failing.dueReason, failing.blocked, failing.notBefore], [true, 'stale', 'daily_cap', '2026-09-27T00:00:00.000Z'])
  assert.deepEqual([failing.lastResult, failing.consecutiveFailures, failing.readsToday], ['read_failed', 3, 3])
  assert.match(failing.lastError, /timeout/)
  // The next UTC day it is read again (and a restart does not change that).
  const restarted = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  const next = await restarted()
  assert.deepEqual([next.accountId, next.outcome], ['43002148', 'read_failed'])
})

test('a failure is not forgotten on restart: the new process waits out the backoff', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['46130058'])
  const fake = broker({ fail: () => true })
  assert.equal((await createAccountSymbolMapRefresh(db, { env: {}, now: () => now, credentials, fetchDeps: fake })()).outcome, 'read_failed')
  const again = await createAccountSymbolMapRefresh(db, { env: {}, now: () => now + 10 * MIN, credentials, fetchDeps: fake })()
  assert.deepEqual([again.result, again.due, again.waiting], ['waiting', 1, 1], 'due but waiting is labelled waiting, never nothing_due')
  assert.equal(fake.calls.length, 1)
})

test('a list that names another account is refused: nothing is written under this account\'s key', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['46130058', '46979908'])
  ownMap(db, '46130058', now - H)
  setState(db, accountSymbolMapKey('46979908'), JSON.stringify({ builtAt: new Date(now - 2 * H).toISOString(), map: { EURUSD: 777 } })) // pre-K2
  const rawBefore = getState(db, accountSymbolMapKey('46979908'))
  // The host-shared cache answered with the primary's list.
  const fake = broker({ answerAs: () => '46130058' })
  const r = await createAccountSymbolMapRefresh(db, { env: {}, now: () => now, credentials, fetchDeps: fake })()
  assert.deepEqual([r.accountId, r.outcome], ['46979908', 'account_identity_mismatch'])
  assert.equal(getState(db, accountSymbolMapKey('46979908')), rawBefore, 'RED if another account\'s list is stored under this key')
  const view = accountSymbolMapRefreshView(db, { now })
  assert.match(view.accounts.find(a => a.accountId === '46979908').lastError, /^account_identity_mismatch/)
})

test('a map written before K2 is re-read once, then left alone', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['46130058'])
  setState(db, accountSymbolMapKey('46130058'), JSON.stringify({ builtAt: new Date(now - H).toISOString(), map: { EURUSD: 1 } }))
  assert.equal(accountSymbolMapRefreshView(db, { now }).accounts[0].dueReason, 'unproven_source')
  const fake = broker(); let at = now
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  assert.equal((await refresh()).dueReason, 'unproven_source')
  assert.equal(stored(db, '46130058').accountId, '46130058')
  for (let i = 0; i < 12; i++) { at += SYMBOL_MAP_PASS_MS; assert.equal((await refresh()).result, 'nothing_due') }
  assert.equal(fake.calls.length, 1)
})

test('no read without routable credentials, a linked broker or an armed environment; one pass at a time', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['43002148'])
  const fake = broker()
  const run = deps => createAccountSymbolMapRefresh(db, { env: {}, now: () => now, credentials, fetchDeps: fake, ...deps })()
  const notReady = await run({ credentials: id => ({ ...credentials(id), ready: false }) })
  assert.deepEqual([notReady.outcome, notReady.brokerRead], ['credentials_unavailable', false])
  assert.equal(accountSymbolMapRefreshView(db, { now }).accounts[0].readsToday, 0, 'no broker read, nothing counted against the daily cap')
  db.prepare(`DELETE FROM agent_state WHERE key = ?`).run(SYMBOL_MAP_RECEIPT_KEY)
  const wrongHost = await run({ credentials: id => ({ ...credentials(id), host: DEMO }) })
  assert.equal(wrongHost.outcome, 'credentials_unavailable', 'the registered host, never another side\'s credentials')
  db.prepare(`DELETE FROM agent_state WHERE key = ?`).run(SYMBOL_MAP_RECEIPT_KEY)
  assert.deepEqual(await run({ env: { RAILWAY_ENVIRONMENT_NAME: 'staging' } }), { result: 'skipped', reason: 'environment_disarmed' })
  db.prepare("DELETE FROM agent_state WHERE key = 'ctrader_account_id'").run()
  assert.deepEqual(await run({}), { result: 'skipped', reason: 'broker_not_linked' })
  assert.equal(fake.calls.length, 0)
  setState(db, 'ctrader_account_id', '46130058')
  let release
  const slow = { wsGetSymbolsList: async (...a) => { await new Promise(r => { release = r }); return fake.wsGetSymbolsList(...a) } }
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => now, credentials, fetchDeps: slow })
  const first = refresh()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(await refresh(), { result: 'skipped', reason: 'in_flight' })
  release()
  assert.equal((await first).result, 'refreshed')
  assert.equal(JSON.parse(getState(db, SYMBOL_MAP_RECEIPT_KEY)).pass.result, 'refreshed', 'the finished pass is the last word')
})

test('no read for an account the broker token was refused for (B7): it waits as token_refused, nothing is counted, and the others are read', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['46130058', '43002148', '43069009'])
  ownMap(db, '46130058', now - H)
  // B2's record of a sidecar whose token the broker refused for 43002148.
  setState(db, 'cpp_exec_refused_accounts_json', JSON.stringify(['43002148']))
  const fake = broker(); let at = now
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  let last = null
  for (let i = 0; i < 12; i++, at += SYMBOL_MAP_PASS_MS) last = await refresh()
  // Both maps are missing and never attempted, so 43002148 would lead (lowest id).
  assert.deepEqual(fake.calls.map(c => c.accountId), ['43069009'], 'RED without the refused skip: the refused account is read, and its refusal fires the reactive token refresh')
  assert.deepEqual([last.result, last.due, last.waiting], ['waiting', 1, 1])
  const view = accountSymbolMapRefreshView(db, { now: at })
  const refused = view.accounts.find(a => a.accountId === '43002148')
  assert.deepEqual([refused.due, refused.dueReason, refused.blocked, refused.notBefore], [true, 'missing', 'token_refused', null])
  assert.deepEqual([refused.lastAttemptAt, refused.readsToday, refused.consecutiveFailures], [null, 0, 0], 'nothing counted against its daily cap or backoff')
  const coverage = buildCalendarCoverage(db, { now: at })
  assert.equal(coverage.accounts.find(a => a.accountId === '43002148').symbolMapRefresh.blocked, 'token_refused')
  assert.deepEqual([coverage.symbolMapRefresher.due, coverage.symbolMapRefresher.waiting], [1, 1])
  // Either sidecar's record counts; once the refusal clears it is read on the next pass.
  setState(db, 'cpp_exec_refused_accounts_json', '[]')
  setState(db, 'cpp_exec_demo_refused_accounts_json', JSON.stringify(['43002148']))
  assert.equal((await refresh()).result, 'waiting')
  setState(db, 'cpp_exec_demo_refused_accounts_json', '[]')
  at += SYMBOL_MAP_PASS_MS
  const cleared = await refresh()
  assert.deepEqual([cleared.result, cleared.accountId], ['refreshed', '43002148'])
  assert.equal(fake.calls.length, 2)
})

test('no read for a disabled account: B7 can only mark accounts a sidecar tries, so it waits as account_disabled, nothing is counted, and the others are read', async t => {
  const now = Date.parse('2026-09-25T15:00:00Z')
  const db = database(t, ['46130058', '43002148', '43069009'])
  ownMap(db, '46130058', now - H)
  // Disabled: out of the sidecars' roster, so never in B2's refused set.
  db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run('43002148')
  const fake = broker(); let at = now
  const refresh = createAccountSymbolMapRefresh(db, { env: {}, now: () => at, credentials, fetchDeps: fake })
  let last = null
  for (let i = 0; i < 12; i++, at += SYMBOL_MAP_PASS_MS) last = await refresh()
  // Both maps are missing and never attempted, so 43002148 would lead (lowest id).
  assert.deepEqual(fake.calls.map(c => c.accountId), ['43069009'], 'RED without the disabled skip: a disabled account is read, outside B7\'s refused-set cover')
  assert.deepEqual([last.result, last.due, last.waiting], ['waiting', 1, 1])
  const view = accountSymbolMapRefreshView(db, { now: at })
  const disabled = view.accounts.find(a => a.accountId === '43002148')
  assert.deepEqual([disabled.enabled, disabled.due, disabled.dueReason, disabled.blocked, disabled.notBefore], [false, true, 'missing', 'account_disabled', null])
  assert.deepEqual([disabled.lastAttemptAt, disabled.readsToday, disabled.consecutiveFailures], [null, 0, 0], 'nothing counted against its daily cap or backoff')
  const coverage = buildCalendarCoverage(db, { now: at })
  const row = coverage.accounts.find(a => a.accountId === '43002148')
  assert.deepEqual([row.symbolMap.status, row.symbolMapRefresh.enabled, row.symbolMapRefresh.blocked], ['missing', false, 'account_disabled'], 'still shown, named missing, with the reason')
  assert.deepEqual([coverage.symbolMapRefresher.due, coverage.symbolMapRefresher.waiting], [1, 1])
  // A disabled account outranks a refused token in the label; re-enabled, it is read on the next pass.
  setState(db, 'cpp_exec_refused_accounts_json', JSON.stringify(['43002148']))
  assert.equal(accountSymbolMapRefreshView(db, { now: at }).accounts.find(a => a.accountId === '43002148').blocked, 'account_disabled')
  setState(db, 'cpp_exec_refused_accounts_json', '[]')
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run('43002148')
  const enabled = await refresh()
  assert.deepEqual([enabled.result, enabled.accountId], ['refreshed', '43002148'])
  assert.equal(fake.calls.length, 2)
})

test('the timer: one pass every 5 minutes, unref\'d and stoppable, wired at boot; disarmed, nothing arms', async t => {
  const db = database(t, ['46130058'])
  let callback, cleared = false, unrefd = false
  const handle = { unref() { unrefd = true } }
  const stop = startAccountSymbolMapRefresh(db, { env: {}, setInterval: (fn, ms) => { callback = fn; assert.equal(ms, 5 * MIN); return handle }, clearInterval: timer => { assert.equal(timer, handle); cleared = true } })
  assert.equal(typeof callback, 'function'); assert.equal(unrefd, true)
  stop(); assert.equal(cleared, true)
  const forbidden = () => { throw new Error('staging must not arm broker reads') }
  startAccountSymbolMapRefresh(db, { env: { RAILWAY_ENVIRONMENT_NAME: 'staging' }, setInterval: forbidden, credentials: forbidden })()
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.match(source, /await import\('\.\/services\/account-symbol-maps\.js'\)/)
  assert.match(source, /startAccountSymbolMapRefresh\(db\)/, 'RED if the boot call is dropped: a refresher nothing starts')
})
