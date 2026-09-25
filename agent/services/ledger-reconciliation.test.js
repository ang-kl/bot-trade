// node --test agent/services/ledger-reconciliation.test.js
//
// V3 B2 (P5b-2): the per-account, per-currency reconciliation report.
//   - every position lands in exactly the class its evidence gives it, and
//     the class counts equal the fixture's classes;
//   - money is per account in its own currency; the byCurrency block pools
//     only accounts whose currency is proven and equal, and an account with
//     no recorded currency is never pooled — SGD and USD are never summed;
//   - GET /state/ledger-reconciliation runs on the report worker (the
//     management connection sees no SQL) and refuses a bad account with 400.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, getState, setState } from '../db.js'
import { buildLedgerReconciliation, CLASS_BASIS } from './ledger-reconciliation.js'
import { readLedgerReconciliation } from './performance-populations.js'
import stateRouter from '../routes/state.js'

const USD = '46130058', SGD1 = '43097342', SGD2 = '42993489', NOCCY = '47790949'

function build(db) {
  for (const [id, live] of [[USD, 0], [SGD1, 0], [SGD2, 1], [NOCCY, 0]]) {
    db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,?,1,'active')").run(id, live)
  }
  for (const [id, currency, live] of [[USD, 'USD', 0], [SGD1, 'SGD', 0], [SGD2, 'SGD', 1]]) {
    setState(db, `acct:${id}:deposit_currency_evidence_json`, JSON.stringify({ accountId: id,
      host: live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com', currency, receivedAt: 1, source: 'broker_asset_list' }))
  }
  const trade = (acct, pid, { status = 'closed', net = null, closed = '2026-09-20 10:00:00', writtenOff = 0, symbol = 'EURUSD', entry = 1.1 } = {}) =>
    Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, exit_price, net_pnl,
      pnl_unresolvable) VALUES (?,?,'BUY',?,?,'2026-07-01 00:00:00',?,?,1.2,?,?)`).run(acct, symbol, status, String(pid), closed, entry, net, writtenOff).lastInsertRowid)
  const deal = (acct, pid, id, net) => db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, net_pnl, closed_at)
    VALUES (?,?,?,'EURUSD',?,'2026-09-20 10:00:00')`).run(String(id), String(pid), acct, net)
  const verdict = (acct, pid, v, brokerNet, ledgerNet = null) => db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict,
    final, reason, broker_net, ledger_net, read_at) VALUES (?,?,?,1,?,?,?,'2026-09-25T10:00:00Z')`).run(acct, String(pid), v, `fixture ${v}`, brokerNet, ledgerNet)

  // USD account: one position per class.
  trade(USD, 101, { net: 10 }); verdict(USD, 101, 'agrees', 10, 10)
  trade(USD, 102, { net: 12 }); verdict(USD, 102, 'money_disagrees', 20, 12)
  trade(USD, 103, { writtenOff: 1 }); verdict(USD, 103, 'never_filled', null)
  trade(USD, 104, { net: 5 }); deal(USD, 104, 1041, 5)
  trade(USD, 105, { net: 7 }); deal(USD, 105, 1051, 9)
  trade(USD, 106, { net: 3, closed: '2026-07-10 09:00:00' })
  trade(USD, 107, { net: 4 })
  deal(USD, 108, 1081, -6)
  trade(USD, 109, { status: 'rejected' }); deal(USD, 109, 1091, 2)
  trade(USD, 110, { status: 'open' })
  trade(USD, 111); deal(USD, 111, 1111, 8)
  // USDCNH #46/#47 shape: one broker position recorded twice.
  trade(USD, 500, { net: -196.35, symbol: 'USDCNH', entry: 7.1 }); trade(USD, 500, { net: -59.73, symbol: 'USDCNH', entry: 7.2 })
  // Two SGD accounts and one with no recorded currency.
  trade(SGD1, 201, { net: 50 }); verdict(SGD1, 201, 'money_disagrees', 45, 50)
  trade(SGD2, 301, { net: 30 }); verdict(SGD2, 301, 'agrees', 30, 30)
  trade(NOCCY, 401, { net: 1 }); verdict(NOCCY, 401, 'agrees', 1, 1)
  return db
}

test('class counts equal the fixture classes, per account, each with the basis it rests on', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  const r = buildLedgerReconciliation(db)
  const usd = r.accounts.find(a => a.accountId === USD)
  assert.equal(usd.currency, 'USD')
  const counts = Object.fromEntries(Object.entries(usd.classes).map(([k, v]) => [k, v.positions]))
  assert.deepEqual(counts, {
    agrees: 1, money_disagrees: 1, never_filled: 1, agrees_on_receipts: 1, differs_on_receipts: 1,
    ledger_only_before_receipts: 1, ledger_only_awaiting_receipt: 2, broker_only: 1, broker_deals_on_rejected_row: 1, unpriced_with_receipts: 1,
  })
  for (const cls of Object.keys(usd.classes)) assert.ok(CLASS_BASIS[cls], `${cls} has a basis`)
  assert.deepEqual([usd.classes.money_disagrees.delta, usd.classes.differs_on_receipts.delta], [-8, -2])
  assert.deepEqual([usd.classes.never_filled.writtenOff, usd.classes.broker_only.brokerNet], [1, -6])
  assert.equal(usd.positions.money_disagrees[0].reason, 'fixture money_disagrees')
  assert.equal(usd.positions.agrees, undefined, 'agreeing positions are counted, not listed')
  // Duplicates re-classed by broker evidence: the extra USDCNH row at its own money.
  assert.deepEqual([usd.duplicates.extraRows, usd.duplicates.extraNet, usd.duplicates.byClassification.same_position], [1, -59.73, 1])
  assert.equal(r.positionCounts.agrees, 3, 'counts may be added across accounts')
})

test('money is pooled only within one proven currency: SGD and USD are never summed, an unknown currency is never pooled', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  const r = buildLedgerReconciliation(db)
  assert.deepEqual(Object.keys(r.byCurrency).sort(), ['SGD', 'USD'])
  assert.deepEqual(r.byCurrency.SGD.accountIds.sort(), [SGD2, SGD1].sort())
  assert.deepEqual(r.byCurrency.USD.accountIds, [USD])
  assert.equal(r.byCurrency.USD.classes.money_disagrees.delta, -8, 'USD holds the USD account only')
  assert.equal(r.byCurrency.SGD.classes.money_disagrees.delta, 5, 'SGD holds the SGD accounts only')
  assert.equal(r.byCurrency.SGD.classes.agrees.ledgerNet, 30)
  assert.equal(r.byCurrency.SGD.classes.agrees.ledgerNetMoneyState, 'recorded_currency_units')
  assert.deepEqual(r.unpooledAccounts, [NOCCY])
  // The no-currency account's class is in no pool: SGD's agrees is SGD2's 30
  // alone, never 30 + NOCCY's 1.
  assert.ok(!Object.values(r.byCurrency).some(c => c.classes.agrees?.ledgerNet === 31 || c.classes.agrees?.ledgerNet === 41))
  assert.equal(r.accounts.find(a => a.accountId === NOCCY).currency, null)
  assert.equal(r.accounts.find(a => a.accountId === NOCCY).currencyReason, 'deposit_currency_not_recorded')
  // No top-level money field exists to sum across currencies.
  for (const key of Object.keys(r)) assert.ok(!/net|pnl|delta/i.test(key), `top-level ${key} is not money`)
})

test('owner principle 1: the report reads no demo/live flag — flipping every account\'s flag changes nothing in it (checker B1)', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  const strip = r => ({ ...r, generatedAt: null })
  const before = strip(buildLedgerReconciliation(db))
  for (const a of before.accounts) assert.ok(!Object.keys(a).some(k => /live/i.test(k)), `${a.accountId} carries no live/demo field`)
  // Flip the flag, and move the currency evidence to the host the flag now
  // routes to (routing may read the flag; the deposit-currency proof checks
  // the evidence came from the account's own host). Only the flag changed.
  db.prepare('UPDATE accounts SET is_live = 1 - is_live').run()
  for (const { account_id: id, is_live: live } of db.prepare('SELECT account_id, is_live FROM accounts').all()) {
    const key = `acct:${id}:deposit_currency_evidence_json`
    const value = getState(db, key)
    if (value) setState(db, key, JSON.stringify({ ...JSON.parse(value), host: live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com' }))
  }
  assert.deepEqual(strip(buildLedgerReconciliation(db)), before)
})

test('a no_ledger_row verdict on a position the ledger now holds has its basis and says the ledger changed since the read (checker N9)', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, exit_price, net_pnl)
    VALUES (?, 'EURUSD', 'BUY', 'closed', '112', '2026-07-01 00:00:00', '2026-09-20 10:00:00', 1.1, 1.2, 6)`).run(USD)
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, reason, broker_net, read_at)
    VALUES (?, '112', 'no_ledger_row', 1, 'fixture no_ledger_row', 6, '2026-09-25T10:00:00Z')`).run(USD)
  const usd = buildLedgerReconciliation(db, { accountId: USD }).accounts[0]
  assert.equal(usd.classes.no_ledger_row.positions, 1)
  assert.equal(CLASS_BASIS.no_ledger_row, 'broker_lifecycle')
  assert.equal(usd.positions.no_ledger_row[0].ledgerChangedSinceRead, true)
})

test('one account in scope; an unregistered account is refused', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  const r = buildLedgerReconciliation(db, { accountId: SGD1 })
  assert.deepEqual(r.accounts.map(a => a.accountId), [SGD1])
  assert.throws(() => buildLedgerReconciliation(db, { accountId: '999' }), /account not registered/)
})

test('the in-memory report path dispatches the worker kind', async t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  const r = await readLedgerReconciliation(db, { accountId: USD })
  assert.equal(r.accounts[0].accountId, USD)
})

test('GET /state/ledger-reconciliation: built on the worker, no SQL on the management connection; bad accounts are 400', async t => {
  const dir = tempDir('ledger-reconciliation-http-')
  const db = build(initDB(join(dir, 'fixture.db')))
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close() })
  const url = q => `http://127.0.0.1:${server.address().port}/state/ledger-reconciliation${q}`
  // The report's single worker slot is held until the worker EXITS, which can
  // trail its answer (the same measurement V3 L1 recorded for order-lifecycle),
  // so a distinct read straight after another may be answered with the typed
  // capacity 503 — explicit and transient, never an empty report (B2-m: this
  // race failed the sequence below 3 times in 5 on the merged tree). A 503 is
  // accepted only with that reason and a retry hint, and the read is repeated
  // until the slot is free.
  const read = async q => {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(url(q))
      if (res.status !== 503) return res
      const busy = await res.json()
      assert.equal(busy.reason, 'ledger_reconciliation_worker_capacity', 'the only 503 accepted is the typed capacity answer')
      assert.ok(Number(res.headers.get('retry-after')) > 0, 'with a retry hint')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`${q}: the worker slot never freed`)
  }
  const prepare = db.prepare
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('ledger reconciliation used the management connection') }
  try {
    const all = await read('?account=all')
    assert.equal(all.status, 200)
    const body = await all.json()
    assert.equal(body.accounts.length, 4)
    assert.equal(all.headers.get('cache-control'), 'no-store')
    const oneRes = await read(`?account=${SGD2}`)
    assert.equal(oneRes.status, 200)
    const one = await oneRes.json()
    assert.deepEqual(one.accounts.map(a => a.accountId), [SGD2])
    assert.equal((await read('?account=999')).status, 400)
    assert.equal((await read('?account=abc')).status, 400)
  } finally { db.prepare = prepare }
  assert.equal(managementReads, 0)
})

