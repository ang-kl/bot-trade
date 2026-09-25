import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { MOMENTUM_TARGET_PRODUCERS } from '../services/momentum-entry-contract.js'
import { runMomentumPartialPass, MOMENTUM_PARTIAL_PASS_KEY } from '../services/momentum-partial-runtime.js'
import { registerPartialPlan } from '../services/momentum-partial-manager.js'
import { planMomentumTargets } from '../services/momentum-target-policy.js'

async function fixture(t) {
  const db = initDB(':memory:'), app = express()
  app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close() })
  return { db, get: async q => { const r = await fetch(`http://127.0.0.1:${server.address().port}/state/momentum-targets${q || ''}`); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') } } }
}

test('target status is read-only, explicit about absent plans, and requires an account or all', async t => {
  const { db, get } = await fixture(t)
  assert.equal((await get()).status, 400)
  const out = await get('?account=11')
  assert.equal(out.status, 200); assert.equal(out.cache, 'no-store')
  assert.equal(out.body.executionAuthorized, false)
  assert.equal(out.body.recordedPlans, 0); assert.deepEqual(out.body.rows, [])
  assert.equal(out.body.runtimeIntegration, 'INCOMPLETE')
  // V3 T3: why it is incomplete, named — no producer wired, no pass yet.
  assert.equal(out.body.passHeartbeatAt, null)
  assert.equal(out.body.pass.fresh, false)
  assert.match(out.body.pass.unavailable, /never run/)
  assert.deepEqual(Object.fromEntries(Object.entries(out.body.wiring).map(([k, w]) => [k, w.status])), { market: 'not wired', limit: 'not wired' })
  assert.equal(out.body.integrationGaps.length, 3)
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='momentum_target_intents'").get().n, 0)
})

test('target status keeps pending and damaged records visible without crediting another account', async t => {
  const { db, get } = await fixture(t)
  db.exec(`CREATE TABLE momentum_target_intents(account_id TEXT, trade_id INTEGER, risk_event_id INTEGER,
    proposal_json TEXT, created_at_ms INTEGER, state TEXT, position_id TEXT, plan_json TEXT, fill_json TEXT)`)
  const add = db.prepare('INSERT INTO momentum_target_intents VALUES(?,?,1,?,1790264000000,?,NULL,NULL,NULL)')
  add.run('11', 1, '{bad', 'PREPARED'); add.run('22', 2, '{}', 'ENROLLED')
  setState(db, 'ctrader_account_id', '11')
  const out = await get()
  assert.equal(out.status, 200); assert.equal(out.body.accountId, '11')
  assert.equal(out.body.recordedPlans, 1); assert.deepEqual(out.body.rows.map(r => r.tradeId), [1])
  assert.equal(out.body.rows[0].evidenceValid, false)
  assert.equal(out.body.rows[0].state, 'PREPARED')
  const all = await get('?account=all&limit=1')
  assert.equal(all.body.recordedPlans, 2); assert.equal(all.body.rows.length, 1)
  assert.equal(all.body.truncated, true)
})

test('target status fails explicitly when the stored schema cannot be read', async t => {
  const { db, get } = await fixture(t)
  db.exec('CREATE TABLE momentum_target_intents(wrong_column TEXT)')
  const out = await get('?account=11')
  assert.equal(out.status, 503); assert.equal(out.body.code, 'momentum_target_status_unavailable')
})

// ---------------------------------------------------------------------------
// V3 T3: the status reports whether the partial manager's pass runs, per
// producer whether anything feeds it, and never COMPLETE before both.
// ---------------------------------------------------------------------------
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })

test('a running pass is reported by its heartbeat, a stale one as unavailable, and neither makes the runtime COMPLETE', async t => {
  const { db, get } = await fixture(t)
  await runMomentumPartialPass(db, { now: () => Date.now() - 60_000 })
  const fresh = await get('?account=11')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.passHeartbeatAt, JSON.parse(db.prepare("SELECT value FROM agent_state WHERE key=?").get(MOMENTUM_PARTIAL_PASS_KEY).value).at)
  assert.equal(fresh.body.pass.fresh, true); assert.equal(fresh.body.pass.unavailable, null)
  assert.equal(fresh.body.runtimeIntegration, 'INCOMPLETE', 'a running pass with no producer feeding it is not a complete runtime')
  assert.equal(fresh.body.integrationGaps.length, 2)
  assert.equal(fresh.body.executionAuthorized, false)
  setState(db, MOMENTUM_PARTIAL_PASS_KEY, JSON.stringify({ at: new Date(Date.now() - 16 * 60_000).toISOString(), ok: true, accounts: {} }))
  const stale = await get('?account=11')
  assert.equal(stale.body.pass.fresh, false)
  assert.match(stale.body.pass.unavailable, /stale: last pass .*16 min ago \(limit 15 min\)/)
  assert.equal(stale.body.integrationGaps.length, 3)
})

