// V3 V1 — every account's closes captured and verified, and a silent account
// can no longer read healthy.
//
// WHAT THESE TESTS ARE FOR. Production 25-09-2026 21:50 SGT:
// /state/position-capture read `pending 0, captured 45` while the only enqueue
// and the only drain sat behind the SELECTED account's reconcile, so six of
// seven accounts and every bot-side close queued nothing; cpp-verify showed
// `sessions: []` since 23-09. Each test below is built so the pre-V1 code
// would fail it: a close on a non-selected account, a close the bot made
// itself, a second account on the same verifier host, an account nobody
// drains.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tempDir } from '../test-support/temp-dir.js'
import { initDB, getState, setState, closeTradeRow } from '../db.js'
import { reconcilePositions } from './reconciler.js'
import { reconcileCrossSideAccounts } from './cross-side-reconcile.js'
import { CONTROLLERS } from './heartbeat.js'
import { CONTROLLER_GROUPS } from '../shared/controller-groups.js'
import { closeCaptureFailures, _resetCloseCaptureForTests, CLOSE_CAPTURE_DELAY_MS } from './close-capture.js'
import { symbolIdFor, accountSymbolMap } from './position-history.js'
import { verifyClient } from '../lib/verify-client.js'
import { enqueueCapture, dueCaptures, drainCaptureQueue, refreshDealsFor, captureQueueView, CAPTURE_DELAY_MS } from './position-capture.js'
import {
  enqueueReconcileCloses, sweepRecentCloses, captureAccountPass, runAllAccountCapture, captureCoverage, positionCaptureView,
  recordCapturePass, backfillDays, STRUCTURAL_FIELDS, CAPTURE_FILLABLE_FIELDS,
  UNCAPTURED_GRACE_MS, DRAIN_STALE_MS, VERIFY_SKIP_STREAK, CAPTURE_PASS_KEY,
} from './position-capture-accounts.js'

const A = '43097342'   // the selected (primary) account in these fixtures
const B = '46979908'   // another demo account
const L = '42993489'   // a live account (the other gateway side)

function fixture() {
  const db = initDB(':memory:')
  for (const [id, live] of [[A, 0], [B, 0], [L, 1]]) {
    db.prepare('INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, ?, 1, ?)').run(id, live, 'active')
  }
  setState(db, 'ctrader_account_id', A)
  setState(db, 'ctrader_is_live', 'false')
  return db
}

const iso = (ms) => new Date(ms).toISOString()
const sqlTime = (ms) => iso(ms).replace('T', ' ').slice(0, 19)

/** A closed trade whose record is COMPLETE once its deal is persisted. */
function seedComplete(db, { acct, pid, closeMs, symbol = 'EURUSD', withDeal = true }) {
  const openMs = closeMs - 4 * 3600_000
  const re = db.prepare(`INSERT INTO risk_events (symbol, side, approved, proposal_json) VALUES (?, 'BUY', 1, ?)`)
    .run(symbol, JSON.stringify({ direction_reason: 'trend continuation' }))
  const t = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, opened_at, closed_at,
                        closed_at_ms, hold_duration_ms, gross_pnl, net_pnl, status, close_reason, strategy,
                        ctrader_position_id, account_id, risk_event_id, origin, commission, swap, realised_rr)
    VALUES (?, 'BUY', 1.1, 1.105, 1.098, 10000, ?, ?, ?, ?, 50, 48, 'closed', 'take_profit', 'vwap_trend', ?, ?, ?, 'scan_dispatch', -1, -1, 2.5)
  `).run(symbol, iso(openMs), sqlTime(closeMs), closeMs, closeMs - openMs, pid, acct, re.lastInsertRowid)
  db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, strategy, planned_entry, planned_sl, risk_dist)
              VALUES (?, ?, ?, 'BUY', 'vwap_trend', 1.1, 1.098, 0.002)`).run(t.lastInsertRowid, acct, symbol)
  // The reconciler's live read of the open position (tamper watch): the
  // volume a capture relies on when the deal rows carry no lots (W10).
  db.prepare(`INSERT INTO monitored_positions (account_id, trade_id, symbol, side, entry_price, current_sl, source, status, broker_volume_units)
              VALUES (?, ?, ?, 'long', 1.1, 1.098, 'autopilot', 'closed', 1000000)`).run(acct, t.lastInsertRowid, symbol)
  if (withDeal) {
    db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price,
                                          opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
                VALUES (?, ?, ?, ?, 'BUY', 10000, 1.1, 1.105, ?, ?, 50, -1, -1, 48)`)
      .run(`d-${acct}-${pid}`, pid, acct, symbol, iso(openMs), iso(closeMs))
  }
  return Number(t.lastInsertRowid)
}

/** A closed trade with NO direction reason: a gap no deal read can fill. */
function seedStructural(db, { acct, pid, closeMs, symbol = 'Cocoa' }) {
  return Number(db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, volume, opened_at, closed_at, closed_at_ms,
                        status, close_reason, ctrader_position_id, account_id, origin)
    VALUES (?, 'BUY', 10, 11, 1, ?, ?, ?, 'closed', 'stop', ?, ?, 'reconciler_adopted')
  `).run(symbol, iso(closeMs - 3600_000), sqlTime(closeMs), closeMs, pid, acct).lastInsertRowid)
}

