// node --test agent/services/pnl-backfill.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillClosedPnl, shouldRunPnlBackfill, noteTradeAttempts } from './pnl-backfill.js'

const NOW = 1_700_000_000_000
// A closing deal as cTrader returns it: realised money on closePositionDetail,
// scaled by moneyDigits (2 → cents). executionTimestamp lets the fake API
// return it only in the matching weekly window, like the real wsGetDeals.
// V3 F5 (B1 N6): a FILLED deal (dealStatus 2) with its closed volume, so a
// fixture can form a whole lifecycle; `vol` defaults to 100 units.
const deal = (positionId, grossCents, { swapCents = 0, commCents = 0, ts = NOW - 3_600_000, vol = 100 } = {}) => ({
  positionId,
  dealId: `${positionId}-${grossCents}`,
  executionTimestamp: ts,
  dealStatus: 2,
  filledVolume: vol,
  closePositionDetail: { grossProfit: grossCents, swap: swapCents, commission: commCents, moneyDigits: 2, closedVolume: vol },
})

// The opening deal of every position that has closing deals in `closes`:
// one FILLED deal, a minute before the first close, for the whole closed
// volume. Money is written only from a complete lifecycle on EVERY window pass
// now (V3 F5, B1 checker N6), so a fixture that means "the broker closed this
// position" must show the broker opening it too.
const openingsFor = (closes) => {
  const byPid = new Map()
  for (const d of closes) {
    if (!d.closePositionDetail) continue
    const k = String(d.positionId)
    const o = byPid.get(k) || { positionId: d.positionId, ts: Infinity, vol: 0 }
    o.ts = Math.min(o.ts, d.executionTimestamp); o.vol += Number(d.closePositionDetail.closedVolume)
    byPid.set(k, o)
  }
  return [...byPid.values()].map(o => ({ positionId: o.positionId, dealId: `${o.positionId}-open`,
    executionTimestamp: o.ts - 60_000, dealStatus: 2, filledVolume: o.vol }))
}

// Window-aware fake of wsGetDeals: returns only the deals whose timestamp
// falls in [t0, t1), so the service's weekly chunking is exercised honestly
// (each deal surfaces in exactly one chunk, never double-counted). Each
// position's opening deal rides with its closes (openingsFor).
const closingOnlyApi = (all) => async (t0, t1) => ({ deal: all.filter(d => d.executionTimestamp >= t0 && d.executionTimestamp < t1) })
const dealsApi = (all) => closingOnlyApi([...openingsFor(all), ...all])

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
  // `exitsFilled` and `dealsPersisted` joined 08-08 with the missing-exit fill
  // and the deal receipt. Kept as a deepEqual on purpose: the early-return
  // shape must stay in step with the success shape, and the one time it did
  // not, a caller read `undefined` as zero work done.
  assert.deepEqual(r, {
    backfilled: 0, attributed: 0, exitsRepaired: 0, exitsFilled: 0, dealsPersisted: 0,
    closingDeals: 0, scanned: 0, gap: 0, liveGap: 0, blockingGap: 0,
  })
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

// --- the blocked desk paces the repair (2026-08-07) -------------------------
//
// MEASURED 06-08 22:38 UTC: 194 of the last 200 decisions vetoed
// `unknown_daily_pnl`, off ONE trade closed 22:09:46 — 29 minutes old, inside
// every write-off rule. The veto engages at the 15m grace window while the
// ladder had already backed the repair off to an hour. These lock that in.

test('a BLOCKING row caps the backoff at the grace window', () => {
  resetBackfillPacing()
  const T = 1_000_000
  // Four non-filling passes would normally reach the 6-hour rung.
  for (let i = 0; i < 4; i++) {
    noteBackfillAttempt('BLOCKED', { backfilled: 0, gap: 1, liveGap: 1, blockingGap: 1 }, T)
  }
  assert.equal(dueForBackfill('BLOCKED', T + 14 * 60_000), false,
    'still not due inside the grace window — we do not ask for history that is not yet late')
  assert.equal(dueForBackfill('BLOCKED', T + 15 * 60_000), true,
    'due at the grace window: a desk blocked at 15m must be retried at 15m, not in six hours')
})

test('the cap applies only while something is actually blocking', () => {
  resetBackfillPacing()
  const T = 1_000_000
  // Same four passes, but nothing is past the grace window yet.
  for (let i = 0; i < 4; i++) {
    noteBackfillAttempt('QUIET', { backfilled: 0, gap: 1, liveGap: 1, blockingGap: 0 }, T)
  }
  assert.equal(dueForBackfill('QUIET', T + 60 * 60_000), false,
    'no block, no acceleration — the ladder backs off exactly as it did before')
  assert.equal(dueForBackfill('QUIET', T + 6 * 3_600_000), true)
})

