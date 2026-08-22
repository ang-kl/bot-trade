// node --test agent/services/stop-adopt.test.js
//
// The audit has called a stop disagreement "arguably the more dangerous state,
// because the UI shows a stop that will not fire" since the day it was written,
// and then done nothing about it. Account 43097342 carried `1 stop
// disagreement` on every pass for days.
//
// THE ONE-DIRECTIONAL RULE IS THE ENTIRE DESIGN, so most of this file is about
// the case that must NOT be adopted. Copying in a broker stop that is WIDER
// than the book would make the two agree, stop the report, and leave the extra
// risk standing with nothing complaining — a guard cured by deleting the guard.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { planStopAdopt, adoptBrokerStops, adoptEnabled } from './stop-adopt.js'

const LONG = { id: 1, symbol: 'EURUSD', side: 'long', current_sl: 1.09, account_id: 'A', trade_id: 7 }
const SHORT = { id: 2, symbol: 'GBPUSD', side: 'short', current_sl: 1.31, account_id: 'A', trade_id: 8 }

// The rule ----------------------------------------------------------------

test('a TIGHTER broker stop is adopted — less risk than the book believed', () => {
  // Long: higher is tighter. Short: lower is tighter.
  assert.deepEqual(planStopAdopt(LONG, { ourSl: 1.09, brokerSl: 1.095 }), { action: 'adopt', sl: 1.095 })
  assert.deepEqual(planStopAdopt(SHORT, { ourSl: 1.31, brokerSl: 1.305 }), { action: 'adopt', sl: 1.305 })
})

test('A WIDER BROKER STOP IS NOT ADOPTED — it stays reported', () => {
  // The case the whole design exists for. The position is risking MORE than
  // the book believed; adopting would silence the only thing carrying that.
  const long = planStopAdopt(LONG, { ourSl: 1.09, brokerSl: 1.085 })
  assert.equal(long.action, 'skip')
  assert.match(long.reason, /WIDER/)
  assert.match(long.reason, /risking more/)

  const short = planStopAdopt(SHORT, { ourSl: 1.31, brokerSl: 1.315 })
  assert.equal(short.action, 'skip')
  assert.match(short.reason, /WIDER/)
})

test('nothing on record is adopted — the book gains a fact it lacked', () => {
  assert.deepEqual(planStopAdopt({ ...LONG, current_sl: null }, { ourSl: null, brokerSl: 1.09 }),
    { action: 'adopt', sl: 1.09 })
})

test('no broker stop is nothing to adopt — that is the naked case, not this one', () => {
  for (const brokerSl of [null, 0, undefined, 'x']) {
    assert.equal(planStopAdopt(LONG, { ourSl: 1.09, brokerSl }).action, 'skip')
  }
})

test('an unrecognised side REFUSES — a rule that cannot be applied is not passed', () => {
  // Without a side there is no "tighter". Assuming it passes would adopt a
  // wider stop, which is the one outcome forbidden above.
  const out = planStopAdopt({ ...LONG, side: 'sideways' }, { ourSl: 1.09, brokerSl: 1.085 })
  assert.equal(out.action, 'skip')
  assert.match(out.reason, /cannot tell which stop is tighter/)
})

test('buy/sell spellings work, not just long/short', () => {
  assert.equal(planStopAdopt({ ...LONG, side: 'BUY' }, { ourSl: 1.09, brokerSl: 1.095 }).action, 'adopt')
  assert.equal(planStopAdopt({ ...SHORT, side: 'Sell' }, { ourSl: 1.31, brokerSl: 1.305 }).action, 'adopt')
})

test('identical stops are a no-op', () => {
  assert.match(planStopAdopt(LONG, { ourSl: 1.09, brokerSl: 1.09 }).reason, /already agree/)
})

// The writer --------------------------------------------------------------

function db0(sl = 1.09, side = 'long') {
  const db = initDB(':memory:')
  db.prepare("INSERT INTO trades (id,symbol,side,status,account_id,ctrader_position_id) VALUES (7,'EURUSD',?,'open','A','111')").run(side)
  db.prepare("INSERT INTO monitored_positions (id,trade_id,symbol,status,account_id,current_sl,side,entry_price,source) VALUES (1,7,'EURUSD','active','A',?,?,1.10,'bot')")
    .run(sl, side)
  return db
}
const rows = (db) => new Map([['111', db.prepare('SELECT * FROM monitored_positions WHERE id = 1').get()]])
const finding = (ourSl, brokerSl) => ({ positionId: '111', symbol: 'EURUSD', ourSl, brokerSl })

test('an adoption writes the book and leaves a timeline entry', () => {
  const db = db0()
  const out = adoptBrokerStops(db, [finding(1.09, 1.095)], rows(db))
  assert.equal(out.adopted, 1, JSON.stringify(out))
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE id = 1').get().current_sl, 1.095)
  const ev = db.prepare("SELECT * FROM position_events WHERE source = 'stop_adopt'").all()
  assert.equal(ev.length, 1, 'a silent correction would hide a repeatedly failing amend')
  assert.equal(Number(ev[0].to_value), 1.095)
})

test('a WIDER broker stop leaves the book untouched', () => {
  const db = db0()
  const out = adoptBrokerStops(db, [finding(1.09, 1.085)], rows(db))
  assert.equal(out.adopted, 0)
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE id = 1').get().current_sl, 1.09,
    'the book must keep disagreeing so the audit keeps reporting')
  assert.match(out.skipped.join(' '), /WIDER/)
})

test('the off switch works, and absent means ON', () => {
  const db = db0()
  assert.equal(adoptEnabled(db), true)
  setState(db, 'stop_adopt_enabled', 'false')
  const out = adoptBrokerStops(db, [finding(1.09, 1.095)], rows(db))
  assert.equal(out.adopted, 0)
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE id = 1').get().current_sl, 1.09)
  assert.match(out.skipped.join(' '), /switched off/)
})

test('no disagreements means no writes at all', () => {
  const db = db0()
  const out = adoptBrokerStops(db, [], rows(db))
  assert.deepEqual(out, { adopted: 0, skipped: [] })
})
