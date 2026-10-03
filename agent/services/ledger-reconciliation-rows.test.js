// node --test agent/services/ledger-reconciliation-rows.test.js
//
// P5b (03-10-2026): the two row-listing reads behind the counts.
//   - GET /state/ledger-reconciliation-rows names the rows of ONE class on
//     ONE explicit registered account (the /account-history guard), through
//     the SAME classification the counts come from (accountSection): the
//     class's rows here are exactly the positions the report counts in it;
//   - each row carries the trade id, symbol, side, timestamps, the ledger
//     money, the broker figure the class was judged against and the class's
//     meaning; a broker-side class with no ledger row lists tradeId null;
//   - GET /state/position-history-missing names the refused closed records
//     behind /state/position-history's `missingFields`, filtered to the three
//     close fields by default and to ?field= when asked;
//   - both are read-only: a full dump of the tables they read is identical
//     before and after, and the row read never caches.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { buildLedgerReconciliation, listLedgerReconciliationRows, CLASS_BASIS, CLASS_MEANING } from './ledger-reconciliation.js'
import { VERDICTS } from './position-lifecycle-evidence.js'
import { incompleteClosedRows, CLOSE_MONEY_FIELDS, positionHistoryView } from './position-history.js'
import { readLedgerReconciliationRows } from './performance-populations.js'
import stateRouter from '../routes/state.js'

const USD = '46130058', SGD1 = '43097342'

