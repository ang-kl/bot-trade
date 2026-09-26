// node --test agent/services/intent-corrections.test.js
//
// V3 X1 (owner-approved 25-09-2026): the one-time correction of resting-order
// intents the old settleIntent stored FILLED at placement. Known answer:
// i7fgue8t2rgxx CADJPY on …0058 (pending_fib_orders, LIMIT), FILLED by
// 'response' 2026-09-12T07:12:12.676Z with the broker's pre-created position
// 241267454, order 360473873 — cancelled unfilled 25-09 07:47. Every fixture
// first asserts its defect is present (CLAUDE.md failure mode #1).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { applyX1Correction, x1Candidates, fillEvidence, x1CorrectionLog, X1_CORRECTION_ID, X1_GRACE_MS } from './intent-corrections.js'
import { settleAcceptedFromOrderDetails, reconcileIntents, ledgerView } from './entry-ledger.js'
import { tagLabelWithIntent } from '../lib/trade-labels.js'

const ACCT = '46130058'
const NOW = Date.parse('2026-09-25T22:00:00Z')
const row = (db, id) => db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(id)

let seq = 0
function legacyIntent(db, { id, orderType = 'LIMIT', producer = 'pending_fib_orders', createdAt = '2026-09-12T07:12:12.676Z', resolvedAfterMs = 900, state = 'FILLED', source = 'response', pid = '241267454', oid = '360473873', symbol = null } = {}) {
  const resolved = new Date(Date.parse(createdAt) + resolvedAfterMs).toISOString()
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, sl, tp, producer_id, basis, mode_epoch,
      permit_id, permit_expires_at, state, broker_order_id, broker_position_id, resolution_source, created_at, updated_at, resolved_at)
    VALUES (?, ?, 'demo', ?, 11, 'BUY', ?, 1000, 50000, 100000, ?, 'bar', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ACCT, symbol, orderType, producer, `p${String(++seq).padStart(12, '0')}`, createdAt, state, oid, pid, source, createdAt, resolved, resolved)
  return id
}

test('the known answer: i7fgue8t2rgxx (LIMIT, FILLED by the placement response, no fill evidence anywhere) moves to ACCEPTED — placed, not filled — keeping its order id; the pre-created position id moves to the log with the full before and after', () => {
  const db = initDB(':memory:')
  legacyIntent(db, { id: 'i7fgue8t2rgxx' })
  assert.equal(row(db, 'i7fgue8t2rgxx').state, 'FILLED', 'the defect is present')
  assert.equal(row(db, 'i7fgue8t2rgxx').broker_position_id, '241267454')
  const out = applyX1Correction(db, { now: NOW })
  assert.deepEqual(out.corrected.map(c => c.intentId), ['i7fgue8t2rgxx'])
  const it = row(db, 'i7fgue8t2rgxx')
  assert.equal(it.state, 'ACCEPTED'); assert.equal(it.broker_order_id, '360473873'); assert.equal(it.broker_position_id, null)
  assert.equal(it.resolution_source, 'x1_correction'); assert.match(it.error_code, /^x1_correction: stored FILLED by the placement answer .* placed, not filled/)
  assert.equal(it.resolved_at, '2026-09-12T07:12:13.576Z', 'resolved_at stays the acceptance time')
  const log = x1CorrectionLog(db)
  assert.equal(log.length, 1); assert.equal(log[0].step, 'to_accepted'); assert.equal(log[0].from_state, 'FILLED'); assert.equal(log[0].to_state, 'ACCEPTED')
  const full = db.prepare(`SELECT before_json, after_json, evidence_json FROM entry_intent_corrections WHERE intent_id = 'i7fgue8t2rgxx'`).get()
  assert.equal(JSON.parse(full.before_json).state, 'FILLED'); assert.equal(JSON.parse(full.before_json).broker_position_id, '241267454', 'nothing is lost: the before image keeps it')
  assert.equal(JSON.parse(full.after_json).state, 'ACCEPTED')
  const ev = JSON.parse(full.evidence_json)
  assert.deepEqual(ev.found, []); assert.ok(ev.looked.length >= 5, 'every place a fill could be recorded was looked at')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entry_intents').get().n, 1, 'no row deleted')
  // readable over GET /state/entry-intents, account redacted
  const v = ledgerView(db)
  assert.deepEqual(v.corrections.steps, [{ correction_id: X1_CORRECTION_ID, step: 'to_accepted', to_state: 'ACCEPTED', n: 1 }])
  assert.equal(v.corrections.recent[0].intentId, 'i7fgue8t2rgxx'); assert.equal(v.corrections.recent[0].accountId, '…0058')
  assert.ok(!JSON.stringify(v).includes(ACCT), 'account ids are redacted')
})

