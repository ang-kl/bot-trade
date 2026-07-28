// node --test agent/services/profit-ratchet.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  DEFAULT_PROFIT_RATCHET, loadProfitRatchetConfig, autoStepUsd, computeFloor, runProfitRatchet,
} from './profit-ratchet.js'

function freshDB(balance = 48000) {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', String(balance))
  setState(db, 'autotrade_enabled', 'true')
  return db
}
const CREDS = { ready: true, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: '42' }

function fakeDeps({ floating = 0, positions = [] } = {}) {
  const closed = []
  const notes = []
  return {
    closed, notes,
    ws: { wsGetUnrealizedPnl: async () => ({ 99: { net: floating } }) },
    exec: {
      reconcile: async () => ({ position: positions }),
      closePosition: async (creds, args) => { closed.push(args) },
    },
    notify: async (t) => { notes.push(t) },
  }
}

test('defaults: on, auto step, flatten at the floor', () => {
  const db = freshDB()
  assert.deepEqual(loadProfitRatchetConfig(db), DEFAULT_PROFIT_RATCHET)
  assert.equal(DEFAULT_PROFIT_RATCHET.floorAction, 'flatten')
})

test('autoStepUsd: 1% clamped to [25, 500]', () => {
  assert.equal(autoStepUsd(48000), 480)
  assert.equal(autoStepUsd(300), 25)      // owner: small accounts step carefully
  assert.equal(autoStepUsd(100000), 500)  // clamp cap
  assert.equal(autoStepUsd(0), null)
})

test('computeFloor: null before the first banked step, then one step behind hwm, never down', () => {
  assert.equal(computeFloor(48000, 48200, 500), null)   // no full step yet
  assert.equal(computeFloor(48000, 48500, 500), 48000)  // step 1 banked → protect baseline
  assert.equal(computeFloor(48000, 49020, 500), 48500)  // step 2 banked
  assert.equal(computeFloor(48000, 50000, 500), 49500)
})

test('staircase: floor initializes, rises with equity, and persists', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  // Pass 1: flat → baseline set, no floor yet.
  let r = await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 }))
  assert.equal(r.floor, null)
  // Pass 2: +600 floating → hwm 48600 → floor 48000, floor-up Telegram sent.
  const d2 = fakeDeps({ floating: 600 })
  r = await runProfitRatchet(db, CREDS, d2)
  assert.equal(r.floor, 48000)
  assert.match(d2.notes[0], /floor moved UP/)
  // Pass 3: gives back to +100 → floor UNCHANGED, no trigger.
  r = await runProfitRatchet(db, CREDS, fakeDeps({ floating: 100 }))
  assert.equal(r.floor, 48000)
  assert.equal(r.triggered, false)
  assert.equal(getState(db, 'autotrade_enabled'), 'true')
})

test('touching the floor: flattens bot positions, disarms autotrade, re-baselines', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  // Ledger: one bot position + one external (must NOT be closed).
  db.prepare(`INSERT INTO trades (id, symbol, status, ctrader_position_id) VALUES (1, 'EURUSD', 'open', '11')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, status, source) VALUES ('EURUSD', 1, 'active', 'autopilot')`).run()
  db.prepare(`INSERT INTO trades (id, symbol, status, ctrader_position_id) VALUES (2, 'GOOGL.US', 'open', '22')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, status, source) VALUES ('GOOGL.US', 2, 'active', 'external')`).run()

  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 }))    // baseline 48000
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 600 }))  // bank a step → floor 48000
  const d = fakeDeps({ floating: -50, positions: [{ positionId: 11, tradeData: { volume: 100 } }] })
  const r = await runProfitRatchet(db, CREDS, d)                  // equity 47950 ≤ floor
  assert.equal(r.triggered, true)
  assert.equal(r.closes, 1)
  assert.deepEqual(d.closed, [{ positionId: 11, volume: 100 }])   // external pid 22 untouched
  assert.equal(getState(db, 'autotrade_enabled'), 'false')
  assert.match(d.notes.at(-1), /TRIGGERED/)
  // Staircase re-baselined: next pass has no floor until a fresh step banks.
  const r2 = await runProfitRatchet(db, CREDS, fakeDeps({ floating: -50 }))
  assert.equal(r2.floor, null)
  assert.equal(r2.triggered, false)
})

test("floorAction 'halt': disarms entries but closes nothing", async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500, floorAction: 'halt' }))
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 }))    // baseline 48000
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 600 }))
  const d = fakeDeps({ floating: -100 })
  const r = await runProfitRatchet(db, CREDS, d)
  assert.equal(r.triggered, true)
  assert.equal(d.closed.length, 0)
  assert.equal(getState(db, 'autotrade_enabled'), 'false')
})

test('off / no balance → skipped', async () => {
  const db = freshDB()
  setState(db, 'profit_ratchet_json', JSON.stringify({ on: false }))
  assert.equal((await runProfitRatchet(db, CREDS, fakeDeps())).skipped, 'off_or_no_creds')
  const db2 = initDB(':memory:')
  assert.equal((await runProfitRatchet(db2, CREDS, fakeDeps())).skipped, 'no_balance')
})
