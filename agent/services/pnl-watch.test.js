// node --test agent/services/pnl-watch.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepOf, shouldAlertStep, runPnlWatch } from './pnl-watch.js'
import { initDB, getState, setState } from '../db.js'

test('stepOf: signed step of balance percent', () => {
  assert.equal(stepOf(500, 50_000, 1), 1)     // +1.0%
  assert.equal(stepOf(499, 50_000, 1), 0)     // +0.998% — inside first step
  assert.equal(stepOf(-1600, 50_000, 1), -3)  // −3.2%
  assert.equal(stepOf(500, 0, 1), 0)          // no balance → never alert
  assert.equal(stepOf(NaN, 50_000, 1), 0)
})

test('shouldAlertStep: deeper-only in one direction, re-arms across zero', () => {
  assert.equal(shouldAlertStep(1, 0), true, 'first crossing alerts')
  assert.equal(shouldAlertStep(1, 1), false, 'same step stays quiet')
  assert.equal(shouldAlertStep(2, 1), true, 'next full step alerts')
  assert.equal(shouldAlertStep(1, 2), false, 'pulling back is not news')
  assert.equal(shouldAlertStep(-1, 2), true, 'flipping sign alerts')
  assert.equal(shouldAlertStep(-2, -1), true)
  assert.equal(shouldAlertStep(0, 2), false, 'inside the first step never alerts')
})

// Regression: the position query joins ctrader_position_id off `trades` (it does
// NOT live on monitored_positions). A wrong table raised "no such column:
// ctrader_position_id" at runtime and silently killed the whole watch. This
// runs the real query path against the real schema so the column must resolve.
test('runPnlWatch: query resolves ctrader_position_id via the trades join (no SQL error)', async () => {
  const db = initDB(':memory:')
  db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run('pnl_alert_pct', '1')
  const t = db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id) VALUES ('EURUSD','buy','open','P123')`
  ).run()
  db.prepare(
    `INSERT INTO monitored_positions (symbol, side, trade_id, status) VALUES ('EURUSD','buy',?, 'active')`
  ).run(t.lastInsertRowid)
  // creds.ready falsy → returns early WITHOUT running the (previously broken)
  // query, so assert the query itself compiles/resolves directly.
  const rows = db.prepare(
    `SELECT t.ctrader_position_id AS pid, m.symbol AS symbol, m.side AS side
       FROM monitored_positions m
       JOIN trades t ON t.id = m.trade_id
      WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL`
  ).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 'P123')
  assert.equal(rows[0].symbol, 'EURUSD')
  // And the guarded entry point stays safe when creds aren't ready.
  const res = await runPnlWatch(db, { ready: false })
  assert.deepEqual(res, { checked: 0, alerts: 0 })
})

test('actual P&L watch uses broker-account balance, rows and independent alert steps', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '100000')
  const trade = db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id)
    VALUES (?, ?, 'buy', 'open', 'same-id')`)
  const monitor = db.prepare(`INSERT INTO monitored_positions (account_id, symbol, side, trade_id, status)
    VALUES (?, ?, 'buy', ?, 'active')`)
  for (const [id, symbol, balance] of [['11', 'EURUSD', 100000], ['22', 'XAUUSD', 1000]]) {
    const tradeId = trade.run(id, symbol).lastInsertRowid
    monitor.run(id, symbol, tradeId)
    setState(db, `acct:${id}:account_balance_usd`, String(balance))
  }
  // The old key cannot suppress a different account's first crossing.
  setState(db, 'pnl_step_same-id', '999')
  const messages = [], reads = []
  const deps = {
    wsGetUnrealizedPnl: async (...args) => { reads.push(args[4]); return { 'same-id': { net: args[4] === '22' ? 20 : 2000 } } },
    sendMessage: async text => { messages.push(text) },
  }
  for (const id of ['22', '11']) {
    const out = await runPnlWatch(db, { ready: true, accountId: id }, deps)
    assert.deepEqual(out, { checked: 1, alerts: 1 })
    assert.equal(getState(db, `acct:${id}:pnl_step_same-id`), '2')
  }
  assert.deepEqual(reads, ['22', '11'])
  assert.match(messages[0], /Account …22: XAUUSD.*2.00%/)
  assert.match(messages[1], /Account …11: EURUSD.*2.00%/)
  assert.equal((await runPnlWatch(db, { ready: true, accountId: '22' }, deps)).alerts, 0)
  assert.equal(messages.length, 2)
  assert.equal(getState(db, 'pnl_step_same-id'), '999')
})

test('P&L watch does not label unowned, conflicting or duplicate positions with a broker result', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'acct:11:account_balance_usd', '1000')
  const add = (tradeAccount, monitorAccount, pid) => {
    const trade = db.prepare(`INSERT INTO trades (account_id, symbol, side, status, ctrader_position_id)
      VALUES (?, 'EURUSD', 'buy', 'open', ?)`).run(tradeAccount, pid).lastInsertRowid
    db.prepare(`INSERT INTO monitored_positions (account_id, symbol, side, trade_id, status)
      VALUES (?, 'EURUSD', 'buy', ?, 'active')`).run(monitorAccount, trade)
  }
  add(null, null, 'unowned'); add('11', '22', 'conflict')
  add('11', '11', 'duplicate'); add('11', '11', 'duplicate')
  const messages = []
  const out = await runPnlWatch(db, { ready: true, accountId: '11' }, {
    wsGetUnrealizedPnl: async () => ({ unowned: { net: 20 }, conflict: { net: 20 }, duplicate: { net: 20 } }),
    sendMessage: async text => { messages.push(text) },
  })
  assert.deepEqual(out, { checked: 0, alerts: 0 })
  assert.deepEqual(messages, [])
})

test('P&L watch requires an explicit broker account and its own positive balance before reading', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '100000')
  setState(db, 'acct:11:account_balance_usd', '100000')
  const deps = { wsGetUnrealizedPnl: async () => { assert.fail('must not read the broker') } }
  assert.equal((await runPnlWatch(db, { ready: true }, deps)).reason, 'account_required')
  assert.deepEqual(await runPnlWatch(db, { ready: true, accountId: '22' }, deps), { checked: 0, alerts: 0 })
  setState(db, 'acct:22:account_balance_usd', '0')
  assert.deepEqual(await runPnlWatch(db, { ready: true, accountId: '22' }, deps), { checked: 0, alerts: 0 })
})
