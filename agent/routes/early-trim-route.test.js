// node --test agent/routes/early-trim-route.test.js
//
// THE BUG THIS FIXES IS AN ABSENCE, so the first test is about reachability
// rather than behaviour.
//
// #685 shipped early-trim as a log-only shadow reading state key
// `early_trim_json`, with a full suite asserting how correctly it stays off.
// Nothing anywhere WROTE that key — no route, no UI, no seed — so the feature
// could never be started. It looked like working, cautious software right up
// until somebody went looking for the rows it was supposed to be writing.
//
// A shadow nobody can switch on is not a cautious shadow. It is a dead one,
// and its own tests were the thing making it look alive.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import actionsRouter from './actions.js'

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

const post = (h, body) => fetch(h.url('/actions/early-trim-settings'), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('the key CAN be written — the reachability the feature shipped without', async () => {
  const h = await server()
  try {
    assert.equal(getState(h.db, 'early_trim_json'), null, 'starts unset, hence off')
    const r = await post(h, { enabled: true })
    assert.equal(r.ok, true)
    assert.equal(r.effective.enabled, true)
    // The point of the whole route: the shadow's own reader now finds something.
    const stored = JSON.parse(getState(h.db, 'early_trim_json'))
    assert.equal(stored.enabled, true)
  } finally { h.close() }
})

test('the response echoes the EFFECTIVE config, not what was sent', async () => {
  const h = await server()
  try {
    // earlyTrimConfig() silently repairs nonsense. Echoing the request back
    // would report atR:'half' as accepted; echoing the effective config makes
    // the repair visible at the moment it happens.
    const r = await post(h, { enabled: true, atR: 'half', frac: 99 })
    assert.equal(r.effective.atR, 1.0, 'unparseable → default')
    // Note the asymmetry, pinned here because it is a sharp edge rather than a
    // bug: a NEGATIVE frac falls back to the 0.5 default, but a positive
    // nonsense value is CLAMPED to the 0.9 ceiling. So a fat-fingered 99 does
    // not become "half", it becomes "trim 90% of the position". Harmless while
    // this is log-only; it would not be if an act path ever landed.
    assert.equal(r.effective.frac, 0.9, 'positive nonsense clamps to the ceiling, it does not reset')
    assert.equal((await post(h, { frac: -1 })).effective.frac, 0.5, 'negative falls back instead')
  } finally { h.close() }
})

test("mode stays 'log' however it is asked for — there is no act path to switch on", async () => {
  const h = await server()
  try {
    const r = await post(h, { enabled: true, mode: 'act' })
    assert.equal(r.effective.mode, 'log')
    assert.equal(JSON.parse(getState(h.db, 'early_trim_json')).mode, 'log')
  } finally { h.close() }
})

test('a partial write merges rather than resetting the untouched fields', async () => {
  const h = await server()
  try {
    await post(h, { enabled: true, atR: 1.5, moveSlToBreakeven: false })
    const r = await post(h, { frac: 0.25 })
    assert.equal(r.effective.atR, 1.5, 'not clobbered back to the default')
    assert.equal(r.effective.moveSlToBreakeven, false)
    assert.equal(r.effective.frac, 0.25)
    assert.equal(r.effective.enabled, true)
  } finally { h.close() }
})

test('enabling while the Profit Keeper is OFF warns instead of quietly writing nothing', async () => {
  const h = await server()
  try {
    // The shadow runs inside the keeper's sweep, which returns early when the
    // keeper is off (profit-keeper.js:258). Without this warning the operator
    // sets enabled:true, gets ok:true, and discovers a week later that the
    // record is empty — the same silent-nothing this whole file exists about.
    setState(h.db, 'profit_keeper_json', JSON.stringify({ on: false }))
    const off = await post(h, { enabled: true })
    assert.equal(off.profitKeeperOn, false)
    assert.match(off.warning, /Profit Keeper is OFF/)
    assert.match(off.warning, /NO rows will be written/)

    setState(h.db, 'profit_keeper_json', JSON.stringify({ on: true }))
    const on = await post(h, { enabled: true })
    assert.equal(on.profitKeeperOn, true)
    assert.equal(on.warning, null)
  } finally { h.close() }
})

test('disabling never warns, whatever the keeper is doing', async () => {
  const h = await server()
  try {
    setState(h.db, 'profit_keeper_json', JSON.stringify({ on: false }))
    const r = await post(h, { enabled: false })
    assert.equal(r.effective.enabled, false)
    assert.equal(r.warning, null, 'an off shadow writing no rows is not a surprise')
  } finally { h.close() }
})

test('GET reports the effective config, the keeper state and what it writes', async () => {
  const h = await server()
  try {
    const before = await fetch(h.url('/actions/early-trim-settings')).then(r => r.json())
    assert.equal(before.effective.enabled, false, 'unset reads as off, not as missing')
    assert.match(before.writes, /applied:false/)

    await post(h, { enabled: true, atR: 2 })
    const after = await fetch(h.url('/actions/early-trim-settings')).then(r => r.json())
    assert.equal(after.effective.enabled, true)
    assert.equal(after.effective.atR, 2)
  } finally { h.close() }
})

test('a corrupt stored value reads as OFF rather than throwing', async () => {
  const h = await server()
  try {
    setState(h.db, 'early_trim_json', '{not json')
    const r = await fetch(h.url('/actions/early-trim-settings')).then(r => r.json())
    assert.equal(r.ok, true)
    assert.equal(r.effective.enabled, false)
    // And a write over the corruption repairs it rather than compounding it.
    const w = await post(h, { enabled: true })
    assert.equal(w.effective.enabled, true)
    assert.equal(JSON.parse(getState(h.db, 'early_trim_json')).enabled, true)
  } finally { h.close() }
})
