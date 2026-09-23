import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { reconcileCrossSideAccounts } from './cross-side-reconcile.js'
import { backfillCrossSidePnl } from './cross-side-pnl.js'
import { backfillClosedPnl, resetBackfillPacing } from './pnl-backfill.js'

const now = Date.now()
const base = { ready: true, accountId: '1', isLive: false }
const getCreds = (_db, { accountId, isLive }) => ({ ready: true, accountId, isLive,
  host: `${isLive ? 'live' : 'demo'}.ctraderapi.com`, clientId: 'i', clientSecret: 's', accessToken: 't' })
function fixture(t) {
  const db = initDB(':memory:')
  resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  for (const [id, live, enabled] of [['1', 0, 1], ['2', 1, 1], ['3', 1, 1], ['4', 1, 0]]) {
    db.prepare('INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, ?, ?)').run(id, live, enabled, 'active')
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ map: { [live ? 'LIVE.US' : 'DEMO.US']: 10 }, builtAt: now }))
  }
  setState(db, 'ctrader_account_id', '1')
  setState(db, 'ctrader_is_live', 'false')
  return db
}
function seed(db, acct, { status = 'closed', positionId = '700', net = null, rr = null } = {}) {
  return Number(db.prepare(`INSERT INTO trades
    (account_id, symbol, side, entry_price, sl_price, volume, ctrader_position_id, status, net_pnl, opened_at, closed_at, realised_rr, pnl_attempts, exit_price)
    VALUES (?, 'LIVE.US', 'BUY', 100, 90, 1, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(acct, positionId, status, net, new Date(now - 7200_000).toISOString(),
      status === 'closed' ? new Date(now - 3600_000).toISOString() : null, rr, net == null ? null : 105).lastInsertRowid)
}
const row = (db, id) => db.prepare('SELECT status, account_id, net_pnl, pnl_attempts, realised_rr FROM trades WHERE id = ?').get(id)
const close = (id = '700') => ({ dealId: '900', positionId: id, symbolId: 10,
  executionTimestamp: now - 3600_000, executionPrice: 94.5, volume: 100,
  closePositionDetail: { grossProfit: -500, commission: -50, swap: 0, moneyDigits: 2 } })
const getter = (calls, items = [close()]) => async (...args) => {
  calls.push(args)
  return { ctidTraderAccountId: args[4], deal: items.filter(d => d.executionTimestamp >= args[5] && d.executionTimestamp < args[6]) }
}

test('cross-side broker closure reaches the real backfill without changing the selected account', async t => {
  const db = fixture(t), live = seed(db, '2', { status: 'open' })
  const demo = seed(db, '1'), orphan = seed(db, null)
  const pricedPeer = seed(db, '3', { net: 10, rr: 987 })
  const reconciled = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (_h, _c, _s, _t, id) => ({ ctidTraderAccountId: id }) })
  assert.equal(row(db, live).status, 'closed')
  assert.equal(row(db, live).net_pnl, null)
  const calls = []
  const result = await backfillCrossSidePnl(db, base, reconciled, { getCreds, getDeals: getter(calls), clock: () => now })
  assert.equal(result.find(r => r.accountId === '2').result.backfilled, 1)
  assert.equal(row(db, live).net_pnl, -5.5)
  assert.equal(row(db, demo).net_pnl, null)
  assert.equal(row(db, orphan).account_id, null)
  assert.equal(row(db, orphan).net_pnl, null)
  assert.equal(row(db, orphan).pnl_attempts, 0)
  assert.equal(row(db, pricedPeer).realised_rr, 987, 'same position ID on another account is not restamped')
  assert.ok(calls.every(a => a[0] === 'live.ctraderapi.com' && ['2', '3'].includes(a[4]) && a[7] <= 5000 && a[8] === 0))
  assert.equal(getState(db, 'ctrader_account_id'), '1')
  assert.equal(getState(db, 'ctrader_is_live'), 'false')
  assert.equal(db.prepare("SELECT symbol FROM broker_deals WHERE account_id = '2'").get().symbol, 'LIVE.US')
})

test('failed and wrong-account responses neither change money nor count attempts; peers still run', async t => {
  const db = fixture(t), bad = seed(db, '2'), good = seed(db, '3')
  for (const reply of [null, {}, { ctidTraderAccountId: '1', deal: [close()] },
    { ctidTraderAccountId: '2', errorCode: 'ACCOUNT_NOT_AUTHORIZED' },
    { ctidTraderAccountId: '2', deal: {} }, { ctidTraderAccountId: '2', deal: [{}] },
    { ctidTraderAccountId: '2', deal: [{ ...close(), closePositionDetail: { grossProfit: 'bad', moneyDigits: 2 } }] }, new Error('timeout')]) {
    const results = await backfillCrossSidePnl(db, base, [], { getCreds, clock: () => now,
      getDeals: async (...args) => {
        if (args[4] === '3') return getter([])(...args)
        if (reply instanceof Error) throw reply
        return reply
      } })
    assert.ok(results.find(r => r.accountId === '2').error)
    assert.equal(row(db, bad).net_pnl, null)
    assert.equal(row(db, bad).pnl_attempts, 0)
    assert.equal(row(db, good).net_pnl, -5.5)
  }
})

test('incomplete history and late replies leave money and exhaustion evidence unchanged', async t => {
  const db = fixture(t), id = seed(db, '2')
  let clock = now
  const deps = { getCreds, clock: () => clock }
  const partial = await backfillCrossSidePnl(db, base, [], { ...deps,
    getDeals: async (_h, _c, _s, _t, acct) => ({ ctidTraderAccountId: acct, deal: [close()], hasMore: true }) })
  assert.match(partial.find(r => r.accountId === '2').error, /incomplete/)
  assert.equal(row(db, id).pnl_attempts, 0)
  const late = await backfillCrossSidePnl(db, base, [], { ...deps, getDeals: async (...args) => {
    clock += 10_001
    return getter([])(...args)
  } })
  assert.match(late.find(r => r.accountId === '2').error, /deadline/)
  assert.equal(row(db, id).net_pnl, null)
  assert.equal(row(db, id).pnl_attempts, 0)
})

test('no gap avoids network I/O; refused/disabled accounts are omitted explicitly', async t => {
  const db = fixture(t)
  seed(db, '2'); seed(db, '4'); seed(db, null)
  setState(db, 'cpp_exec_refused_accounts_json', JSON.stringify(['2']))
  const calls = []
  const result = await backfillCrossSidePnl(db, base, [], { getCreds, getDeals: getter(calls), clock: () => now })
  assert.equal(calls.length, 0)
  assert.equal(result.find(r => r.accountId === '2').skipped, 'token_refused')
  assert.equal(result.some(r => r.accountId === '4'), false)
})

test('a position predating the fetched window cannot receive a partial lifetime P&L', async t => {
  const db = fixture(t), id = seed(db, '2')
  const safe = seed(db, '2', { positionId: '701' })
  const missing = seed(db, '2', { positionId: '702' })
  db.prepare('UPDATE trades SET opened_at = ? WHERE id = ?').run(new Date(now - 20 * 86400_000).toISOString(), id)
  const result = await backfillCrossSidePnl(db, base, [], { getCreds, getDeals: getter([], [close(), { ...close('701'), dealId: '901' }]), clock: () => now })
  assert.equal(result.find(r => r.accountId === '2').result.lifetimeSkipped, 1)
  assert.equal(row(db, id).net_pnl, null)
  assert.equal(row(db, id).pnl_attempts, 0)
  assert.equal(row(db, safe).net_pnl, -5.5)
  assert.equal(row(db, missing).pnl_attempts, 1)
})

test('a queued broker read releases the loop at the wall deadline without overlapping or writing late', async t => {
  const db = fixture(t), id = seed(db, '2'), peer = seed(db, '3')
  let release, calls = 0
  const queued = new Promise(r => { release = r })
  const deps = { getCreds, clock: () => now, budgetMs: 20, getDeals: async (...args) => {
    if (args[4] === '2') { calls++; return queued }
    return getter([])(...args)
  } }
  const started = Date.now()
  const results = await backfillCrossSidePnl(db, base, [], deps)
  assert.ok(Date.now() - started < 1000, 'the socket helper never settles, but the outer deadline does')
  assert.match(results.find(r => r.accountId === '2').error, /deadline/)
  assert.equal(row(db, peer).net_pnl, -5.5)
  assert.equal((await backfillCrossSidePnl(db, base, [], deps)).find(r => r.accountId === '2').skipped, 'read_still_in_flight')
  assert.equal(calls, 1)
  release({ ctidTraderAccountId: '2', deal: [close()] })
  await new Promise(r => setImmediate(r))
  assert.equal(row(db, id).net_pnl, null)
  assert.equal(row(db, id).pnl_attempts, 0)
})

test('existing pacing applies, but a newly reconciled close gets an immediate attempt', async t => {
  const db = fixture(t), id = seed(db, '2')
  const calls = [], deps = { getCreds, getDeals: getter(calls, []), clock: () => now }
  await backfillCrossSidePnl(db, base, [], deps)
  assert.equal(row(db, id).pnl_attempts, 1)
  calls.length = 0
  assert.equal((await backfillCrossSidePnl(db, base, [], deps)).find(r => r.accountId === '2').skipped, 'paced')
  assert.equal(calls.length, 0)
  await backfillCrossSidePnl(db, base, [{ accountId: '2', result: { closedDetected: [{ id }] } }], deps)
  assert.equal(row(db, id).pnl_attempts, 2)
  assert.ok(calls.length > 0)
})

test('selecting live recovers demo through its own host and rejects credential mismatches', async t => {
  const db = fixture(t), id = seed(db, '1'), calls = []
  const liveBase = { ...base, isLive: true }
  const bad = await backfillCrossSidePnl(db, liveBase, [], { getCreds: () => ({ ready: true, accountId: '2', host: 'live.ctraderapi.com' }), getDeals: getter(calls) })
  assert.match(bad[0].error, /mismatched/)
  assert.equal(calls.length, 0)
  await backfillCrossSidePnl(db, liveBase, [], { getCreds, getDeals: getter(calls), clock: () => now })
  assert.ok(calls.every(a => a[0] === 'demo.ctraderapi.com' && a[4] === '1'))
  assert.equal(row(db, id).net_pnl, -5.5)
})

test('strict backfill requires an explicit matching account and cannot fetch for unattributed rows alone', async t => {
  const db = fixture(t), calls = []
  seed(db, null)
  await assert.rejects(backfillClosedPnl(db, { accountId: '2' }, { accountId: '3', strictAccount: true }), /identity/)
  const result = await backfillClosedPnl(db, { accountId: '2' }, { accountId: '2', strictAccount: true, getDeals: getter(calls), now })
  assert.equal(result.gap, 0)
  assert.equal(calls.length, 0)
})

test('the main loop reaches cross-side money recovery after cross-side reconciliation', () => {
  const source = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(source, /const crossReconciled = await reconcileCrossSideAccounts\(db, getCtraderCreds\(db\)\)/)
  assert.match(source, /await backfillCrossSidePnl\(db, getCtraderCreds\(db\), crossReconciled\)/)
})