test('idempotent: a second run moves nothing and logs nothing; once past the grace with nothing left, it is marked done and stops querying', () => {
  const db = initDB(':memory:')
  legacyIntent(db, { id: 'iaaaaaaaaaaa1' })
  const a = applyX1Correction(db, { now: NOW })
  assert.equal(a.corrected.length, 1)
  const b = applyX1Correction(db, { now: NOW + 1000 })
  assert.equal(b.corrected.length, 0); assert.equal(x1CorrectionLog(db).length, 1)
  const c = applyX1Correction(db, { now: NOW + X1_GRACE_MS + 120_000 })
  assert.equal(c.done, true)
  assert.ok(db.prepare('SELECT 1 FROM migrations_applied WHERE id = ?').get(`${X1_CORRECTION_ID}:done`))
  // a legacy-shaped row that appears after "done" is not touched (the query no longer runs)
  legacyIntent(db, { id: 'iaaaaaaaaaaa2', createdAt: '2026-09-11T00:00:00.000Z' })
  assert.equal(applyX1Correction(db, { now: NOW + X1_GRACE_MS + 200_000 }).corrected.length, 0)
  assert.equal(row(db, 'iaaaaaaaaaaa2').state, 'FILLED')
})

test('a row WITH evidence of a fill stays FILLED: a trade or monitored position carrying the tag, a trade or broker deal holding the pre-created position id, or a fill event for the order', () => {
  const db = initDB(':memory:')
  const ids = ['ibbbbbbbbbb01', 'ibbbbbbbbbb02', 'ibbbbbbbbbb03', 'ibbbbbbbbbb04', 'ibbbbbbbbbb05', 'ibbbbbbbbbb06']
  ids.forEach((id, i) => legacyIntent(db, { id, pid: String(500 + i), oid: String(600 + i) }))
  db.prepare(`INSERT INTO trades (symbol, side, account_id, status, label_raw) VALUES ('CADJPY', 'BUY', ?, 'closed', ?)`).run(ACCT, tagLabelWithIntent('AU|v1|FIB|M|LN|4h|RG', ids[0]))
  const t2 = db.prepare(`INSERT INTO trades (symbol, side, account_id, status) VALUES ('CADJPY', 'BUY', ?, 'closed')`).run(ACCT).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, account_id, status, label_raw) VALUES ('CADJPY', ?, 'long', ?, 'closed', ?)`).run(t2, ACCT, tagLabelWithIntent('AU|v1|FIB|M|LN|4h|RG', ids[1]))
  db.prepare(`INSERT INTO trades (symbol, side, account_id, status, ctrader_position_id) VALUES ('CADJPY', 'BUY', ?, 'closed', '502')`).run(ACCT)
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol) VALUES ('d1', '503.0', ?, 'CADJPY')`).run(ACCT)
  db.prepare(`INSERT INTO cpp_events (side, boot_id, seq, execution_type, order_id, position_id, account_id) VALUES ('cpp_exec_demo', 'b', 1, 'ORDER_FILLED', '604', '504', ?)`).run(ACCT)
  // a label that merely ENDS with the id, in a field that is not the tag, is not this intent's tag
  db.prepare(`INSERT INTO trades (symbol, side, account_id, status, label_raw) VALUES ('CADJPY', 'BUY', ?, 'closed', ?)`).run(ACCT, `AU|v1|FIB|M|LN|4h|RG|iother0000000|${ids[5]}`)
  assert.equal(fillEvidence(db, row(db, ids[5])).found.length, 0, 'the LIKE matched, labelIntentId did not')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE label_raw LIKE ?`).get(`%|${ids[5]}`).n, 1)
  const out = applyX1Correction(db, { now: NOW })
  assert.deepEqual(out.leftFilled.map(l => l.intentId).sort(), ids.slice(0, 5).sort())
  for (const id of ids.slice(0, 5)) assert.equal(row(db, id).state, 'FILLED', id)
  assert.deepEqual(out.corrected.map(c => c.intentId), [ids[5]], 'only the row with no evidence moves')
  assert.deepEqual(fillEvidence(db, row(db, ids[0])).found.map(f => f.source), ['trades.label_tag'])
  // each kept row is logged with the evidence that kept it, and judged once
  const kept = db.prepare(`SELECT intent_id, evidence_json FROM entry_intent_corrections WHERE step = 'kept_filled' ORDER BY intent_id`).all()
  assert.deepEqual(kept.map(k => k.intent_id), ids.slice(0, 5))
  assert.deepEqual(JSON.parse(kept[3].evidence_json).found.map(f => f.source), ['broker_deals.position_id'])
  const again = applyX1Correction(db, { now: NOW + 1000 })
  assert.equal(again.considered, 0, 'a judged row is not judged again')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intent_corrections`).get().n, 6)
})