test('the rung still climbs while capped — the cap delays, it does not reset', () => {
  resetBackfillPacing()
  const T = 1_000_000
  for (let i = 0; i < 4; i++) {
    noteBackfillAttempt('CLIMB', { backfilled: 0, gap: 1, liveGap: 1, blockingGap: 1 }, T)
  }
  // The block clears (row filled elsewhere, or aged out) but the gap remains:
  // the account must resume at the rung it had climbed to, not at the bottom.
  const next = noteBackfillAttempt('CLIMB', { backfilled: 0, gap: 1, liveGap: 1, blockingGap: 0 }, T)
  assert.equal(next.n, 4, 'the rung was never rewound by the cap')
  assert.equal(dueForBackfill('CLIMB', T + 60 * 60_000), false, 'back to the six-hour wait')
})

test('a caller that predates blockingGap behaves exactly as before', () => {
  resetBackfillPacing()
  const T = 1_000_000
  for (let i = 0; i < 4; i++) noteBackfillAttempt('OLD', { backfilled: 0, gap: 1 }, T)
  assert.equal(dueForBackfill('OLD', T + 60 * 60_000), false,
    'absent field means no claim of blocking, so pacing is untouched')
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

// ---------------------------------------------------------------------------
// THE LADDER MUST NOT BE PACED BY ROWS NOBODY CAN FIX.
//
// Measured 04-08-2026 in production: unknown_daily_pnl was 34,818 of 56,304
// vetoes over seven days. The rows actually blocking were FRESH — 17 trades
// closed inside the previous 78 minutes — and they were blocking because their
// P&L had not arrived for over an hour. It had not arrived because three rows
// on that account sit at 42 failed attempts and can never fill, and those three
// were counted in the "did this pass get stuck" test, ratcheting the account to
// the six-hour retry rung and holding it there.
// ---------------------------------------------------------------------------

test('a pass that only failed on written-off rows does NOT step the ladder', () => {
  resetBackfillPacing()
  // gap 3 (all dead), liveGap 0 → nothing a retry could have helped.
  const step = noteBackfillAttempt('46130058', { backfilled: 0, gap: 3, liveGap: 0 })
  assert.equal(step.n, 0, 'dead rows must not cost a rung')
  assert.equal(dueForBackfill('46130058'), true, 'and the next cycle may fetch immediately')
})

test('a pass that failed on a LIVE row still steps the ladder', () => {
  resetBackfillPacing()
  const step = noteBackfillAttempt('46130058', { backfilled: 0, gap: 4, liveGap: 1 })
  assert.equal(step.n, 1, 'a repairable row that did not repair is the case backoff is for')
})

test('three dead rows can no longer park an account on the six-hour rung', () => {
  // The production shape, run forward: every pass fails, but only on rows the
  // repair has already given up on. Before this change each pass cost a rung
  // and by the fifth the account was fetching deal history every six hours —
  // so every fresh close waited six hours for a figure that would otherwise
  // have arrived in one cycle, blocking entries the whole time.
  resetBackfillPacing()
  for (let i = 0; i < 8; i++) noteBackfillAttempt('46130058', { backfilled: 0, gap: 3, liveGap: 0 })
  assert.equal(dueForBackfill('46130058'), true)
})

test('a caller that predates liveGap keeps the old behaviour exactly', () => {
  // Falls back to `gap`, so this is preserved rather than silently loosened.
  resetBackfillPacing()
  assert.equal(noteBackfillAttempt('x', { backfilled: 0, gap: 2 }).n, 1)
})

test('filling something always resets the ladder, dead rows present or not', () => {
  resetBackfillPacing()
  noteBackfillAttempt('y', { backfilled: 0, gap: 5, liveGap: 5 })
  const step = noteBackfillAttempt('y', { backfilled: 1, gap: 4, liveGap: 4 })
  assert.equal(step.n, 0)
})

test('liveGap excludes written-off and exhausted rows, and gap still counts them', async () => {
  const db = initDB(':memory:')
  const ins = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, opened_at, closed_at, ctrader_position_id, account_id, net_pnl, pnl_attempts, pnl_unresolvable)
    VALUES (?, 'BUY', 1.1, 'closed', datetime('now'), datetime('now'), ?, '46130058', NULL, ?, ?)
  `)
  ins.run('GBPJPY', '101', 42, 0)     // exhausted — 42 attempts, never filled
  ins.run('GBPCNH', '102', 42, 0)     // exhausted
  ins.run('0066.HK', '103', 3, 1)     // written off outright
  ins.run('EURUSD', '104', 1, 0)      // FRESH — the one a retry could help

  const out = await backfillClosedPnl(db, {}, {
    accountId: '46130058',
    getDeals: async () => ({ deal: [] }),      // broker returns nothing
  })
  assert.equal(out.gap, 4, 'the hole in the ledger is still four rows wide')
  assert.equal(out.liveGap, 1, 'but only one of them is worth asking about again')

  // …and that one live row is what decides the pacing.
  resetBackfillPacing()
  assert.equal(noteBackfillAttempt('46130058', out).n, 1)
})

// ---------------------------------------------------------------------------
// EXIT-PRICE REPAIR (go-live Phase 0, P0-1)
//
// 56 of 190 decidable closed rows carry an exit_price that contradicts their
// own P&L. The deal history is the only source that can settle them, and this
// module is already fetching it.
// ---------------------------------------------------------------------------

// A closing deal that also carries the price and size it executed at.
const pricedDeal = (positionId, grossCents, px, vol, opts = {}) => ({
  // The broker's volume is an integer (hundredths of a unit); `volume` below
  // stays the fixture's own weighting figure, as before.
  ...deal(positionId, grossCents, { vol: Math.round(vol * 100), ...opts }),
  executionPrice: px,
  volume: vol,
})

function seedMismatch(db, { positionId, side = 'BUY', entry, exit, sl, net, acct = '46130058', flag = 1 }) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, status,
                         opened_at, closed_at, net_pnl, ctrader_position_id, account_id, pnl_price_mismatch)
     VALUES ('JPN225', ?, ?, ?, ?, 1, 'closed', '2026-08-04 05:18:21', '2026-08-04 05:50:42', ?, ?, ?, ?)`
  ).run(side, entry, exit, sl, net, String(positionId), acct, flag).lastInsertRowid
}

test('a flagged row gets the DEAL price, and the flag clears', async () => {
  // The JPN225 shape: a long booked at a profit with an exit BELOW its entry.
  // net_pnl is broker truth and stays; the price is what gets repaired.
  const db = initDB(':memory:')
  const id = seedMismatch(db, { positionId: 234866462, entry: 63557.3, exit: 63404.5, sl: 62031.9, net: 14259.55 })
  const r = await backfillClosedPnl(db, {}, {
    getDeals: dealsApi([pricedDeal(234866462, 1425955, 63814.8, 55.57)]),
    now: NOW,
  })
  assert.equal(r.exitsRepaired, 1)
  const t = db.prepare(`SELECT exit_price, net_pnl, pnl_price_mismatch, realised_rr FROM trades WHERE id = ?`).get(id)
  assert.equal(Math.round(t.exit_price * 10) / 10, 63814.8, 'the deal price, not the snapshot')
  assert.equal(t.net_pnl, 14259.55, 'broker P&L untouched — it was never the wrong half')
  assert.equal(t.pnl_price_mismatch, 0, 'and the row now agrees with itself')
  assert.ok(t.realised_rr > 0, 'realised R recomputed from the repaired price')
})

test('a SOUND row is never touched, however many deals arrive', async () => {
  const db = initDB(':memory:')
  const id = seedMismatch(db, { positionId: 999, entry: 100, exit: 110, sl: 98, net: 120, flag: 0 })
  const r = await backfillClosedPnl(db, {}, {
    getDeals: dealsApi([pricedDeal(999, 12000, 9.9999, 1)]),
    now: NOW,
  })
  assert.equal(r.exitsRepaired, 0)
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE id = ?`).get(id).exit_price, 110)
})

test('THE GATE: a repairable row is reason enough to fetch, with no P&L missing', async () => {
  // The bug this file caught in its own first run. Every one of the 56
  // contradicting rows HAS its P&L, so a gate that only asked "is any P&L
  // missing" would have skipped the round-trip forever and the repair would
  // never once have fired in production.
  const db = initDB(':memory:')
  seedMismatch(db, { positionId: 777, entry: 100, exit: 90, sl: 98, net: 500 })
  let asked = false
  const r = await backfillClosedPnl(db, {}, {
    getDeals: async (t0, t1) => {
      asked = true
      return dealsApi([pricedDeal(777, 50000, 106, 1)])(t0, t1)
    },
    now: NOW,
  })
  assert.equal(asked, true, 'the broker WAS asked')
  assert.equal(r.exitsRepaired, 1)
})

test('a partial-close scale-out resolves to a VOLUME-WEIGHTED exit', async () => {
  // Two closing deals at different prices. Taking whichever came last would
  // report a price the position never averaged.
  const db = initDB(':memory:')
  const id = seedMismatch(db, { positionId: 888, entry: 100, exit: 90, sl: 98, net: 300 })
  await backfillClosedPnl(db, {}, {
    getDeals: dealsApi([
      pricedDeal(888, 10000, 110, 1),
      pricedDeal(888, 20000, 120, 3, { ts: NOW - 3_500_000 }),
    ]),
    now: NOW,
  })
  // (110*1 + 120*3) / 4 = 117.5
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE id = ?`).get(id).exit_price, 117.5)
})

