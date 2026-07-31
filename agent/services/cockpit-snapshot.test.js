// PHASE 1 GATE (cockpit live-wiring prompt): "two-account isolation test
// passes." The route's whole contract is identity — these tests are the gate,
// not decoration.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { cockpitSnapshot } from './cockpit-snapshot.js'

function freshDb() {
  const db = initDB(':memory:')
  const t = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, opened_at, ctrader_position_id, status)
    VALUES (?, ?, ?, ?, datetime('now'), ?, 'open')`)
  const mp = db.prepare(`INSERT INTO monitored_positions
    (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
  // Account A: EURUSD long. Account B: XAUUSD short. One legacy NULL-account row.
  const ta = t.run('EURUSD', 'long', 1.1, 0.5, '900001').lastInsertRowid
  const tb = t.run('XAUUSD', 'short', 2400, 0.1, '900002').lastInsertRowid
  const idA = mp.run('EURUSD', ta, 'long', 1.1, 1.09, 1.13, 'ACC_A').lastInsertRowid
  const idB = mp.run('XAUUSD', tb, 'short', 2400, 2420, 2350, 'ACC_B').lastInsertRowid
  const idLegacy = mp.run('USDJPY', null, 'long', 155, 154, 158, null).lastInsertRowid
  return { db, idA, idB, idLegacy }
}

let ctx
beforeEach(() => { ctx = freshDb() })

const scope = (accountId) => ({ accountId, all: false, explicit: true })

test('account A cannot read account B position — same 404 as a nonexistent id', () => {
  const asA = cockpitSnapshot(ctx.db, ctx.idB, scope('ACC_A'))
  const missing = cockpitSnapshot(ctx.db, 999999, scope('ACC_A'))
  assert.equal(asA.status, 404)
  assert.equal(missing.status, 404)
  // Indistinguishable on purpose: a wrong-account probe must not learn the id
  // exists. Compare the messages with ids normalised out.
  assert.equal(
    String(asA.body.error).replace(/\d+/g, 'N'),
    String(missing.body.error).replace(/\d+/g, 'N'))
  // And not one field of B's data may ride along on the refusal.
  assert.ok(!JSON.stringify(asA.body).includes('XAUUSD'))
})

test('the right account gets its own position with full identity in meta', () => {
  const out = cockpitSnapshot(ctx.db, ctx.idA, scope('ACC_A'))
  assert.equal(out.status, 200)
  assert.equal(out.body.meta.accountId, 'ACC_A')
  assert.equal(out.body.meta.dbPositionId, ctx.idA)
  assert.equal(out.body.meta.brokerPositionId, '900001')
  assert.equal(typeof out.body.meta.tradeId, 'number')
  assert.equal(out.body.position.symbol, 'EURUSD')
  assert.equal(out.body.position.sl, 1.09)
})

test('identity must be explicit — an implicit scope is refused, not defaulted', () => {
  // The prompt: no silent account fallback. The selected account is set, and
  // the route must still refuse to use it for a deep link.
  setState(ctx.db, 'ctrader_account_id', 'ACC_A')
  const out = cockpitSnapshot(ctx.db, ctx.idA, { accountId: 'ACC_A', all: false, explicit: false })
  assert.equal(out.status, 400)
  assert.match(out.body.error, /account is required/)
})

test('a garbage id is a 400, not a scan', () => {
  for (const bad of ['abc', -1, 0, 1.5, null, undefined]) {
    assert.equal(cockpitSnapshot(ctx.db, bad, scope('ACC_A')).status, 400)
  }
})

test('a legacy NULL-account row answers to any explicit account (M1 convention)', () => {
  const out = cockpitSnapshot(ctx.db, ctx.idLegacy, scope('ACC_A'))
  assert.equal(out.status, 200)
  assert.equal(out.body.position.symbol, 'USDJPY')
})

test('everything the shell cannot vouch for is UNKNOWN, never a default', () => {
  const out = cockpitSnapshot(ctx.db, ctx.idA, scope('ACC_A'))
  for (const k of ['account', 'bars', 'indicators', 'execution', 'intention', 'correlation', 'environment', 'fleet']) {
    assert.equal(out.body[k].status, 'unknown', `${k} must be unknown in the shell`)
  }
  assert.deepEqual(out.body.journal, [])
  // No broker snapshot cache seeded → price/pnl are null with a staleness advisory.
  assert.equal(out.body.position.price, null)
  assert.equal(out.body.position.pnl, null)
  assert.ok(out.body.advisories.some(a => a.kind === 'staleness'))
})

test('the broker snapshot cache enriches price/pnl and stamps provenance', () => {
  setState(ctx.db, 'broker_snapshot_cache_json', JSON.stringify({
    fetchedAt: '2026-07-31T00:00:00Z',
    account: { positions: [{ positionId: 900001, price: 1.105, bid: 1.1049, ask: 1.1051, pnl: 12.5, currency: 'USD' }] },
  }))
  const out = cockpitSnapshot(ctx.db, ctx.idA, scope('ACC_A'))
  assert.equal(out.body.position.price, 1.105)
  assert.equal(out.body.position.pnl, 12.5)
  assert.equal(out.body.position.source, 'local-db+broker-snapshot-cache')
  assert.equal(out.body.position.asOf, '2026-07-31T00:00:00Z')
  // The revision moves with the live cache, so cached explanations invalidate.
  assert.ok(String(out.body.meta.revision).includes('2026-07-31T00:00:00Z'))
})
