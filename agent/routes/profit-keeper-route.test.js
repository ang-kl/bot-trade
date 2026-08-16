// node --test agent/routes/profit-keeper-route.test.js
//
// TWO DEFECTS, both about reach rather than behaviour.
//
// 1. POST /actions/profit-keeper rebuilt its config field by field from a
//    fixed list, so every key the list did not mention was DROPPED. That is
//    the whole spike and structure block — eight trailing knobs. Changing
//    armAtrMult reset all of them, with a 200 and a reply that looked right,
//    because the reply was built from the same truncated object.
//
//    It has been harmless purely by luck: each stored value happened to equal
//    its code default, and loadProfitKeeperConfig merges over the defaults, so
//    they came back identical. The first time one is tuned away from its
//    default, the next unrelated POST silently reverts it.
//
// 2. Those eight knobs were settable NOWHERE — no route accepted them. The
//    only way to change how tightly a winner is trailed was to edit the
//    defaults and redeploy. Measured 16-08-2026: non-burn-in winners captured
//    a MEDIAN OF 23% of their planned target, and the spike trail (1 x ATR,
//    roughly 0.4R behind the peak, triggered by one wide bar in the last
//    three) is the leading suspect. Diagnosing that was possible; acting on it
//    was not.
//
// Same shape as early-trim-route.test.js records for #685: a feature whose own
// tests looked healthy while nothing could switch it on.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'
import { DEFAULT_PROFIT_KEEPER, loadProfitKeeperConfig } from '../services/profit-keeper.js'

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}
const post = (h, body) => fetch(h.url('/actions/profit-keeper'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('the spike and structure knobs can be set at all', async () => {
  const h = await server()
  try {
    const r = await post(h, { spikeTrailAtrMult: 2, structurePivotBars: 3 })
    assert.equal(r.ok, true)
    assert.equal(r.config.spikeTrailAtrMult, 2)
    assert.equal(r.config.structurePivotBars, 3)
    // And the keeper's own reader sees them — a reply is not persistence.
    const cfg = loadProfitKeeperConfig(h.db)
    assert.equal(cfg.spikeTrailAtrMult, 2)
    assert.equal(cfg.structurePivotBars, 3)
  } finally { h.close() }
})

test('an unrelated POST no longer resets a tuned trailing knob', async () => {
  // THE REGRESSION. Tune the spike trail away from its default, then change
  // something else entirely. Before the fix the second call dropped the first.
  const h = await server()
  try {
    await post(h, { spikeTrailAtrMult: 2, structurePivotBars: 3, spikeBars: 5 })
    await post(h, { armAtrMult: 1.2 })
    const cfg = loadProfitKeeperConfig(h.db)
    assert.equal(cfg.armAtrMult, 1.2, 'the requested change applied')
    assert.equal(cfg.spikeTrailAtrMult, 2, 'and did NOT reset the spike trail')
    assert.equal(cfg.structurePivotBars, 3)
    assert.equal(cfg.spikeBars, 5)
  } finally { h.close() }
})

test('a key the route has never heard of survives a write', async () => {
  // The general form of the same bug: the old code could only preserve what it
  // enumerated, so any field added to the config later would be silently
  // deleted by the next POST until someone remembered to extend the list.
  const h = await server()
  try {
    setState(h.db, 'profit_keeper_json', JSON.stringify({
      ...DEFAULT_PROFIT_KEEPER, someFutureKnob: 'keep me',
    }))
    await post(h, { armAtrMult: 1.5 })
    const stored = JSON.parse(getState(h.db, 'profit_keeper_json'))
    assert.equal(stored.someFutureKnob, 'keep me')
    assert.equal(stored.armAtrMult, 1.5)
  } finally { h.close() }
})

test('values are clamped, and a bad one leaves the stored value alone', async () => {
  const h = await server()
  try {
    await post(h, { spikeTrailAtrMult: 2 })
    const r = await post(h, { spikeTrailAtrMult: 'nonsense', structurePivotBars: 999 })
    assert.equal(r.config.spikeTrailAtrMult, 2, 'unparseable input does not overwrite')
    assert.equal(r.config.structurePivotBars, 10, 'out of range is clamped, not stored raw')
  } finally { h.close() }
})

test('structureMaxAtrMult keeps null meaning unbounded', async () => {
  // null is MEANINGFUL here — unbounded giveback. An earlier fix in
  // profit-keeper.js existed precisely because an ABSENT key defaulted wrong,
  // so this route must not quietly turn a deliberate null into a number.
  const h = await server()
  try {
    const r = await post(h, { structureMaxAtrMult: null })
    assert.equal(r.config.structureMaxAtrMult, null)
    assert.equal(loadProfitKeeperConfig(h.db).structureMaxAtrMult, null)
  } finally { h.close() }
})

test('toggles are booleans, not truthiness', async () => {
  const h = await server()
  try {
    let r = await post(h, { spikeTightenEnabled: false, structureTrailEnabled: false })
    assert.equal(r.config.spikeTightenEnabled, false)
    assert.equal(r.config.structureTrailEnabled, false)
    r = await post(h, { spikeTightenEnabled: true })
    assert.equal(r.config.spikeTightenEnabled, true)
    assert.equal(r.config.structureTrailEnabled, false, 'the other toggle stayed off')
  } finally { h.close() }
})