test('a deal with no price leaves the flagged row alone rather than writing zero', async () => {
  const db = initDB(':memory:')
  const id = seedMismatch(db, { positionId: 666, entry: 100, exit: 90, sl: 98, net: 500 })
  const r = await backfillClosedPnl(db, {}, {
    getDeals: dealsApi([deal(666, 50000)]),   // no executionPrice, no volume
    now: NOW,
  })
  assert.equal(r.exitsRepaired, 0)
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE id = ?`).get(id).exit_price, 90,
    'a known-wrong price is still better than an invented zero')
})


// ---------------------------------------------------------------------------
// 08-08-2026. Three changes, each guarding against the SAME mistake this file
// has now made twice: a repair that ships behind a gate which cannot see the
// rows it was written for. So the GATE is what these test, not just the write.
// ---------------------------------------------------------------------------

test('the magnitude flag alone makes the pass fetch — #691 shipped behind a blind gate', async () => {
  const db = initDB(':memory:')
  // P&L present, so NOT in `gap`. Sign-consistent, so NOT pnl_price_mismatch.
  // Only exit_price_suspect marks it: the exact row #691 widened the repair
  // for, and the exact row the old gate refused to fetch for.
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, entry_price, exit_price, volume, net_pnl,
       pnl_price_mismatch, exit_price_suspect, closed_at)
     VALUES ('EURUSD','BUY','closed','9101', 100, 101, 1, 50, 0, 1, datetime('now','-1 day'))`
  ).run()
  let called = false
  const api = dealsApi([pricedDeal(9101, 5000, 150, 1)])
  const getDeals = async (t0, t1) => { called = true; return api(t0, t1) }
  const r = await backfillClosedPnl(db, {}, { getDeals, now: NOW })
  assert.equal(called, true, 'a suspect row is work to do')
  assert.equal(r.exitsRepaired, 1)
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE ctrader_position_id='9101'`).get().exit_price, 150)
})

test('an ABSENT exit price is filled from broker truth, counted apart from a repair', async () => {
  const db = initDB(':memory:')
  // reconciler.js:392's shape — the dominant close path leaves BOTH null. The
  // money filled via `gap`; the price was left for ever, because no audit
  // flags a NULL and the repair only touched flagged rows.
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, entry_price, exit_price, volume, net_pnl, closed_at)
     VALUES ('EURUSD','BUY','closed','9102', 100, NULL, 1, NULL, datetime('now','-1 day'))`
  ).run()
  const r = await backfillClosedPnl(db, {}, { getDeals: dealsApi([pricedDeal(9102, -2500, 97.5, 1)]), now: NOW })
  assert.equal(r.backfilled, 1, 'money filled as before')
  assert.equal(r.exitsFilled, 1, 'and now the price too')
  assert.equal(r.exitsRepaired, 0, 'a fill is not a repair — the buckets stay distinct')
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE ctrader_position_id='9102'`).get().exit_price, 97.5)
})

test('money landing on a row whose exit arrived first still stamps realised R', async () => {
  // THE RACE (02-09-2026). Two writers land a broker-side close's exit price:
  // this service's fill, which re-stamped R, and the loop's price-reconcile
  // step, which did not — and runs every cycle, so it usually won. When it
  // did, the row reached this pass with exit PRESENT and money NULL; the
  // money filled, the exit-fill found nothing to do, and the only re-stamp
  // sat behind it. Ten of twelve bot closes carried no R for exactly this.
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, entry_price, exit_price, sl_price, volume, net_pnl, realised_rr, pnl_price_mismatch, closed_at)
     VALUES ('NATGAS','BUY','closed','239675091', 2.933, 2.919, 2.9144642857142857, 1, NULL, NULL, 0, datetime('now','-1 day'))`
  ).run()
  const r = await backfillClosedPnl(db, {}, { getDeals: dealsApi([pricedDeal(239675091, -49840, 2.919, 1)]), now: NOW })
  assert.equal(r.backfilled, 1)
  assert.equal(r.exitsFilled, 0, 'the exit was already there — nothing to fill')
  const row = db.prepare(`SELECT net_pnl, realised_rr, pnl_price_mismatch FROM trades WHERE ctrader_position_id='239675091'`).get()
  assert.equal(row.net_pnl, -498.4)
  assert.ok(Number.isFinite(row.realised_rr) && row.realised_rr < 0, `R must be stamped once the money lands, got ${row.realised_rr}`)
  assert.equal(row.pnl_price_mismatch, 0)
})

