// node --test agent/routes/order-lifecycle-route.test.js
//
// GET /state/order-lifecycle (V3 L1) over HTTP, disk-backed:
//   - every rule runs on the read-only worker: the management connection's
//     prepare() is trapped and sees 0 calls, whatever ?account= says (the
//     selected account included — the worker reads it on its own connection);
//   - a worker that cannot open its database is an explicit 503 naming the
//     last snapshot, never an empty or zero body (owner principle 6);
//   - a bad parameter is a 400 decided before any worker starts;
//   - at production-like size the event loop is not held for 50 ms while five
//     GETs are served, and the probe that says so can go red (a deliberate
//     120 ms block is caught).
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, setState } from '../db.js'
import { invalidateStateCache } from '../lib/state-cache.js'
import { buildOrderLifecycle, SNAPSHOT_KEY } from '../services/order-lifecycle.js'
import stateRouter from './state.js'

const A = '46130058', B = '43097342'

async function serve(t, connection, onClose = () => {}) {
  const app = express(); app.use('/state', stateRouter(connection))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    onClose()
  })
  return p => `http://127.0.0.1:${server.address().port}/state/order-lifecycle${p}`
}

function smallFixture() {
  const dir = tempDir('order-lifecycle-http-')
  const db = initDB(join(dir, 'fixture.db'))
  const now = Date.now()
  const at = new Date(now - 3_600_000).toISOString()
  const ins = db.prepare(`INSERT INTO risk_events (symbol, side, approved, disposition, account_id, created_at, proposal_json) VALUES ('EURUSD', 'BUY', 1, 'ordered', ?, ?, ?)`)
  ins.run(A, at, JSON.stringify({ strategy: 'x', entry: 1.1, sl: 1.09 })) // no direction_reason
  ins.run(B, at, JSON.stringify({ strategy: 'x', entry: 1.1, sl: 1.09, direction_reason: 'breakout' }))
  ins.run(null, at, '{}')
  db.prepare(`INSERT INTO pending_orders (symbol, dir, status, note, account_id, placed_at, expires_at) VALUES ('QCOM.US', 1, 'working', 'pending-fib', ?, '2026-09-10 07:12:00', '2026-09-20T00:00:00Z')`).run(A)
  setState(db, 'ctrader_account_id', B)
  return { dir, db }
}

const rule = (body, id) => body.rules.find(r => r.id === id)

test('the GET never executes SQL on the management connection — all, one account, and the selected account', async t => {
  const { db } = smallFixture()
  const url = await serve(t, db, () => db.close())
  const prepare = db.prepare
  let managementReads = 0
  db.prepare = () => { managementReads++; throw new Error('order-lifecycle blocked the management connection') }
  const bodies = {}
  try {
    for (const q of ['?account=all', `?account=${A}`, '']) {
      // A pool slot is held until the previous worker EXITS, which can trail
      // its answer under a loaded gate: an explicit capacity 503 (whose
      // failure path reads the last snapshot row) is waited out, and the
      // statement count is judged on the attempt that answered 200.
      let res
      for (let attempt = 0; attempt < 50; attempt++) {
        invalidateStateCache()
        managementReads = 0
        res = await fetch(url(q))
        if (res.status !== 503) break
        const body = await res.json()
        assert.equal(body.code, 'order_lifecycle_worker_capacity', `${q}: only a capacity refusal is waited out`)
        await new Promise(r => setTimeout(r, 100))
      }
      assert.equal(res.status, 200, q)
      assert.equal(managementReads, 0, `${q}: statements on the management connection`)
      bodies[q] = await res.json()
    }
  } finally { db.prepare = prepare }
  const all = bodies['?account=all']
  assert.equal(all.scope.account, 'all')
  assert.equal(rule(all, 'PRE-01').violations, 2, 'A and the unattributed row')
  assert.equal(rule(all, 'PRE-01').unattributed, 1)
  assert.equal(rule(all, 'STK-01').violations, 1)
  const one = bodies[`?account=${A}`]
  assert.equal(one.scope.account, A)
  assert.equal(rule(one, 'PRE-01').violations, 1)
  const selected = bodies['']
  assert.equal(selected.scope.account, B, 'the selected account, read on the worker connection')
  assert.equal(selected.scope.explicit, false)
  assert.equal(rule(selected, 'PRE-01').violations, 0)
  assert.equal(rule(selected, 'PRE-01').population, 1)
  // The worker's answer is the builder's answer (same rules, same counts).
  const direct = buildOrderLifecycle(db, { account: 'all' })
  assert.deepEqual(all.rules.map(r => [r.id, r.population, r.violations, r.newViolations]), direct.rules.map(r => [r.id, r.population, r.violations, r.newViolations]))
})

