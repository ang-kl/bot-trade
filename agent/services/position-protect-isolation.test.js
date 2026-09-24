import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { protectPosition } from './position-protect.js'

function seed(db, account, { position = '700', monitorAccount = account } = {}) {
  const trade = db.prepare(`INSERT INTO trades (symbol,side,status,account_id,ctrader_position_id)
    VALUES ('EURUSD','long','open',?,?)`).run(account, position).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (trade_id,symbol,status,account_id,current_sl,current_tp,source)
    VALUES (?,'EURUSD','active',?,1.05,1.2,'bot')`).run(trade, monitorAccount)
  return Number(trade)
}
const rows = db => db.prepare('SELECT * FROM monitored_positions ORDER BY id').all()

test('protection bookkeeping cannot change another account with the same broker position ID', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const foreignTrade = seed(db, 'B'), ownTrade = seed(db, 'A')
  const foreignBefore = rows(db).find(r => r.trade_id === foreignTrade)
  const sent = []
  await protectPosition(db, { accountId: 'A' }, { positionId: '700', sl: 1.06, tp: 1.21 }, {
    amend: async (creds, args) => { sent.push({ account: creds.accountId, ...args }); return {} },
  })
  assert.deepEqual(rows(db).find(r => r.trade_id === foreignTrade), foreignBefore)
  assert.equal(rows(db).find(r => r.trade_id === ownTrade).current_tp, 1.21)
  assert.deepEqual(sent, [{ account: 'A', positionId: 700, stopLoss: 1.06, takeProfit: 1.21 }])
  assert.deepEqual(db.prepare('SELECT DISTINCT account_id,trade_id FROM position_events').all(), [{ account_id: 'A', trade_id: ownTrade }])
})

test('ambiguous same-account lifecycle rows are not arbitrarily rewritten or journalled', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, 'A'); seed(db, 'A')
  const before = rows(db)
  let sends = 0
  const result = await protectPosition(db, { accountId: 'A' }, { positionId: '700', sl: 1.06, tp: 1.21 }, {
    amend: async () => { sends++; return {} },
  })
  assert.equal(sends, 1, 'explicit broker protection does not depend on local lifecycle attribution')
  assert.deepEqual(rows(db), before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_events').get().n, 0)
  assert.equal(result.ledgerUpdated, false)
  assert.match(result.ledgerReason, /ambiguous/)
})

test('conflicting trade/monitor ownership does not acquire a protection journal entry', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, 'A', { monitorAccount: 'B' })
  const before = rows(db)
  const result = await protectPosition(db, { accountId: 'A' }, { positionId: '700', sl: 1.06, tp: 1.21 }, { amend: async () => ({}) })
  assert.deepEqual(rows(db), before)
  assert.equal(result.ledgerUpdated, false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_events').get().n, 0)
})

test('a lifecycle closed during broker I/O is not rewritten from the earlier snapshot', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, 'A')
  const result = await protectPosition(db, { accountId: 'A' }, { positionId: '700', sl: 1.06, tp: 1.21 }, {
    amend: async () => { db.prepare("UPDATE monitored_positions SET status = 'closed'").run(); return {} },
  })
  assert.equal(rows(db)[0].current_tp, 1.2)
  assert.equal(result.ledgerUpdated, false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_events').get().n, 0)
})

test('a resolved broker rejection is not reported as protection success', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, 'A')
  const before = rows(db)
  for (const response of [{ alreadyClosed: true }, { rawError: 'POSITION_NOT_FOUND' }, { ok: false }, { error: 'refused' }]) {
    await assert.rejects(protectPosition(db, { accountId: 'A' }, { positionId: '700', sl: 1.06, tp: 1.21 }, {
      amend: async () => response,
    }), /not accepted/)
  }
  assert.deepEqual(rows(db), before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_events').get().n, 0)
})

test('invalid identities refuse before broker reads or writes; integer-form legacy IDs remain supported', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, 'A')
  let calls = 0
  const deps = { amend: async () => { calls++; return {} }, readPosition: async () => { calls++; return null } }
  for (const positionId of [null, '700junk', '700.5', '0', '-700', '9007199254740993', {}]) {
    await assert.rejects(protectPosition(db, { accountId: 'A' }, { positionId, tp: 1.21 }, deps), /positionId.*required/)
  }
  for (const accountId of [null, '', 'all', '_all']) {
    await assert.rejects(protectPosition(db, { accountId }, { positionId: '700', tp: 1.21 }, deps), /accountId.*required/)
  }
  assert.equal(calls, 0)
  const result = await protectPosition(db, { accountId: 'A' }, { positionId: '700.0', sl: 1.06, tp: 1.21 }, deps)
  assert.equal(result.positionId, '700')
  assert.equal(result.ledgerUpdated, true)
})