test('a PRESENT and unflagged exit price is never overwritten', async () => {
  const db = initDB(':memory:')
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, entry_price, exit_price, volume, net_pnl, closed_at)
     VALUES ('EURUSD','BUY','closed','9103', 100, 101, 1, NULL, datetime('now','-1 day'))`
  ).run()
  const r = await backfillClosedPnl(db, {}, { getDeals: dealsApi([pricedDeal(9103, 5000, 150, 1)]), now: NOW })
  assert.equal(r.exitsFilled, 0)
  assert.equal(r.exitsRepaired, 0)
  assert.equal(db.prepare(`SELECT exit_price FROM trades WHERE ctrader_position_id='9103'`).get().exit_price, 101,
    'filling a NULL is broker truth; overwriting a value is a different claim')
})

test('a missing exit OUTSIDE the fetch window does not pin the gate open', async () => {
  const db = initDB(':memory:')
  // Money present, price absent, closed 60 days ago against a 14-day fetch.
  // No deal exists to fill from, so counting it as work would mean a broker
  // round-trip every cycle, for ever, achieving nothing.
  db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, entry_price, exit_price, volume, net_pnl, closed_at)
     VALUES ('EURUSD','BUY','closed','9104', 100, NULL, 1, 25, datetime('now','-60 days'))`
  ).run()
  let called = false
  const getDeals = async () => { called = true; return { deal: [] } }
  await backfillClosedPnl(db, {}, { getDeals, now: NOW, days: 14 })
  assert.equal(called, false, 'unfillable is not work to do')
})

