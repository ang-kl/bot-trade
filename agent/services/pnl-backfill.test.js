// node --test agent/services/pnl-backfill.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillClosedPnl, shouldRunPnlBackfill } from './pnl-backfill.js'

const NOW = 1_700_000_000_000
// A closing deal as cTrader returns it: realised money on closePositionDetail,
// scaled by moneyDigits (2 → cents). executionTimestamp lets the fake API
// return it only in the matching weekly window, like the real wsGetDeals.
const deal = (positionId, grossCents, { swapCents = 0, commCents = 0, ts = NOW - 3_600_000 } = {}) => ({
  positionId,
  dealId: `${positionId}-${grossCents}`,
  executionTimestamp: ts,
  closePositionDetail: { grossProfit: grossCents, swap: swapCents, commission: commCents, moneyDigits: 2 },
})

// Window-aware fake of wsGetDeals: returns only the deals whose timestamp
// falls in [t0, t1), so the service's weekly chunking is exercised honestly
// (each deal surfaces in exactly one chunk, never double-counted).
const dealsApi = (all) => async (t0, t1) => ({ deal: all.filter(d => d.executionTimestamp >= t0 && d.executionTimestamp < t1) })

function seedClosed(db, { positionId, net = null }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?)`
  ).run(String(positionId), net)
}

test('fills NULL net_pnl on a broker-closed trade from its close deal', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 111, net: null })
  // gross -5000 cents = -$50, minus $2 commission → -$52 net.
  const getDeals = dealsApi([deal(111, -5000, { commCents: -200 })])

  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  const row = db.prepare(`SELECT net_pnl, gross_pnl FROM trades WHERE ctrader_position_id = '111'`).get()
  assert.equal(row.net_pnl, -52)
  assert.equal(row.gross_pnl, -50)
})

test('never overwrites a net_pnl the bot already stamped', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 222, net: 12.34 }) // bot-computed, must be preserved
  const getDeals = dealsApi([deal(222, -9999)]) // would say something else
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 0)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '222'`).get().net_pnl, 12.34)
})

test('aggregates partial closes (several deals) into one net figure', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 333, net: null })
  const getDeals = dealsApi([deal(333, 3000), deal(333, 1500, { swapCents: -100 })])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  // (30 + 15) gross, swap -1 → 44 net.
  const row = db.prepare(`SELECT net_pnl, gross_pnl FROM trades WHERE ctrader_position_id = '333'`).get()
  assert.equal(row.net_pnl, 44)
  assert.equal(row.gross_pnl, 45)
})

test('skips the broker round-trip entirely when no closed trade is missing P&L', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 444, net: 5 }) // already filled
  let called = false
  const getDeals = async () => { called = true; return { deal: [] } }
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(called, false, 'must not fetch deals when there is no gap')
  // `gap: 0` joined the shape when the caller gained the ability to tell
  // "nothing was missing" from "something was missing and would not fill" —
  // this test's point is the assertion above: NO broker call.
  assert.deepEqual(r, { backfilled: 0, attributed: 0, closingDeals: 0, scanned: 0, gap: 0 })
})