function build(db) {
  for (const id of [USD, SGD1]) db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(id)
  setState(db, `acct:${USD}:deposit_currency_evidence_json`, JSON.stringify({ accountId: USD, host: 'demo.ctraderapi.com', currency: 'USD', receivedAt: 1, source: 'broker_asset_list' }))
  const trade = (acct, pid, { status = 'closed', net = null, exit = 1.2, closed = '2026-09-20 10:00:00', symbol = 'EURUSD', side = 'BUY', reason = null } = {}) =>
    Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, exit_price, net_pnl, close_reason)
      VALUES (?,?,?,?,?,'2026-07-01 00:00:00',?,1.1,?,?,?)`).run(acct, symbol, side, status, String(pid), closed, exit, net, reason).lastInsertRowid)
  const deal = (acct, pid, id, net) => db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, net_pnl, closed_at)
    VALUES (?,?,?,'EURUSD',?,'2026-09-20 10:00:00')`).run(String(id), String(pid), acct, net)
  const verdict = (acct, pid, v, brokerNet, ledgerNet = null) => db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict,
    final, reason, broker_net, ledger_net, read_at) VALUES (?,?,?,1,?,?,?,'2026-09-25T10:00:00Z')`).run(acct, String(pid), v, `fixture ${v}`, brokerNet, ledgerNet)

  const ids = {}
  ids.agrees = trade(USD, 101, { net: 10 }); verdict(USD, 101, 'agrees', 10, 10)
  ids.disagrees = trade(USD, 102, { net: 12, symbol: 'GBPUSD', side: 'SELL', reason: 'stop' }); verdict(USD, 102, 'money_disagrees', 20, 12)
  // Two closed rows on one position (the USDCNH shape): both list, once each.
  ids.fragA = trade(USD, 103, { net: -5, symbol: 'USDCNH' }); ids.fragB = trade(USD, 103, { net: -2, symbol: 'USDCNH' })
  verdict(USD, 103, 'money_bearing_fragment', -7, -7)
  ids.neverFilled = trade(USD, 104, { net: null, exit: null }); verdict(USD, 104, 'never_filled', null)
  ids.receipts = trade(USD, 105, { net: 5 }); deal(USD, 105, 1051, 5)
  deal(USD, 108, 1081, -6)
  ids.rejected = trade(USD, 109, { status: 'rejected' }); deal(USD, 109, 1091, 2)
  trade(USD, 110, { status: 'open' })
  // The other account: one disagreeing row that must NOT list under USD.
  ids.otherDisagrees = trade(SGD1, 201, { net: 50 }); verdict(SGD1, 201, 'money_disagrees', 45, 50)

  // The refused closed records behind /position-history's missingFields.
  const refused = (acct, pid, missing, partial = {}, closedAtMs = Date.parse('2026-09-20T10:00:00Z')) => db.prepare(
    `INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json) VALUES (?,?,?,?,?,?)`)
    .run(acct, String(pid), partial.symbol ?? 'EURUSD', closedAtMs, JSON.stringify(missing), JSON.stringify(partial))
  refused(USD, 104, ['exit_price', 'net_pnl', 'close_reason'], { trade_id: ids.neverFilled, direction: 'BUY' })
  refused(USD, 105, ['close_reason', 'commission'], { symbol: 'EURUSD' }, Date.parse('2026-09-20T11:00:00Z'))
  refused(USD, 777, ['commission'], { symbol: 'XAUUSD' })
  refused(SGD1, 201, ['net_pnl'], { trade_id: ids.otherDisagrees })
  return ids
}

/** Every row of the tables the readers touch, as one string. */
function dump(db) {
  return JSON.stringify(['trades', 'broker_deals', 'position_lifecycle_evidence', 'position_history_incomplete', 'accounts']
    .map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))
}

test('the rows of a class are exactly the positions the report counts in it, named per trade id, on one account only', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const ids = build(db)
  const report = buildLedgerReconciliation(db, { accountId: USD }).accounts[0]
  for (const cls of Object.keys(report.classes)) {
    const rows = listLedgerReconciliationRows(db, { accountId: USD, cls })
    assert.equal(rows.positions, report.classes[cls].positions, `${cls}: the lister sees the positions the report counts`)
    assert.deepEqual([...new Set(rows.rows.map(r => r.positionId))].sort(), [...new Set(rows.rows.map(r => r.positionId))].sort())
    for (const r of rows.rows) { assert.equal(r.class, cls); assert.equal(r.basis, CLASS_BASIS[cls]); assert.equal(r.meaning, CLASS_MEANING[cls]) }
  }
  const d = listLedgerReconciliationRows(db, { accountId: USD, cls: 'money_disagrees' })
  assert.equal(d.rows.length, 1, 'the SGD account\'s disagreeing row does not list under USD')
  const [row] = d.rows
  assert.deepEqual([row.tradeId, row.symbol, row.side, row.openedAt, row.closedAt], [ids.disagrees, 'GBPUSD', 'SELL', '2026-07-01 00:00:00', '2026-09-20 10:00:00'])
  assert.deepEqual(row.ledger, { entryPrice: 1.1, exitPrice: 1.2, netPnl: 12, closeReason: 'stop', writtenOff: false })
  assert.deepEqual([row.ledgerNet, row.brokerNet, row.delta], [12, 20, -8], 'the broker figure the class was judged against, and the delta')
  assert.equal(row.reason, 'fixture money_disagrees')
  assert.equal(row.meaning, VERDICTS.money_disagrees.meaning, 'a verdict class carries the verdict\'s own meaning text')
  assert.equal(d.currency, 'USD')
  // Quiet classes are counted only by the report; the lister names them too.
  const a = listLedgerReconciliationRows(db, { accountId: USD, cls: 'agrees' })
  assert.deepEqual(a.rows.map(r => r.tradeId), [ids.agrees])
  assert.equal(report.positions.agrees, undefined, 'the report itself still lists no quiet class')
})

test('a position held by two closed rows lists each row with the position money; a broker-side class lists tradeId null', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const ids = build(db)
  const frag = listLedgerReconciliationRows(db, { accountId: USD, cls: 'money_bearing_fragment' })
  assert.deepEqual(frag.rows.map(r => r.tradeId).sort(), [ids.fragA, ids.fragB].sort())
  assert.deepEqual(frag.rows.map(r => [r.ledger.netPnl, r.ledgerNet, r.brokerNet]).sort((a, b) => a[0] - b[0]), [[-5, -7, -7], [-2, -7, -7]])
  assert.equal(frag.positions, 1)
  const bo = listLedgerReconciliationRows(db, { accountId: USD, cls: 'broker_only' })
  assert.deepEqual(bo.rows.map(r => [r.positionId, r.tradeId, r.brokerNet, r.receipts, r.ledger]), [['108', null, -6, 1, null]])
  const rej = listLedgerReconciliationRows(db, { accountId: USD, cls: 'broker_deals_on_rejected_row' })
  assert.deepEqual(rej.rows.map(r => [r.tradeId, r.status, r.brokerNet]), [[ids.rejected, 'rejected', 2]])
  const nf = listLedgerReconciliationRows(db, { accountId: USD, cls: 'never_filled' })
  assert.deepEqual([nf.rows[0].ledger.exitPrice, nf.rows[0].ledger.netPnl, nf.rows[0].brokerNet], [null, null, null], 'missing money is null, never 0')
  // A class with nothing in it answers an empty list, not an error.
  assert.deepEqual(listLedgerReconciliationRows(db, { accountId: USD, cls: 'empty_at_broker' }).rows, [])
  // limit truncates and says so.
  const lim = listLedgerReconciliationRows(db, { accountId: USD, cls: 'money_bearing_fragment', limit: 1 })
  assert.deepEqual([lim.rows.length, lim.total, lim.truncated], [1, 2, true])
})

test('the lister refuses an unregistered account and an unknown class, and the in-memory worker path dispatches it', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  build(db)
  assert.throws(() => listLedgerReconciliationRows(db, { accountId: '999', cls: 'agrees' }), /explicit registered account required/)
  assert.throws(() => listLedgerReconciliationRows(db, { accountId: 'all', cls: 'agrees' }), /explicit registered account required/)
  assert.throws(() => listLedgerReconciliationRows(db, { accountId: USD, cls: 'unreadable' }), /unknown class/, 'unreadable is not a class')
  assert.throws(() => listLedgerReconciliationRows(db, { accountId: USD, cls: 'agrees; DROP TABLE trades' }), /unknown class/)
  const r = await readLedgerReconciliationRows(db, { accountId: USD, cls: 'money_disagrees' })
  assert.equal(r.rows.length, 1)
})

test('incompleteClosedRows names the refused closed records behind missingFields, filtered to the close fields', t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const ids = build(db)
  const view = positionHistoryView(db, { limit: 10 })
  const counted = Object.fromEntries(view.missingFields.map(m => [m.field, m.n]))
  const all = incompleteClosedRows(db)
  assert.deepEqual(all.fields, [...CLOSE_MONEY_FIELDS])
  assert.deepEqual(all.scope, { accountId: null, all: true })
  // Every record missing one of the three close fields, and none that misses only commission.
  assert.deepEqual(all.rows.map(r => [r.accountId, r.positionId]).sort(), [[SGD1, '201'], [USD, '104'], [USD, '105']])
  for (const f of CLOSE_MONEY_FIELDS) {
    assert.equal(all.rows.filter(r => r.missing.includes(f)).length, counted[f] ?? 0, `${f}: the rows reconcile with /position-history's count`)
  }
  const nf = all.rows.find(r => r.positionId === '104')
  assert.deepEqual([nf.tradeId, nf.tradeIdSource, nf.symbol, nf.side, nf.closedAt], [ids.neverFilled, 'partial_record', 'EURUSD', 'BUY', '2026-09-20T10:00:00.000Z'])
  assert.deepEqual(nf.missingWanted, ['exit_price', 'net_pnl', 'close_reason'])
  assert.deepEqual(nf.ledger, { status: 'closed', exitPrice: null, netPnl: null, closeReason: null })
  const rc = all.rows.find(r => r.positionId === '105')
  assert.deepEqual([rc.tradeId, rc.tradeIdSource, rc.missing, rc.missingWanted], [ids.receipts, 'ledger_row', ['close_reason', 'commission'], ['close_reason']],
    'no trade id in the partial record: the closed ledger row holding the position names it')
  assert.deepEqual(rc.ledger, { status: 'closed', exitPrice: 1.2, netPnl: 5, closeReason: null })
  // One field, one account.
  const one = incompleteClosedRows(db, { accountId: USD, fields: ['net_pnl'] })
  assert.deepEqual(one.rows.map(r => r.positionId), ['104'])
  assert.deepEqual(one.scope, { accountId: USD, all: false })
  const comm = incompleteClosedRows(db, { fields: 'commission' })
  assert.deepEqual(comm.rows.map(r => r.positionId).sort(), ['105', '777'])
  assert.equal(comm.rows.find(r => r.positionId === '777').tradeId, null, 'no row holds it: tradeId null, not a guess')
  assert.throws(() => incompleteClosedRows(db, { fields: [] }), /at least one field required/)
  const lim = incompleteClosedRows(db, { limit: 1 })
  assert.deepEqual([lim.rows.length, lim.total, lim.truncated], [1, 3, true])
})