test('the fetched deals are persisted, so a P&L can be checked against its source', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 9105, net: null })
  const r = await backfillClosedPnl(db, {}, { getDeals: dealsApi([pricedDeal(9105, -3000, 99, 1)]), now: NOW })
  assert.equal(r.backfilled, 1)
  assert.ok(r.dealsPersisted >= 1, `dealsPersisted was ${r.dealsPersisted}`)
  // The receipt. /state/broker-deals returned ZERO rows for position 234799435
  // — the 9,171.76 trade — because these were fetched, used and discarded, so
  // the one number every risk brake keys on was unverifiable after the fact.
  assert.ok(db.prepare(`SELECT COUNT(*) AS c FROM broker_deals WHERE position_id = '9105'`).get().c >= 1,
    'the deal that produced the number is now on record')
})

test('a persistence failure never fails the backfill — the receipt is not the job', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 9106, net: null })
  db.exec('DROP TABLE broker_deals')   // make the receipt impossible
  const r = await backfillClosedPnl(db, {}, { getDeals: dealsApi([pricedDeal(9106, -1000, 99, 1)]), now: NOW })
  assert.equal(r.backfilled, 1, 'the P&L still filled')
  assert.equal(r.dealsPersisted, 0)
})

// ---------------------------------------------------------------------------
// 02-09-2026 (codebase audit). The pnl_reconcile heartbeat's `ok` was a count
// compared to zero — true unless the SQL threw — so the failure its own
// comment described could never be reported.
// ---------------------------------------------------------------------------
import { pnlReconciliationState, pnlUnreachedRows, pnlReconcileHeartbeat } from './pnl-backfill.js'
import { readFileSync } from 'node:fs'