test('an open trade is never backfilled, even with a matching deal', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl) VALUES ('EURUSD','BUY','open','555',NULL)`).run()
  seedClosed(db, { positionId: 556, net: null }) // a real gap so the fetch runs
  const getDeals = dealsApi([deal(555, -1000), deal(556, 700)])
  await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id='555'`).get().net_pnl, null)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id='556'`).get().net_pnl, 7)
})

// shouldRunPnlBackfill: the trigger gap this fix closes. Before this fix,
// loop.js only checked closedDetected — a trade closed ONLY via the orphan
// sweep or the dedup sweep (reconciler.js) could never trigger the backfill
// and sat permanently excluded from Edge Health (alpha-decay.js's
// `net_pnl IS NOT NULL` read).
test('shouldRunPnlBackfill: true when closedDetected has entries (pre-existing path)', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [{ symbol: 'EURUSD' }], orphansClosed: [], dupsClosed: [] }), true)
})

test('shouldRunPnlBackfill: true when ONLY orphansClosed has entries — the fixed gap', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [{ tradeId: 1 }], dupsClosed: [] }), true)
})

test('shouldRunPnlBackfill: true when ONLY dupsClosed has entries — the fixed gap', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [], dupsClosed: [{ tradeId: 2 }] }), true)
})

test('shouldRunPnlBackfill: false when every reconcile path found nothing to close', () => {
  assert.equal(shouldRunPnlBackfill({ closedDetected: [], orphansClosed: [], dupsClosed: [] }), false)
})

test('shouldRunPnlBackfill: tolerates a missing/undefined result shape', () => {
  assert.equal(shouldRunPnlBackfill({}), false)
  assert.equal(shouldRunPnlBackfill(undefined), false)
})

test('end-to-end: a trade closed ONLY via the orphan-sweep path (net_pnl NULL, no closedDetected entry) gets backfilled once shouldRunPnlBackfill gates it on', async () => {
  const db = initDB(':memory:')
  // Simulates reconciler.js's orphan sweep: an open trade whose position
  // vanished at the broker gets marked closed directly, net_pnl left NULL —
  // this is the exact shape reconciler.test.js's orphan-sweep test produces.
  seedClosed(db, { positionId: 555, net: null })
  const reconcileResult = { closedDetected: [], orphansClosed: [{ tradeId: 1, symbol: 'GBPUSD', positionId: '555' }], dupsClosed: [] }

  assert.equal(shouldRunPnlBackfill(reconcileResult), true)
  const getDeals = dealsApi([deal(555, -1000, { commCents: -50 })])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(r.backfilled, 1)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '555'`).get().net_pnl, -10.5)
})

// ---------------------------------------------------------------------------
// ACCOUNT SCOPING (2026-07-29). Until this, the gap was counted across EVERY
// account while the deal history was fetched for exactly ONE — whichever was
// selected. On the M4 soak that meant 7 closed trades on 46130058, a deal list
// requested for 43097342, nothing matched, and a log line blaming
// "deal-history coverage" every cycle when the coverage was fine.
//
// It is a SAFETY gap, not a reporting one. Per this module's own header the
// daily-loss veto, equity stop, loss-streak cooldown, performance breaker and
// Kelly veto all key on realised P&L — so on every account except the selected
// one, all of those brakes were blind to broker-side stop-outs, which are
// exactly the losers that close at the broker.
// ---------------------------------------------------------------------------

function seedAcct(db, { positionId, accountId, net = null }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, account_id)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, ?)`
  ).run(String(positionId), net, accountId)
}

test('a non-selected account backfills from its OWN deal history', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', '43097342')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
  seedAcct(db, { positionId: 777, accountId: '46130058' })   // NOT the selected account

  const getDeals = dealsApi([deal(777, 2500, { commCents: -100 })])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '46130058' })
  assert.equal(r.backfilled, 1, 'the soak case: trades on one account, selection on another')
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '777'`).get().net_pnl, 24)
})

