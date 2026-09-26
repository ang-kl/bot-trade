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
  // V3 T4: the market producer is wired, and switched OFF by the repo's
  // config (OD-1 unanswered): wired is not on, and the runtime stays
  // INCOMPLETE with the switch named as the gap.
  assert.deepEqual(Object.fromEntries(Object.entries(out.body.wiring).map(([k, w]) => [k, w.status])), { market: 'wired', limit: 'not wired' })
  assert.deepEqual([out.body.wiring.market.enabled, out.body.wiring.market.switch], [false, 'off'])
  assert.deepEqual([out.body.wiring.limit.enabled, out.body.wiring.limit.switch], [false, null])
  assert.ok(out.body.integrationGaps.some(g => /^market: wired, switched off .*OD-1/.test(g)), JSON.stringify(out.body.integrationGaps))
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

// T3 checker BLOCKER 2: a fresh pass whose record says it could not act on an
// account (here: no credentials) must not let that account's triggers read as
// armed. Driven by the real pass, not a hand-written record.
test('a fresh pass that could not act on an account reports its triggers unavailable there, per row, and names the gap', async t => {
  const { db, get } = await fixture(t)
  db.exec(`CREATE TABLE momentum_target_intents(account_id TEXT, trade_id INTEGER, risk_event_id INTEGER,
    proposal_json TEXT, created_at_ms INTEGER, state TEXT, position_id TEXT, plan_json TEXT, fill_json TEXT)`)
  const add = db.prepare('INSERT INTO momentum_target_intents VALUES(?,?,1,?,1790264000000,?,?,?,NULL)')
  for (const [a, tr, pid] of [['11', 7, '33'], ['22', 8, '34']]) {
    add.run(a, tr, '{}', 'ENROLLED', pid, JSON.stringify(plan))
    registerPartialPlan(db, { accountId: a, tradeId: tr, positionId: pid, plan, evidenceId: `f:${tr}`, identity: { host: 'demo.ctraderapi.com', accountId: a, symbolId: '22' } })
  }
  let adapters = 0
  const out = await runMomentumPartialPass(db, {
    credsFor: id => id === '11' ? null : { accountId: id, host: 'demo.ctraderapi.com', ready: true },
    now: () => Date.now() - 60_000, deps: { adapterFor: () => { adapters++; throw Error('no broker in this test') } } })
  assert.equal(out.accounts['11'].error, 'no_credentials'); assert.equal(out.accounts['22'].error, null)
  assert.equal(adapters, 1, 'only …22 reached the broker step')
  const one = await get('?account=11')
  assert.equal(one.body.pass.fresh, true, 'the pass itself is running')
  assert.equal(one.body.pass.available, false)
  assert.equal(one.body.pass.accountError, 'no_credentials')
  assert.match(one.body.pass.unavailable, /could not act on this account — no_credentials/)
  assert.match(one.body.rows[0].passUnavailable, /no_credentials/)
  assert.ok(one.body.integrationGaps.some(g => /no_credentials/.test(g)), JSON.stringify(one.body.integrationGaps))
  const two = await get('?account=22')
  assert.equal(two.body.pass.available, true); assert.equal(two.body.pass.unavailable, null)
  assert.equal(two.body.rows[0].passUnavailable, null)
  const all = await get('?account=all')
  assert.equal(all.body.pass.available, true)
  const byAccount = Object.fromEntries(all.body.rows.map(r => [r.accountId, r.passUnavailable]))
  assert.match(byAccount['11'], /no_credentials/); assert.equal(byAccount['22'], null)
  assert.ok(all.body.integrationGaps.some(g => /^account 11: .*no_credentials/.test(g)), JSON.stringify(all.body.integrationGaps))
})

// A producer that records target intents is the only thing that can make the
// wiring "wired". Pinned to the code (V3 T4): the market producer is wired
// because exactly one production file, loop.js, calls recordMomentumEntry,
// and it does so inside autoTrade's market path, in the transaction that
// writes the submitting trade. No resting path calls it, so `limit` stays
// "not wired"; a new caller turns this red until MOMENTUM_TARGET_PRODUCERS
// and this pin are updated in the same change.
test('producer wiring is pinned to the code: the market path records target intents, no resting path does', () => {
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
  assert.deepEqual(callers, ['loop.js'], 'a new producer records target intents: update MOMENTUM_TARGET_PRODUCERS (and this pin) in the same change')
  const loop = strip(readFileSync(join(agentDir, 'loop.js'), 'utf8'))
  const start = loop.indexOf('export async function autoTrade('), end = loop.indexOf('\nexport ', start + 1)
  const body = loop.slice(start, end)
  const call = body.indexOf('recordMomentumEntry(db, {')
  assert.ok(start > 0 && call > 0, 'the call is inside autoTrade')
  assert.equal(loop.split('recordMomentumEntry(').length - 1, 1, 'one call site')
  // Inside the transaction that inserts the submitting trade, and before the send.
  const tx = body.lastIndexOf('intentId = db.transaction(() => {', call)
  assert.ok(tx > 0 && body.indexOf('insertIntent()', tx) < call, 'the INSERT and the intent share one transaction')
  assert.ok(call < body.indexOf('execPlaceOrder('), 'the intent is recorded before the order is sent')
  // On the market path only: after the closed-market and HTF-limit refusals.
  assert.ok(body.indexOf('closedMarketMomentumRefusal(') < call && body.indexOf('restingMomentumRefusal(') < call)
  assert.equal(MOMENTUM_TARGET_PRODUCERS.market.wired, true)
  assert.equal(MOMENTUM_TARGET_PRODUCERS.limit.wired, false)
})