test('pnlReconciliationState separates "never tried, just closed" from "never tried, overdue"', () => {
  const db = initDB(':memory:')
  const ins = (closedAgoMin, attempts) => db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, status, opened_at, closed_at, ctrader_position_id, account_id, net_pnl, pnl_attempts)
    VALUES ('EURUSD','BUY',1.1,'closed', datetime('now','-2 hours'), datetime('now', ?), '1', '47790949', NULL, ?)`
  ).run(`-${closedAgoMin} minutes`, attempts)
  ins(1, 0)     // closed a minute ago, not yet reached — not a failure
  ins(40, 0)    // closed 40 min ago, never attempted — the repair is not reaching it
  ins(60, 7)    // tried seven times — a broker fact, not ours
  const st = pnlReconciliationState(db)
  assert.equal(st.unresolved, 3)
  assert.equal(st.neverTried, 2)
  assert.equal(st.neverTriedOverdue, 1)
  assert.equal(pnlReconciliationState(db, { overdueMin: 0 }).neverTriedOverdue, 2)
})

test('pnlUnreachedRows names only overdue, repairable, never-attempted identities', () => {
  const db = gapDb()
  const rows = pnlUnreachedRows(db)
  assert.deepEqual(rows.map(r => r.id), [905])
  assert.equal(rows[0].symbol, 'NAS100')
  assert.equal(rows[0].accountId, '111')
})

// V3 I1 (25-09-2026) moved `ok` from "no overdue never-tried rows" to "the
// pass completed": keying on records held the controller in error for four
// days on two rows it reached every pass. The 02-09 point still stands — the
// beat must be ABLE to fail — and is now shown by behaviour, not by a pin on
// the old predicate (pnl-reconcile-stall.test.js has the full contract).
test('the pnl_reconcile heartbeat can actually fail: a pass that fails on any account, or unreadable state (behaviour)', () => {
  const st = { unresolved: 1, neverTriedOverdue: 1 }
  assert.equal(pnlReconcileHeartbeat(st, { attempted: 2, completed: 0, failures: [{ accountId: '1', error: 'x' }] }).ok, false)
  // V3 I1 checker B1: one account failing is not masked by another completing.
  assert.equal(pnlReconcileHeartbeat(st, { attempted: 2, completed: 1, failures: [{ accountId: '1', error: 'x' }] }).ok, false)
  assert.equal(pnlReconcileHeartbeat({ unresolved: -1 }, { attempted: 1, completed: 1 }).ok, false)
  assert.equal(pnlReconcileHeartbeat(st, { attempted: 2, completed: 2 }).ok, true, 'a completed pass is not a failure because a record is unpriced')
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  assert.match(src, /verdict\.detail\.unreachedRows = pnlUnreachedRows\(db, \{ limit: 10 \}\)/, 'unreached rows are still named in the detail')
  assert.doesNotMatch(src, /ok: st\.unresolved >= 0,/, 'the old predicate — a count compared to zero — must be gone')
})

// ---------------------------------------------------------------------------
// pnlGapBreakdown (PR-W, owner order 17-09-2026 "fix the 20 unknown P&L").
//
// The production line read "20 closed trade(s) still missing net_pnl … deal
// history had no matching close" every cycle. The count was a bare
// COUNT(*) WHERE net_pnl IS NULL with no qualification, so it included rows
// sweepUnresolvable had already written off — and the sentence asserted
// broker coverage for rows nobody had asked the broker about.
// ---------------------------------------------------------------------------
import { pnlGapBreakdown } from './pnl-backfill.js'

function gapDb() {
  const db = initDB(':memory:')
  db.exec(`INSERT INTO trades (id, symbol, status, closed_at, net_pnl, account_id, pnl_attempts, pnl_unresolvable) VALUES
    (901, 'GBPJPY',  'closed', datetime('now','-40 days'), NULL, '111', 42, 1),
    (902, 'GBPCNH',  'closed', datetime('now','-40 days'), NULL, '111', 42, 1),
    (903, '0066.HK', 'closed', datetime('now','-40 days'), NULL, '111', 42, 1),
    (904, 'EURUSD',  'closed', datetime('now','-2 hours'), NULL, '111',  3, 0),
    (905, 'NAS100',  'closed', datetime('now','-2 hours'), NULL, '111',  0, 0),
    (906, 'BTCUSD',  'closed', datetime('now','-10 seconds'), NULL, '111', 0, 0),
    (907, 'AAPL.US', 'closed', datetime('now','-1 hours'), -12.5, '111', 1, 0)`)
  return db
}

test('pnlGapBreakdown separates written-off rows from rows still worth repairing', () => {
  const g = pnlGapBreakdown(gapDb())
  assert.equal(g.total, 6, 'every closed row with no P&L — the ledger is honestly this incomplete')
  assert.equal(g.writtenOff, 3, 'the three the broker has no history for, already given up on with a reason')
  assert.equal(g.live, 3, 'and only these are still repairable — the number the old line should have printed')
})

test('a row nobody has asked about says nothing about broker coverage', () => {
  const g = pnlGapBreakdown(gapDb())
  // 905 (2h, never tried) and 906 (10s, never tried) have pnl_attempts = 0.
  assert.equal(g.neverTried, 2)
  // …but only the 2-hour-old one is OVERDUE: a row closed seconds ago is not a
  // failure, the paced pass may simply not have reached it.
  assert.equal(g.neverTriedOverdue, 1)
  // Exactly one row was actually asked for and came back empty. That is the
  // only row the phrase "deal history had no matching close" was ever true of.
  assert.equal(g.attempted, 1)
})

test('all-written-off reads as nothing left to repair, not as a broken repair', () => {
  const db = initDB(':memory:')
  db.exec(`INSERT INTO trades (id, symbol, status, closed_at, net_pnl, account_id, pnl_attempts, pnl_unresolvable) VALUES
    (911, 'GBPJPY', 'closed', datetime('now','-40 days'), NULL, '111', 42, 1),
    (912, 'GBPCNH', 'closed', datetime('now','-40 days'), NULL, '111', 42, 1)`)
  const g = pnlGapBreakdown(db)
  assert.equal(g.total, 2)
  assert.equal(g.live, 0, 'the repair has finished; the ledger is incomplete and says so')
  assert.equal(g.writtenOff, 2)
})

test('an empty ledger is zero everywhere, not an error', () => {
  const g = pnlGapBreakdown(initDB(':memory:'))
  assert.equal(g.total, 0)
  assert.equal(g.live, 0)
  assert.equal(g.error, false)
})

test('the loop prints the breakdown, not the bare count', () => {
  // CLAUDE.md failure mode #4: the helper is invisible from here and a
  // refactor drops the call in silence, restoring the misleading line.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert.match(src, /pnlGapBreakdown\(db\)/)
  assert.match(src, /still repairable/)
  assert.match(src, /never attempted/)
  assert.doesNotMatch(src, /\$\{gapBefore\} closed trade\(s\) still missing net_pnl/,
    'the old unqualified sentence must be gone, not merely supplemented')
})


// V3 I1: overdue never-attempted rows are a notice now, not a heartbeat
// failure — and their identities are still logged whenever they exist.
test('the loop logs exact overdue P&L identities whenever the reconciliation notice is raised', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(src, /if \(verdict\.detail\.notice\) \{\s+verdict\.detail\.unreachedRows = pnlUnreachedRows\(db, \{ limit: 10 \}\)\s+log\(`P&L reconciliation not-yet-attempted rows:/)
  assert.match(src, /JSON\.stringify\(verdict\.detail\.unreachedRows\)/)
})

