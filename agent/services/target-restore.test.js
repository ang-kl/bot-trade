// node --test agent/services/target-restore.test.js
//
// WHY A SECOND REPAIR PATH. naked-position-guard.js has attached targets since
// 04-08-2026 via tp-suggest — a target COMPUTED from volume structure, for
// adopted positions that never had one. This is the other case: a position the
// bot opened WITH a target that one of the four amend paths later deleted
// (#748). The target is not missing, it is lost, and the bot wrote it down.
//
// The two do not overlap and must not. This restores only what is on record
// and never computes; the suggester computes only when there is no record.
//
// The existing path is also gated behind the SIX-HOUR alert mute, so a target
// stripped at 09:00 waits until an alert falls due. This runs on the sweep and
// is bounded by its own per-position retry window instead — the repair is
// chained to the fault, not to the notification cadence.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { planTargetRestore, restoreMissingTargets, restoreEnabled, MAX_PER_SWEEP } from './target-restore.js'

const LONG = { id: 1, symbol: 'EURUSD', side: 'long', entry_price: 1.10, current_tp: 1.15, account_id: 'A', trade_id: 7 }
const SHORT = { id: 2, symbol: 'GBPUSD', side: 'short', entry_price: 1.30, current_tp: 1.25, account_id: 'A', trade_id: 8 }

// The decision ------------------------------------------------------------

test('a recorded target on the profit side of entry is restored', () => {
  assert.deepEqual(planTargetRestore(LONG, { brokerSl: 1.09 }), { action: 'restore', tp: 1.15 })
  assert.deepEqual(planTargetRestore(SHORT, { brokerSl: 1.31 }), { action: 'restore', tp: 1.25 })
})

test('NO RECORDED TARGET MEANS NO RESTORE — this never invents a level', () => {
  // The whole safety property. An adopted position with no target of its own
  // is left alone and left reported; inventing one is the suggester's job,
  // under its own rules.
  for (const tp of [null, undefined, 0, -1, 'abc']) {
    const out = planTargetRestore({ ...LONG, current_tp: tp }, { brokerSl: 1.09 })
    assert.equal(out.action, 'skip', String(tp))
    assert.match(out.reason, /no target on record/)
  }
})

test('a target on the WRONG side of entry is refused, not sent', () => {
  // A corrupt record, not a target: sending it asks the broker to close at a
  // loss the moment it fills.
  const badLong = planTargetRestore({ ...LONG, current_tp: 1.05 }, { brokerSl: 1.09 })
  assert.equal(badLong.action, 'skip')
  assert.match(badLong.reason, /not above/)

  const badShort = planTargetRestore({ ...SHORT, current_tp: 1.35 }, { brokerSl: 1.31 })
  assert.equal(badShort.action, 'skip')
  assert.match(badShort.reason, /not below/)
})

test('a target EQUAL to entry is refused — that is a scratch, not a target', () => {
  assert.equal(planTargetRestore({ ...LONG, current_tp: 1.10 }, { brokerSl: 1.09 }).action, 'skip')
})

test('no entry price, or an unrecognised side, refuses rather than guesses', () => {
  assert.match(planTargetRestore({ ...LONG, entry_price: null }, { brokerSl: 1.09 }).reason, /no entry price/)
  assert.match(planTargetRestore({ ...LONG, side: 'sideways' }, { brokerSl: 1.09 }).reason, /unrecognised side/)
})

test('an unknown broker stop refuses — a TP-only amend would clear the stop', () => {
  // This defect inverted. amend REPLACES: sending a target with no stop turns
  // a targetless position into a NAKED one, which is strictly worse.
  const out = planTargetRestore(LONG, { brokerSl: null })
  assert.equal(out.action, 'skip')
  assert.match(out.reason, /would risk the stop/)
})

test('buy/sell are accepted as side spellings, not just long/short', () => {
  assert.equal(planTargetRestore({ ...LONG, side: 'BUY' }, { brokerSl: 1.09 }).action, 'restore')
  assert.equal(planTargetRestore({ ...SHORT, side: 'Sell' }, { brokerSl: 1.31 }).action, 'restore')
})

// The runner --------------------------------------------------------------

function db0() {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO trades (id,symbol,side,status,account_id,ctrader_position_id) VALUES (7,'EURUSD','long','open','A','111')").run()
  db.prepare("INSERT INTO monitored_positions (id,trade_id,symbol,status,account_id,current_sl,current_tp,side,entry_price,source) VALUES (1,7,'EURUSD','active','A',1.09,1.15,'long',1.10,'bot')").run()
  return db
}
const finding = { positionId: '111', symbol: 'EURUSD', brokerSl: 1.09, source: 'bot' }
const rows = (db) => new Map([['111', db.prepare('SELECT * FROM monitored_positions WHERE id = 1').get()]])

