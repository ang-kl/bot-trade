// node --test agent/routes/stage-matrix-tally.test.js
//
// GET /state/stage-matrix — the per-account tally.
//
// Owner, 04-08-2026: "have a count of tick/cross per account." The matrix
// renders one scope at a time, so "how much is armed over there" could only be
// answered by switching the account pill and counting cells by eye.
//
// The property that matters is not the arithmetic — it is that the tally is a
// count of THE SAME merged matrix the cells render from. A tally computed off
// its own copy of the rules is the two-sources-of-truth defect again, in the
// one place whose whole job is to say how much is armed.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState } from '../db.js'
import stateRouter from './state.js'
import actionsRouter from './actions.js'
import { loadStageMatrix } from '../services/stage-matrix.js'

const A = '46130058'
const B = '47790949'

function server() {
  const db = initDB(':memory:')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(A, 0, 1, 'manage_only', '5203012')
  db.prepare('INSERT INTO accounts (account_id,is_live,enabled,mode,trader_login) VALUES (?,?,?,?,?)')
    .run(B, 0, 1, 'active', '5306502')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  app.use('/actions', actionsRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

const mx = (s, acct) =>
  fetch(s.url(`/state/stage-matrix${acct ? `?account=${acct}` : ''}`)).then(r => r.json())

// The tally, counted independently from the rendered cells — if these two ever
// disagree, the number on screen is describing something the ticks are not.
function countCells(m, stage) {
  let on = 0, off = 0
  for (const row of [...(m.strategies || []), ...(m.filters || [])]) {
    const v = row.stages?.[stage]
    if (v == null) continue
    if (v) on += 1; else off += 1
  }
  return { on, off }
}

test('every registry account gets a row, with its mode and enabled state', async () => {
  const s = await server()
  try {
    const j = await mx(s)
    assert.equal(j.tallies.length, 2)
    const a = j.tallies.find(t => t.accountId === A)
    assert.equal(a.traderLogin, '5203012')
    assert.equal(a.mode, 'manage_only')
    assert.equal(a.enabled, true)
    assert.equal(a.isLive, false)
  } finally { s.close() }
})

test('the counts match the cells that account actually renders', async () => {
  const s = await server()
  try {
    const j = await mx(s)
    for (const t of j.tallies) {
      const m = loadStageMatrix(s.db, getState, t.accountId)
      for (const stage of Object.keys(t.stages)) {
        assert.deepEqual(t.stages[stage], countCells(m, stage), `${t.accountId} · ${stage}`)
      }
    }
  } finally { s.close() }
})

test('arming a cell for ONE account moves only that account\'s count', async () => {
  const s = await server()
  try {
    const before = await mx(s)
    const key = loadStageMatrix(s.db, getState).strategies.find(r => !r.stages.trade)?.key
    assert.ok(key, 'need a strategy that is off in the trade stage')
    // Through the real write route, not the service: /state/* is served from a
    // 10s response cache that only a write through the API invalidates, so a
    // test that pokes the DB directly would be checking a stale answer and
    // calling it a pass.
    const w = await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key, stage: 'trade', on: true, accountId: A }),
    })
    assert.equal(w.status, 200)

    const after = await mx(s)
    const pick = (j, id) => j.tallies.find(t => t.accountId === id).stages.trade
    assert.equal(pick(after, A).on, pick(before, A).on + 1)
    assert.equal(pick(after, A).off, pick(before, A).off - 1)
    assert.deepEqual(pick(after, B), pick(before, B), 'the other account did not move')
    assert.equal(after.tallies.find(t => t.accountId === A).pinned, 1, 'and the pin is reported')
  } finally { s.close() }
})

test('the tally rides along on a SCOPED read too — the page never has to ask twice', async () => {
  const s = await server()
  try {
    const j = await mx(s, A)
    assert.equal(j.accountId, A)
    assert.equal(j.tallies.length, 2, 'still every account, so the scoped view can compare')
  } finally { s.close() }
})

// ---------------------------------------------------------------------------
// THE WRITE ANSWERS WITH THE TALLY TOO (review finding on #609).
//
// The page merges the write's response into its matrix. When only strategies
// and filters came back, the tick the operator had just flipped disagreed with
// the per-account count underneath it until the next 20s poll — for the edited
// account on an overlay write, and for every inheriting account on a shared
// one. A count that lags the thing it counts is precisely the defect the tally
// was added to remove.
// ---------------------------------------------------------------------------
test('POST /actions/stage-matrix returns tallies that already include the edit', async () => {
  const s = await server()
  try {
    const key = loadStageMatrix(s.db, getState).strategies.find(r => !r.stages.trade)?.key
    const before = (await mx(s)).tallies.find(t => t.accountId === A).stages.trade

    const w = await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key, stage: 'trade', on: true, accountId: A }),
    })
    const body = await w.json()
    assert.ok(Array.isArray(body.tallies), 'the write carries tallies')
    const after = body.tallies.find(t => t.accountId === A).stages.trade
    assert.equal(after.on, before.on + 1, 'and they already count this edit')
    assert.equal(body.tallies.find(t => t.accountId === A).pinned, 1)
    // The bystander is unchanged in the very same payload.
    assert.deepEqual(
      body.tallies.find(t => t.accountId === B).stages.trade,
      (await mx(s)).tallies.find(t => t.accountId === B).stages.trade)
  } finally { s.close() }
})

test('a SHARED edit moves every inheriting account in the write\'s own answer', async () => {
  const s = await server()
  try {
    const key = loadStageMatrix(s.db, getState).strategies.find(r => !r.stages.trade)?.key
    const before = (await mx(s)).tallies
    const body = await (await fetch(s.url('/actions/stage-matrix'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'strategy', key, stage: 'trade', on: true }),   // no accountId
    })).json()
    for (const id of [A, B]) {
      const b = before.find(t => t.accountId === id).stages.trade
      const a = body.tallies.find(t => t.accountId === id).stages.trade
      assert.equal(a.on, b.on + 1, `${id} follows the shared change`)
    }
  } finally { s.close() }
})
