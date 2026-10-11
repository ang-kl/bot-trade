// node --test agent/routes/capped-hybrid-settings-route.test.js
// W10 — Claude · № 13,391 12-Oct (owner's yes for W10; claude-builder).
// POST /actions/capped-hybrid-settings merges onto what is stored, validates
// the whole against the policy's ranges, and resets on request; GET
// /state/capped-hybrid-settings reads the effective values back.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState } from '../db.js'
import actionsRouter from './actions.js'
import stateRouter from './state.js'
import { CAPPED_HYBRID_SETTINGS_KEY } from '../services/capped-hybrid-policy.js'

async function server(t) {
  const db = initDB(':memory:'), app = express()
  app.use(express.json()); app.use('/actions', actionsRouter(db)); app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const x = app.listen(0, '127.0.0.1', () => resolve(x)) })
  t.after(async () => { s.closeAllConnections(); await new Promise(r => s.close(r)); db.close() })
  const url = p => `http://127.0.0.1:${s.address().port}${p}`
  const post = async body => { const r = await fetch(url('/actions/capped-hybrid-settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  const get = async () => (await fetch(url('/state/capped-hybrid-settings'))).json()
  return { db, post, get }
}

test('W10 route: defaults until set; a patch merges onto what is stored; reset returns to the defaults', async t => {
  const { db, post, get } = await server(t)
  assert.deepEqual((await get()).effective, { triggerR: 2, closeFraction: 0.5, source: 'default', error: null })
  let r = await post({ triggerR: 2.5 })
  assert.equal(r.status, 200); assert.deepEqual(r.body.effective, { triggerR: 2.5, closeFraction: 0.5, source: 'stored', error: null })
  r = await post({ closeFraction: 0.4 })
  assert.deepEqual(r.body.effective, { triggerR: 2.5, closeFraction: 0.4, source: 'stored', error: null }, 'the earlier triggerR is kept')
  assert.deepEqual(JSON.parse(getState(db, CAPPED_HYBRID_SETTINGS_KEY)), { triggerR: 2.5, closeFraction: 0.4 })
  r = await post({ reset: true })
  assert.deepEqual(r.body.effective, { triggerR: 2, closeFraction: 0.5, source: 'default', error: null })
  assert.equal(getState(db, CAPPED_HYBRID_SETTINGS_KEY), null)
  const g = await get()
  assert.deepEqual([g.defaults, g.ranges], [{ triggerR: 2, closeFraction: 0.5 }, { triggerR: [1, 5], closeFraction: [0.1, 0.9] }])
})

test('W10 route: out of range or empty is refused, and nothing is stored', async t => {
  const { db, post } = await server(t)
  for (const [body, code] of [[{ triggerR: 9 }, 'capped_hybrid_settings_invalid'], [{ closeFraction: 1 }, 'capped_hybrid_settings_invalid'],
    [{ triggerR: '2.5' }, 'capped_hybrid_settings_invalid'], [{}, 'capped_hybrid_settings_empty']]) {
    const r = await post(body)
    assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.code, code)
  }
  assert.equal(getState(db, CAPPED_HYBRID_SETTINGS_KEY), null)
})
