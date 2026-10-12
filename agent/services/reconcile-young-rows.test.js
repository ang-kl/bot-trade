// node --test agent/services/reconcile-young-rows.test.js
//
// Claude · № 13,757 12-Oct (demo stress run, defect D1; owner "Age guard now,
// snapshot time next"; claude-builder)
//
// MEASURED 12-10-2026 on demo 47790949. Two manual orders filled at 09:21:15Z
// and 09:21:20Z (trades #1797 BTCUSD, #1798 JPYX). At 09:21:25Z the loop's
// per-account reconcile logged "2 closed" and closed both rows "closed at the
// broker" with no exit price or P&L, while the broker still held both: the
// independent protection reader counted 5 open on the account every minute
// after. At 09:24:26Z the reconcile adopted them back as NEW external rows
// (#1800, #1801).
//
// The mechanism: on the native engine `execReconcile` is answered from the
// gateway's per-account position cache, refreshed by its own loop about every
// 30 s, so the snapshot can predate a row written seconds before the read.
// A row opened within SNAPSHOT_AGE_BOUND_MS of the read is therefore never
// closed on that snapshot — in the close loop or the orphan sweep — and is
// reported as deferred instead. Through the real writer (recordManualOrderTrade)
// and the real reconcilePositions over SQLite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { reconcilePositions, GENERIC_BROKER_CLOSE, SNAPSHOT_AGE_BOUND_MS } from './reconciler.js'
import { recordManualOrderTrade } from '../routes/actions.js'

const A = '47790949'
const setAcct = (db) => (k, v) => setState(db, `acct:${A}:${k}`, v)

function fresh() {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(A, A)
  setState(db, 'ctrader_account_id', '99999999') // the selected account is another one: this is the per-account pass
  return db
}

const pos = (positionId, symbolName, volume = 10000) => ({
  positionId, symbolName, price: 100, stopLoss: 99, takeProfit: 102,
  tradeData: { positionId, symbolId: 1, tradeSide: 'BUY', openPrice: 100, volume, label: 'MAN|v1|VWAP|-|LDN|-|-|i1zc4mryytjsu' },
})

function place(db, { symbol, positionId, volLots = 0.04 }) {
  return recordManualOrderTrade(db, {
    symbol, side: 'BUY', entryP: 100, entryEstimate: 100, sl: 99, tp: 102, volLots, positionId,
    structuredLabel: 'MAN|v1|VWAP|-|LDN|-|-', accountId: A, strategy: 'vwap_trend',
  })
}

const status = (db, id) => ({
  trade: db.prepare('SELECT status, close_reason FROM trades WHERE id = ?').get(id),
  mon: db.prepare('SELECT status FROM monitored_positions WHERE trade_id = ?').get(id)?.status,
})

test('a row written seconds before the read is not closed on a snapshot that does not hold it yet — reported as deferred', () => {
  const db = fresh()
  const old = place(db, { symbol: 'UNH.US', positionId: '242243016' })
  db.prepare("UPDATE trades SET opened_at = datetime('now', '-1 day') WHERE id = ?").run(old)
  const btc = place(db, { symbol: 'BTCUSD', positionId: '247938233' })
  const jpyx = place(db, { symbol: 'JPYX', positionId: '247938246', volLots: 100 })
  // The gateway's cached snapshot: only the position it already knew.
  const r = reconcilePositions(db, [pos('242243016', 'UNH.US')], [], setAcct(db), { accountId: A, readAt: Date.now() })
  assert.deepEqual(r.closedDetected, [], 'RED before: both young rows were closed "at the broker"')
  assert.deepEqual(r.orphansClosed, [])
  assert.deepEqual(r.closeDeferred.map(x => x.positionId).sort(), ['247938233', '247938246'])
  assert.deepEqual(r.closeDeferred.map(x => x.path), ['close', 'close'], 'deferred by the close loop that would have closed them')
  for (const id of [btc, jpyx]) {
    assert.equal(status(db, id).trade.status, 'open')
    assert.equal(status(db, id).mon, 'active')
  }
  // The next pass, once the cache holds them: no duplicate adoption, the
  // original rows are the ones still open.
  const r2 = reconcilePositions(db, [pos('242243016', 'UNH.US'), pos('247938233', 'BTCUSD'), pos('247938246', 'JPYX', 10_000_000)], [], setAcct(db), { accountId: A, readAt: Date.now() })
  assert.equal(r2.newExternal.length, 0, 'RED before: both were adopted again as new external rows')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'open' AND account_id = ?").get(A).n, 3)
})

test('the guard is bounded: a row opened before the bound whose position is gone is closed as before', () => {
  const db = fresh()
  const id = place(db, { symbol: 'BTCUSD', positionId: '1001' })
  const openedMs = Date.now() - SNAPSHOT_AGE_BOUND_MS - 5_000
  db.prepare('UPDATE trades SET opened_at = ? WHERE id = ?').run(new Date(openedMs).toISOString().replace('T', ' ').slice(0, 19), id)
  const r = reconcilePositions(db, [], [], setAcct(db), { accountId: A, readAt: Date.now() })
  assert.equal(r.closedDetected.length, 1)
  assert.deepEqual(r.closeDeferred, [])
  assert.equal(status(db, id).trade.status, 'closed')
  assert.equal(status(db, id).trade.close_reason, GENERIC_BROKER_CLOSE)
})

test('the orphan sweep honours the same bound: a young open row with no active monitor row is not swept', () => {
  const db = fresh()
  const id = place(db, { symbol: 'JPYX', positionId: '2002' })
  db.prepare("UPDATE monitored_positions SET status = 'closed' WHERE trade_id = ?").run(id) // invisible to the close loop
  const r = reconcilePositions(db, [], [], setAcct(db), { accountId: A, readAt: Date.now() })
  assert.deepEqual(r.orphansClosed, [], 'RED before: the orphan sweep closed it on the same stale snapshot')
  assert.equal(status(db, id).trade.status, 'open')
  assert.deepEqual(r.closeDeferred.map(x => x.positionId), ['2002'])
  // Past the bound, the sweep closes it as before.
  db.prepare("UPDATE trades SET opened_at = datetime('now', '-1 hour') WHERE id = ?").run(id)
  const r2 = reconcilePositions(db, [], [], setAcct(db), { accountId: A, readAt: Date.now() })
  assert.equal(r2.orphansClosed.length, 1)
})

test('a caller that does not know its read time is unchanged: the row is judged as before', () => {
  const db = fresh()
  const id = place(db, { symbol: 'BTCUSD', positionId: '3003' })
  const r = reconcilePositions(db, [], [], setAcct(db), { accountId: A })
  assert.equal(r.closedDetected.length, 1)
  assert.equal(status(db, id).trade.status, 'closed')
})