test('GET /state/ledger-reconciliation-rows and /state/position-history-missing: the guards, the fields, no-store, and nothing written', async t => {
  const dir = tempDir('ledger-reconciliation-rows-http-')
  const db = initDB(join(dir, 'fixture.db'))
  const ids = build(db)
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close() })
  const base = `http://127.0.0.1:${server.address().port}/state`
  // The reconciliation slot is held until its worker exits (see the B2 test):
  // the typed capacity 503 is the only 503 accepted, and the read is repeated.
  const read = async path => {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(base + path)
      if (res.status !== 503) return res
      const busy = await res.json()
      assert.equal(busy.reason, 'ledger_reconciliation_worker_capacity')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`${path}: the worker slot never freed`)
  }
  const before = dump(db)

  // The /account-history guard: no account, `all`, an unregistered or malformed id are all 400.
  for (const q of ['', 'account=all&', 'account=999&', 'account=abc&', `account=${USD}'&`]) {
    const res = await read(`/ledger-reconciliation-rows?${q}class=agrees`)
    assert.equal(res.status, 400, q || '(none)')
    assert.equal((await res.json()).error, 'explicit registered account required')
  }
  const bad = await read(`/ledger-reconciliation-rows?account=${USD}&class=nope`)
  assert.equal(bad.status, 400)
  const badBody = await bad.json()
  assert.equal(badBody.error, 'unknown class')
  assert.ok(badBody.classes.includes('money_disagrees'), 'the refusal names the classes')
  assert.equal((await read(`/ledger-reconciliation-rows?account=${USD}`)).status, 400, 'a missing class is refused')

  const ok = await read(`/ledger-reconciliation-rows?account=${USD}&class=money_disagrees&limit=5`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  const body = await ok.json()
  assert.deepEqual([body.accountId, body.class, body.basis, body.total], [USD, 'money_disagrees', 'broker_lifecycle', 1])
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ['basis', 'brokerNet', 'class', 'closedAt', 'delta', 'ledger', 'ledgerNet', 'meaning', 'openedAt', 'positionId', 'readAt', 'reason', 'side', 'status', 'symbol', 'tradeId'])
  assert.equal(body.rows[0].tradeId, ids.disagrees)
  // The counts route and the rows route agree on the class, read through the same worker kind.
  const counts = await read(`/ledger-reconciliation?account=${USD}`)
  assert.equal((await counts.json()).accounts[0].classes.money_disagrees.positions, body.positions)

  // The missing-fields read.
  const miss = await fetch(`${base}/position-history-missing`)
  assert.equal(miss.status, 200)
  assert.equal(miss.headers.get('cache-control'), 'no-store')
  const m = await miss.json()
  assert.deepEqual(m.fields, ['exit_price', 'net_pnl', 'close_reason'])
  assert.deepEqual(m.rows.map(r => [r.accountId, r.positionId, r.tradeId]).sort(), [[SGD1, '201', ids.otherDisagrees], [USD, '104', ids.neverFilled], [USD, '105', ids.receipts]])
  const scoped = await (await fetch(`${base}/position-history-missing?account=${USD}&field=net_pnl`)).json()
  assert.deepEqual([scoped.scope, scoped.fields, scoped.rows.map(r => r.positionId)], [{ accountId: USD, all: false }, ['net_pnl'], ['104']])
  const two = await (await fetch(`${base}/position-history-missing?field=net_pnl&field=commission`)).json()
  assert.deepEqual(two.rows.map(r => r.positionId).sort(), ['104', '105', '201', '777'])
  assert.equal((await fetch(`${base}/position-history-missing?account=999`)).status, 400)
  assert.equal((await fetch(`${base}/position-history-missing?account=abc`)).status, 400)
  const everyone = await (await fetch(`${base}/position-history-missing?account=all`)).json()
  assert.equal(everyone.rows.length, 3)

  assert.equal(dump(db), before, 'neither read wrote a row')
  // A second read of the rows route is not served from the cache: the slot
  // and the no-store header both say so, and a changed ledger changes the answer.
  db.prepare('UPDATE trades SET close_reason = ? WHERE id = ?').run('manual', ids.disagrees)
  const again = await (await read(`/ledger-reconciliation-rows?account=${USD}&class=money_disagrees&limit=5`)).json()
  assert.equal(again.rows[0].ledger.closeReason, 'manual', 'the rows route is never cached (same URL as the first read)')
  db.prepare('DELETE FROM position_history_incomplete WHERE ctrader_position_id = ?').run('777')
  const missAgain = await (await fetch(`${base}/position-history-missing?field=net_pnl&field=commission`)).json()
  assert.deepEqual(missAgain.rows.map(r => r.positionId).sort(), ['104', '105', '201'], 'the missing-fields route is never cached (same URL as the first read)')
})
