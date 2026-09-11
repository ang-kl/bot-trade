// agent/services/entry-drain.test.js — P1c: resting entry orders are drained
// by stored id on a switch to STOPPED, and the state settles on evidence.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { engineStatusFor, requestEntryMode, admitEntry } from './entry-mode.js'
import { drainEntryOrders, drainEntryOrdersPass } from './entry-drain.js'
import { isBotOrderLabel, brokerOrderFields, BOT_MARKERS } from './pending-orders.js'

const DEMO = '46130058', LIVE = '42993489'
const creds = (accountId) => ({ host: 'demo.ctraderapi.com', clientId: 'c', clientSecret: 's', accessToken: 't', accountId, ready: true })

function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  const ins = db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, account_id)
    VALUES (?, '4h', ?, 1, 1.1, 1.09, 1.12, 1000, '2099-01-01T00:00:00.000Z', 'working', ?, ?)`)
  ins.run('EURUSD', '101', 'pending-fib', DEMO)
  ins.run('MSFT.US', '102', 'pending-closed', DEMO)
  ins.run('GBPUSD', '201', 'pending-fib', LIVE)
  ins.run('USDJPY', '301', 'pending-fib', null)
  return db
}
function fakeExec({ failCancel = () => false, snapshots = [] } = {}) {
  const calls = { cancelled: [], reconciles: 0 }
  return {
    calls,
    exec: {
      cancelOrder: async (c, { orderId }) => {
        calls.cancelled.push({ accountId: c.accountId, orderId: String(orderId) })
        const why = failCancel(String(orderId))
        if (why) throw new Error(why)
        return { ok: true }
      },
      reconcile: async () => { calls.reconciles++; return { order: snapshots.shift() ?? [], position: [] } },
    },
  }
}
const rowOf = (db, orderId) => db.prepare(`SELECT status, note FROM pending_orders WHERE order_id = ?`).get(orderId)

test('STOPPED with resting rows enters QUIESCING; the drain cancels this account\'s working rows by stored id only and settles STABLE', async () => {
  const db = fresh()
  const r = requestEntryMode(db, DEMO, 'STOPPED', { expectedRevision: 0 })
  assert.equal(r.status.transitionState, 'QUIESCING'); assert.equal(r.status.entryCounts.resting, 2)
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch' }).ok, false, 'the fence is closed before the drain runs')
  const manual = { orderId: 900, tradeData: { label: 'owner-manual', symbolId: 1 } }
  const fx = fakeExec({ snapshots: [[manual]] })
  const d = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.deepEqual(fx.calls.cancelled.map(c => c.orderId), ['101', '102'])
  assert.ok(fx.calls.cancelled.every(c => c.accountId === DEMO), 'cancelled with the account\'s own credentials')
  assert.equal(rowOf(db, '101').status, 'cancelled'); assert.match(rowOf(db, '101').note, /entry_mode drain \(epoch 1, was pending-fib\)/)
  assert.equal(rowOf(db, '102').status, 'cancelled'); assert.match(rowOf(db, '102').note, /was pending-closed/)
  assert.equal(rowOf(db, '201').status, 'working', 'the other account\'s row is untouched')
  assert.equal(rowOf(db, '301').status, 'working', 'a row with no account is never cancelled with this account\'s credentials')
  assert.equal(d.unattributed, 1)
  assert.equal(d.resting, 0); assert.equal(d.unknown, 0, 'a manual order at the broker is not ours'); assert.equal(d.transitionState, 'STABLE')
  const st = engineStatusFor(db, DEMO)
  assert.equal(st.transitionState, 'STABLE'); assert.equal(st.entryCounts.resting, 0); assert.equal(st.entryCounts.unknown, 0)
  assert.equal(st.modeEpoch, 1); assert.equal(st.configRevision, 1, 'a drain pass is not a config change')
  assert.equal(fx.calls.reconciles, 1, 'the snapshot is fetched once, after the cancels')
  // idempotent: the next pass returns before any broker call
  const again = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(again.skipped, 'stable'); assert.equal(fx.calls.reconciles, 1); assert.equal(fx.calls.cancelled.length, 2)
  const logRows = db.prepare(`SELECT body FROM action_log WHERE path = '/entry-mode/drain'`).all()
  assert.equal(logRows.length, 1)
  assert.equal(JSON.parse(logRows[0].body).to, 'STABLE')
})

test('a failed cancel leaves its row working and the state RECONCILING; the next pass retries by the same stored id and settles', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  let fail = true
  const fx = fakeExec({
    failCancel: (id) => (id === '102' && fail ? 'broker says no' : false),
    snapshots: [[{ orderId: 102, tradeData: { label: 'pending-closed', symbolId: 2 } }], []],
  })
  const d1 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(d1.cancelled.length, 1); assert.equal(d1.failures.length, 1); assert.equal(d1.failures[0].error, 'broker says no')
  assert.equal(rowOf(db, '102').status, 'working')
  assert.equal(d1.resting, 1); assert.equal(d1.unknown, 0, 'a working row explains the broker order'); assert.equal(d1.transitionState, 'RECONCILING')
  assert.equal(engineStatusFor(db, DEMO).transitionState, 'RECONCILING')
  fail = false
  const d2 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.deepEqual(fx.calls.cancelled.map(c => c.orderId), ['101', '102', '102'])
  assert.equal(d2.transitionState, 'STABLE'); assert.equal(rowOf(db, '102').status, 'cancelled')
})

test('an order the broker still shows after its cancel counts unknown (RECONCILING) and settles on the next clean snapshot without a second cancel', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const fx = fakeExec({ snapshots: [[{ orderId: 101, tradeData: { label: 'pending-fib', symbolId: 1 } }], []] })
  const d1 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(d1.cancelled.length, 2); assert.equal(d1.resting, 0); assert.equal(d1.unknown, 1); assert.equal(d1.transitionState, 'RECONCILING')
  const d2 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(fx.calls.cancelled.length, 2, 'cancelled rows are not cancelled again'); assert.equal(d2.unknown, 0); assert.equal(d2.transitionState, 'STABLE')
})

test('a fill during the cancel is the ledger\'s call: the drain never invents a fill, and settles once the fill pass has marked the row', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const fx = fakeExec({ failCancel: (id) => (id === '102' ? 'ORDER_NOT_FOUND: already filled' : false), snapshots: [[], []] })
  const d1 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(d1.transitionState, 'RECONCILING'); assert.equal(rowOf(db, '102').status, 'working')
  // what managePendingOrders / reconcileStaleClosedMarketLimits write when the position appears
  db.prepare(`UPDATE pending_orders SET status = 'filled', note = 'filled: position 555' WHERE order_id = '102'`).run()
  const d2 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(d2.cancelled.length, 0); assert.equal(d2.failures.length, 0); assert.equal(d2.transitionState, 'STABLE')
  assert.equal(rowOf(db, '102').status, 'filled')
})

test('no broker snapshot is no evidence: cancels still go out by stored id, but the state cannot settle on it', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const exec = { cancelOrder: async () => ({ ok: true }), reconcile: async () => { throw new Error('sidecar down') } }
  const d = await drainEntryOrders(db, creds(DEMO), { exec })
  assert.equal(d.cancelled.length, 2); assert.equal(d.snapshotError, 'sidecar down'); assert.equal(d.transitionState, 'RECONCILING')
  assert.equal(engineStatusFor(db, DEMO).transitionState, 'RECONCILING')
})

test('under an active mode the pass recounts and never cancels: resting rows are legitimate there, only unknown must clear', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const fx = fakeExec({ snapshots: [[{ orderId: 777, tradeData: { label: 'pending-fib', symbolId: 3 } }], []] })
  const d1 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(d1.unknown, 1, 'an orphan with a bot marker is unknown'); assert.equal(d1.transitionState, 'RECONCILING')
  const back = requestEntryMode(db, DEMO, 'TIME_BASED', { expectedRevision: 1 })
  assert.equal(back.ok, true)
  assert.equal(back.status.transitionState, 'RECONCILING', 'an unresolved entry cannot be declared STABLE under an active mode')
  assert.equal(admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch' }).ok, true, 'the fence reads the mode, not the transition')
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, expires_at, status, note, account_id)
    VALUES ('AUDUSD', '4h', '150', 1, 0.7, 0.69, 0.72, 1000, '2099-01-01T00:00:00.000Z', 'working', 'pending-fib', ?)`).run(DEMO)
  const d2 = await drainEntryOrders(db, creds(DEMO), { exec: fx.exec })
  assert.equal(fx.calls.cancelled.length, 2, 'no cancel under TIME_BASED'); assert.equal(d2.resting, 1); assert.equal(d2.unknown, 0); assert.equal(d2.transitionState, 'STABLE')
  assert.equal(rowOf(db, '150').status, 'working')
  // a STOPPED account with nothing resting is STABLE at once and the drain has nothing to do
  const r2 = requestEntryMode(db, LIVE, 'STOPPED')
  db.prepare(`UPDATE pending_orders SET status = 'expired' WHERE order_id = '201'`).run()
  assert.equal(r2.status.transitionState, 'QUIESCING')
  const r3 = requestEntryMode(db, LIVE, 'STOPPED', { expectedRevision: 1 })
  assert.equal(r3.status.transitionState, 'STABLE'); assert.equal((await drainEntryOrders(db, creds(LIVE), { exec: fx.exec })).skipped, 'stable')
})

