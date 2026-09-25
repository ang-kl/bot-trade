// agent/services/tick-entry-work.test.js — V3 C4 (SEQUENCE PR-4, WP-B B2):
// the tick permit feeder's work receipt. The feeder names every account it
// served by its FULL id with its outcome; the heartbeat pass that did the work
// writes the receipt; a stale or orphaned receipt is never evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initDB, setState, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, acknowledgeEntryEpochs, writeEngineStatus } from './entry-mode.js'
import { profileHashFull, DEFAULT_PARAMS } from '../lib/tick-strategy.js'
import { runTickPermitFeeder, PAUSE_CHECKS } from './tick-permits.js'
import { recordTickEntryWork, clearTickEntryWork, tickEntryReceipts, TICK_ENTRY_WORK_KEY, TICK_RECEIPT_MAX_AGE_MS } from './tick-entry-work.js'
import { feedTickPermits, _resetTickPermitPushForTests } from './heartbeat.js'

const PAUSED = '46000001', CAPPED = '46000002', PLACING = '46000003'
const side = { isLive: false, name: 'cpp_exec_demo' }
const creds = { ready: true, host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: PLACING }
const META = { lotSize: 10_000_000, minVolume: 100_000, maxVolume: 10_000_000_000, stepVolume: 100_000, digits: 5 }
const ids = { EURUSD: 1, XAUUSD: 41 }
const resolveSymbolId = async (_db, _c, name) => ({ id: ids[name] ?? null, source: 'test' })
const readyAll = () => ({ ready: true, readiness: PAUSE_CHECKS.map(check => ({ check, ok: true })) })

