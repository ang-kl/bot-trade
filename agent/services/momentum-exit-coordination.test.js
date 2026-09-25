// node --test agent/services/momentum-exit-coordination.test.js
//
// T2 (V3 P0-1b): the other closers read the momentum partial plan before
// they close. The loss cap and the profit ratchet's flatten defer while a
// partial or rank close is in flight; the manual close, partial and reverse
// routes also refuse while the partial's outcome is ambiguous. With no plan
// (recordedPlans 0) every closer is unchanged — each test's control case.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import actionsRouter from '../routes/actions.js'
import { registerPartialPlan } from './momentum-partial-manager.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { runLossCap } from './loss-cap.js'
import { runProfitRatchet } from './profit-ratchet.js'
import { competingExitRefusal, IN_FLIGHT_EXIT_STATES, MANUAL_REFUSED_EXIT_STATES } from './momentum-exit-coordination.js'
import { ctraderEnvReport } from '../lib/ctrader-env.js'

const ACCT = '42'
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
const CREDS = { ready: true, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: ACCT }

function withPlan(db, state, positionId = '11') {
  registerPartialPlan(db, { accountId: ACCT, tradeId: 7, positionId, plan, evidenceId: 'fixture:7',
    identity: { host: 'demo.ctraderapi.com', accountId: ACCT, symbolId: '7' } })
  if (state) db.prepare('UPDATE momentum_partial_plans SET state=?').run(state)
}

test('the refusal rule: which states each kind of closer waits on', () => {
  const db = initDB(':memory:')
  assert.equal(competingExitRefusal(db, { accountId: ACCT, positionId: '11', states: MANUAL_REFUSED_EXIT_STATES }), null, 'no plan table')
  withPlan(db, 'ARMED')
  for (const state of ['ARMED', 'SENDING', 'AMBIGUOUS', 'RECEIVED', 'CONFIRMED', 'REJECTED', 'NOT_EXECUTED',
    'CLOSED_EXTERNALLY', 'VOLUME_CHANGED', 'RANK_RESERVED', 'RANK_SENDING', 'RANK_AMBIGUOUS', 'RANK_CONFIRMED']) {
    db.prepare('UPDATE momentum_partial_plans SET state=?').run(state)
    assert.equal(!!competingExitRefusal(db, { accountId: ACCT, positionId: '11', states: IN_FLIGHT_EXIT_STATES }),
      ['SENDING', 'RANK_SENDING'].includes(state), `protective ${state}`)
    assert.equal(!!competingExitRefusal(db, { accountId: ACCT, positionId: '11', states: MANUAL_REFUSED_EXIT_STATES }),
      ['SENDING', 'AMBIGUOUS', 'RANK_SENDING'].includes(state), `manual ${state}`)
  }
  db.prepare("UPDATE momentum_partial_plans SET state='SENDING'").run()
  assert.equal(competingExitRefusal(db, { accountId: '43', positionId: '11', states: IN_FLIGHT_EXIT_STATES }), null, 'another account')
  assert.equal(competingExitRefusal(db, { accountId: ACCT, positionId: '12', states: IN_FLIGHT_EXIT_STATES }), null, 'another position')
})

function lossCapDB() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, `acct:${ACCT}:account_balance_usd`, '10000')
  setState(db, 'symbol_id_map', JSON.stringify({ 'GOOGL.US': 7 }))
  return db
}
function lossCapDeps() {
  const closed = [], notes = []
  return { closed, notes,
    exec: { reconcile: async () => ({ position: [{ positionId: 11, tradeData: { symbolId: 7, tradeSide: 'BUY', volume: 10000 } }] }),
      closePosition: async (_c, args) => { closed.push(args) } },
    ws: { wsGetUnrealizedPnl: async () => ({ 11: { net: -900 } }) },
    notify: async text => { notes.push(text) } }
}

test('loss cap: a breach during an in-flight partial close is deferred this pass, closes after it; AMBIGUOUS does not block it', async () => {
  const control = lossCapDB(), c = lossCapDeps()
  assert.equal((await runLossCap(control, CREDS, c)).closes, 1, 'control: no plan, the cap closes')
  for (const state of IN_FLIGHT_EXIT_STATES) {
    const db = lossCapDB(); withPlan(db, state)
    const d = lossCapDeps()
    const r = await runLossCap(db, CREDS, d)
    assert.equal(d.closed.length, 0, state); assert.equal(r.closes, 0)
    assert.ok(r.errors.some(e => e.startsWith(`loss cap deferred: momentum partial plan ${state}`)), JSON.stringify(r.errors))
    // Not stamped as fired: the next pass, after the request ended, closes.
    db.prepare("UPDATE momentum_partial_plans SET state='AMBIGUOUS'").run()
    const next = lossCapDeps()
    assert.equal((await runLossCap(db, CREDS, next)).closes, 1, `${state} → AMBIGUOUS: the full close proceeds`)
    assert.deepEqual(next.closed[0], { positionId: 11, volume: 10000 })
  }
})

