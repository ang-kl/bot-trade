// node --test agent/routes/void-cross-account-duplicates.test.js
//
// № 10,448 (02-10-2026; owner № 10,447 "remove duplicates"). The 30-09
// 07:45:55Z shape rebuilt on two accounts: …9908's four positions adopted on
// …0058 (phantoms), …0058's own five falsely closed and re-adopted three
// minutes later (pairs). The route plans by evidence, writes only on
// `apply: true`, reopens the original and voids the twin.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, setState } from '../db.js'
import actionsRouter from './actions.js'
import { planCrossAccountDuplicates } from '../services/cross-account-duplicates.js'

const TOKEN = 'sess_cccccccccccccccccccccccccccccccccccccccccccccccc'
const A = '46130058', B = '46979908'

function seed(db) {
  const ins = db.prepare(`INSERT INTO trades (id, symbol, side, entry_price, volume, ctrader_position_id, source, status, opened_at, closed_at, close_reason, exit_price, net_pnl, account_id, origin, risk_event_id)
                          VALUES (?, ?, 'BUY', ?, 0.1, ?, 'autopilot', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  // B's real rows: V.US closed by the broker stop with a deal; ETHUSD still open and in the verifier's list.
  ins.run(1684, 'V.US', 360, '241760418', 'closed', '2026-09-16 13:34:10', '2026-10-01 13:33:21', 'stop loss hit', 358.83, -1.77, B, 'bot_pending_fill', 446947)
  ins.run(1687, 'ETHUSD', 2500, '242004561', 'open', '2026-09-17 00:10:00', null, null, null, null, B, 'bot_pending_fill', 447009)
  // A's phantoms of B's positions (no deal evidence of their own).
  ins.run(1730, 'V.US', 360, '241760418', 'closed', '2026-09-30 07:45:55', '2026-09-30 07:48:57', 'closed at the broker - exit cause and initiating actor not yet verified', null, null, A, 'bot_pending_fill', null)
  ins.run(1731, 'ETHUSD', 2500, '242004561', 'closed', '2026-09-30 07:45:55', '2026-09-30 07:48:57', 'closed at the broker - exit cause and initiating actor not yet verified', null, null, A, 'bot_pending_fill', null)
  // A's original JNJ, falsely closed, and its re-adopted twin.
  ins.run(1489, 'JNJ.US', 254, '240732676', 'closed', '2026-09-09 13:33:48', '2026-09-30 07:45:55', 'closed at the broker - exit cause and initiating actor not yet verified', null, null, A, 'reconciler_adopted', 405589)
  ins.run(1733, 'JNJ.US', 254, '240732676', 'open', '2026-09-30 07:48:57', null, null, null, null, A, 'reconciler_adopted', null)
  // A legitimately closed row with no twin anywhere: untouched.
  ins.run(1500, 'KO.US', 70, '555', 'closed', '2026-09-10 00:00:00', '2026-09-12 00:00:00', 'closed at the broker - exit cause and initiating actor not yet verified', null, null, A, 'bot_market_dispatch', 1)
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source, paused) VALUES ('JNJ.US', 1733, 'long', 254, 256.44, ?, 'active', 'autopilot', 1)`).run(A)
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES ('JNJ.US', 1489, 'long', 254, 240, ?, 'closed', 'autopilot')`).run(A)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status) VALUES (1733, ?, 'JNJ.US', '240732676', 'long', 254, 256.44, '2026-09-30T07:49:27Z', 'open')`).run(A)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, exited_at, status) VALUES (1489, ?, 'JNJ.US', '240732676', 'long', 254, 240, '2026-09-09T13:33:48Z', '2026-09-30T07:45:55Z', 'closed')`).run(A)
  db.prepare(`INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, missing_json, partial_json) VALUES (?, '241760418', 'V.US', '["direction_reason"]', '{}')`).run(A)
  setState(db, 'independent_protection_json', JSON.stringify({ accounts: [
    { accountId: A, ok: true, positions: [{ positionId: '240732676' }] },
    { accountId: B, ok: true, positions: [{ positionId: '242004561' }] },
  ] }))
}

function serve() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  seed(db)
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  return { db, server, base: `http://127.0.0.1:${server.address().port}` }
}
const post = (base, body) => fetch(`${base}/actions/positions/void-cross-account-duplicates`, {
  method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body ?? {}),
}).then(r => r.json())
const status = (db, id) => db.prepare('SELECT status, close_reason, closed_at, exit_price FROM trades WHERE id = ?').get(id)

test('the plan names the two phantoms (one by deal, one by the verifier) and the JNJ pair, and nothing else', () => {
  const db = initDB(':memory:'); seed(db)
  const plan = planCrossAccountDuplicates(db, { verifierState: JSON.parse(db.prepare("SELECT value FROM agent_state WHERE key='independent_protection_json'").get().value) })
  assert.deepEqual(plan.phantoms.map(p => [p.tradeId, p.heldBy, p.twinTradeId]).sort(), [[1730, B, 1684], [1731, B, 1687]])
  assert.match(plan.phantoms.find(p => p.tradeId === 1730).evidence, /closed with deal evidence/)
  assert.match(plan.phantoms.find(p => p.tradeId === 1731).evidence, /verifier/)
  assert.deepEqual(plan.pairs.map(p => [p.originalTradeId, p.twinTradeId]), [[1489, 1733]])
  // Without the verifier's list the ETHUSD phantom has no evidence and is not named.
  const noVerifier = planCrossAccountDuplicates(db, { verifierState: null })
  assert.deepEqual(noVerifier.phantoms.map(p => p.tradeId), [1730])
})

