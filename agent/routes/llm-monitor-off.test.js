// node --test agent/routes/llm-monitor-off.test.js
//
// THE FROZEN BADGE (#755 review, finding 1 — the one worth more than the
// diff). With the AI layer off, the loop returns before recordLlmMonitorResult
// ever runs, and ok:true is the only thing that resets failStreak. So a
// streak that stood at >= 3 when the switch flipped stays there FOREVER, and
// the nav badge tells every page "LLM monitor unavailable — N consecutive
// failures" about a decision the owner made on purpose, with nothing in the
// UI able to clear it. llm-switch.js's opening argument (#694: an alarm that
// cannot be cleared teaches you to stop reading alarms), reproduced by the
// feature built to prevent it — and the realistic path is exactly the owner's
// last week: keys removed, streak climbing on 401s, switch flipped.
//
// The reading lives on the ROUTE, next to the flag, not as a reset in
// POST /llm-switch — because the env brake never passes through that route
// and must get the same treatment.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import stateRouter from './state.js'
import { recordLlmMonitorResult } from '../services/llm-monitor-health.js'

const TOKEN = 'sess_cccccccccccccccccccccccccccccccccccccccccccccccc'

function serve(db) {
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}
function frozenStreakDb() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  for (let i = 0; i < 4; i++) recordLlmMonitorResult(db, { ok: false, reason: 'OpenAI 429' })
  return db
}
const get = (base) => fetch(`${base}/state/llm-monitor-health`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then(r => r.json())

test('with the switch ON, a real streak still reads degraded — the alarm works', async () => {
  const db = frozenStreakDb()
  const { server, base } = serve(db)
  try {
    const h = await get(base)
    assert.equal(h.degraded, true)
    assert.equal(h.off, undefined)
  } finally { server.close() }
})

test('THE FROZEN CASE: layer off + stale streak reads OFF, not degraded', async () => {
  const db = frozenStreakDb()
  setState(db, 'llm_disabled', '1')
  const { server, base } = serve(db)
  try {
    const h = await get(base)
    assert.equal(h.degraded, false, 'a deliberate off must not wear the outage badge')
    assert.equal(h.off, true)
    assert.equal(h.offBy, 'llm_disabled state key')
    assert.equal(h.failStreak, 4, 'the forensic streak is preserved, only the verdict changes')
  } finally { server.close() }
})

test('flipping back on, the streak resumes meaning — nothing was erased', async () => {
  const db = frozenStreakDb()
  setState(db, 'llm_disabled', '1')
  setState(db, 'llm_disabled', '')
  const { server, base } = serve(db)
  try {
    const h = await get(base)
    assert.equal(h.degraded, true, 'the streak was history, not deleted — re-enabling restores the true reading')
  } finally { server.close() }
})