/** An OPEN trade with its monitored row — the shape a reconcile or a bot close acts on. */
function seedOpen(db, { acct, pid, symbol = 'EURUSD' }) {
  const id = Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, entry_price, volume, ctrader_position_id, source, status)
                                VALUES (?, ?, 'BUY', 1.1, 1, ?, 'autopilot', 'open')`).run(acct, symbol, pid).lastInsertRowid)
  db.prepare(`INSERT INTO monitored_positions (account_id, trade_id, symbol, side, entry_price, current_sl, source, status)
              VALUES (?, ?, ?, 'long', 1.1, 1.09, 'autopilot', 'active')`).run(acct, id, symbol)
  return id
}

const queueRow = (db, acct, pid) =>
  db.prepare('SELECT * FROM position_capture_queue WHERE account_id = ? AND position_id = ?').get(String(acct), String(pid))

const creds = (acct, isLive = false) => ({
  ready: true, accountId: acct, isLive, host: `${isLive ? 'live' : 'demo'}.ctraderapi.com`,
  clientId: 'cid', clientSecret: 'csec', accessToken: 'tok', accountIds: isLive ? [acct] : [A, B],
})

// ---------------------------------------------------------------------------
// 1. The close seam — W11 and every reconcile path
// ---------------------------------------------------------------------------

test('W11: a close the BOT makes (closeTradeRow) queues its capture, on any account', () => {
  const db = fixture()
  _resetCloseCaptureForTests()
  const id = seedOpen(db, { acct: B, pid: '900001' })
  const now = Date.now()
  const r = closeTradeRow(db, id, { closeReason: 'position_manager', closedAtMs: now })
  assert.equal(r.changed, true)
  const q = queueRow(db, B, '900001')
  assert.ok(q, 'the bot-side close is queued — before V1 nothing queued it, because the monitored row was closed with it')
  assert.equal(q.state, 'pending')
  assert.equal(q.source, 'close')
  assert.equal(q.due_at_ms, now + CAPTURE_DELAY_MS, "the owner's 30 seconds")
})

test('W11: a second close of the same row, and a trade that never had a position, queue nothing new', () => {
  const db = fixture()
  const id = seedOpen(db, { acct: B, pid: '900002' })
  closeTradeRow(db, id, { closeReason: 'position_manager' })
  const before = queueRow(db, B, '900002')
  closeTradeRow(db, id, { closeReason: 'already_closed' })   // no longer open: not a transition
  assert.deepEqual(queueRow(db, B, '900002'), before, 'the row is not reset')
  const noPos = Number(db.prepare(`INSERT INTO trades (account_id, symbol, side, status) VALUES (?, 'EURUSD', 'BUY', 'open')`).run(B).lastInsertRowid)
  closeTradeRow(db, noPos, { closeReason: 'never_filled' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_capture_queue').get().n, 1)
})

test('a close on a row with NO account is counted as unattributed, not queued and not silent', () => {
  const db = fixture()
  _resetCloseCaptureForTests()
  const id = Number(db.prepare(`INSERT INTO trades (symbol, side, ctrader_position_id, status) VALUES ('EURUSD','BUY','900003','open')`).run().lastInsertRowid)
  closeTradeRow(db, id, { closeReason: 'x' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_capture_queue').get().n, 0)
  assert.equal(closeCaptureFailures().unattributed, 1)
  assert.equal(closeCaptureFailures().count, 0, 'a gap in the row is not a broken queue')
})

test('a reconcile on a NON-selected account queues that account\'s detected close', () => {
  const db = fixture()
  seedOpen(db, { acct: B, pid: '900010' })
  // B's snapshot no longer holds the position.
  const res = reconcilePositions(db, [], [], (k, v) => setState(db, `acct:${B}:${k}`, v), { accountId: B })
  assert.equal(res.closedDetected.length, 1)
  const q = queueRow(db, B, '900010')
  assert.ok(q, 'queued for B — pre-V1 only the selected account\'s result was ever enqueued')
  assert.equal(queueRow(db, A, '900010'), undefined, 'and never under another account')
})

test('the OPPOSITE gateway side\'s reconcile queues its closes too', async () => {
  const db = fixture()
  setState(db, `symbol_id_map:${L}`, JSON.stringify({ map: { 'EURUSD': 1 } }))
  seedOpen(db, { acct: L, pid: '900020' })
  const results = await reconcileCrossSideAccounts(db, { ready: true, accountId: A, isLive: false }, {
    getCreds: (_db, { accountId, isLive }) => creds(accountId, isLive),
    readSnapshot: async (...args) => ({ ctidTraderAccountId: args[4] }),
  })
  assert.equal(results.find(r => r.accountId === L).result.closedDetected.length, 1)
  assert.ok(queueRow(db, L, '900020'), 'the live account\'s close is queued')
})

test('enqueueReconcileCloses: a detected close whose trade was already closed is queued once, orphans too', () => {
  const db = fixture()
  const result = {
    closedDetected: [{ positionId: '900030', symbol: 'EURUSD' }, { positionId: '900030', symbol: 'EURUSD' }],
    orphansClosed: [{ tradeId: 1, positionId: '900031', symbol: 'GBPUSD' }],
  }
  const r = enqueueReconcileCloses(db, result, { accountId: B, source: 'cross_side' })
  assert.deepEqual(r, { seen: 3, queued: 2, refused: 0 }, 'the duplicate is deduplicated by (account, position)')
  assert.equal(queueRow(db, B, '900030').source, 'cross_side')
  assert.ok(queueRow(db, B, '900031'))
  assert.equal(enqueueReconcileCloses(db, result, { accountId: null }).refused, 3, 'no account, no row')
})

test('enqueueCapture keeps its old contract: ok + no_identity, and never resets a row', () => {
  const db = fixture()
  assert.deepEqual(enqueueCapture(db, { accountId: null, positionId: '1' }), { ok: false, reason: 'no_identity' })
  assert.equal(enqueueCapture(db, { accountId: A, positionId: '5', now: 1000 }).ok, true)
  db.prepare(`UPDATE position_capture_queue SET attempts = 3 WHERE position_id = '5'`).run()
  enqueueCapture(db, { accountId: A, positionId: '5', now: 9000 })
  assert.equal(queueRow(db, A, '5').attempts, 3)
  assert.equal(queueRow(db, A, '5').due_at_ms, 1000 + CAPTURE_DELAY_MS)
  assert.equal(CLOSE_CAPTURE_DELAY_MS, CAPTURE_DELAY_MS, 'the close seam waits the same 30 seconds as the reconcile enqueue')
})

// ---------------------------------------------------------------------------
// 2. The drain is per account, with that account's own credentials
// ---------------------------------------------------------------------------

test('a drain scoped to one account never touches another account\'s rows', async () => {
  const db = fixture()
  const now = Date.now()
  enqueueCapture(db, { accountId: A, positionId: '1', now: now - 60_000 })
  enqueueCapture(db, { accountId: B, positionId: '2', now: now - 60_000 })
  assert.equal(dueCaptures(db, { now, accountId: B }).length, 1)
  assert.equal(dueCaptures(db, { now }).length, 2, 'the unscoped form is unchanged')
  const asked = []
  const out = await drainCaptureQueue(db, { now, accountId: B, getDeals: async (f, t) => { asked.push([f, t]); return { deal: [], hasMore: false } } })
  assert.equal(out.due, 1)
  assert.equal(queueRow(db, A, '1').attempts, 0, 'A\'s row was not handed to B\'s deal history')
  assert.equal(queueRow(db, B, '2').attempts, 1)
})

test('a deal read that THROWS stops that account\'s drain instead of burning an attempt on every row', async () => {
  const db = fixture()
  const now = Date.now()
  for (const pid of ['11', '12', '13']) enqueueCapture(db, { accountId: B, positionId: pid, now: now - 60_000 })
  let calls = 0
  const out = await drainCaptureQueue(db, {
    now, accountId: B, stopOnDealError: true,
    getDeals: async () => { calls++; throw new Error('ECONNRESET') },
  })
  assert.equal(calls, 1)
  assert.equal(out.stopped, 'deal_read_failed')
  const attempts = db.prepare(`SELECT position_id, attempts FROM position_capture_queue ORDER BY position_id`).all().map(r => r.attempts)
  assert.deepEqual(attempts, [1, 0, 0])
})

test('the deal pull names another account\'s deals from THAT account\'s symbol list, never the primary\'s', async () => {
  const db = fixture()
  const closeMs = Date.parse('2026-09-20T12:00:00Z')
  seedComplete(db, { acct: B, pid: '700', closeMs, withDeal: false })
  // The primary's map says id 5 is GOLD; B's own list says id 5 is EURUSD.
  setState(db, 'symbol_id_map', JSON.stringify({ GOLD: 5 }))
  setState(db, `symbol_id_map:${B}`, JSON.stringify({ builtAt: iso(Date.now()), map: { EURUSD: 5 } }))
  const deal = { dealId: 1, positionId: 700, symbolId: 5, volume: 100000, tradeSide: 2, executionPrice: 1.105, executionTimestamp: closeMs,
    closePositionDetail: { entryPrice: 1.1, grossProfit: 5000, swap: -100, commission: -100, moneyDigits: 2 } }
  await refreshDealsFor(db, { accountId: B, positionId: '700', getDeals: async () => ({ deal: [deal], hasMore: false }) })
  assert.equal(db.prepare(`SELECT symbol FROM broker_deals WHERE deal_id = '1'`).get().symbol, 'EURUSD')
})

test('symbolIdFor: the account\'s own id first; another account never borrows the primary\'s map', () => {
  const db = fixture()
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1 }))
  setState(db, `symbol_id_map:${B}`, JSON.stringify({ map: { EURUSD: 77 } }))
  assert.equal(symbolIdFor(db, 'EURUSD'), 1, 'no account: exactly as before')
  assert.equal(symbolIdFor(db, 'EURUSD', A), 1, 'the primary with no own list reads the global map')
  assert.equal(symbolIdFor(db, 'EURUSD', B), 77, 'B reads its own list')
  assert.equal(symbolIdFor(db, 'eurusd', B), 77, 'own lists are keyed upper-case')
  assert.equal(symbolIdFor(db, 'EURUSD', L), null, 'L has no list: absent, never the primary\'s id')
  assert.deepEqual(accountSymbolMap(db, L), {})
  assert.deepEqual(accountSymbolMap(db, B), { EURUSD: 77 })
})

// ---------------------------------------------------------------------------
// 3. The all-account pass
// ---------------------------------------------------------------------------

test('THE PASS: every account is drained with its own deal reader and verified under its own credentials', async () => {
  const db = fixture()
  const now = Date.now()
  seedComplete(db, { acct: A, pid: '501', closeMs: now - 3600_000 })
  seedComplete(db, { acct: B, pid: '502', closeMs: now - 3600_000 })
  seedComplete(db, { acct: L, pid: '503', closeMs: now - 3600_000 })
  const env = { DB_PATH: join(tempDir('v1-pass-'), 'agent.db'), POSITION_CAPTURE_BACKFILL_DAYS: '7' }
  const read = { [A]: 0, [B]: 0, [L]: 0 }
  const deps = Object.fromEntries([A, B, L].map(id => [id, {
    getDeals: async () => { read[id]++; return { deal: [], hasMore: false } },
    lotSizeFor: async () => null,
  }]))
  const asked = []
  const verifier = async (record, c) => { asked.push([record.account_id, c.accountId, c.host]); return { state: 'verified', disputes: [], contractVersion: 3 } }
  const beats = []
  const rec = await runAllAccountCapture(db, {
    env, now, verifier, deps, refused: new Set(),
    credsFor: async (id) => creds(id, id === L),
    beat: (_db, name, o) => beats.push([name, o.ok]),
  })
  assert.deepEqual(read, { [A]: 1, [B]: 1, [L]: 1 }, 'each account read its OWN deal history once')
  assert.deepEqual(asked.sort(), [[A, A, 'demo.ctraderapi.com'], [B, B, 'demo.ctraderapi.com'], [L, L, 'live.ctraderapi.com']].sort())
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM position_history WHERE verification_state = 'verified'`).get().n, 3)
  assert.equal(rec.ok, true)
  assert.deepEqual(beats, [['position_capture', true]])
  const view = positionCaptureView(db, { now, env })
  assert.equal(view.pending, captureQueueView(db).pending, 'the old totals ride along unchanged')
  for (const id of [A, B, L]) {
    const a = view.accounts.find(x => x.accountId === id)
    assert.equal(a.status, 'ok'); assert.equal(a.closes, 1); assert.equal(a.verified, 1)
  }
  assert.ok(getState(db, CAPTURE_PASS_KEY), 'the pass is written down')
})