function spyAmend() {
  const calls = []
  return { calls, fn: async (_creds, args) => { calls.push(args); return { executionType: 'OK' } } }
}

test('the restore sends BOTH legs — the stop must survive the amend', async () => {
  // Sending only the take profit would clear the stop. Same rule as #748,
  // pointed the other way, and this is the one place that would get it wrong.
  const db = db0()
  const amend = spyAmend()
  const out = await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: amend.fn })
  assert.equal(out.restored, 1, JSON.stringify(out))
  assert.equal(amend.calls.length, 1)
  assert.equal(amend.calls[0].takeProfit, 1.15)
  assert.equal(amend.calls[0].stopLoss, 1.09, 'the broker stop must be re-sent alongside the target')
})

test('a restore is recorded as a position event, so the timeline shows it', async () => {
  const db = db0()
  await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: spyAmend().fn })
  const ev = db.prepare("SELECT * FROM position_events WHERE kind = 'tp_moved'").all()
  assert.equal(ev.length, 1)
  assert.equal(Number(ev[0].to_value), 1.15)
})

test('THE SAME POSITION IS NOT RETRIED EVERY SWEEP', async () => {
  // The sweep runs every ~30s. Without this, a position the broker keeps
  // refusing would be amended 2,880 times a day.
  const db = db0()
  const amend = spyAmend()
  const t0 = Date.parse('2026-08-22T08:00:00Z')
  await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: amend.fn, nowMs: t0 })
  const second = await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: amend.fn, nowMs: t0 + 60_000 })
  assert.equal(amend.calls.length, 1, 'a second sweep a minute later must not re-amend')
  assert.match(second.skipped.join(' '), /waiting/)

  // ...and it IS retried once the window has passed.
  await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: amend.fn, nowMs: t0 + 31 * 60_000 })
  assert.equal(amend.calls.length, 2)
})

test('a FAILED amend still marks the attempt, so a broken position cannot loop', async () => {
  const db = db0()
  let n = 0
  const failing = async () => { n++; throw new Error('MARKET_CLOSED') }
  const t0 = Date.parse('2026-08-22T08:00:00Z')
  const out = await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: failing, nowMs: t0 })
  assert.equal(out.restored, 0)
  assert.match(out.errors.join(' '), /MARKET_CLOSED/)
  await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: failing, nowMs: t0 + 60_000 })
  assert.equal(n, 1, 'a failure must be rate-limited exactly like a success')
})

test('the off switch works, and absent means ON', async () => {
  const db = db0()
  assert.equal(restoreEnabled(db), true, 'default must be on — the owner asked for this to run')
  setState(db, 'target_restore_enabled', 'false')
  assert.equal(restoreEnabled(db), false)
  const amend = spyAmend()
  const out = await restoreMissingTargets(db, { accountId: 'A' }, [finding], rows(db), { amend: amend.fn })
  assert.equal(amend.calls.length, 0)
  assert.match(out.skipped.join(' '), /switched off/)
})

test('a mass event is capped, and says how many it did not attempt', async () => {
  // A broker-side wipe must not become a burst of dozens of amends.
  const db = db0()
  const many = Array.from({ length: MAX_PER_SWEEP + 3 }, (_, i) => ({ ...finding, positionId: String(200 + i) }))
  const row = db.prepare('SELECT * FROM monitored_positions WHERE id = 1').get()
  const map = new Map(many.map(f => [String(f.positionId), row]))
  const amend = spyAmend()
  const out = await restoreMissingTargets(db, { accountId: 'A' }, many, map, { amend: amend.fn })
  assert.equal(amend.calls.length, MAX_PER_SWEEP)
  assert.match(out.skipped.join(' '), /not attempted this sweep/)
})

test('nothing targetless means nothing happens at all', async () => {
  const db = db0()
  const amend = spyAmend()
  const out = await restoreMissingTargets(db, { accountId: 'A' }, [], rows(db), { amend: amend.fn })
  assert.deepEqual(out, { restored: 0, skipped: [], errors: [] })
  assert.equal(amend.calls.length, 0)
  assert.equal(getState(db, 'target_restore_attempts_json'), null, 'a no-op sweep must not write state')
})