test('one account\'s deal list never fills another account\'s row', async () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', '43097342')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
  seedAcct(db, { positionId: 888, accountId: '46979908' })

  // Running the pass for a DIFFERENT account must leave that row alone, even
  // though the deal list happens to carry a matching position id.
  const getDeals = dealsApi([deal(888, 9999)])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '46130058' })
  assert.equal(r.backfilled, 0)
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '888'`).get().net_pnl, null)
})

test('the gap check is scoped too — no broker round-trip for an account with no gap', async () => {
  // Before scoping, ANY account's gap triggered a fetch for the selected one.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', '43097342')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
  seedAcct(db, { positionId: 999, accountId: '46130058' })   // a gap, on ANOTHER account
  let called = false
  const getDeals = async () => { called = true; return { deal: [] } }

  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '43097342' })
  assert.equal(called, false, 'this account has no gap — it must not call the broker')
  assert.equal(r.backfilled, 0)
})

test('a NULL-account row: deal evidence beats the selected-account presumption', async () => {
  // SUPERSEDED CONVENTION, deliberately (2026-07-31). This test used to assert
  // that a non-selected pass must never claim an unstamped row — the
  // "legacy rows belong to the selected account" presumption. That presumption
  // was for rows with NO evidence. Here the non-selected account's OWN deal
  // history contains the close (at the real broker, deal history is strictly
  // per-account), which is broker proof of which account executed it — and the
  // production cost of refusing that proof was one orphan row vetoing every
  // account for three days with no path to clear it.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO agent_state (key, value) VALUES ('ctrader_account_id', '43097342')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run()
  seedAcct(db, { positionId: 1001, accountId: null })

  const getDeals = dealsApi([deal(1001, 500)])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '46130058' })
  assert.equal(r.backfilled, 1, 'the account whose history holds the close claims the row')
  assert.equal(r.attributed, 1)
  const row = db.prepare(`SELECT account_id, net_pnl FROM trades WHERE ctrader_position_id = '1001'`).get()
  assert.equal(row.account_id, '46130058')
  assert.equal(row.net_pnl, 5)
  // A row with NO matching deal still stays with the selected account: the
  // presumption survives where there is no evidence to beat it.
  seedAcct(db, { positionId: 1002, accountId: null })
  const r2 = await backfillClosedPnl(db, {}, { getDeals: dealsApi([]), now: NOW, accountId: '46130058' })
  assert.equal(r2.backfilled, 0)
  assert.equal(db.prepare(`SELECT account_id FROM trades WHERE ctrader_position_id = '1002'`).get().account_id, null)
})

test('with no accountId passed, behaviour is unchanged for a single-account setup', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 1100, net: null })
  const getDeals = dealsApi([deal(1100, 1000)])
  assert.equal((await backfillClosedPnl(db, {}, { getDeals, now: NOW })).backfilled, 1)
})

// ---------------------------------------------------------------------------
// GAP-TRIGGERED ATTEMPTS (2026-07-29). The close-based trigger cannot see most
// closes: the reconcile feeding shouldRunPnlBackfill runs once, for the
// SELECTED account, so a position closing anywhere else never sets it.
// Measured on the M4 soak — Cocoa closed 12:14:30Z on 46130058 while 43097342
// was selected, and none of the eight closed trades gained a net_pnl even
// after the fetch itself was account-scoped (#494).
//
// The gate is now "is any closed trade missing its money?", a question about
// our own database that cannot be wrong about which account it asks. Pacing
// exists only so a PERMANENTLY unfillable row (closing deal outside the
// deal-history window) cannot buy a broker fetch per account every cycle.
// ---------------------------------------------------------------------------
import { dueForBackfill, noteBackfillAttempt, resetBackfillPacing } from './pnl-backfill.js'

test('backfillClosedPnl reports the GAP it saw, not just what it filled', async () => {
  // Without this, "nothing was missing" and "something was missing and the
  // broker had no matching close" are indistinguishable — and only the second
  // should ever cost a retry.
  const db = initDB(':memory:')
  assert.equal((await backfillClosedPnl(db, {}, { getDeals: dealsApi([]), now: NOW })).gap, 0)

  seedClosed(db, { positionId: 2001, net: null })
  const stuck = await backfillClosedPnl(db, {}, { getDeals: dealsApi([]), now: NOW })
  assert.equal(stuck.gap, 1, 'a gap the broker could not fill is still a gap')
  assert.equal(stuck.backfilled, 0)

  const ok = await backfillClosedPnl(db, {}, { getDeals: dealsApi([deal(2001, 1000)]), now: NOW })
  assert.equal(ok.backfilled, 1)
  assert.equal(ok.gap, 1)
})

test('pacing backs off only an account whose gap did NOT fill', () => {
  resetBackfillPacing()
  const T = 1_000_000
  assert.equal(dueForBackfill('A', T), true, 'an unseen account is always due')

  // Gap, nothing filled → step onto the ladder.
  noteBackfillAttempt('A', { backfilled: 0, gap: 3 }, T)
  assert.equal(dueForBackfill('A', T + 60_000), false, 'still inside the 5-minute step')
  assert.equal(dueForBackfill('A', T + 6 * 60_000), true)

  // Repeated failure lengthens the wait.
  noteBackfillAttempt('A', { backfilled: 0, gap: 3 }, T)
  noteBackfillAttempt('A', { backfilled: 0, gap: 3 }, T)
  assert.equal(dueForBackfill('A', T + 30 * 60_000), false, 'now past 15 minutes')

  // Anything filled resets it immediately — the account is healthy again.
  noteBackfillAttempt('A', { backfilled: 1, gap: 3 }, T)
  assert.equal(dueForBackfill('A', T), true)
})

test('an account with NO gap is never paced', () => {
  // Pacing a healthy account would delay the first real stop-out it ever has.
  resetBackfillPacing()
  noteBackfillAttempt('B', { backfilled: 0, gap: 0 }, 1_000_000)
  assert.equal(dueForBackfill('B', 1_000_000), true)
})

test('pacing is per account — one stuck account never delays another', () => {
  resetBackfillPacing()
  const T = 1_000_000
  noteBackfillAttempt('STUCK', { backfilled: 0, gap: 1 }, T)
  assert.equal(dueForBackfill('STUCK', T + 1000), false)
  assert.equal(dueForBackfill('HEALTHY', T + 1000), true,
    'a permanently unfillable row on one account must not blind the others')
})

test('the ladder is bounded — it cannot grow without limit', () => {
  resetBackfillPacing()
  const T = 1_000_000
  for (let i = 0; i < 50; i++) noteBackfillAttempt('C', { backfilled: 0, gap: 1 }, T)
  assert.equal(dueForBackfill('C', T + 6 * 3_600_000), true, 'capped at the 6-hour step')
})

// --- attribute-on-match (2026-07-31) ---------------------------------------
// The production three-day block: one closed row with account_id NULL vetoed
// every account, and the write-off path could never reach it. When an
// account's own deal history contains that row's close, the backfill now
// claims it — account + P&L in one write, both from broker facts.

function seedClosedOn(db, { positionId, accountId = null, net = null }) {
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, account_id)
     VALUES ('EURUSD', 'BUY', 'closed', ?, ?, ?)`
  ).run(String(positionId), net, accountId)
}