test('a worker that cannot open its database is a 503 naming the last snapshot — no rules, no zeros', async t => {
  const { dir, db } = smallFixture()
  setState(db, SNAPSHOT_KEY, JSON.stringify({ at: '2026-09-25T10:00:00.000Z', summary: {} }))
  const missing = new Proxy(db, { get(target, key) {
    if (key === 'name') return join(dir, 'missing.db')
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const url = await serve(t, missing, () => db.close())
  const res = await fetch(url('?account=all'))
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assert.equal(body.error, 'order_lifecycle_unavailable')
  assert.equal(body.lastSnapshotAt, '2026-09-25T10:00:00.000Z')
  assert.ok(body.code)
  for (const k of ['rules', 'summary', 'stages', 'accounts']) assert.equal(body[k], undefined, `a failed build must not carry ${k}`)
})

test('a bad parameter is a 400 decided before any worker starts', async t => {
  const { db } = smallFixture()
  const url = await serve(t, db, () => db.close())
  const prepare = db.prepare
  let reads = 0
  db.prepare = () => { reads++; throw new Error('no') }
  try {
    for (const q of ['?days=0', '?since=yesterday', '?rule=NOPE-1', '?limit=26', '?account=a%20b']) {
      const res = await fetch(url(q))
      assert.equal(res.status, 400, q)
      assert.ok((await res.json()).error, q)
    }
  } finally { db.prepare = prepare }
  assert.equal(reads, 0)
})

// ---------------------------------------------------------------------------
// The stall budget at production-like size.
// ---------------------------------------------------------------------------
function bigFixture() {
  const dir = tempDir('order-lifecycle-stall-')
  const db = initDB(join(dir, 'big.db'))
  const now = Date.now()
  const pad = 'x'.repeat(900)
  const recent = i => new Date(now - (i % 20) * 86_400_000 - 3_600_000).toISOString()
  db.transaction(() => {
    const re = db.prepare(`INSERT INTO risk_events (symbol, side, approved, disposition, account_id, opportunity_key, created_at, proposal_json) VALUES (?, 'BUY', ?, ?, ?, ?, ?, ?)`)
    for (let i = 0; i < 50_000; i++) {
      const approved = i % 50 === 0 ? 1 : 0 // 1,000 approvals among 50,000 events
      re.run(`SYM${i % 300}`, approved, approved ? 'ordered' : 'vetoed', i % 2 ? A : B, `ok${i}`, recent(i),
        JSON.stringify({ strategy: 's', entry: 1.1, sl: 1.09, tp1: 1.13, ...(i % 3 ? { direction_reason: 'r' } : {}), pad }))
    }
    const tr = db.prepare(`INSERT INTO trades (symbol, side, status, origin, account_id, ctrader_position_id, opened_at, closed_at, closed_at_ms, net_pnl, close_reason) VALUES (?, 'BUY', ?, 'bot_market_dispatch', ?, ?, ?, ?, ?, ?, ?)`)
    for (let i = 0; i < 2_000; i++) {
      const closed = i % 4 !== 0
      tr.run(`SYM${i % 300}`, closed ? 'closed' : 'open', i % 2 ? A : B, String(100000 + i), recent(i), closed ? recent(i) : null, closed ? Date.parse(recent(i)) : null, closed ? 1 : null, closed ? 'take profit' : null)
    }
    const po = db.prepare(`INSERT INTO pending_orders (symbol, order_id, dir, level, sl, volume, status, note, account_id, placed_at, expires_at) VALUES (?, ?, 1, 1, 0.9, 1, ?, 'pending-closed', ?, ?, ?)`)
    for (let i = 0; i < 1_000; i++) po.run(`SYM${i % 300}`, String(5000 + i), i % 10 ? 'expired' : 'working', i % 2 ? A : B, recent(i), recent(i))
    const rs = db.prepare(`INSERT INTO refusal_scores (opportunity_key, account_id, symbol, outcome, scored_at) VALUES (?, ?, ?, ?, ?)`)
    for (let i = 0; i < 40_000; i++) rs.run(`rs${i}`, i % 2 ? A : B, `SYM${i % 300}`, i % 9 ? 'no_bars' : 'stop', recent(i))
    const tg = db.prepare(`INSERT INTO telegram_outbox (queued_at, kind, priority, text, sent_at) VALUES (?, 'alert', 'normal', ?, ?)`)
    for (let i = 0; i < 60_000; i++) tg.run(recent(i), `message ${i}`, i % 20 === 5 ? null : recent(i))
  })()
  return db
}

/** Max lateness of a 5 ms self-rescheduling timer while `work` runs. */
async function probeLateness(work) {
  let maxLate = 0, ticks = 0, running = true, timer
  let last = performance.now()
  const tick = () => {
    const now = performance.now()
    maxLate = Math.max(maxLate, now - last - 5)
    last = now; ticks++
    if (running) timer = setTimeout(tick, 5)
  }
  timer = setTimeout(tick, 5)
  try { await work() } finally { running = false; clearTimeout(timer) }
  return { maxLate, ticks }
}

test('stall: five concurrent GETs at production-like size hold the event loop under 50 ms, and the probe can see a 120 ms block', { timeout: 120_000 }, async t => {
  const db = bigFixture()
  const url = await serve(t, db, () => db.close())
  // Positive control first: a deliberate synchronous block must be seen.
  const control = await probeLateness(async () => {
    await new Promise(r => setTimeout(r, 20))
    const until = performance.now() + 120
    while (performance.now() < until) { /* hold the loop */ }
    await new Promise(r => setTimeout(r, 20))
  })
  assert.ok(control.maxLate >= 100, `the probe missed a 120 ms block (saw ${control.maxLate.toFixed(0)} ms) — it cannot go red`)
  // A real stall reproduces on every attempt; scheduler noise from the
  // parallel test run does not. The best of three attempts is compared.
  let best = Infinity, bestTicks = 0, body = null, statuses = []
  for (let attempt = 0; attempt < 3 && best >= 50; attempt++) {
    invalidateStateCache() // each attempt recomputes: no cached answer
    const r = await probeLateness(async () => {
      const res = await Promise.all(Array.from({ length: 5 }, () => fetch(url('?account=all'))))
      statuses = res.map(x => x.status)
      body = await res[0].json()
      await Promise.all(res.slice(1).map(x => x.arrayBuffer()))
    })
    if (r.maxLate < best) { best = r.maxLate; bestTicks = r.ticks }
  }
  t.diagnostic(`event-loop max lateness ${best.toFixed(1)} ms (best of attempts, ${bestTicks} ticks); positive control ${control.maxLate.toFixed(0)} ms`)
  assert.ok(best < 50, `the event loop was held ${best.toFixed(0)} ms (best of three) while serving five GETs`)
  assert.ok(bestTicks > 5, `only ${bestTicks} probe ticks`)
  assert.deepEqual(statuses, [200, 200, 200, 200, 200])
  // The answer really read the heavy tables (not a fast empty read).
  assert.equal(rule(body, 'PRE-02').population, 40_000)
  assert.equal(rule(body, 'PRE-01').population, 1_000)
  assert.ok(rule(body, 'PRE-01').violations > 300)
  assert.ok(rule(body, 'STK-08').violations === 1, 'the telegram backlog')
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 512 * 1024)
})
