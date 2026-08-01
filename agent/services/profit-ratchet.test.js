// node --test agent/services/profit-ratchet.test.js — Ratchet v2.
//
// The claims under test are v2's design promises (owner 01-08, "build v2"):
// per-account staircases, a soft warning stage before any action, hysteresis
// on the hard floor, per-account halt that NEVER touches the S.A.T. keys,
// auto re-arm on sustained recovery, and [Keep off] disabling it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import {
  DEFAULT_PROFIT_RATCHET, loadProfitRatchetConfig, autoStepUsd, computeFloor,
  runProfitRatchet, ratchetGate, rearmRatchet, keepRatchetOff, haltKey, softKey,
} from './profit-ratchet.js'

const ACCT = '42'
function freshDB(balance = 48000) {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', String(balance))
  setState(db, 'autotrade_enabled', 'true')
  return db
}
const CREDS = { ready: true, host: 'h', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: ACCT }

function fakeDeps({ floating = 0, positions = [], now = 1_000_000_000 } = {}) {
  const closed = []
  const notes = []
  return {
    closed, notes, now,
    ws: { wsGetUnrealizedPnl: async () => ({ 99: { net: floating } }) },
    exec: {
      reconcile: async () => ({ position: positions }),
      closePosition: async (creds, args) => { closed.push(args) },
    },
    notify: async (t, opts) => { notes.push({ t, opts }) },
  }
}
const acct = (r) => r.accounts.find(a => String(a.accountId) === ACCT)

/** Advance to a banked step: baseline pass, then +600 → floor at baseline. */
async function bankAStep(db) {
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 }))
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 600 }))
}
/** Drive equity to/below the floor for `n` consecutive reads. */
async function breach(db, n, { floating = -50, positions = [] } = {}) {
  let last = null
  for (let i = 0; i < n; i++) {
    last = fakeDeps({ floating, positions })
    await runProfitRatchet(db, CREDS, last)
  }
  return last
}

test('defaults: on, auto step, flatten, soft band, 3-read hysteresis, auto re-arm', () => {
  const db = freshDB()
  assert.deepEqual(loadProfitRatchetConfig(db), DEFAULT_PROFIT_RATCHET)
  assert.equal(DEFAULT_PROFIT_RATCHET.floorAction, 'flatten')
  assert.equal(DEFAULT_PROFIT_RATCHET.confirmReads, 3)
  assert.equal(DEFAULT_PROFIT_RATCHET.autoRearm, true)
})

test('autoStepUsd: 1% clamped to [25, 500]', () => {
  assert.equal(autoStepUsd(48000), 480)
  assert.equal(autoStepUsd(300), 25)
  assert.equal(autoStepUsd(100000), 500)
  assert.equal(autoStepUsd(0), null)
})

test('computeFloor: null before the first banked step, then one step behind hwm, never down', () => {
  assert.equal(computeFloor(48000, 48200, 500), null)
  assert.equal(computeFloor(48000, 48500, 500), 48000)
  assert.equal(computeFloor(48000, 49020, 500), 48500)
  assert.equal(computeFloor(48000, 50000, 500), 49500)
})

test('staircase per account: floor initializes, rises, persists — switches untouched', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  let r = acct(await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 })))
  assert.equal(r.floor, null)
  const d2 = fakeDeps({ floating: 600 })
  r = acct(await runProfitRatchet(db, CREDS, d2))
  assert.equal(r.floor, 48000)
  assert.match(d2.notes[0].t, /floor moved UP/)
  assert.match(d2.notes[0].t, /account 42/)
  r = acct(await runProfitRatchet(db, CREDS, fakeDeps({ floating: 400 })))
  assert.equal(r.floor, 48000)
  assert.equal(r.triggered, false)
  assert.equal(getState(db, 'autotrade_enabled'), 'true')
})

test('STAGE 1: inside the warning band — entries pause, one warning, nothing closed', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  await bankAStep(db) // floor 48000, soft band 250
  const d = fakeDeps({ floating: 100 }) // equity 48100 ∈ (48000, 48250]
  const r = acct(await runProfitRatchet(db, CREDS, d))
  assert.equal(r.stage, 'soft')
  assert.equal(r.triggered, false)
  assert.equal(d.closed.length, 0)
  assert.match(d.notes[0].t, /warning/)
  assert.equal(ratchetGate(db, ACCT).blocked, true)
  assert.equal(ratchetGate(db, ACCT).stage, 'soft')
  // Same band next read → NO second warning (once per floor level).
  const d2 = fakeDeps({ floating: 120 })
  acct(await runProfitRatchet(db, CREDS, d2))
  assert.equal(d2.notes.length, 0)
  // Recovery above the band clears the pause on its own.
  acct(await runProfitRatchet(db, CREDS, fakeDeps({ floating: 400 })))
  assert.equal(ratchetGate(db, ACCT).blocked, false)
})