test('rows carry the partial target and the partial attempt, scoped to their own account', async t => {
  const { db, get } = await fixture(t)
  db.exec(`CREATE TABLE momentum_target_intents(account_id TEXT, trade_id INTEGER, risk_event_id INTEGER,
    proposal_json TEXT, created_at_ms INTEGER, state TEXT, position_id TEXT, plan_json TEXT, fill_json TEXT)`)
  const add = db.prepare('INSERT INTO momentum_target_intents VALUES(?,?,1,?,1790264000000,?,?,?,NULL)')
  add.run('11', 7, '{}', 'ENROLLED', '33', JSON.stringify(plan)); add.run('22', 8, '{}', 'ENROLLED', '34', JSON.stringify(plan))
  for (const [a, tr, pid] of [['11', 7, '33'], ['22', 8, '34']]) {
    registerPartialPlan(db, { accountId: a, tradeId: tr, positionId: pid, plan, evidenceId: `f:${tr}`, identity: { host: 'demo.ctraderapi.com', accountId: a, symbolId: '22' } })
  }
  db.prepare("UPDATE momentum_partial_plans SET state='SENDING', attempted_at=5, order_id='77' WHERE account_id='22'").run()
  setState(db, MOMENTUM_PARTIAL_PASS_KEY, JSON.stringify({ at: new Date().toISOString(), ok: true, activePlans: 2,
    accounts: { 11: { plans: 1, checked: 1 }, 22: { plans: 1, checked: 1, error: null } }, lastCheckAt: { '11|7': 123, '22|8': 456 } }))
  const one = await get('?account=11')
  assert.deepEqual(one.body.rows.map(r => r.tradeId), [7])
  const [r] = one.body.rows
  assert.deepEqual(r.target, { side: 'BUY', entry: 100, trigger: 130.4, runnerTarget: plan.brokerTarget, closeVolume: plan.closeVolume,
    volume: 10000, closePercentage: plan.closePercentage, digits: 2 })
  assert.equal(r.partial.state, 'ARMED'); assert.equal(r.partial.lastCheckAtMs, 123)
  assert.deepEqual(one.body.pass.account, { plans: 1, checked: 1 }, 'the scoped pass line is this account\'s only')
  assert.equal(one.body.pass.accounts, undefined)
  assert.deepEqual(one.body.partialPlans, { ARMED: 1 })
  const all = await get('?account=all')
  const other = all.body.rows.find(x => x.accountId === '22')
  assert.deepEqual([other.partial.state, other.partial.orderId, other.partial.attemptedAtMs, other.partial.lastCheckAtMs], ['SENDING', '77', 5, 456])
  assert.deepEqual(all.body.partialPlans, { ARMED: 1, SENDING: 1 })
})

// A producer that records target intents is the only thing that can make the
// wiring "wired". Pinned to the code: while no production file calls
// recordMomentumEntry, both producers must say "not wired"; the first call
// T4 adds turns this red until MOMENTUM_TARGET_PRODUCERS is updated with it.
test('producer wiring is pinned to the code: no production caller of recordMomentumEntry, so nothing is wired', () => {
  const agentDir = fileURLToPath(new URL('..', import.meta.url))
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(p)
    }
  }
  walk(agentDir)
  assert.ok(files.length > 100, `scanned ${files.length} files`)
  const callers = files.filter(f => !f.endsWith('momentum-entry-contract.js') && /\brecordMomentumEntry\s*\(/.test(strip(readFileSync(f, 'utf8'))))
    .map(f => relative(agentDir, f))
  assert.deepEqual(callers, [], 'a producer now records target intents: update MOMENTUM_TARGET_PRODUCERS (and this pin) in the same change')
  assert.equal(MOMENTUM_TARGET_PRODUCERS.market.wired, false)
  assert.equal(MOMENTUM_TARGET_PRODUCERS.limit.wired, false)
})