test('only OLD-code resting rows FILLED by the placement answer are candidates: not MARKET, not a later reconcile / event / deal-history fill, not a row created after the cutoff, not one inside the grace', () => {
  const db = initDB(':memory:')
  legacyIntent(db, { id: 'icccccccccc01', orderType: 'MARKET', producer: 'scan_dispatch' })
  legacyIntent(db, { id: 'icccccccccc02', source: 'reconcile' })
  legacyIntent(db, { id: 'icccccccccc03', source: 'deal_history' })
  legacyIntent(db, { id: 'icccccccccc04', resolvedAfterMs: 5 * 60_000 }) // a 'response' five minutes on is not the placement answer
  legacyIntent(db, { id: 'icccccccccc05', orderType: 'STOP' })
  legacyIntent(db, { id: 'icccccccccc06', orderType: '2' })
  // first run: the cutoff is recorded at NOW
  const first = applyX1Correction(db, { now: NOW })
  assert.deepEqual(first.corrected.map(c => c.intentId).sort(), ['icccccccccc05', 'icccccccccc06'])
  for (const id of ['icccccccccc01', 'icccccccccc02', 'icccccccccc03', 'icccccccccc04']) assert.equal(row(db, id).state, 'FILLED', id)
  // a resting row created AFTER the cutoff (the new code) is never a candidate
  legacyIntent(db, { id: 'icccccccccc07', createdAt: new Date(NOW + 1000).toISOString() })
  assert.equal(applyX1Correction(db, { now: NOW + 2 * X1_GRACE_MS }).corrected.length, 0)
  assert.equal(row(db, 'icccccccccc07').state, 'FILLED')
  // a row inside the grace waits: the reconciler may not have adopted its fill yet
  const db2 = initDB(':memory:')
  legacyIntent(db2, { id: 'icccccccccc08', createdAt: new Date(NOW - 60_000).toISOString() })
  assert.equal(x1Candidates(db2, { now: NOW }).length, 0)
  assert.equal(applyX1Correction(db2, { now: NOW }).corrected.length, 0)
  assert.equal(applyX1Correction(db2, { now: NOW + X1_GRACE_MS }).corrected.length, 1, 'judged once the grace has passed (cutoff was recorded at the first run)')
})

test('a place that cannot be looked at is not a place with nothing in it: an unreadable evidence table leaves the row FILLED and the correction not done', () => {
  const db = initDB(':memory:')
  legacyIntent(db, { id: 'idddddddddd01' })
  db.exec('DROP TABLE position_history')
  const out = applyX1Correction(db, { now: NOW + 2 * X1_GRACE_MS })
  assert.equal(out.corrected.length, 0); assert.equal(out.unreadable.length, 1); assert.equal(out.done, false)
  assert.equal(row(db, 'idddddddddd01').state, 'FILLED')
})

