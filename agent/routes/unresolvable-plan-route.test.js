// node --test agent/routes/unresolvable-plan-route.test.js
//
// GET /state/unresolvable-plan must be able to SHOW the write-off plan and must
// never be able to APPLY it.
//
// #513 shipped the sweep behind a `dryRun` default and told the owner to look
// at the plan first — with no way to look. This route closes that gap, and the
// thing worth pinning is not that it returns rows: it is that no request shape,
// including a hostile one, can turn a page load into a money-data write.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB } from '../db.js'
import stateRouter from './state.js'
import { noteBackfillAttempt, resetBackfillPacing } from '../services/pnl-backfill.js'

// Drive an account to the TOP backoff rung — the "we tried and gave up" half of
// the evidence. Without this every plan is empty and a no-write assertion
// proves nothing, because there was nothing to write.
function exhaust(accountId) {
  for (let i = 0; i < 8; i++) noteBackfillAttempt(accountId, { backfilled: 0, gap: 1 })
}

function server() {
  const db = initDB(':memory:')
  const app = express()
  app.use(express.json())
  app.use('/state', stateRouter(db))
  return new Promise(resolve => {
    const s = app.listen(0, () => resolve({
      db, close: () => s.close(),
      url: (p) => `http://127.0.0.1:${s.address().port}${p}`,
    }))
  })
}

// A closed trade with no realised P&L, `daysAgo` old.
function stuckTrade(db, { daysAgo = 30, account = '111', symbol = 'EURUSD', exit = null } = {}) {
  db.prepare(`
    INSERT INTO trades (symbol, side, status, entry_price, exit_price, net_pnl,
                        opened_at, closed_at, account_id)
    VALUES (?, 'BUY', 'closed', 100, ?, NULL,
            datetime('now', ?), datetime('now', ?), ?)
  `).run(symbol, exit, `-${daysAgo + 1} days`, `-${daysAgo} days`, account)
  return db.prepare('SELECT last_insert_rowid() AS id').get().id
}

const unresolvableCount = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM trades WHERE COALESCE(pnl_unresolvable,0) = 1').get().n

test('the plan is empty while the backfill has not given up on anything — and SAYS so', async () => {
  const s = await server()
  try {
    stuckTrade(s.db, { daysAgo: 60 })
    const r = await (await fetch(s.url('/state/unresolvable-plan'))).json()
    assert.equal(r.ok, true)
    assert.equal(r.readOnly, true)
    // exhaustedAccounts() is in-memory on a fresh process: nothing has been
    // attempted, so nothing qualifies. A 60-day-old stuck row still exists.
    assert.equal(r.found, 0)
    assert.deepEqual(r.exhaustedAccounts, [])
    // The distinction that matters: "nothing qualifies" is not "nothing stuck".
    assert.match(r.note, /not the same as nothing being stuck/)
  } finally { s.close() }
})

test('reading the plan never marks a row — no query shape can make it write', async () => {
  const s = await server()
  try {
    for (let i = 0; i < 3; i++) stuckTrade(s.db, { daysAgo: 90, account: String(100 + i) })
    assert.equal(unresolvableCount(s.db), 0)

    // Every shape a caller could reach for, including ones that look like they
    // might flip the sweep out of dry-run.
    for (const q of [
      '',
      '?horizonDays=1',
      '?dryRun=false',
      '?dryRun=0',
      '?apply=true',
      '?confirm=yes&dryRun=false',
      '?horizonDays=0',
      '?horizonDays=-5',
      '?horizonDays=abc',
      '?horizonDays=99999',
    ]) {
      const res = await fetch(s.url(`/state/unresolvable-plan${q}`))
      assert.equal(res.status, 200, q)
      const body = await res.json()
      assert.equal(body.readOnly, true, q)
      assert.equal(unresolvableCount(s.db), 0, `a write happened for ${q || '(no query)'}`)
    }
  } finally { s.close() }
})

test('horizonDays is clamped rather than trusted', async () => {
  const s = await server()
  try {
    // 0 / negative / non-numeric all fall back to the default rather than
    // listing rows that closed a minute ago — age IS the evidence here.
    for (const q of ['?horizonDays=0', '?horizonDays=-5', '?horizonDays=abc', '']) {
      const r = await (await fetch(s.url(`/state/unresolvable-plan${q}`))).json()
      assert.equal(r.horizonDays, 7, q)
    }
    const r1 = await (await fetch(s.url('/state/unresolvable-plan?horizonDays=1'))).json()
    assert.equal(r1.horizonDays, 1)
    const rBig = await (await fetch(s.url('/state/unresolvable-plan?horizonDays=99999'))).json()
    assert.equal(rBig.horizonDays, 365)
    const rFrac = await (await fetch(s.url('/state/unresolvable-plan?horizonDays=7.6'))).json()
    assert.equal(rFrac.horizonDays, 8)
  } finally { s.close() }
})

