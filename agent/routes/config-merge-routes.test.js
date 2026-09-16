// node --test agent/routes/config-merge-routes.test.js
//
// CLAUDE.md failure mode #5 — an endpoint that rebuilds instead of merging.
// POST /actions/session-open-guard and /actions/performance-breaker built
// `next` from a fixed field list, so any key the list did not name was
// silently DROPPED from the stored config on the next unrelated POST.

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
const post = (h, path, body) => fetch(h.url(path), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json())

test('session-open-guard: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'session_open_guard_json', JSON.stringify({ on: true, windowMin: 30, minR: 0.2, futureKnob: 7 }))
    const r = await post(h, '/actions/session-open-guard', { minR: 0.3 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'session_open_guard_json'))
    assert.equal(stored.futureKnob, 7, 'an unrelated POST must not drop a stored key')
    assert.equal(stored.windowMin, 30, 'an untouched known key keeps its stored value')
    assert.equal(stored.minR, 0.3, 'the patched key changes')
    assert.equal(r.futureKnob, 7, 'the reply is built from what is stored, not from a fixed list')
  } finally { h.close() }
})

test('performance-breaker: a stored key the route does not know survives a partial POST', async () => {
  const h = await server()
  try {
    setState(h.db, 'performance_breaker_json', JSON.stringify({ on: true, window: 40, minTrades: 20, pfThreshold: 0.8, autoDisarm: true, futureKnob: 'x' }))
    const r = await post(h, '/actions/performance-breaker', { window: 50 })
    assert.equal(r.ok, true)
    const stored = JSON.parse(getState(h.db, 'performance_breaker_json'))
    assert.equal(stored.futureKnob, 'x')
    assert.equal(stored.autoDisarm, true, 'the armed auto-disarm must not be reset by an unrelated POST')
    assert.equal(stored.minTrades, 20)
    assert.equal(stored.window, 50)
    assert.equal(r.futureKnob, 'x')
  } finally { h.close() }
})

// PR-K (16-09-2026): the momentum book's horizon switches are the REVERT path
// for a change to exit behaviour on real money, so the merge is exercised for
// real rather than asserted against the route's source text. A source-text pin
// cannot catch the regression it is named for — a ninth knob added to
// momentumBookConfig and forgotten in the route's key list leaves it green.
test('momentum-book: a one-knob POST keeps every other stored knob, and the horizon switches are writable and readable', async () => {
  const h = await server()
  try {
    const { MOMENTUM_BOOK_CONFIG_KEY, loadMomentumBook } = await import('../services/momentum-book.js')
    setState(h.db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({
      enabled: true, timeframe: '1d', atrPeriod: 20, stopAtr: 3, maxPositionsPerAccount: 8, conviction: 8,
      bookExitCadence: 'daily', bookMinHoldHours: 24,
    }))
    // The revert: one value, posted alone.
    let r = await post(h, '/actions/momentum-book', { bookExitCadence: 'every_pass' })
    assert.equal(r.ok, true)
    assert.equal(r.effective.bookExitCadence, 'every_pass', 'the reply is the effective policy')
    let stored = loadMomentumBook(h.db)
    assert.equal(stored.bookExitCadence, 'every_pass')
    assert.equal(stored.enabled, true, 'the book was not switched off by an unrelated POST')
    assert.equal(stored.bookMinHoldHours, 24, 'the other horizon knob survives')
    assert.equal(stored.stopAtr, 3)
    assert.equal(stored.maxPositionsPerAccount, 8)
    // And back again, plus the hold, each one alone.
    r = await post(h, '/actions/momentum-book', { bookExitCadence: 'daily' })
    assert.equal(r.effective.bookExitCadence, 'daily')
    r = await post(h, '/actions/momentum-book', { bookMinHoldHours: 12 })
    stored = loadMomentumBook(h.db)
    assert.equal(stored.bookMinHoldHours, 12)
    assert.equal(stored.bookExitCadence, 'daily', 'the cadence set a moment ago is not reset by the next POST')
    assert.equal(stored.conviction, 8)
    // A cleared field must not silently disable the hold.
    r = await post(h, '/actions/momentum-book', { bookMinHoldHours: null })
    assert.equal(loadMomentumBook(h.db).bookMinHoldHours, 24, 'null is not 0 — it falls back to the default')
    // An unrelated POST leaves the horizon alone.
    await post(h, '/actions/momentum-book', { stopAtr: 4 })
    stored = loadMomentumBook(h.db)
    assert.equal(stored.stopAtr, 4)
    assert.equal(stored.bookMinHoldHours, 24)
    assert.equal(stored.bookExitCadence, 'daily')
    // PR-P (16-09-2026): the entry brake's five knobs go through the SAME
    // merge. This is a risk control, so the regression that matters is the
    // one the comment above names — a knob added to momentumBookConfig and
    // forgotten in the route's key list, which would leave the brake
    // un-tunable and, worse, reset by any unrelated POST.
    r = await post(h, '/actions/momentum-book', { bookDrawdownPct: 35 })
    stored = loadMomentumBook(h.db)
    assert.equal(stored.bookDrawdownPct, 35, 'the brake threshold is writable')
    assert.equal(stored.bookDrawdownOn, true)
    assert.equal(stored.stopAtr, 4, 'and the previous POST survives it')
    r = await post(h, '/actions/momentum-book', { bookDrawdownMinRows: 3, bookMarkMaxAgeHours: 48, bookDrawdownMinCoveragePct: 80 })
    stored = loadMomentumBook(h.db)
    assert.deepEqual([stored.bookDrawdownMinRows, stored.bookMarkMaxAgeHours, stored.bookDrawdownMinCoveragePct, stored.bookDrawdownPct], [3, 48, 80, 35])
    // An unrelated POST must not reset the brake — the exact failure the
    // rebuild-instead-of-merge regression caused before (failure mode #5).
    await post(h, '/actions/momentum-book', { conviction: 9 })
    stored = loadMomentumBook(h.db)
    assert.deepEqual([stored.conviction, stored.bookDrawdownPct, stored.bookDrawdownMinRows, stored.bookDrawdownMinCoveragePct], [9, 35, 3, 80])
    // A cleared field cannot turn a risk control off, and cannot widen it.
    await post(h, '/actions/momentum-book', { bookDrawdownOn: null, bookDrawdownPct: '' })
    stored = loadMomentumBook(h.db)
    assert.equal(stored.bookDrawdownOn, true, 'null is not false')
    assert.equal(stored.bookDrawdownPct, 50, "'' falls back to the default, never to a permissive number")
    // Out of range in EITHER direction falls back to the default too — the
    // clamping version sent -500 to the floor (freezing every account) and
    // 5000 to the ceiling (as good as off). Both are the worst reading.
    await post(h, '/actions/momentum-book', { bookDrawdownPct: -500 })
    assert.equal(loadMomentumBook(h.db).bookDrawdownPct, 50)
    await post(h, '/actions/momentum-book', { bookDrawdownPct: 5000 })
    assert.equal(loadMomentumBook(h.db).bookDrawdownPct, 50)
    // OFF is still reachable, deliberately and explicitly.
    await post(h, '/actions/momentum-book', { bookDrawdownOn: false })
    assert.equal(loadMomentumBook(h.db).bookDrawdownOn, false)
  } finally { h.close() }
})
