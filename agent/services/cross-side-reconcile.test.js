import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { reconcileCrossSideAccounts } from './cross-side-reconcile.js'
import { reconcilePositions } from './reconciler.js'

function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  for (const [id, live, enabled] of [['1', 0, 1], ['2', 1, 1], ['3', 1, 1], ['4', 1, 0]]) {
    db.prepare('INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, ?, ?)')
      .run(id, live, enabled, 'active')
    setState(db, `symbol_id_map:${id}`, JSON.stringify({ map: { [live ? 'LIVE.US' : 'DEMO.US']: 10 } }))
  }
  setState(db, 'ctrader_account_id', '1')
  setState(db, 'ctrader_is_live', 'false')
  return db
}

function seed(db, accountId, { positionId = '700', status = 'open', pnl = null } = {}) {
  const id = db.prepare(`INSERT INTO trades
    (account_id, symbol, side, entry_price, volume, ctrader_position_id, source, status, net_pnl)
    VALUES (?, 'LIVE.US', 'BUY', 100, 1, ?, 'autopilot', ?, ?)`)
    .run(accountId, positionId, status, pnl).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions
    (account_id, trade_id, symbol, side, entry_price, current_sl, source, status)
    VALUES (?, ?, 'LIVE.US', 'long', 100, 90, 'autopilot', ?)`)
    .run(accountId, id, status === 'open' ? 'active' : 'closed')
  return Number(id)
}

const getCreds = (_db, { accountId, isLive }) => ({ ready: true, accountId, isLive,
  host: `${isLive ? 'live' : 'demo'}.ctraderapi.com`, clientId: 'i', clientSecret: 's', accessToken: 't' })
const base = { ready: true, accountId: '1', isLive: false }
const status = (db, id) => db.prepare('SELECT status FROM trades WHERE id = ?').get(id).status
const position = { positionId: '700', tradeData: { symbolId: 10, tradeSide: 'BUY', volume: 10000 }, price: 100, stopLoss: 90, takeProfit: 120 }

test('fresh empty live snapshots close only those accounts, including colliding position IDs', async t => {
  const db = fixture(t)
  const demo = seed(db, '1'), live = seed(db, '2')
  const calls = []
  const results = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (...args) => { calls.push(args); return { ctidTraderAccountId: args[4] } },
  })
  assert.deepEqual(calls.map(a => [a[0], a[4], a[5], a[6]]), [
    ['live.ctraderapi.com', '2', 5000, 0], ['live.ctraderapi.com', '3', 5000, 0],
  ])
  assert.equal(status(db, demo), 'open')
  assert.equal(status(db, live), 'closed')
  assert.equal(results.find(r => r.accountId === '2').result.closedDetected.length, 1)
  assert.ok(getState(db, 'acct:2:last_reconcile_at'))
  assert.equal(getState(db, 'last_reconcile_at'), null)
  assert.equal(getState(db, 'ctrader_account_id'), '1')
  assert.equal(getState(db, 'ctrader_is_live'), 'false')
})

test('adoption uses the live symbol map and never relinks a demo trade sharing its position ID', async t => {
  const db = fixture(t)
  const demo = seed(db, '1')
  const results = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (_h, _i, _s, _t, id) => ({ ctidTraderAccountId: id, position: id === '2' ? [position] : [] }),
  })
  const adopted = results.find(r => r.accountId === '2').result.newExternal
  assert.equal(adopted.length, 1)
  assert.equal(adopted[0].symbol, 'LIVE.US')
  assert.equal(status(db, demo), 'open', 'cross-account IDs are not duplicate adoptions')
  assert.equal(db.prepare('SELECT account_id FROM trades WHERE id = ?').get(adopted[0].tradeId).account_id, '2')
})

test('duplicate cleanup remains within the reconciled account for open rows and historical P&L', t => {
  const db = fixture(t)
  const demo = seed(db, '1'), oldLive = seed(db, '2'), newLive = seed(db, '2')
  const demoClosed = seed(db, '1', { positionId: '800', status: 'closed', pnl: 5 })
  const liveClosed = seed(db, '2', { positionId: '800', status: 'closed', pnl: 5 })
  const liveDup = seed(db, '2', { positionId: '800', status: 'closed', pnl: 5 })
  reconcilePositions(db, [{ ...position, symbolName: 'LIVE.US' }], [],
    (k, v) => setState(db, `acct:2:${k}`, v), { accountId: '2' })
  assert.equal(status(db, demo), 'open')
  assert.equal(status(db, oldLive), 'rejected')
  assert.equal(status(db, newLive), 'open')
  assert.equal(status(db, demoClosed), 'closed')
  assert.equal(status(db, liveClosed), 'closed')
  assert.equal(status(db, liveDup), 'rejected')
})

test('failed, malformed and wrong-account reads leave live positions active', async t => {
  const db = fixture(t)
  const live = seed(db, '2')
  for (const bad of [null, {}, { ctidTraderAccountId: '1' },
    { ctidTraderAccountId: '2', errorCode: 'ACCOUNT_NOT_AUTHORIZED' },
    { ctidTraderAccountId: '2', position: {} }, { ctidTraderAccountId: '2', order: {} },
    { ctidTraderAccountId: '2', position: [{}] },
    { ctidTraderAccountId: '2', order: [{}] }, new Error('read timed out')]) {
    const results = await reconcileCrossSideAccounts(db, base, { getCreds,
      readSnapshot: async (_h, _i, _s, _t, id) => {
        if (id === '3') return { ctidTraderAccountId: id }
        if (bad instanceof Error) throw bad
        return bad
      },
    })
    assert.ok(results.find(r => r.accountId === '2').error)
    assert.ok(results.find(r => r.accountId === '3').result, 'one failure does not block another account')
    assert.equal(status(db, live), 'open')
    assert.equal(getState(db, 'acct:2:last_reconcile_at'), null)
  }
})

test('missing account symbol mapping refuses the entire snapshot before closing rows', async t => {
  const db = fixture(t)
  const live = seed(db, '2', { positionId: '900' })
  const result = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (_h, _i, _s, _t, id) => ({ ctidTraderAccountId: id,
      position: id === '2' ? [{ ...position, tradeData: { ...position.tradeData, symbolId: 99 } }] : [] }),
  })
  assert.match(result.find(r => r.accountId === '2').error, /symbol map missing symbol 99/)
  assert.equal(status(db, live), 'open')
})

test('refused and disabled accounts are not probed', async t => {
  const db = fixture(t)
  setState(db, 'cpp_exec_refused_accounts_json', JSON.stringify(['2']))
  const ids = []
  const results = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (_h, _i, _s, _t, id) => { ids.push(id); return { ctidTraderAccountId: id } },
  })
  assert.deepEqual(ids, ['3'])
  assert.equal(results.find(r => r.accountId === '2').skipped, 'token_refused')
})

test('a cross-account order-id conflict refuses the snapshot without stealing the existing order', async t => {
  const db = fixture(t)
  const live = seed(db, '2')
  db.prepare("INSERT INTO broker_orders (order_id, account_id, status) VALUES ('800', '1', 'working')").run()
  const result = await reconcileCrossSideAccounts(db, base, { getCreds,
    readSnapshot: async (_h, _i, _s, _t, id) => ({ ctidTraderAccountId: id,
      order: id === '2' ? [{ orderId: '800', tradeData: { symbolId: 10 } }] : [] }),
  })
  assert.match(result.find(r => r.accountId === '2').error, /conflicts with another account/)
  assert.equal(status(db, live), 'open')
  assert.deepEqual(db.prepare("SELECT account_id, status FROM broker_orders WHERE order_id = '800'").get(),
    { account_id: '1', status: 'working' })
})

test('selecting live reconciles demo through the demo host', async t => {
  const db = fixture(t)
  const calls = []
  await reconcileCrossSideAccounts(db, { ...base, isLive: true }, { getCreds,
    readSnapshot: async (host, _i, _s, _t, id) => { calls.push([host, id]); return { ctidTraderAccountId: id } },
  })
  assert.deepEqual(calls, [['demo.ctraderapi.com', '1']])
})

test('main loop calls the cross-side reconciler (wiring check, comments excluded)', () => {
  const source = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(source, /await reconcileCrossSideAccounts\(db, getCtraderCreds\(db\)\)/)
})
