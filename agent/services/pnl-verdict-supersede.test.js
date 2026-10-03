// node --test agent/services/pnl-verdict-supersede.test.js
//
// A P&L verdict is about ONE close (03-10-2026, #1489 JNJ.US …0058). The
// fixture below is that row as production held it on 03-10: six attempts
// spent on a false 30-09 close, the terminal verdict written at the sixth,
// the reader's memory marking it judged, the capture queue given up — and
// then a REAL close on 02-10 13:31:52Z that every repair skipped for ever.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { supersededPnlVerdicts, sweepSupersededPnlVerdicts, resetPnlVerdict, ledgerMs } from './pnl-verdict-supersede.js'
import { pnlLiveGapIds, LIVE_GAP_MAX_ATTEMPTS, resetBackfillPacing } from './pnl-backfill.js'
import { recoverOldPositionPnl, LIFECYCLE_RULES } from './old-position-pnl.js'

const A = '46130058', POS = '240732676'
const LAST_ATTEMPT = '2026-09-30T09:49:45.677Z'
const REAL_CLOSE = '2026-10-02 13:31:52'
const VERDICT = 'unresolved: no broker evidence: ledger identity ambiguous for position 240732676 on account 46130058 (#1489:closed,#1733:open); 6 attempt(s), last 2026-09-30T09:49:45.677Z; net_pnl stays NULL, excluded from P&L, shown'

function fixture(t) {
  const db = initDB(':memory:'); resetBackfillPacing()
  t.after(() => { db.close(); resetBackfillPacing() })
  db.prepare("INSERT INTO accounts (account_id,is_live,enabled,mode) VALUES (?,0,1,'active')").run(A)
  setState(db, 'ctrader_account_id', A)
  return db
}

/** #1489 exactly, plus every other place its verdict lives. */
function seed1489(db, { closedAt = REAL_CLOSE, lastAttempt = LAST_ATTEMPT, attempts = LIVE_GAP_MAX_ATTEMPTS, id = 1489, writtenOff = true } = {}) {
  db.prepare(`INSERT INTO trades (id, symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, closed_at, close_reason, exit_price,
      net_pnl, gross_pnl, account_id, origin, pnl_attempts, pnl_last_attempt_at, pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
    VALUES (?, 'JNJ.US', 'BUY', 254, 0.1, ?, 'autopilot', 'closed', '2026-09-09 13:33:48', ?, 'momentum_account: rank exit (daily pass)', 257.5,
      NULL, NULL, ?, 'reconciler_adopted', ?, ?, ?, ?, ?)`)
    .run(id, POS, closedAt, A, attempts, lastAttempt, writtenOff ? 1 : 0, writtenOff ? VERDICT : null, writtenOff ? lastAttempt : null)
  setState(db, `position_pnl_reread:${A}`, JSON.stringify({ [id]: { at: lastAttempt, outcome: 'terminal', rule: LIFECYCLE_RULES }, 777: { at: lastAttempt, outcome: 'settled', rule: LIFECYCLE_RULES } }))
  db.prepare(`INSERT OR IGNORE INTO position_capture_queue (account_id, position_id, symbol, due_at_ms, attempts, state, last_error, settled_at)
    VALUES (?, ?, 'JNJ.US', 0, 6, 'gave_up', 'missing: close_deal', '2026-09-30T08:31:00.000Z')`).run(A, POS)
  return id
}
const row = (db, id) => db.prepare(`SELECT status, net_pnl, pnl_attempts, pnl_last_attempt_at, COALESCE(pnl_unresolvable,0) AS pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at FROM trades WHERE id = ?`).get(id)
const capture = (db) => db.prepare(`SELECT state, attempts, last_error, settled_at FROM position_capture_queue WHERE account_id = ? AND position_id = ?`).get(A, POS)

test('ledgerMs reads both ledger timestamp forms as UTC', () => {
  assert.equal(ledgerMs('2026-10-02 13:31:52'), Date.parse('2026-10-02T13:31:52Z'))
  assert.equal(ledgerMs('2026-09-30T09:49:45.677Z'), Date.parse('2026-09-30T09:49:45.677Z'))
  assert.ok(Number.isNaN(ledgerMs(null))); assert.ok(Number.isNaN(ledgerMs('')))
})