// ---------------------------------------------------------------------------
// V3 F5 (B1 checker N6): the lifecycle rule on the NON-STRICT window path.
// B1 wrote money only from a complete lifecycle on strict calls; the
// non-strict path (no production caller today) still summed whatever closing
// deals one window returned. Each test's control has the same closes WITH the
// opening, so the refusal is the rule and not a broken fixture.
// ---------------------------------------------------------------------------

test('F5 N6: non-strict window pass — closing deals without their opening write NO money; the position is reported deferred', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 4401, net: null })
  const r = await backfillClosedPnl(db, {}, { getDeals: closingOnlyApi([deal(4401, -5000, { vol: 100 })]), now: NOW })
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '4401'`).get().net_pnl, null, 'no lifecycle, no money')
  assert.equal(r.backfilled, 0)
  assert.equal(r.deferred, 1)
  assert.deepEqual(r.deferredPositions, ['4401'])
  assert.equal(r.lifetimeSkipped, undefined, 'the strict-only field is not claimed on the non-strict path')
  // Control: the same close with its opening among the deals is written.
  const ok = initDB(':memory:')
  seedClosed(ok, { positionId: 4401, net: null })
  const w = await backfillClosedPnl(ok, {}, { getDeals: dealsApi([deal(4401, -5000, { vol: 100 })]), now: NOW })
  assert.equal(ok.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '4401'`).get().net_pnl, -50)
  assert.equal(w.backfilled, 1)
  assert.equal(w.deferred, undefined, 'nothing deferred, nothing reported')
})

test('F5 N6: non-strict — the probe-p5bd tail (opening and first partial before the window) is deferred, not paid 50 of 150', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 4402, net: null })
  const old = NOW - 20 * 86_400_000 // before the 14-day window
  const all = [
    { positionId: 4402, dealId: '4402-open', executionTimestamp: old, dealStatus: 2, filledVolume: 300 },
    deal(4402, 10000, { vol: 100, ts: old + 60_000 }),          // first partial, outside the window
    { ...deal(4402, 5000, { vol: 200 }), dealId: '4402-tail' }, // the tail, inside it
  ]
  const r = await backfillClosedPnl(db, {}, { getDeals: closingOnlyApi(all), now: NOW })
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '4402'`).get().net_pnl, null,
    'the window shows 50 of a 150 lifetime; nothing is written')
  assert.deepEqual(r.deferredPositions, ['4402'])
  // Control: a window that reaches back to the opening writes the whole 150.
  const whole = initDB(':memory:')
  seedClosed(whole, { positionId: 4402, net: null })
  await backfillClosedPnl(whole, {}, { getDeals: closingOnlyApi(all), now: NOW, days: 30 })
  assert.equal(whole.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '4402'`).get().net_pnl, 150)
})

test('F5 N6: a deferred position is not charged a backfill attempt on the non-strict path', async () => {
  const db = initDB(':memory:')
  seedClosed(db, { positionId: 4403, net: null })
  seedClosed(db, { positionId: 4404, net: null })
  await backfillClosedPnl(db, {}, { getDeals: closingOnlyApi([deal(4403, -5000)]), now: NOW })
  const attempts = pid => db.prepare(`SELECT COALESCE(pnl_attempts, 0) AS n FROM trades WHERE ctrader_position_id = ?`).get(pid).n
  assert.equal(db.prepare(`SELECT net_pnl FROM trades WHERE ctrader_position_id = '4403'`).get().net_pnl, null, 'deferred, not written')
  // Non-strict has no per-position reader: the row stays NULL and uncharged
  // until a strict pass settles it (the known gap noted in pnl-backfill.js).
  assert.equal(attempts('4403'), 0, 'deferred: no attempt spent; left NULL for a strict pass to settle')
  assert.equal(attempts('4404'), 1, 'control: a row the pass could not match is charged, as before')
})

// ---------------------------------------------------------------------------
// checker fix round, B1: UI-5 / RS-1's "stop re-stamping written-off rows"
// is noteTradeAttempts's pnl_attempts counter (see that function's own
// comment), NOT restampPosition — restampPosition MUST still stamp a
// written-off row, because old-position-pnl.js's settle path writes the
// money and calls restampPosition BEFORE it clears pnl_unresolvable, and a
// row excluded there would settle with no verdict at all (measured in
// pnl-reconcile-stall.test.js's R4 fixture, row 9: pnl_price_mismatch 0 on
// base, NULL when restampPosition wrongly excluded it).
// ---------------------------------------------------------------------------