test('it reports what the veto is doing, so the plan is read in context', async () => {
  const s = await server()
  try {
    const r = await (await fetch(s.url('/state/unresolvable-plan'))).json()
    // Present and numeric, not merely truthy — 0 is the expected value here and
    // a truthiness check would pass on `undefined` too.
    assert.equal(typeof r.blocking.stillBlocking, 'number')
    assert.equal(r.blocking.alreadyWrittenOff, 0)
    assert.equal(typeof r.found, 'number')
    assert.equal(typeof r.withExitPrice, 'number')
  } finally { s.close() }
})

test('the payload carries no price or P&L figures — only what identifies a row', async () => {
  const s = await server()
  try {
    stuckTrade(s.db, { daysAgo: 40, exit: 1.2345 })
    const r = await (await fetch(s.url('/state/unresolvable-plan'))).json()
    // Whatever the plan contains, exit PRICE is reported only as a boolean:
    // the question is "could this be computed properly", not "what was it".
    const allowed = new Set(['id', 'symbol', 'side', 'accountId', 'closedAt', 'hasExitPrice'])
    for (const row of r.plan) {
      for (const k of Object.keys(row)) assert.ok(allowed.has(k), `unexpected field ${k}`)
    }
  } finally { s.close() }
})

test('WITH candidates: the plan lists them and STILL writes nothing', async () => {
  // The tests above run on an empty plan, which cannot prove much. This one
  // gives the route real rows to write off and checks it does not.
  resetBackfillPacing()
  const s = await server()
  try {
    const older = stuckTrade(s.db, { daysAgo: 40, account: '111', symbol: 'EURUSD', exit: 1.2345 })
    const noExit = stuckTrade(s.db, { daysAgo: 40, account: '111', symbol: 'GBPUSD', exit: null })
    // Same account, but INSIDE the horizon — age is half the evidence, so this
    // must not appear however exhausted the account is.
    stuckTrade(s.db, { daysAgo: 2, account: '111', symbol: 'USDJPY' })
    // Old enough, but on an account the backfill never gave up on.
    stuckTrade(s.db, { daysAgo: 40, account: '222', symbol: 'AUDUSD' })
    exhaust('111')

    const r = await (await fetch(s.url('/state/unresolvable-plan'))).json()
    assert.deepEqual(r.exhaustedAccounts, ['111'])
    assert.equal(r.found, 2, 'only the two old rows on the exhausted account')
    assert.deepEqual(r.plan.map(x => x.id).sort((a, b) => a - b), [older, noExit].sort((a, b) => a - b))
    assert.equal(r.withExitPrice, 1)
    assert.equal(r.plan.find(x => x.id === older).hasExitPrice, true)
    assert.equal(r.plan.find(x => x.id === noExit).hasExitPrice, false)
    assert.match(r.note, /Give-up evidence on 1 account/)

    // THE POINT: rows qualified, and not one was marked.
    assert.equal(unresolvableCount(s.db), 0)
    // Re-read repeatedly — still nothing.
    for (const q of ['', '?dryRun=false', '?apply=true']) {
      await fetch(s.url(`/state/unresolvable-plan${q}`))
      assert.equal(unresolvableCount(s.db), 0, q)
    }
  } finally { resetBackfillPacing(); s.close() }
})

test('a restart clears the give-up state, so the plan empties rather than persisting', async () => {
  // exhaustedAccounts() is in-memory on purpose: after a redeploy the right
  // bias is to retry, not to write off rows a fresh backfill might still fill.
  resetBackfillPacing()
  const s = await server()
  try {
    stuckTrade(s.db, { daysAgo: 40, account: '111' })
    exhaust('111')
    assert.equal((await (await fetch(s.url('/state/unresolvable-plan'))).json()).found, 1)
    resetBackfillPacing()                       // stands in for the restart
    const after = await (await fetch(s.url('/state/unresolvable-plan'))).json()
    assert.equal(after.found, 0)
    assert.deepEqual(after.exhaustedAccounts, [])
  } finally { resetBackfillPacing(); s.close() }
})

test('the plan is never served from the shared response cache', async () => {
  // Its answer depends on pnl-backfill's IN-MEMORY ladder, which no write
  // touches — so the cache's write-epoch invalidation cannot see it change.
  // This assertion is the guard: if someone drops the route back into the
  // cached set, the plan starts lying by up to ten seconds about which rows
  // are about to be written off.
  resetBackfillPacing()
  const s = await server()
  try {
    stuckTrade(s.db, { daysAgo: 40, account: '111' })
    exhaust('111')
    const first = await fetch(s.url('/state/unresolvable-plan'))
    assert.equal(first.headers.get('x-cache'), null)
    const second = await fetch(s.url('/state/unresolvable-plan'))
    assert.notEqual(second.headers.get('x-cache'), 'hit')
  } finally { resetBackfillPacing(); s.close() }
})
