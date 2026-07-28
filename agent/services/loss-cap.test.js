// node --test agent/services/loss-cap.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { DEFAULT_LOSS_CAP, loadLossCapConfig, effectiveCapUsd, runLossCap } from './loss-cap.js'

function freshDB() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'symbol_id_map', JSON.stringify({ 'GOOGL.US': 7, EURUSD: 1 }))
  return db
}

const CREDS = { ready: true, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '42' }

function fakeDeps({ positions, pnl }) {
  const closed = []
  const notes = []
  return {
    closed, notes,
    exec: {
      reconcile: async () => ({ position: positions }),
      closePosition: async (creds, args) => { closed.push(args) },
    },
    ws: { wsGetUnrealizedPnl: async () => pnl },
    notify: async (text) => { notes.push(text) },
  }
}

const GOOGL = { positionId: 11, tradeData: { symbolId: 7, tradeSide: 'BUY', volume: 100 } }

test('defaults: on, both cap shapes present, % cap 2, action close', () => {
  const db = freshDB()
  assert.deepEqual(loadLossCapConfig(db), DEFAULT_LOSS_CAP)
  assert.equal(DEFAULT_LOSS_CAP.on, true)
  assert.equal(DEFAULT_LOSS_CAP.maxLossPctOfBalance, 2)
  assert.equal(DEFAULT_LOSS_CAP.maxLossUsd, null)
  assert.equal(DEFAULT_LOSS_CAP.action, 'close')
})

test('effectiveCapUsd: tighter of $ and % applies; null when both off', () => {
  assert.equal(effectiveCapUsd({ maxLossUsd: 500, maxLossPctOfBalance: 2 }, 10000), 200)
  assert.equal(effectiveCapUsd({ maxLossUsd: 150, maxLossPctOfBalance: 2 }, 10000), 150)
  assert.equal(effectiveCapUsd({ maxLossUsd: 500, maxLossPctOfBalance: null }, 10000), 500)
  assert.equal(effectiveCapUsd({ maxLossUsd: null, maxLossPctOfBalance: 2 }, null), null) // % cap never guesses without a balance
  assert.equal(effectiveCapUsd({ maxLossUsd: null, maxLossPctOfBalance: null }, 10000), null)
})

test('breach closes the position, records the event, and notifies', async () => {
  const db = freshDB() // 2% of 10000 → $200 cap
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.breaches, 1)
  assert.equal(r.closes, 1)
  assert.deepEqual(deps.closed[0], { positionId: 11, volume: 100 })
  assert.match(deps.notes[0], /CLOSED GOOGL\.US BUY/)
  const ev = db.prepare(`SELECT * FROM position_events WHERE kind = 'loss_cap_close'`).get()
  assert.ok(ev)
  assert.match(ev.reason, /breached/)
})

test('inside the cap → no action', async () => {
  const db = freshDB()
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -150 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.checked, 1)
  assert.equal(r.breaches, 0)
  assert.equal(deps.closed.length, 0)
})

test('alert-only mode notifies without closing', async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ action: 'alert' }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.breaches, 1)
  assert.equal(r.closes, 0)
  assert.equal(deps.closed.length, 0)
  assert.match(deps.notes[0], /alert-only/)
})

test('retry guard: a breach does not re-fire inside retryMinutes', async () => {
  const db = freshDB()
  const t0 = Date.now()
  const deps1 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  await runLossCap(db, CREDS, { ...deps1, now: t0 })
  const deps2 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r2 = await runLossCap(db, CREDS, { ...deps2, now: t0 + 5 * 60_000 })
  assert.equal(r2.breaches, 1)
  assert.equal(deps2.closed.length, 0) // suppressed — inside the 10-min retry window
  const deps3 = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r3 = await runLossCap(db, CREDS, { ...deps3, now: t0 + 11 * 60_000 })
  assert.equal(r3.closes, 1) // past the window → retried
})

test("scope 'bot' skips positions not in the ledger", async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ scope: 'bot' }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.checked, 0) // pid 11 has no monitored_positions/trades row
  assert.equal(deps.closed.length, 0)
})

test('off switch and missing creds are no-ops', async () => {
  const db = freshDB()
  setState(db, 'loss_cap_json', JSON.stringify({ on: false }))
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  assert.deepEqual(await runLossCap(db, CREDS, deps), { checked: 0, breaches: 0, closes: 0, errors: [] })
  const db2 = freshDB()
  assert.deepEqual(await runLossCap(db2, { ready: false }, deps), { checked: 0, breaches: 0, closes: 0, errors: [] })
})

test('close failure lands in errors and notifies for manual action', async () => {
  const db = freshDB()
  const deps = fakeDeps({ positions: [GOOGL], pnl: { 11: { net: -900 } } })
  deps.exec.closePosition = async () => { throw new Error('MARKET_CLOSED') }
  const r = await runLossCap(db, CREDS, deps)
  assert.equal(r.closes, 0)
  assert.equal(r.errors.length, 1)
  assert.match(deps.notes[0], /FAILED to close/)
})