test('a written-off row on a position that gets fresh backfill money IS re-stamped — restampPosition does not exclude pnl_unresolvable rows', async () => {
  const db = initDB(':memory:')
  const writtenOffId = db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, entry_price, exit_price, sl_price, pnl_unresolvable, pnl_unresolvable_reason)
     VALUES ('EURUSD', 'BUY', 'closed', '556', NULL, 1.10, 1.30, 1.05, 1, 'unresolved: no broker evidence')`
  ).run().lastInsertRowid

  const before = db.prepare('SELECT realised_rr, pnl_price_mismatch FROM trades WHERE id = ?').get(writtenOffId)
  assert.equal(before.realised_rr, null, 'sanity: not stamped before the backfill')

  const getDeals = dealsApi([deal(556, 5000, { commCents: -200 })])
  await backfillClosedPnl(db, {}, { getDeals, now: NOW })

  const after = db.prepare('SELECT net_pnl, realised_rr, pnl_price_mismatch, pnl_unresolvable_reason FROM trades WHERE id = ?').get(writtenOffId)
  assert.notEqual(after.net_pnl, null, 'money can still land here — a separate, pre-existing behaviour this test does not judge')
  assert.notEqual(after.realised_rr, null, 'stamped with a real verdict, exactly like an ordinary row')
  assert.equal(after.pnl_price_mismatch, 0, 'a real verdict, never NULL, just because the row used to be written off')
  assert.equal(after.pnl_unresolvable_reason, 'unresolved: no broker evidence', 'the write-off flag/reason themselves are untouched by restampPosition — only classify() (old-position-pnl.js) clears them')
})

function writtenOffRow(db, { pid = '900', attempts = 15718 } = {}) {
  return db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, entry_price, exit_price, sl_price, pnl_attempts, pnl_unresolvable, pnl_unresolvable_reason)
     VALUES ('EURUSD', 'BUY', 'closed', ?, NULL, 1.10, NULL, 1.05, ?, 1, 'unresolved: no broker evidence')`
  ).run(pid, attempts).lastInsertRowid
}

test('B1: noteTradeAttempts no longer increments a written-off row by default — the runaway pnl_attempts counter this actually fixes', () => {
  const db = initDB(':memory:')
  const id = writtenOffRow(db, { pid: '900', attempts: 15718 })
  const ordinaryId = db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, entry_price, sl_price, pnl_attempts)
     VALUES ('EURUSD', 'BUY', 'closed', '901', NULL, 1.10, 1.05, 3)`
  ).run().lastInsertRowid

  const changed = noteTradeAttempts(db, { at: '2026-09-27T00:00:00Z' })
  assert.equal(changed, 1, 'only the ordinary row counted as an attempt')
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(id).pnl_attempts, 15718, 'the written-off row is left exactly where it was')
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(ordinaryId).pnl_attempts, 4)
})

test('B1: includeWrittenOff:true is the deliberate escape hatch old-position-pnl.js uses for its bounded, row-scoped re-read', () => {
  const db = initDB(':memory:')
  const id = writtenOffRow(db, { pid: '902', attempts: 7 })
  const changed = noteTradeAttempts(db, { positionId: '902', tradeId: id, includeWrittenOff: true, at: '2026-09-27T00:00:00Z' })
  assert.equal(changed, 1)
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(id).pnl_attempts, 8, 'the named row-scoped attempt still counts, unlike the broad sweep')
})

// checker fix round #2, item 1 (CLAUDE.md #1, "a mutation check that cannot
// fail proves nothing"): pnl-backfill.js:882's call-site argument
// `includeWrittenOff: !windowPass` was never pinned — nothing asserted that
// the WHOLE backfillClosedPnl pass, not just noteTradeAttempts in isolation,
// actually reaches a window pass with that value. Flipping it to `true` or
// `false` there left every existing test green.
test('B1: a window pass (no positionId, nothing on the broker) leaves a written-off row\'s pnl_attempts unchanged and still charges an ordinary row', async () => {
  const db = initDB(':memory:')
  const writtenOffId = writtenOffRow(db, { pid: '910', attempts: 15718 })
  const ordinaryId = db.prepare(
    `INSERT INTO trades (symbol, side, status, ctrader_position_id, net_pnl, entry_price, sl_price, pnl_attempts)
     VALUES ('EURUSD', 'BUY', 'closed', '911', NULL, 1.10, 1.05, 3)`
  ).run().lastInsertRowid

  // Empty deal history: the broker has nothing to say about either position,
  // so this exercises noteTradeAttempts through the real window-pass call
  // site (pnl-backfill.js:882), not a direct unit call.
  await backfillClosedPnl(db, {}, { getDeals: dealsApi([]), now: NOW })

  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(writtenOffId).pnl_attempts, 15718,
    'written off: the broad window sweep must not touch it (the runaway-counter fix)')
  assert.equal(db.prepare('SELECT pnl_attempts FROM trades WHERE id = ?').get(ordinaryId).pnl_attempts, 4,
    'ordinary: the broad window sweep still charges it, exactly as before B1')
})