test('#1489: closed AFTER its last attempt is superseded; the pure read names it and nothing else', t => {
  const db = fixture(t); seed1489(db)
  // A standing terminal verdict (closed before its attempts) is not returned.
  seed1489(db, { id: 1490, closedAt: '2026-09-30 07:45:55' })
  const r = supersededPnlVerdicts(db)
  assert.deepEqual(r.superseded.map(x => x.id), [1489])
  assert.deepEqual(r.unordered, [])
  assert.equal(r.superseded[0].closedMs, Date.parse('2026-10-02T13:31:52Z'))
  assert.equal(r.superseded[0].lastMs, Date.parse(LAST_ATTEMPT))
})

test('the sweep resets #1489 everywhere its verdict lived, audits the old verdict, and the row is a backfill candidate again', t => {
  const db = fixture(t); seed1489(db)
  // BEFORE: excluded by the live-gap predicate (attempts at the cap, written off).
  assert.deepEqual(pnlLiveGapIds(db, { accountId: A }), [])
  const lines = []
  const out = sweepSupersededPnlVerdicts(db, { log: m => lines.push(m), now: Date.parse('2026-10-03T06:00:00Z') })
  assert.equal(out.superseded.length, 1)
  assert.equal(out.superseded[0].reset.writtenOff, true)
  assert.equal(out.superseded[0].reset.rereadCleared, true)
  assert.equal(out.superseded[0].reset.captureRearmed, true)
  // AFTER: the row (status unchanged, money still unknown) carries no verdict.
  assert.deepEqual(row(db, 1489), { status: 'closed', net_pnl: null, pnl_attempts: 0, pnl_last_attempt_at: null, pnl_unresolvable: 0, pnl_unresolvable_reason: null, pnl_unresolvable_at: null })
  assert.deepEqual(pnlLiveGapIds(db, { accountId: A }), [1489], 'the same predicate backfillClosedPnl counts live rows by now includes it')
  // The reader's memory forgets only this trade; its other entries stand.
  assert.deepEqual(JSON.parse(getState(db, `position_pnl_reread:${A}`)), { 777: { at: LAST_ATTEMPT, outcome: 'settled', rule: LIFECYCLE_RULES } })
  // The capture give-up for the position is re-armed, count at zero.
  assert.deepEqual(capture(db), { state: 'pending', attempts: 0, last_error: null, settled_at: null })
  // ONE log line, naming row, symbol, account tail and both timestamps.
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[loop\] P&L verdicts superseded: 1 row\(s\) closed after their last attempt — #1489 JNJ\.US …0058 \(closed 2026-10-02T13:31:52Z, last attempt 2026-09-30T09:49:45Z\)$/)
  // The verdict it replaced is history, not erased.
  const audit = db.prepare(`SELECT body, account_id FROM action_log WHERE method = 'PNL_VERDICT_SUPERSEDED'`).all()
  assert.equal(audit.length, 1); assert.equal(audit[0].account_id, A)
  const body = JSON.parse(audit[0].body)
  assert.equal(body.tradeId, 1489); assert.equal(body.attempts, 6); assert.equal(body.writtenOffReason, VERDICT); assert.equal(body.lastAttemptAt, LAST_ATTEMPT)
  // Idempotent and quiet: nothing left to supersede, no log line.
  const again = sweepSupersededPnlVerdicts(db, { log: m => lines.push(m) })
  assert.equal(again.superseded.length, 0); assert.equal(lines.length, 1)
})