test('drainEntryOrdersPass drains only accounts in QUIESCING/RECONCILING, each with its own credentials, and reports unready ones', async () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  requestEntryMode(db, LIVE, 'STOPPED')
  const fx = fakeExec({ snapshots: [[], []] })
  const credsFor = (_db, { accountId, isLive }) => (isLive ? { accountId, isLive, ready: false } : creds(accountId))
  const p = await drainEntryOrdersPass(db, { exec: fx.exec, credsFor })
  assert.equal(p.checked, 2)
  assert.equal(p.drained.length, 1); assert.equal(p.drained[0].accountId, DEMO); assert.equal(p.drained[0].transitionState, 'STABLE')
  assert.deepEqual(p.skipped, [{ accountId: LIVE, reason: 'credentials not ready' }])
  assert.equal(rowOf(db, '201').status, 'working', 'no credentials, no cancel')
  assert.ok(fx.calls.cancelled.every(c => c.accountId === DEMO))
  const p2 = await drainEntryOrdersPass(db, { exec: fx.exec, credsFor })
  assert.equal(p2.checked, 1, 'the settled account is not visited again'); assert.equal(p2.drained.length, 0)
})

test('helpers: only a bot marker makes an order ours; broker fields are read off either payload shape', () => {
  assert.deepEqual([...BOT_MARKERS], ['pending-fib', 'pending-closed'])
  assert.equal(isBotOrderLabel('pending-fib|v3|x'), true); assert.equal(isBotOrderLabel('pending-closed'), true)
  assert.equal(isBotOrderLabel('owner manual'), false); assert.equal(isBotOrderLabel(null), false); assert.equal(isBotOrderLabel(undefined), false)
  assert.deepEqual(brokerOrderFields({ orderId: 5, tradeData: { label: 'pending-fib', symbolId: 9 } }), { orderId: 5, label: 'pending-fib', symbolId: 9 })
  assert.deepEqual(brokerOrderFields({ orderId: 6, label: 'x', symbolId: 2 }), { orderId: 6, label: 'x', symbolId: 2 })
  assert.deepEqual(brokerOrderFields({}), { orderId: null, label: '', symbolId: null })
})

test('wiring pins (comments stripped): the loop runs the pass, the route runs the first drain, requestEntryMode enters QUIESCING, the sweep uses the exported marker rule', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const src = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'))
  assert.match(src('../loop.js'), /drainEntryOrdersPass\(db\)/, 'the loop drains every cycle')
  assert.match(src('../routes/actions.js'), /transitionState === 'QUIESCING'[\s\S]{0,600}drainEntryOrders\(db, creds/, 'the route runs the first pass')
  assert.match(src('./entry-mode.js'), /resting > 0 \? 'QUIESCING'/)
  assert.match(src('./pending-orders.js'), /const isBotOrder = isBotOrderLabel/)
  assert.match(src('./entry-drain.js'), /exec\.cancelOrder\(creds, \{ orderId: row\.order_id \}\)/, 'cancelled by the stored id, nothing else')
})