test('THE PASS beats the real heartbeat row, and position_capture is a registered, grouped controller', async () => {
  const db = fixture()
  const now = Date.now()
  await runAllAccountCapture(db, { env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' }, now, verifier: null, refused: new Set(), credsFor: async (id) => creds(id), deps: { all: { getDeals: async () => ({ deal: [] }) } } })
  const hb = db.prepare(`SELECT * FROM controller_heartbeats WHERE name = 'position_capture'`).get()
  assert.ok(hb, 'the beat landed')
  assert.equal(hb.consecutive_failures, 0)
  assert.ok(JSON.parse(hb.last_detail_json).accounts[B], 'per-account counts ride in the beat')
  assert.ok(CONTROLLERS.position_capture?.effect?.key === CAPTURE_PASS_KEY)
  assert.ok(CONTROLLER_GROUPS.some(g => g.names.includes('position_capture')))
})

test('A SILENT ACCOUNT CANNOT READ HEALTHY: an uncaptured close fails the beat and names the account', async () => {
  const db = fixture()
  const now = Date.now()
  seedComplete(db, { acct: B, pid: '600', closeMs: now - UNCAPTURED_GRACE_MS - 60_000 })
  const beats = []
  // Sweep off: nothing will pick the close up — the pre-V1 state for B.
  const rec = await runAllAccountCapture(db, {
    env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' }, now, verifier: null, refused: new Set(),
    credsFor: async (id) => creds(id), deps: { all: { getDeals: async () => ({ deal: [] }) } },
    beat: (_db, name, o) => beats.push(o),
  })
  assert.equal(rec.ok, false)
  assert.match(rec.error, /…9908 silent \(1 close/)
  assert.equal(beats[0].ok, false)
  const b = captureCoverage(db, { now, days: 7 }).accounts.find(a => a.accountId === B)
  assert.equal(b.status, 'silent')
  assert.deepEqual(b.uncapturedSample, ['600'])
})

test('...and with the sweep on, the same close is queued and drained, and the account reads ok', async () => {
  const db = fixture()
  const now = Date.now()
  seedComplete(db, { acct: B, pid: '601', closeMs: now - UNCAPTURED_GRACE_MS - 60_000 })
  const rec = await runAllAccountCapture(db, {
    env: { POSITION_CAPTURE_BACKFILL_DAYS: '7' }, now, verifier: null, refused: new Set(),
    credsFor: async (id) => creds(id), deps: { all: { getDeals: async () => ({ deal: [] }) } },
    beat: () => {},
  })
  assert.equal(queueRow(db, B, '601').source, 'sweep')
  assert.equal(queueRow(db, B, '601').state, 'captured', 'swept and drained in the same pass (first sweep row is due at once)')
  assert.equal(rec.ok, true)
})

test('a token-refused account is never read, and its skip is recorded', async () => {
  const db = fixture()
  const now = Date.now()
  enqueueCapture(db, { accountId: L, positionId: '77', now: now - 60_000 })
  let read = 0
  await runAllAccountCapture(db, {
    env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' }, now, verifier: null, refused: new Set([L]),
    credsFor: async (id) => creds(id, id === L), deps: { all: { getDeals: async () => { read++; return { deal: [] } } } },
    beat: () => {},
  })
  assert.equal(read, 0)
  assert.equal(JSON.parse(getState(db, CAPTURE_PASS_KEY)).accounts[L].skipped, 'token_refused')
})

test('STALLED: rows due for 30+ minutes with no successful drain of the account', () => {
  const db = fixture()
  const now = Date.now()
  enqueueCapture(db, { accountId: B, positionId: '88', now: now - DRAIN_STALE_MS - 120_000, delayMs: 0 })
  let cov = captureCoverage(db, { now, days: 7, passAccounts: {} })
  assert.equal(cov.accounts.find(a => a.accountId === B).status, 'stalled')
  cov = captureCoverage(db, { now, days: 7, passAccounts: { [B]: { lastDrainOkAt: iso(now - 60_000) } } })
  assert.equal(cov.accounts.find(a => a.accountId === B).status, 'ok', 'a drain that is running but behind is busy, not stalled')
})

test('VERIFY_FAILING: the verifier leaving an account\'s asks unanswered is counted per account and reset by an answer', () => {
  const db = fixture()
  const now = Date.now()
  const run = (answered, skipped) => recordCapturePass(db, [{ accountId: B, drain: { due: 1, captured: 1, verified: 0, answered, skipped, incomplete: 0, gaveUp: 0, stopped: null, errors: [] } }], { now, verifierConfigured: true })
  run(0, 1); run(0, 1)
  let r = run(0, 1)
  assert.equal(r.accounts[B].verifySkipStreak, VERIFY_SKIP_STREAK)
  assert.equal(r.ok, false)
  assert.match(r.error, /verifier refused the last 3/)
  r = run(1, 0)
  assert.equal(r.accounts[B].verifySkipStreak, 0)
  assert.equal(r.ok, true)
})

test('an account the pass did not reach keeps its old timestamps, which then age', () => {
  const db = fixture()
  const t0 = Date.now() - 2 * 3600_000
  recordCapturePass(db, [{ accountId: B, drain: { due: 0, captured: 0, verified: 0, answered: 0, skipped: 0, incomplete: 0, gaveUp: 0, stopped: null, errors: [] } }], { now: t0 })
  const r = recordCapturePass(db, [{ accountId: A, drain: { due: 0, captured: 0, verified: 0, answered: 0, skipped: 0, incomplete: 0, gaveUp: 0, stopped: null, errors: [] } }], { now: Date.now() })
  assert.equal(r.accounts[B].lastDrainOkAt, iso(t0), 'not re-stamped by a pass that never visited it')
})

// ---------------------------------------------------------------------------
// 4. The bounded sweep
// ---------------------------------------------------------------------------

test('SWEEP: a close a deal read can complete is queued; a structural one is RECORDED as refused, not queued', () => {
  const db = fixture()
  const now = Date.now()
  seedComplete(db, { acct: B, pid: '801', closeMs: now - 2 * 86_400_000, withDeal: false })
  seedStructural(db, { acct: B, pid: '802', closeMs: now - 86_400_000 })
  const out = sweepRecentCloses(db, { accountId: B, now, days: 7 })
  assert.equal(out.enqueued, 1)
  assert.equal(out.structural, 1)
  assert.equal(queueRow(db, B, '801').source, 'sweep')
  assert.equal(queueRow(db, B, '802'), undefined, 'six deal reads into gave_up would fix nothing')
  const inc = db.prepare(`SELECT missing_json FROM position_history_incomplete WHERE account_id = ? AND ctrader_position_id = '802'`).get(B)
  assert.ok(JSON.parse(inc.missing_json).includes('direction_reason'), 'the refused record names the gap')
  assert.equal(out.missing.direction_reason, 1)
  // The next pass does not look at either again.
  const again = sweepRecentCloses(db, { accountId: B, now, days: 7 })
  assert.equal(again.candidates, 0)
  const b = captureCoverage(db, { now, days: 7 }).accounts.find(a => a.accountId === B)
  assert.equal(b.uncaptured, 0, 'a refused record is not silence')
  assert.equal(b.structural, 1)
})

test('SWEEP is bounded: per pass, by window, per account, and off at 0 days', () => {
  const db = fixture()
  const now = Date.now()
  for (let i = 0; i < 14; i++) seedComplete(db, { acct: B, pid: String(1000 + i), closeMs: now - (i + 1) * 3600_000, withDeal: false })
  seedComplete(db, { acct: B, pid: '1999', closeMs: now - 9 * 86_400_000, withDeal: false })
  seedComplete(db, { acct: A, pid: '2000', closeMs: now - 3600_000, withDeal: false })
  const out = sweepRecentCloses(db, { accountId: B, now, days: 7, enqueueLimit: 10, spacingMs: 20_000 })
  assert.equal(out.enqueued, 10)
  const dues = db.prepare(`SELECT due_at_ms FROM position_capture_queue WHERE account_id = ? ORDER BY due_at_ms`).all(B).map(r => r.due_at_ms - now)
  assert.deepEqual(dues.slice(0, 3), [0, 20_000, 40_000], 'spaced, not a burst')
  assert.equal(queueRow(db, B, '1999'), undefined, 'outside the window')
  assert.equal(queueRow(db, A, '2000'), undefined, 'another account is not swept by this call')
  assert.deepEqual(sweepRecentCloses(db, { accountId: B, now, days: 0 }), { ran: false, reason: 'disabled' })
  assert.equal(backfillDays({ POSITION_CAPTURE_BACKFILL_DAYS: '0' }), 0)
  assert.equal(backfillDays({}), 7)
  assert.equal(backfillDays({ POSITION_CAPTURE_BACKFILL_DAYS: '365' }), 30)
})

test('volume is structural for the sweep until the capture writer stores lots (W10)', () => {
  assert.ok(STRUCTURAL_FIELDS.includes('volume'))
  assert.ok(STRUCTURAL_FIELDS.includes('direction_reason'))
  assert.ok(!CAPTURE_FILLABLE_FIELDS.includes('volume'))
  assert.ok(CAPTURE_FILLABLE_FIELDS.includes('net_pnl'))
})

test('captureAccountPass arms the verify backlog ONLY with a verifier, and drains nothing without credentials', async () => {
  const db = fixture()
  const now = Date.now()
  db.prepare(`INSERT INTO position_history (account_id, ctrader_position_id, symbol, direction, direction_reason, strategy, origin,
      planned_entry, planned_sl, risk_dist, entry_price, exit_price, volume, opened_at_ms, closed_at_ms, hold_ms,
      gross_pnl, commission, swap, net_pnl, realised_r, close_reason, sl_moves, tp_moves, scale_outs, events_json, sources_json)
    VALUES (?, '3001', 'EURUSD', 'long', 'r', 's', 'o', 1, 0.9, 0.1, 1, 1.1, 1, ?, ?, 1, 1, 0, 0, 1, 1, 'tp', 0, 0, 0, '[]', '{}')`).run(B, now - 7200_000, now - 3600_000)
  await captureAccountPass(db, { accountId: B, creds: creds(B), verifier: null, now, env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' }, deps: { getDeals: async () => ({ deal: [] }) } })
  assert.equal(queueRow(db, B, '3001'), undefined, 'no verifier: a re-capture would buy a deal read and no answer')
  const r = await captureAccountPass(db, { accountId: B, creds: null, verifier: async () => ({ state: 'verified' }), now, env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' } })
  assert.equal(r.skipped, 'no_credentials')
  assert.equal(r.drain, null)
  const armed = await captureAccountPass(db, { accountId: B, creds: creds(B), verifier: async () => ({ state: 'verified', disputes: [] }), now, env: { POSITION_CAPTURE_BACKFILL_DAYS: '0' }, deps: { getDeals: async () => ({ deal: [] }), lotSizeFor: async () => null } })
  assert.equal(armed.backlog.armed, 1)
})

// ---------------------------------------------------------------------------
// 5. The verifier client holds EVERY account it was asked about
// ---------------------------------------------------------------------------

function fetchStub(script) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    const next = script.shift()
    if (!next) throw new Error(`unscripted call to ${url}`)
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body }
  }
  return { impl, calls }
}
const ENV = { VERIFY_URL: 'http://verify.internal:8080', EXEC_SECRET: 's3cret' }
const rec = (acct) => ({ account_id: acct, ctrader_position_id: '1', direction: 'long', volume: 1, entry_price: 1, exit_price: 1, net_pnl: 1, opened_at_ms: 1, closed_at_ms: 2 })
const C = (acct) => ({ clientId: 'c', clientSecret: 's', accessToken: 't', accountId: acct })
const ok = { state: 'verified', disputes: [] }

test('a SECOND account on the same host reconnects naming BOTH — a connect replaces the host\'s session', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1, accounts: [{ accountId: Number(A), authorized: true }] } },
    { status: 200, body: ok },
    { status: 200, body: { authorized: 2, accounts: [{ accountId: Number(A), authorized: true }, { accountId: Number(B), authorized: true }] } },
    { status: 200, body: ok },
    { status: 200, body: ok },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  assert.equal((await verify(rec(A), { host: 'h', ...C(A) })).state, 'verified')
  assert.equal((await verify(rec(B), { host: 'h', ...C(B) })).state, 'verified')
  assert.equal((await verify(rec(A), { host: 'h', ...C(A) })).state, 'verified', 'A is still held: no third connect')
  const connects = calls.filter(c => /\/connect$/.test(c.url))
  assert.equal(connects.length, 2)
  assert.deepEqual(connects[1].body.accountIds.sort(), [Number(A), Number(B)].sort(), 'the union, not just B')
})

test('the host roster is authorized in ONE connect when the caller passes it', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 2, accounts: [{ accountId: Number(A), authorized: true }, { accountId: Number(B), authorized: true }] } },
    { status: 200, body: ok }, { status: 200, body: ok },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  await verify(rec(A), { host: 'h', ...C(A), accountIds: [A, B] })
  await verify(rec(B), { host: 'h', ...C(B), accountIds: [A, B] })
  assert.equal(calls.filter(c => /\/connect$/.test(c.url)).length, 1)
})

test('an account the broker refused on connect is named, not sent to a guaranteed 403', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1, accounts: [{ accountId: Number(A), authorized: true }, { accountId: Number(B), authorized: false }] } },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(rec(B), { host: 'h', ...C(B), accountIds: [A, B] })
  assert.equal(v.skipped, 'connect_account_refused')
  assert.equal(calls.filter(c => /\/verify$/.test(c.url)).length, 0)
})

test('a 403 reconnects with the union and retries ONCE; a second 403 is reported', async () => {
  const { impl, calls } = fetchStub([
    { status: 200, body: { authorized: 1 } },
    { status: 403, body: {} },
    { status: 200, body: { authorized: 1 } },
    { status: 403, body: {} },
  ])
  const verify = verifyClient({ env: ENV, fetchImpl: impl })
  const v = await verify(rec(A), { host: 'h', ...C(A) })
  assert.equal(v.skipped, 'http_403')
  assert.equal(calls.filter(c => /\/connect$/.test(c.url)).length, 2)
})