test('negative: a row closed BEFORE its last attempt keeps its terminal verdict', t => {
  const db = fixture(t); seed1489(db, { closedAt: '2026-09-30 07:45:55' })
  const lines = []
  const out = sweepSupersededPnlVerdicts(db, { log: m => lines.push(m) })
  assert.equal(out.superseded.length, 0); assert.equal(out.unordered.length, 0); assert.equal(lines.length, 0)
  const r = row(db, 1489)
  assert.equal(r.pnl_attempts, 6); assert.equal(r.pnl_last_attempt_at, LAST_ATTEMPT); assert.equal(r.pnl_unresolvable, 1); assert.equal(r.pnl_unresolvable_reason, VERDICT)
  assert.equal(capture(db).state, 'gave_up')
  assert.deepEqual(pnlLiveGapIds(db, { accountId: A }), [])
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM action_log WHERE method = 'PNL_VERDICT_SUPERSEDED'`).get().n, 0)
})

test('a row at the cap with NO last-attempt stamp is not reset (no ordering evidence) but is named as unordered', t => {
  const db = fixture(t); seed1489(db, { lastAttempt: null })
  const lines = []
  const out = sweepSupersededPnlVerdicts(db, { log: m => lines.push(m) })
  assert.equal(out.superseded.length, 0)
  assert.deepEqual(out.unordered.map(r => r.id), [1489])
  assert.equal(row(db, 1489).pnl_attempts, 6, 'untouched')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /0 row\(s\) closed after their last attempt; 1 unordered \(left terminal, no ordering evidence\) — #1489 JNJ\.US …0058 \(6 attempts, no last-attempt stamp\)/)
})

test('a row under the cap with NO write-off carries no verdict: not the sweep\'s business, whatever its timestamps say', t => {
  const db = fixture(t); seed1489(db, { attempts: LIVE_GAP_MAX_ATTEMPTS - 1, writtenOff: false })
  assert.deepEqual(supersededPnlVerdicts(db), { superseded: [], unordered: [] })
})

// Codex P1 on #1207: mark-unresolvable.js's account-level sweep writes off
// every old unresolved row on an exhausted account, so a row with ONE attempt
// can carry a terminal verdict. Closed after that attempt, it is superseded
// like any other; the attempt count alone must not hide it.
test('a WRITTEN-OFF row under the cap, closed after its last attempt, is superseded (the verdict, not the count, is the test)', t => {
  const db = fixture(t); seed1489(db, { attempts: 1 })
  const r = supersededPnlVerdicts(db)
  assert.deepEqual(r.superseded.map(x => x.id), [1489])
  const out = sweepSupersededPnlVerdicts(db, { log: () => {} })
  assert.deepEqual(out.superseded.map(x => x.id), [1489])
  const after = row(db, 1489)
  assert.equal(after.pnl_unresolvable, 0); assert.equal(after.pnl_unresolvable_reason, null); assert.equal(after.pnl_attempts, 0)
  assert.deepEqual(pnlLiveGapIds(db, { accountId: A }), [1489], 'a backfill candidate again')
})

test('a written-off row under the cap with no last-attempt stamp is unordered, not reset', t => {
  const db = fixture(t); seed1489(db, { attempts: 1, lastAttempt: null })
  const r = supersededPnlVerdicts(db)
  assert.deepEqual(r.superseded, []); assert.deepEqual(r.unordered.map(x => x.id), [1489])
  sweepSupersededPnlVerdicts(db, { log: () => {} })
  assert.equal(row(db, 1489).pnl_unresolvable, 1, 'untouched')
})

test('resetPnlVerdict on an unknown id is a no-op that says so', t => {
  const db = fixture(t)
  assert.deepEqual(resetPnlVerdict(db, 99999), { found: false, tradeId: 99999 })
})

// THROUGH THE REAL READER. Before the sweep the old-position reader does not
// even list #1489 as a candidate (written off AND remembered as judged under
// the current rules); after it, the same reader with the same fake broker
// history settles the money from the 02-10 close.
test('#1489 through recoverOldPositionPnl: invisible before the sweep, settled from the broker history after it', async t => {
  const db = fixture(t); seed1489(db)
  const now = Date.parse('2026-10-03T06:00:00Z')
  const creds = { ready: true, host: 'demo.ctraderapi.com', accountId: A, isLive: false }
  const common = { positionId: POS, symbolId: 10, dealStatus: 2, volume: 100, filledVolume: 100, executionPrice: 254 }
  const history = async () => ({ ctidTraderAccountId: A, hasMore: false, deal: [
    { ...common, dealId: '900', executionTimestamp: ledgerMs('2026-09-09 13:33:48') },
    { ...common, dealId: '901', executionTimestamp: ledgerMs(REAL_CLOSE), executionPrice: 257.5,
      closePositionDetail: { grossProfit: 35000, swap: -100, commission: -200, moneyDigits: 2, closedVolume: 100 } },
  ] })
  const reads = []
  const read = async () => recoverOldPositionPnl(db, creds, { now, isCurrent: () => true, getPositionDeals: async pid => { reads.push(pid); return history() } })
  const before = await read()
  assert.equal(before.state, 'no_old_gap', 'the terminal verdict keeps the row out of the candidate list')
  assert.deepEqual(reads, [], 'no broker read was even attempted')
  sweepSupersededPnlVerdicts(db, { log: () => {}, now })
  const after = await read()
  assert.equal(after.state, 'recovered', JSON.stringify(after))
  assert.deepEqual(reads, [POS])
  const r = db.prepare('SELECT net_pnl, gross_pnl, status, pnl_unresolvable FROM trades WHERE id = 1489').get()
  assert.equal(r.status, 'closed'); assert.equal(r.gross_pnl, 350); assert.equal(r.net_pnl, 347)
  assert.equal(Number(r.pnl_unresolvable), 0)
})