function ratchetDB(state) {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '48000')
  setState(db, `acct:${ACCT}:account_balance_usd`, '48000')
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, account_id)
     VALUES ('EURUSD', 'BUY', 1.1, 0.01, '11', 'autopilot', 'open', datetime('now'), ?)`).run(ACCT).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id)
     VALUES ('EURUSD', ?, 'long', 1.1, 1.09, 1.12, 't', 1, 'autopilot', 'active', ?)`).run(tradeId, ACCT)
  if (state) withPlan(db, state)
  return db
}
function ratchetDeps(floating) {
  const closed = []
  return { closed, now: 1_000_000_000, ws: { wsGetUnrealizedPnl: async () => ({ 11: { net: floating } }) },
    exec: { reconcile: async () => ({ position: [{ positionId: 11, tradeData: { volume: 10000 } }] }),
      closePosition: async (_c, args) => { closed.push(args) } },
    notify: async () => {} }
}
async function flatten(db) {
  await runProfitRatchet(db, CREDS, ratchetDeps(0))
  await runProfitRatchet(db, CREDS, ratchetDeps(600))
  let last, out
  for (let i = 0; i < 3; i++) { last = ratchetDeps(-100); out = await runProfitRatchet(db, CREDS, last) }
  return { closed: last.closed, out: out.accounts.find(a => String(a.accountId) === ACCT) }
}

test('profit ratchet: the floor flatten skips a position whose partial close is in flight, and says so', async () => {
  const control = await flatten(ratchetDB(null))
  assert.equal(control.closed.length, 1, 'control: no plan, flattened')
  for (const state of IN_FLIGHT_EXIT_STATES) {
    const { closed, out } = await flatten(ratchetDB(state))
    assert.equal(closed.length, 0, state)
    assert.ok(out.errors.some(e => /EURUSD: flatten skipped — momentum partial plan/.test(e)), JSON.stringify(out.errors))
  }
  const { closed } = await flatten(ratchetDB('AMBIGUOUS'))
  assert.equal(closed.length, 1, 'an ended request does not block the flatten')
})

async function app(t, db) {
  const a = express()
  a.use(express.json())
  a.use('/actions', actionsRouter(db))
  const srv = await new Promise(resolve => { const s = a.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(() => new Promise(r => srv.close(r)))
  return (path, body) => fetch(`http://127.0.0.1:${srv.address().port}/actions${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

// The position is recorded on the account, so both the body account and the
// position record resolve to it. No access token: past the refusal the route
// stops at "cTrader not connected" (400), before any broker call. The cTrader
// variables of the process environment are hidden for these tests, so a
// container that carries real credentials cannot turn a control case into a
// broker read.
function hideCtraderEnv(t) {
  const names = ctraderEnvReport().flatMap(r => r.names)
  const saved = Object.fromEntries(names.map(k => [k, process.env[k]]))
  for (const k of names) delete process.env[k]
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v })
}
function manualDB(state) {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, '1', 0, 1, 'active')`).run(ACCT)
  setState(db, 'ctrader_account_id', ACCT)
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, entry_price, volume, ctrader_position_id, account_id)
    VALUES ('GOOGL.US', 'BUY', 'open', datetime('now'), 100, 1, '11', ?)`).run(ACCT)
  if (state) withPlan(db, state)
  return db
}

test('manual routes: close, partial and reverse refuse (409) while the partial is SENDING, AMBIGUOUS or RANK_SENDING, before any broker call', async t => {
  hideCtraderEnv(t)
  for (const state of ['SENDING', 'AMBIGUOUS', 'RANK_SENDING']) {
    const post = await app(t, manualDB(state))
    for (const [path, body] of [['/position-close', { positionId: '11', account: ACCT }],
      ['/position-close', { positionId: '11', account: ACCT, lots: 0.26 }],
      ['/position-close', { positionId: '11' }],
      ['/position-reverse', { positionId: '11' }]]) {
      const res = await post(path, body)
      assert.equal(res.status, 409, `${state} ${path} ${JSON.stringify(body)}`)
      assert.match((await res.json()).error, new RegExp(`momentum partial plan ${state} on position 11`))
    }
  }
  // Every other state, and no plan, reaches the ordinary route.
  for (const state of [null, 'ARMED', 'CONFIRMED', 'NOT_EXECUTED', 'RANK_AMBIGUOUS']) {
    const post = await app(t, manualDB(state))
    for (const path of ['/position-close', '/position-reverse']) {
      const res = await post(path, { positionId: '11', account: ACCT })
      assert.equal(res.status, 400, `${state} ${path}`)
      assert.match((await res.json()).error, /not connected/)
    }
  }
})
