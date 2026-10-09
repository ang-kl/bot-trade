// Codex · №12,472 · 2026-10-09; codex-footprint: owner HK exclusion at actual entry boundaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { upsertAccount } from '../services/account-registry.js'
import { reserveEntry, redeemPermit, reserveStandingPermits, TICK_PRODUCER } from '../services/entry-ledger.js'
import { admitEntry } from '../services/entry-mode.js'
const accountId = '46130058'
function fresh() { const db = initDB(':memory:'); upsertAccount(db, { accountId, isLive: false }); return db }
const order = { accountId, producerId: 'route_manual_order', symbol: 'EURUSD', symbolId: 1, side: 'BUY', volume: 1000 }
test('owner exclusion rejects fresh HK entries for both sides and manual/automatic producers; indices remain admissible', () => {
  const db = fresh()
  try {
    for (const symbol of ['9618.HK', '0066.hk']) for (const side of ['BUY', 'SELL']) for (const producerId of ['route_manual_order', 'daily_momentum_account']) {
      const r = reserveEntry(db, { ...order, symbol, side, producerId })
      assert.equal(r.ok, false); assert.match(r.reason, /owner_hk_share_excluded/)
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_intents').get().n, 0)
    for (const [i, symbol] of ['HK50', 'CHINAH', 'CN50', 'DBS.SG'].entries()) assert.equal(reserveEntry(db, { ...order, symbol, symbolId: i + 5 }).ok, true)
  } finally { db.close() }
})
test('an old queued HK permit cannot be redeemed, while an already accepted broker order is not rewritten', () => {
  const db = fresh()
  try {
    const r = reserveEntry(db, order)
    db.prepare("UPDATE entry_intents SET symbol = '9618.HK' WHERE id = ?").run(r.intentId)
    const stopped = redeemPermit(db, r.permit.id)
    assert.equal(stopped.ok, false); assert.match(stopped.reason, /owner_hk_share_excluded/)
    assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(r.intentId).state, 'RELEASED')
    db.prepare("UPDATE entry_intents SET state = 'ACCEPTED' WHERE id = ?").run(r.intentId)
    assert.equal(redeemPermit(db, r.permit.id).ok, false)
    assert.equal(db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(r.intentId).state, 'ACCEPTED')
  } finally { db.close() }
})
test('standing native HK permits are withdrawn instead of reused', () => {
  const db = fresh()
  try {
    const opts = { accountId, producerId: TICK_PRODUCER, entries: [{ key: 'k', symbol: 'EURUSD', symbolId: 1, volume: 1000 }], admit: (db, o) => admitEntry(db, { ...o, producerId: 'daily_momentum_account' }) }
    assert.equal(reserveStandingPermits(db, opts).permits.length, 2)
    db.prepare("UPDATE entry_intents SET symbol = '9618.HK'").run()
    const r = reserveStandingPermits(db, { ...opts, entries: [{ ...opts.entries[0], symbol: '9618.HK' }] })
    assert.equal(r.permits.length, 0); assert.equal(r.released, 2)
  } finally { db.close() }
})
test('HK exclusion resolves numeric-only requests from THIS account map, refuses conflicts and unknown numeric-only identity', () => {
  const db = fresh()
  try {
    setState(db, `symbol_id_map:${accountId}`, JSON.stringify({ accountId, map: { '9618.HK': 7, HK50: 8 }, builtAt: new Date().toISOString() }))
    setState(db, 'symbol_id_map:other', JSON.stringify({ accountId: 'other', map: { EURUSD: 7 }, builtAt: new Date().toISOString() }))
    assert.equal(reserveEntry(db, { ...order, symbol: null, symbolId: 7 }).ok, false)
    assert.equal(reserveEntry(db, { ...order, symbol: 'EURUSD', symbolId: 7 }).ok, false)
    assert.equal(reserveEntry(db, { ...order, symbol: null, symbolId: 8 }).ok, true)
    assert.equal(reserveEntry(db, { ...order, symbol: null, symbolId: 999 }).ok, false)
  } finally { db.close() }
})