test('step 2: the broker\'s evidence settles a corrected row — cancelled → RELEASED, expired → EXPIRED, filled → FILLED — and the log records the terminal step with its evidence; an unreadable one ends "unresolved: no broker evidence", logged too', async () => {
  const db = initDB(':memory:')
  legacyIntent(db, { id: 'i7fgue8t2rgxx', oid: '360473873', pid: '241267454' })
  legacyIntent(db, { id: 'i2wm19e0npceg', oid: '360356369', pid: '241171224', createdAt: '2026-09-11T14:09:45.634Z' })
  legacyIntent(db, { id: 'ieeeeeeeeee01', oid: '1001', pid: '2001', createdAt: '2026-09-11T10:00:00.000Z' })
  legacyIntent(db, { id: 'ieeeeeeeeee02', oid: '1002', pid: '2002', createdAt: '2026-09-11T11:00:00.000Z' })
  applyX1Correction(db, { now: NOW })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE state = 'ACCEPTED'`).get().n, 4)
  const answers = {
    360473873: { order: { orderId: 360473873, orderStatus: 'ORDER_STATUS_CANCELLED', executedVolume: 0 }, deal: [] },
    360356369: { order: { orderId: 360356369, orderStatus: 'ORDER_STATUS_EXPIRED' } },
    1001: { order: { orderId: 1001, orderStatus: 'ORDER_STATUS_FILLED' }, deal: [{ positionId: 2001, dealStatus: 'FILLED' }] },
  }
  const getOrderDetails = async (oid) => { if (answers[oid]) return answers[oid]; throw new Error('cTrader error: ORDER_NOT_FOUND') }
  let t = NOW + 1000
  await settleAcceptedFromOrderDetails(db, { accountId: ACCT, workingOrderIds: [], getOrderDetails, now: t })
  assert.equal(row(db, 'i7fgue8t2rgxx').state, 'RELEASED'); assert.match(row(db, 'i7fgue8t2rgxx').error_code, /^order_cancelled/)
  assert.equal(row(db, 'i2wm19e0npceg').state, 'EXPIRED')
  assert.deepEqual([row(db, 'ieeeeeeeeee01').state, row(db, 'ieeeeeeeeee01').broker_position_id], ['FILLED', '2001'])
  const terminal = db.prepare(`SELECT intent_id, to_state, evidence_json FROM entry_intent_corrections WHERE step = 'terminal' ORDER BY intent_id`).all()
  assert.deepEqual(terminal.map(r => [r.intent_id, r.to_state]), [['i2wm19e0npceg', 'EXPIRED'], ['i7fgue8t2rgxx', 'RELEASED'], ['ieeeeeeeeee01', 'FILLED']])
  assert.equal(JSON.parse(terminal[1].evidence_json).source, 'order_details')
  for (let i = 0; i < 6; i++) { t += 11 * 60_000; await settleAcceptedFromOrderDetails(db, { accountId: ACCT, workingOrderIds: [], getOrderDetails, now: t }) }
  assert.equal(row(db, 'ieeeeeeeeee02').state, 'ACCEPTED'); assert.match(row(db, 'ieeeeeeeeee02').error_code, /^unresolved: no broker evidence/)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intent_corrections WHERE intent_id = 'ieeeeeeeeee02' AND step = 'unresolved'`).get().n, 1)
  // the snapshot path logs its terminal step the same way
  const db2 = initDB(':memory:')
  legacyIntent(db2, { id: 'ifffffffffff1', oid: '3001', pid: '4001' })
  applyX1Correction(db2, { now: NOW })
  db2.prepare(`INSERT INTO cpp_events (side, boot_id, seq, execution_type, order_id, account_id) VALUES ('cpp_exec_demo', 'b', 1, 'ORDER_EXPIRED', '3001', ?)`).run(ACCT)
  reconcileIntents(db2, { accountId: ACCT, now: NOW + 1000 })
  assert.equal(row(db2, 'ifffffffffff1').state, 'EXPIRED')
  assert.equal(db2.prepare(`SELECT to_state FROM entry_intent_corrections WHERE intent_id = 'ifffffffffff1' AND step = 'terminal'`).get().to_state, 'EXPIRED')
})
