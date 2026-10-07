// node --test agent/services/trail-status-view.test.js
//
// GET /state/trail-status — the C++ TrailEngine's live set, read through one
// account's credentials (07-10-2026, Claude · № 11,596·D·1, ordered
// № 11,583·D·1).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from '../routes/state.js'
import { trailStatusView } from './trail-status-view.js'

function depsWith({ execMode = 'cpp', status = { enabled: true, positions: [] } } = {}) {
  const calls = []
  return {
    calls,
    credsLib: {
      credsForRegisteredAccount: (_db, id) => id === '777' ? { ready: true, accountId: '777', isLive: false }
        : id === '888' ? { ready: false, accountId: '888', isLive: true } : null,
      getCtraderCreds: () => ({ ready: false, accountId: null }),
    },
    exec: {
      execEngineMode: () => execMode,
      getTrailStatus: async (creds) => { calls.push(creds.accountId); return status },
      // The named refusal rides the view (Claude · #1243 read-back, after № 11,609).
      lastTrailConfigRefusal: (creds) => creds.accountId === '777' ? { at: '2026-10-06T22:24:17.163Z', reason: 'TRAIL_TICK_ENABLED not set', count: 9 } : null,
    },
  }
}

test('a registered account with credentials: the side, the mode and the engine\'s set', async () => {
  const db = initDB(':memory:')
  const deps = depsWith({ status: { enabled: true, tracked: 2, positions: [{ positionId: 1722, accountId: 46979908 }, { positionId: 1724, accountId: 43097342 }] } })
  const out = await trailStatusView(db, '777', deps)
  assert.equal(out.status, 200)
  assert.equal(out.body.account, '777')
  assert.equal(out.body.side, 'demo')
  assert.equal(out.body.execMode, 'cpp')
  assert.equal(out.body.enabled, true)
  assert.deepEqual(out.body.positions.map(p => p.positionId), [1722, 1724], 'the whole side, not one account')
  assert.deepEqual(deps.calls, ['777'])
  assert.deepEqual(out.body.lastPushRefusal, { at: '2026-10-06T22:24:17.163Z', reason: 'TRAIL_TICK_ENABLED not set', count: 9 }, 'a refused push is named on the read-back')
})

test('not cpp: enabled:false without asking a gateway', async () => {
  const db = initDB(':memory:')
  const deps = depsWith({ execMode: 'js' })
  const out = await trailStatusView(db, '777', deps)
  assert.equal(out.status, 200)
  assert.equal(out.body.enabled, false)
  assert.equal(out.body.execMode, 'js')
  assert.deepEqual(deps.calls, [])
})

test('unregistered, malformed, or credential-less accounts are refusals, never a guess', async () => {
  const db = initDB(':memory:')
  const deps = depsWith()
  assert.equal((await trailStatusView(db, '999', deps)).status, 400)
  assert.equal((await trailStatusView(db, 'abc', deps)).status, 400)
  const noCreds = await trailStatusView(db, '888', deps)
  assert.equal(noCreds.status, 503)
  assert.equal(noCreds.body.account, '888')
  const noSelection = await trailStatusView(db, null, deps)
  assert.equal(noSelection.status, 503)
  assert.deepEqual(deps.calls, [])
})

test('the route is mounted: GET /state/trail-status answers through the view', async t => {
  const db = initDB(':memory:')
  t.after(() => db.close())
  const app = express(); app.use('/state', stateRouter(db))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const res = await fetch(`http://127.0.0.1:${server.address().port}/state/trail-status?account=abc`)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'explicit registered account required')
  assert.equal(res.headers.get('cache-control'), 'no-store')
})