// ---------------------------------------------------------------------------
// B2-m (merge onto main after V3 WEB-5): the pools come from THE one pooling
// rule (poolByCurrency → splitByCurrency → populationStats) keyed by THE one
// currency reader (reportCurrency over depositCurrencies()), so the report
// carries the rule's own guarantees: a partly priced pool is marked partial,
// a class priced over no position has no figure (null, never a zero), and an
// account whose currency evidence is not its own is in no pool.
// ---------------------------------------------------------------------------
test('B2-m: a partly priced pool is marked partial, and a class priced over no position is null, never a zero', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  // SGD1 gains a written-off, unpriced never_filled position; SGD2 one with a
  // priced ledger row (a never_filled verdict beside a priced row is the
  // fixture's shape, not a claim about production).
  db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, exit_price, net_pnl, pnl_unresolvable)
    VALUES (?, 'EURUSD', 'BUY', 'closed', '202', '2026-07-01 00:00:00', '2026-09-20 10:00:00', 1.1, 1.2, NULL, 1)`).run(SGD1)
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, reason, read_at)
    VALUES (?, '202', 'never_filled', 1, 'fixture never_filled', '2026-09-25T10:00:00Z')`).run(SGD1)
  db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id, opened_at, closed_at, entry_price, exit_price, net_pnl)
    VALUES (?, 'EURUSD', 'BUY', 'closed', '302', '2026-07-01 00:00:00', '2026-09-20 10:00:00', 1.1, 1.2, 4)`).run(SGD2)
  db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, reason, read_at)
    VALUES (?, '302', 'never_filled', 1, 'fixture never_filled', '2026-09-25T10:00:00Z')`).run(SGD2)
  const r = buildLedgerReconciliation(db)
  const sgd1 = r.accounts.find(a => a.accountId === SGD1).classes.never_filled
  assert.deepEqual([sgd1.positions, sgd1.ledgerNet, sgd1.ledgerPriced, sgd1.brokerNet, sgd1.delta], [1, null, 0, null, null],
    'one account, nothing priced: no figure, never 0')
  const pool = r.byCurrency.SGD.classes.never_filled
  assert.deepEqual([pool.positions, pool.rows, pool.writtenOff], [2, 2, 1])
  assert.deepEqual([pool.ledgerNet, pool.ledgerPriced, pool.ledgerNetMoneyState], [4, 1, 'partial_recorded_currency_units'])
  assert.deepEqual([pool.brokerNet, pool.brokerPriced, pool.brokerNetMoneyState], [null, 0, 'unavailable'])
  const usd = r.byCurrency.USD.classes.never_filled
  assert.deepEqual([usd.ledgerNet, usd.ledgerNetMoneyState], [null, 'unavailable'], 'USD never_filled is priced over no position')
})

test('B2-m: the currency comes from the one reader — evidence recorded on another host is no currency, and the account is pooled with nothing', t => {
  const db = build(initDB(':memory:')); t.after(() => db.close())
  // SGD2 is routed to the live host; its evidence now names the demo host.
  setState(db, `acct:${SGD2}:deposit_currency_evidence_json`, JSON.stringify({ accountId: SGD2, host: 'demo.ctraderapi.com', currency: 'SGD',
    receivedAt: 1, source: 'broker_asset_list' }))
  const r = buildLedgerReconciliation(db)
  const sgd2 = r.accounts.find(a => a.accountId === SGD2)
  assert.deepEqual([sgd2.currency, sgd2.currencyReason], [null, 'deposit_currency_evidence_mismatch'])
  assert.deepEqual(r.byCurrency.SGD.accountIds, [SGD1])
  assert.equal(r.byCurrency.SGD.classes.agrees, undefined, "SGD2's agrees (30) is no longer in the SGD pool")
  assert.deepEqual(r.unpooledAccounts.sort(), [SGD2, NOCCY].sort())
})
