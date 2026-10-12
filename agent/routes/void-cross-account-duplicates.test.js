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

// ---------------------------------------------------------------------------
// Claude · № 13,764 12-Oct (owner "Fix route + these two"; claude-builder)
//
// MEASURED 12-10-2026 on demo 47790949 (stress run, #1334). Two manual orders
// (#1797 BTCUSD, #1798 JPYX at 107.87 lots, the gate's figure; the broker took
// its 100-lot maximum) were falsely closed by a reconcile and re-adopted as
// NEW rows #1800/#1801. Adoption labels a MAN-labelled position `external`
// (isOurs is false for MAN) and records the broker's volume. This route then
// reopened the originals and moved the twins' monitor rows onto them — so the
// reopened manual orders came back `external`, which the fast monitor and the
// loop's per-account management only observe, and #1798 kept 107.87 lots.
// The reopened trade's own source is who opened the position; the twin's
// volume is what the broker holds. Through the real writer, the real
// reconciler (false close, then adoption) and the real route.
// ---------------------------------------------------------------------------
import { recordManualOrderTrade } from './actions.js'
import { reconcilePositions } from '../services/reconciler.js'

const S = '47790949'
const MAN = 'MAN|v1|VWAP|-|LDN|-|-'
const brokerPos = (positionId, symbolName, volume) => ({
  positionId, symbolName, price: 100, stopLoss: 99, takeProfit: 102,
  tradeData: { positionId, symbolId: 1, tradeSide: 'BUY', openPrice: 100, volume, label: `${MAN}|i1zc4mryytjsu` },
})

function stressShape() {
  const db = initDB(':memory:')
  setState(db, 'device_sessions', JSON.stringify({ [TOKEN]: Date.now() + 86_400_000 }))
  db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(S, S)
  setState(db, 'ctrader_account_id', '99999999')
  const setAcct = (k, v) => setState(db, `acct:${S}:${k}`, v)
  const place = (symbol, positionId, volLots) => recordManualOrderTrade(db, {
    symbol, side: 'BUY', entryP: 100, entryEstimate: 100, sl: 99, tp: 102, volLots, positionId,
    structuredLabel: MAN, accountId: S, strategy: 'vwap_trend',
  })
  const btc = place('BTCUSD', '247938233', 0.04)
  const jpyx = place('JPYX', '247938246', 107.87)
  // The false close: a snapshot that does not hold them, from a caller that does not pass its read time.
  reconcilePositions(db, [], [], setAcct, { accountId: S })
  // The next pass holds them: adopted as new rows with the broker's volume.
  reconcilePositions(db, [brokerPos('247938233', 'BTCUSD', 4), brokerPos('247938246', 'JPYX', 1_000_000)], [], setAcct, { accountId: S, readAt: Date.now() })
  const twinOf = (id) => db.prepare(`SELECT id, source, volume FROM trades WHERE ctrader_position_id = (SELECT ctrader_position_id FROM trades WHERE id = ?) AND id <> ?`).get(id, id)
  return { db, btc, jpyx, twinOf }
}
const activeMon = (db, tradeId) => db.prepare(`SELECT source FROM monitored_positions WHERE trade_id = ? AND status = 'active'`).all(tradeId).map(r => r.source)
const vol = (db, id) => db.prepare('SELECT volume FROM trades WHERE id = ?').get(id).volume
function serveDb(db) {
  const app = express()
  app.use(express.json())
  app.use('/actions', actionsRouter(db))
  const server = app.listen(0)
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test('the stress-run shape: a reopened manual order keeps its own source and takes the broker volume the twin recorded', async t => {
  const { db, btc, jpyx, twinOf } = stressShape()
  // The production rows before the route: originals falsely closed, twins adopted external with the broker's volume.
  assert.equal(db.prepare('SELECT status FROM trades WHERE id = ?').get(jpyx).status, 'closed')
  assert.deepEqual([twinOf(btc).source, twinOf(btc).volume], ['external', 0.04])
  assert.deepEqual([twinOf(jpyx).source, twinOf(jpyx).volume], ['external', 100])
  const { server, base } = serveDb(db); t.after(() => server.close())
  const r = await post(base, { apply: true })
  assert.deepEqual(r.result.reopened.map(x => x.originalTradeId).sort((a, b) => a - b), [btc, jpyx])
  assert.deepEqual(r.result.errors, [])
  // RED before: both came back 'external' (observe-only) and #1798 kept 107.87.
  assert.deepEqual(activeMon(db, btc), ['manual'])
  assert.deepEqual(activeMon(db, jpyx), ['manual'])
  assert.equal(vol(db, jpyx), 100)
  assert.equal(vol(db, btc), 0.04)
  // The reopen's audit names what the management rows took.
  const audit = db.prepare(`SELECT body FROM action_log WHERE method = 'REOPEN_FALSE_CLOSE'`).all().map(a => JSON.parse(a.body))
  const j = audit.find(a => a.originalTradeId === jpyx)
  assert.deepEqual([j.management.sourceFrom, j.management.sourceTo, j.management.volumeFrom, j.management.volumeTo], ['external', 'manual', 107.87, 100])
  assert.deepEqual(r.plan.reopenedRepairs, [])
})

test('an earlier reopen left observe-only is repaired by the same route: dry run names it, apply writes it once, audited', async t => {
  const { db, btc, jpyx } = stressShape()
  const { server, base } = serveDb(db); t.after(() => server.close())
  await post(base, { apply: true })
  // What the route wrote before this fix (production 10:22Z): the moved rows say 'external' and #1798 still 107.87.
  db.prepare(`UPDATE monitored_positions SET source = 'external' WHERE trade_id IN (?, ?) AND status = 'active'`).run(btc, jpyx)
  db.prepare('UPDATE trades SET volume = 107.87 WHERE id = ?').run(jpyx)
  db.prepare(`DELETE FROM action_log WHERE method <> 'REOPEN_FALSE_CLOSE'`).run()
  const dry = await post(base, {})
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.plan.reopenedRepairs.map(x => [x.originalTradeId, x.sourceFrom, x.sourceTo, x.volumeFrom ?? null, x.volumeTo ?? null]),
    [[btc, 'external', 'manual', null, null], [jpyx, 'external', 'manual', 107.87, 100]])
  assert.deepEqual(activeMon(db, jpyx), ['external'], 'the dry run writes nothing')
  const r = await post(base, { apply: true })
  assert.deepEqual(r.result.repaired.sort((a, b) => a - b), [btc, jpyx])
  assert.deepEqual(r.result.errors, [])
  assert.deepEqual(activeMon(db, btc), ['manual'])
  assert.deepEqual(activeMon(db, jpyx), ['manual'])
  assert.equal(vol(db, jpyx), 100)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM action_log WHERE method = 'REPAIR_REOPENED_PAIR'`).get().n, 2)
  // Idempotent, and a reopened trade that has since closed is left alone.
  const again = await post(base, {})
  assert.deepEqual(again.plan.reopenedRepairs, [])
  db.prepare(`UPDATE monitored_positions SET source = 'external' WHERE trade_id = ?`).run(jpyx)
  db.prepare(`UPDATE trades SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(jpyx)
  assert.deepEqual((await post(base, {})).plan.reopenedRepairs, [])
})