function fresh(accounts = [PAUSED, CAPPED, PLACING]) {
  const db = initDB(':memory:')
  for (const id of accounts) upsertAccount(db, { accountId: id, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1').run()
  setState(db, 'tick_symbols_json', JSON.stringify(['EURUSD', 'XAUUSD']))
  return db
}
function switchOn(db, id) {
  writeEngineStatus(db, { ...engineStatusFor(db, id), profileHash: profileHashFull(DEFAULT_PARAMS), profileId: 'tick_momentum_breakout@v1', validationStage: 'SHADOW_PASSED', configRevision: engineStatusFor(db, id).configRevision + 1, updatedAt: new Date().toISOString() })
  const r = requestEntryMode(db, id, 'TICK_MOMENTUM', { readiness: () => ({ ready: true, blockedReasons: [] }) })
  assert.equal(r.ok, true)
  acknowledgeEntryEpochs(db, { [id]: r.status.modeEpoch })
}
const opts = (over = {}) => ({ creds, resolveSymbolId, readiness: readyAll, volumeMeta: async () => META,
  push: async () => ({ ok: true }), log: () => {}, ...over })

test('work names every evaluated account by its FULL id with its own outcome: TM-40 paused, capped, placing', async () => {
  const db = fresh()
  for (const id of [PAUSED, CAPPED, PLACING]) { switchOn(db, id); setState(db, `acct:${id}:account_balance_usd`, '10000') }
  const put = db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id) VALUES (?, 'BUY', 'open', ?, ?)`)
  ;['GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD'].forEach((sym, i) => put.run(sym, CAPPED, String(9000 + i)))
  const readiness = (_db, id) => id === PAUSED
    ? { ready: false, readiness: PAUSE_CHECKS.map(check => ({ check, ok: check !== 'recorder_recording' })) }
    : readyAll()
  const r = await runTickPermitFeeder(db, side, opts({ readiness }))
  assert.equal(r.pushed, true)
  assert.deepEqual(r.carried.sort(), ['EURUSD', 'XAUUSD'], 'the names the pass carried')
  const by = Object.fromEntries(r.work.map(w => [w.accountId, w]))
  assert.deepEqual(Object.keys(by).sort(), [PAUSED, CAPPED, PLACING], 'full ids, never the masked …1234 form')
  assert.equal(by[PAUSED].permits, 0)
  assert.equal(by[PAUSED].paused, 'entry_mode_readiness: recorder_recording')
  assert.equal(by[CAPPED].permits, 0)
  assert.equal(by[CAPPED].paused, null)
  assert.match(by[CAPPED].firstRefusal, /^max_positions: 5\/5 open/)
  assert.equal(by[CAPPED].refused.length, 2, 'one refusal per carried symbol, this account only')
  assert.equal(by[CAPPED].refused.some(x => 'accountId' in x), false, 'the masked id is not carried into the full-id record')
  assert.equal(by[PLACING].permits, 4, '2 symbols × BUY/SELL — counted for THIS account, not across accounts')
  assert.equal(by[PLACING].firstRefusal, null)
  assert.equal(r.permits, 4)
})

test('the feeder pass is independent of the bar scan: no scans rows, no bar receipt, permits still pushed', async () => {
  const db = fresh([PLACING])
  switchOn(db, PLACING); setState(db, `acct:${PLACING}:account_balance_usd`, '10000')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scans').get().n, 0)
  assert.equal(getState(db, 'legacy_scanner_work_json'), null)
  const pushes = []
  const r = await runTickPermitFeeder(db, side, opts({ push: async (_c, body) => { pushes.push(body); return { ok: true } } }))
  assert.equal(r.pushed, true); assert.equal(r.permits, 4)
  assert.deepEqual(pushes[0].tickEntryAccounts, [Number(PLACING)])
})

test('recordTickEntryWork: complete only for a pushed pass that carried a symbol; other sides kept; stale receipts are not evidence', async () => {
  const db = fresh([PLACING])
  switchOn(db, PLACING); setState(db, `acct:${PLACING}:account_balance_usd`, '10000')
  const now = Date.parse('2026-09-22T06:00:00Z')
  const r = await runTickPermitFeeder(db, side, opts())
  const receipt = recordTickEntryWork(db, { side, creds, accounts: [PLACING], result: r, completedAt: now })
  assert.equal(receipt.complete, true)
  assert.equal(receipt.nextDue, now + 120_000)
  assert.deepEqual(receipt.accounts.map(a => [a.accountId, a.permits, a.reached]), [[PLACING, 4, true]])
  assert.deepEqual(receipt.symbols.sort(), ['EURUSD', 'XAUUSD'])
  // a pass that carried nothing is not complete, and says why
  const empty = recordTickEntryWork(db, { side: { name: 'cpp_exec' }, creds, accounts: [PLACING], result: { ...r, carried: [] }, completedAt: now })
  assert.equal(empty.complete, false); assert.equal(empty.reason, 'no_symbol_carried')
  // a push the sidecar refused is not complete
  assert.equal(recordTickEntryWork(db, { side: { name: 'cpp_exec' }, creds, accounts: [PLACING], result: { ...r, pushed: false, error: 'refused' }, completedAt: now }).complete, false)
  // no credentials: the pass never reached the account
  const noCreds = await runTickPermitFeeder(db, side, opts({ creds: { ready: false } }))
  const nc = recordTickEntryWork(db, { side: { name: 'cpp_exec' }, creds: { ready: false }, accounts: [PLACING], result: noCreds, completedAt: now })
  assert.equal(nc.complete, false); assert.equal(nc.reason, 'no_creds'); assert.equal(nc.accounts[0].reached, false)
  const all = JSON.parse(getState(db, TICK_ENTRY_WORK_KEY))
  assert.deepEqual(Object.keys(all).sort(), ['cpp_exec', 'cpp_exec_demo'], 'each side keeps its own receipt')
  assert.deepEqual(tickEntryReceipts(db, now + 1000).map(x => x.side).sort(), ['cpp_exec', 'cpp_exec_demo'])
  assert.deepEqual(tickEntryReceipts(db, now + TICK_RECEIPT_MAX_AGE_MS), [], 'a receipt 360 s old is not evidence')
  assert.deepEqual(tickEntryReceipts(db, now - 1), [], 'a receipt from the future is not evidence')
  assert.equal(clearTickEntryWork(db, 'cpp_exec'), true)
  assert.equal(clearTickEntryWork(db, 'cpp_exec'), false, 'nothing to delete writes nothing')
  assert.deepEqual(Object.keys(JSON.parse(getState(db, TICK_ENTRY_WORK_KEY))), ['cpp_exec_demo'])
})

test('heartbeat: the feeder pass writes the side receipt with full ids, and the receipt goes when no account on the side admits tick', async () => {
  delete process.env.CTRADER_CLIENT_ID; delete process.env.CTRADER_CLIENT_SECRET
  _resetTickPermitPushForTests()
  const db = fresh([PLACING])
  switchOn(db, PLACING)
  const now = Date.parse('2026-09-22T06:00:00Z')
  // No credentials here, so this is the no_creds pass: the receipt still
  // names the account and must say the pass is NOT complete.
  await feedTickPermits(db, {}, side, now)
  const receipt = JSON.parse(getState(db, TICK_ENTRY_WORK_KEY))?.cpp_exec_demo
  assert.ok(receipt, 'feedTickPermits wrote the receipt (RED if the recordTickEntryWork call is removed)')
  assert.equal(receipt.completedAt, now)
  assert.equal(receipt.nextDue, now + 120_000)
  assert.equal(receipt.accounts[0].accountId, PLACING, 'the full id')
  assert.equal(receipt.complete, false)
  assert.equal(receipt.pushed, false)
  // the account leaves tick: the side's receipt is deleted, not left to emit items
  requestEntryMode(db, PLACING, 'STOPPED')
  await feedTickPermits(db, {}, side, now + 120_000)
  assert.equal(JSON.parse(getState(db, TICK_ENTRY_WORK_KEY))?.cpp_exec_demo, undefined)
})