test('dry run writes nothing; apply voids the phantoms, reopens JNJ and relinks its management to the original', async t => {
  const { db, server, base } = serve(); t.after(() => server.close())
  const dry = await post(base, {})
  assert.equal(dry.ok, true); assert.equal(dry.dryRun, true); assert.equal(dry.result, null)
  assert.equal(status(db, 1730).status, 'closed'); assert.equal(status(db, 1489).status, 'closed'); assert.equal(status(db, 1733).status, 'open')
  const r = await post(base, { apply: true })
  assert.equal(r.ok, true); assert.equal(r.mode, 'apply')
  assert.deepEqual(r.result.voided.sort(), [1730, 1731])
  assert.deepEqual(r.result.reopened, [{ originalTradeId: 1489, voidedTwin: 1733 }])
  assert.deepEqual(r.result.errors, [])
  for (const id of [1730, 1731]) { const s = status(db, id); assert.equal(s.status, 'cancelled'); assert.match(s.close_reason, /cross_account_duplicate.*…9908/) }
  const jnj = status(db, 1489); assert.equal(jnj.status, 'open'); assert.equal(jnj.closed_at, null); assert.equal(jnj.close_reason, null)
  const twin = status(db, 1733); assert.equal(twin.status, 'cancelled'); assert.match(twin.close_reason, /superseded by trade 1489/)
  // Management follows the position: the twin's active monitor row and open book row now name the original, with the trailed stop kept.
  assert.deepEqual(db.prepare(`SELECT trade_id, current_sl, status FROM monitored_positions WHERE status = 'active'`).all(), [{ trade_id: 1489, current_sl: 256.44, status: 'active' }])
  assert.deepEqual(db.prepare(`SELECT trade_id, stop, status FROM momentum_book WHERE status = 'open'`).all(), [{ trade_id: 1489, stop: 256.44, status: 'open' }])
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM position_history_incomplete WHERE account_id = ?`).get(A).n, 0, 'the phantom\'s refused record is gone')
  // B's rows and the untwinned KO.US row are untouched.
  assert.equal(status(db, 1684).status, 'closed'); assert.equal(status(db, 1687).status, 'open'); assert.equal(status(db, 1500).status, 'closed')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM action_log WHERE method IN ('VOID_CROSS_ACCOUNT_DUPLICATE', 'REOPEN_FALSE_CLOSE')`).get().n, 3)
  // Idempotent: a second apply finds nothing.
  const again = await post(base, { apply: true })
  assert.deepEqual([again.plan.phantoms.length, again.plan.pairs.length], [0, 0])
})

// Rule 1 (03-10-2026): the reopen resets the P&L verdict the false close had
// accumulated. On production #1489 kept pnl_attempts 6 (the cap), the terminal
// write-off and the reader's "judged" memory through its reopen, so its REAL
// close on 02-10 was skipped by every repair for ever.
test('reopening the original resets the verdict spent on its false close: attempts, write-off, reader memory, capture give-up', async t => {
  const { db, server, base } = serve(); t.after(() => server.close())
  const VERDICT = 'unresolved: no broker evidence: ledger identity ambiguous for position 240732676 on account 46130058 (#1489:closed,#1733:open); 6 attempt(s), last 2026-09-30T09:49:45.677Z; net_pnl stays NULL, excluded from P&L, shown'
  db.prepare(`UPDATE trades SET pnl_attempts = 6, pnl_last_attempt_at = '2026-09-30T09:49:45.677Z', pnl_unresolvable = 1, pnl_unresolvable_reason = ?, pnl_unresolvable_at = '2026-09-30T09:49:45.677Z' WHERE id = 1489`).run(VERDICT)
  setState(db, `position_pnl_reread:${A}`, JSON.stringify({ 1489: { at: '2026-09-30T09:49:45.677Z', outcome: 'terminal', rule: 3 }, 1500: { at: '2026-09-12T00:00:00Z', outcome: 'settled', rule: 3 } }))
  db.prepare(`INSERT INTO position_capture_queue (account_id, position_id, symbol, due_at_ms, attempts, state, last_error, settled_at) VALUES (?, '240732676', 'JNJ.US', 0, 6, 'gave_up', 'missing: close_deal', '2026-09-30T08:31:00.000Z')`).run(A)
  const r = await post(base, { apply: true })
  assert.deepEqual(r.result.reopened, [{ originalTradeId: 1489, voidedTwin: 1733 }])
  const jnj = db.prepare(`SELECT status, pnl_attempts, pnl_last_attempt_at, COALESCE(pnl_unresolvable,0) AS pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at FROM trades WHERE id = 1489`).get()
  assert.deepEqual(jnj, { status: 'open', pnl_attempts: 0, pnl_last_attempt_at: null, pnl_unresolvable: 0, pnl_unresolvable_reason: null, pnl_unresolvable_at: null })
  assert.deepEqual(JSON.parse(db.prepare(`SELECT value FROM agent_state WHERE key = ?`).get(`position_pnl_reread:${A}`).value),
    { 1500: { at: '2026-09-12T00:00:00Z', outcome: 'settled', rule: 3 } }, 'only the reopened row is forgotten')
  assert.deepEqual(db.prepare(`SELECT state, attempts, last_error FROM position_capture_queue WHERE account_id = ? AND position_id = '240732676'`).get(A), { state: 'pending', attempts: 0, last_error: null })
  const audit = db.prepare(`SELECT body FROM action_log WHERE method = 'PNL_VERDICT_RESET_ON_REOPEN'`).all()
  assert.equal(audit.length, 1)
  const body = JSON.parse(audit[0].body)
  assert.equal(body.tradeId, 1489); assert.equal(body.attempts, 6); assert.equal(body.writtenOffReason, VERDICT); assert.match(body.note, /twin 1733 voided/)
})
