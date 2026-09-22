import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { hourlyActivity } from './hourly-activity.js'
import { activityEvidence } from '../../src/lib/hourly-activity.js'
const to = Date.parse('2026-09-22T09:00:00Z'), from = to - 86400_000
const scope = { all: false, accountId: '11', explicit: true }
function fixture(t) {
  const db = initDB(':memory:'); t.after(() => db.close())
  const insert = db.prepare("INSERT INTO trades (symbol,status,account_id,opened_at,closed_at,net_pnl) VALUES ('EURUSD','closed',?,?,?,?)")
  return { db, add: (id = '11', at = to - 1, pnl = 2) => insert.run(id, new Date(from).toISOString(), typeof at === 'number' ? new Date(at).toISOString() : at, pnl),
    read: (s = scope) => hourlyActivity(db, s, { to, nowMs: to }) }
}
test('all closes are counted beyond journal paging, including missing P&L', t => {
  const { db, add, read } = fixture(t)
  db.transaction(() => { for (let i = 0; i < 1205; i++) add() })()
  add('11', to - 1, null)
  const r = read()
  assert.equal(r.closedN, 1206); assert.equal(r.pricedN, 1205)
  assert.equal(r.net, null); assert.equal(r.moneyByAccount[0].recordedNet, 2410)
  assert.ok(activityEvidence(r, { accountId: '11', to, nowMs: to }))
})
test('different accounts and legacy rows retain their own amounts without mixing unknown currencies', t => {
  const { add, read } = fixture(t)
  add('11'); add('22', to - 1, 300); add(null, to - 1, 5)
  const r = read({ all: true })
  assert.equal(r.closedN, 3); assert.equal(r.net, null)
  assert.equal(r.moneyByAccount.length, 3)
  assert.equal(read().closedN, 2, 'NULL-account convention is explicit')
})
test('close boundaries are half-open, missing dates remain unknown, empty is verified zero', t => {
  const { add, read } = fixture(t)
  assert.equal(read().closedN, 0); assert.equal(read().net, 0)
  for (const at of [from - 1, from, from + 3600_000, to - 1, to, null]) add('11', at)
  const r = read()
  assert.equal(r.closedN, 3); assert.equal(r.unknownCloseTimeN, 1)
  assert.deepEqual([r.rows[0].closedN, r.rows[1].closedN, r.rows[23].closedN], [1, 1, 1])
  assert.equal(activityEvidence({ ...r, closedN: 0 }, { accountId: '11', to, nowMs: to }), null)
  assert.equal(activityEvidence(r, { accountId: '22', to, nowMs: to }), null)
})