test('HYSTERESIS: one or two breaching reads do NOT trigger; the third does', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  db.prepare(`INSERT INTO trades (id, symbol, status, ctrader_position_id) VALUES (1, 'EURUSD', 'open', '11')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, status, source, account_id) VALUES ('EURUSD', 1, 'active', 'autopilot', '42')`).run()
  db.prepare(`INSERT INTO trades (id, symbol, status, ctrader_position_id) VALUES (2, 'GOOGL.US', 'open', '22')`).run()
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, status, source, account_id) VALUES ('GOOGL.US', 2, 'active', 'external', '42')`).run()
  await bankAStep(db)

  await breach(db, 1)
  assert.equal(getState(db, haltKey(ACCT)), null, 'read 1: no halt')
  await breach(db, 1)
  assert.equal(getState(db, haltKey(ACCT)) === 'true', false, 'read 2: still no halt')
  assert.equal(ratchetGate(db, ACCT).blocked, true, 'but entries are already paused while confirming')
  assert.equal(getState(db, 'autotrade_enabled'), 'true')

  const d = await breach(db, 1, { positions: [{ positionId: 11, tradeData: { volume: 100 } }] })
  const halted = getState(db, haltKey(ACCT))
  assert.equal(halted, 'true', 'read 3: confirmed → halt')
  assert.deepEqual(d.closed, [{ positionId: 11, volume: 100 }], 'only THIS account\'s bot position closed; external untouched')
  assert.match(d.notes.at(-1).t, /TRIGGERED on account 42/)
  assert.ok(d.notes.at(-1).opts.buttons[0].some(b => b.callback_data === 'ratchetarm|42'), 'alert carries the Re-arm button')
  // THE IRONCLAD PROMISE: the S.A.T. keys were never written.
  assert.equal(getState(db, 'autotrade_enabled'), 'true')
  assert.equal(getState(db, 'acct:42:autotrade_enabled'), null)
})

test('a single spike between good reads resets the streak', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  await bankAStep(db)
  await breach(db, 2)                                          // 2 of 3
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 400 })) // recovers
  await breach(db, 2)                                          // must need 3 again
  assert.equal(getState(db, haltKey(ACCT)) === 'true', false)
})

test('AUTO RE-ARM: sustained recovery clears the halt; [Keep off] disables it', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500, rearmHoldMin: 15 }))
  await bankAStep(db)
  await breach(db, 3)
  assert.equal(getState(db, haltKey(ACCT)), 'true')

  // Recovery: haltFloor 48000 + 250 = 48250 → floating +300 = 48300. First
  // sighting starts the clock; 15 min later it re-arms.
  const t0 = 2_000_000_000
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 300, now: t0 }))
  assert.equal(getState(db, haltKey(ACCT)), 'true', 'not yet — must HOLD')
  const d = fakeDeps({ floating: 300, now: t0 + 16 * 60_000 })
  const r = acct(await runProfitRatchet(db, CREDS, d))
  assert.equal(r.rearmed, true)
  assert.equal(getState(db, haltKey(ACCT)), 'false')
  assert.match(d.notes[0].t, /re-armed/)

  // Trip again, then [Keep off]: the same recovery must NOT re-arm.
  await bankAStep(db)
  await breach(db, 3)
  keepRatchetOff(db, ACCT)
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 900, now: t0 }))
  await runProfitRatchet(db, CREDS, fakeDeps({ floating: 900, now: t0 + 60 * 60_000 }))
  assert.equal(getState(db, haltKey(ACCT)), 'true', 'keepOff holds until a manual re-arm')

  // Manual re-arm clears everything.
  rearmRatchet(db, ACCT)
  assert.equal(getState(db, haltKey(ACCT)), 'false')
  assert.equal(getState(db, softKey(ACCT)), 'false')
  assert.equal(ratchetGate(db, ACCT).blocked, false)
})

test("floorAction 'halt': halts entries but closes nothing", async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500, floorAction: 'halt' }))
  await bankAStep(db)
  const d = await breach(db, 3, { floating: -100 })
  assert.equal(getState(db, haltKey(ACCT)), 'true')
  assert.equal(d.closed.length, 0)
  assert.equal(getState(db, 'autotrade_enabled'), 'true')
})

test('registry accounts: each enabled account gets its OWN staircase', async () => {
  const db = freshDB(48000)
  setState(db, 'profit_ratchet_json', JSON.stringify({ stepUsd: 500 }))
  db.prepare("INSERT INTO accounts (account_id, enabled) VALUES ('42', 1)").run()
  db.prepare("INSERT INTO accounts (account_id, enabled) VALUES ('77', 1)").run()
  db.prepare("INSERT INTO accounts (account_id, enabled) VALUES ('88', 0)").run()
  setState(db, 'acct:42:account_balance_usd', '48000')
  setState(db, 'acct:77:account_balance_usd', '10000')
  const r = await runProfitRatchet(db, CREDS, fakeDeps({ floating: 0 }))
  assert.deepEqual(r.accounts.map(a => a.accountId).sort(), ['42', '77'], 'disabled 88 is not watched')
})

test('off / no balance → skipped', async () => {
  const db = freshDB()
  setState(db, 'profit_ratchet_json', JSON.stringify({ on: false }))
  assert.equal((await runProfitRatchet(db, CREDS, fakeDeps())).skipped, 'off_or_no_creds')
  const db2 = initDB(':memory:')
  const r = await runProfitRatchet(db2, CREDS, fakeDeps())
  assert.equal(acct(r).skipped, 'no_balance')
})