test('an unattributed row is claimed by the account whose deal history closed it', async () => {
  const db = initDB(':memory:')
  seedClosedOn(db, { positionId: 777, accountId: null })
  // A NON-selected account pass (selected is unset → acct comes from opts).
  const getDeals = dealsApi([deal(777, 2500)])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '47790949' })
  assert.equal(r.backfilled, 1)
  assert.equal(r.attributed, 1)
  const row = db.prepare(`SELECT account_id, net_pnl FROM trades WHERE ctrader_position_id = '777'`).get()
  assert.equal(row.account_id, '47790949')
  assert.equal(row.net_pnl, 25)
})

test('a row already attributed to ANOTHER account is never re-claimed', async () => {
  const db = initDB(':memory:')
  seedClosedOn(db, { positionId: 888, accountId: '46130058' })
  const getDeals = dealsApi([deal(888, 1000)])
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW, accountId: '47790949' })
  // The scoped update misses (wrong account) and the claim must not touch an
  // ATTRIBUTED row — its account is a fact someone recorded; only its P&L may
  // arrive later, via its OWN account's pass.
  assert.equal(r.backfilled, 0)
  assert.equal(r.attributed, 0)
  const row = db.prepare(`SELECT account_id, net_pnl FROM trades WHERE ctrader_position_id = '888'`).get()
  assert.equal(row.account_id, '46130058')
  assert.equal(row.net_pnl, null)
})
