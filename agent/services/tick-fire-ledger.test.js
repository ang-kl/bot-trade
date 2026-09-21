// agent/services/tick-fire-ledger.test.js
//
// THE MEASURED DEFECT these tests pin (20-09-2026). A tick fill is owned by
// the bot (PR-1a) but its CLOSE could not produce a complete
// `position_history` row: `direction_reason` is in REQUIRED_FIELDS and is
// readable only from `risk_events.proposal_json` via `trades.risk_event_id`,
// and the tick path writes NO risk_events row — signal → order is in-process
// on the sidecar. The capture queue burned its attempts on every tick close
// and gave up with `missing: direction_reason` (…0949, COIN.US).
//
// The end-to-end test below is the whole point: ring row → ledger → adoption
// → close → a record with EVERY required field. The others are the ways a
// "helpful" implementation would have cheated: writing a risk event for a
// refusal, writing a reason that names the strategy back at itself, or
// writing a second one on the next pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState } from '../db.js'
import { runTickFireLedger, TICK_FIRE_LEDGER_CURSOR_KEY, TICK_FIRE_LEDGER_LAST_KEY, TICK_FIRE_LEDGER_TOTALS_KEY, reasonFor, parseDetail } from './tick-fire-ledger.js'
import { reconcilePositions, repairMisfiledOwnPositions } from './reconciler.js'
import { REQUIRED_FIELDS, buildPositionRecord, capturePosition } from './position-history.js'

const ACCT = '46130058'          // logged by its last 4: …0058
const INTENT = 'itick01abcdef'
const OPEN_MS = Date.parse('2026-09-20T08:05:00Z')
const CLOSE_MS = Date.parse('2026-09-20T09:05:00Z')

const fresh = () => initDB(':memory:')

function seedTickIntent(db, { id = INTENT, accountId = ACCT, state = 'FILLED', symbol = 'EURUSD', side = 'BUY', sl = null, tp = null } = {}) {
  const at = '2026-09-20T08:00:00.000Z'
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, sl, tp, producer_id, basis, mode_epoch, permit_id, permit_expires_at, state, created_at, updated_at)
              VALUES (?, ?, 'demo', ?, 1, ?, 'MARKET', 1000, ?, ?, 'tick_momentum', 'tick', 0, ?, ?, ?, ?, ?)`)
    .run(id, String(accountId), symbol, side, sl, tp, `p${id.slice(1)}`, at, state, at, at)
  return id
}

/** One sidecar ring row, exactly as pullDecisionsIntoDb lands it. */
function ring(db, { kind = 'fire_result', code = 'ok', seq = 1, detail, symbolId = 1, accountId = ACCT, bootId = 'boot-a', tsMs = OPEN_MS } = {}) {
  db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail)
              VALUES ('cpp_exec_demo', ?, ?, ?, 'tick', ?, ?, ?, ?, ?)`)
    .run(bootId, seq, tsMs, kind, String(accountId), symbolId, code, detail)
}

// Wire units (1e-5 of a price): entry=110000 → 1.1, stop=109500 → 1.095,
// target=111000 → 1.11, ref=109900 → 1.099 (the signal ask this BUY crossed
// — below entry, so the reason reads "entry ... over ref").
const okDetail = (intent = INTENT) =>
  `intent=${intent} pos=7001 order=9001 entry=110000 stop=109500 target=111000 side=BUY ref=109900`

// ---------------------------------------------------------------------------
// 1. One accepted fire → exactly one approved risk event, linked, once.
// ---------------------------------------------------------------------------
test('an accepted tick fire writes ONE approved risk event whose reason states what moved, links the intent, and never writes it twice', () => {
  const db = fresh()
  seedTickIntent(db)
  ring(db, { detail: okDetail() })

  const r = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(r.written, 1)
  assert.equal(r.unattributed, 0)

  const rows = db.prepare(`SELECT * FROM risk_events`).all()
  assert.equal(rows.length, 1, 'one fire, one event')
  assert.equal(rows[0].approved, 1)
  assert.equal(rows[0].account_id, ACCT)
  assert.equal(rows[0].symbol, 'EURUSD')
  assert.equal(rows[0].side, 'BUY')
  const proposal = JSON.parse(rows[0].proposal_json)
  assert.equal(proposal.strategy, 'tick_momentum_breakout')
  assert.equal(proposal.producer_id, 'tick_momentum')
  assert.equal(proposal.intent_id, INTENT)

  // NOT A TAUTOLOGY. "long because it is a long strategy" is the shape
  // position-history.js:93-107 refuses: the reason must carry the prices that
  // were crossed, so a reader can check it against the chart.
  const reason = proposal.direction_reason
  assert.match(reason, /entry=[\d.]+/, 'the reason carries the entry price it broke out at')
  assert.match(reason, /stop=[\d.]+/, 'and the stop that defined the risk')
  assert.match(reason, /_over_ref=/, 'a BUY states what it broke ABOVE, not just its own levels')
  assert.equal(reason, 'tick:breakout_BUY_entry=1.1_over_ref=1.099_stop=1.095_target=1.11')
  assert.ok(!/^tick$/.test(reason) && reason.length > 'tick'.length + 4, 'a bare producer name is not a reason')

  // PRICE units, not wire units: the wire fixture (110000) is in the
  // hundred-thousands; the price it converts to is under 1000.
  assert.ok(proposal.entry < 1000, 'entry is stored in price units, not wire units')
  assert.equal(proposal.entry, 1.1)
  assert.equal(proposal.units, 'price')

  const it = db.prepare('SELECT risk_event_id FROM entry_intents WHERE id = ?').get(INTENT)
  assert.equal(it.risk_event_id, rows[0].id, 'the intent names its event — the link the ±5-min window could never find')

  const cur = JSON.parse(getState(db, TICK_FIRE_LEDGER_CURSOR_KEY))
  assert.ok(cur.lastId > 0, 'the high-water mark advanced')
  assert.equal(cur.bootId, 'boot-a')

  // A SECOND PASS OVER THE SAME RING WRITES ZERO — idempotent by intent id,
  // not merely by cursor: the cursor is reset here to force the re-read a
  // sidecar restart (which replays the whole ring) would cause.
  db.prepare(`UPDATE agent_state SET value = ? WHERE key = ?`).run(JSON.stringify({ lastId: 0 }), TICK_FIRE_LEDGER_CURSOR_KEY)
  const again = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(again.written, 0)
  assert.equal(again.skipped, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 1)
})

// ---------------------------------------------------------------------------
// 2. END TO END: the capture completes. This is the defect, closed.
// ---------------------------------------------------------------------------
test('END TO END: ring row → ledger → adoption → close → a position_history record with EVERY required field', () => {
  const db = fresh()
  seedTickIntent(db)
  ring(db, { detail: okDetail() })
  assert.equal(runTickFireLedger(db, { now: OPEN_MS }).written, 1)

  // The fill arrives at the reconciler as the sidecar labelled it.
  const label = `tick:${'a'.repeat(16)}|||||||${INTENT}`
  const PID = '7001'
  const brokerPos = [{
    positionId: 7001,
    tradeData: { positionId: 7001, symbolId: 1, tradeSide: 'BUY', openPrice: 1.1000, volume: 1000, label },
    price: 1.1000, stopLoss: 1.0980, takeProfit: 1.1060, symbolName: 'EURUSD', label,
  }]
  const setState = (k, v) => db.prepare('INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)').run(k, v)
  const adopted = reconcilePositions(db, brokerPos, [], setState, { accountId: ACCT })
  assert.equal(adopted.newExternal[0].adopted, true)
  const reid = db.prepare('SELECT risk_event_id FROM entry_intents WHERE id = ?').get(INTENT).risk_event_id
  assert.equal(adopted.newExternal[0].stampedFromIntent.riskEventId, reid,
    'the reconciler took the intent\'s own event, not a window guess')

  const tid = db.prepare(`SELECT id FROM trades WHERE ctrader_position_id = ?`).get(PID).id
  assert.equal(db.prepare('SELECT risk_event_id FROM trades WHERE id = ?').get(tid).risk_event_id, reid)

  // The close, as the reconciler and the deal pull leave it.
  db.prepare(`UPDATE trades SET status = 'closed', exit_price = 1.1050, opened_at = ?, closed_at = ?, closed_at_ms = ?,
              hold_duration_ms = ?, gross_pnl = 50, net_pnl = 48, commission = -1, swap = -1, realised_rr = 2.5, close_reason = 'take_profit'
              WHERE id = ?`)
    .run(new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString(), CLOSE_MS, CLOSE_MS - OPEN_MS, tid)
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
              VALUES ('d1', ?, ?, 'EURUSD', 'BUY', 0.01, 1.1000, 1.1050, ?, ?, 50, -1, -1, 48)`)
    .run(PID, ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())

  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.deepEqual(missing, [], 'nothing required is absent — direction_reason included')
  for (const f of REQUIRED_FIELDS) assert.notEqual(record[f], null, `${f} is present`)
  assert.match(record.direction_reason, /^tick:breakout_BUY_entry=/)
  assert.equal(record.strategy, 'tick_momentum_breakout')
  assert.equal(record.origin, 'bot_market_dispatch')
  assert.equal(capturePosition(db, { accountId: ACCT, positionId: PID }).ok, true, 'the capture COMPLETES')
})

// ---------------------------------------------------------------------------
// 3. A refusal or a rejection opened no risk, so it gets no risk event.
// ---------------------------------------------------------------------------
test('fire_reject and fire_refused write NO risk event, and the pass surfaces what it could not attribute', () => {
  const db = fresh()
  seedTickIntent(db)
  ring(db, { kind: 'fire_reject', code: 'permit_epoch_stale', seq: 1, detail: `intent=${INTENT} epoch 2 vs 3` })
  ring(db, { kind: 'fire_refused', code: 'no_permit', seq: 2, detail: `BUY no keeper permit held seq=10 profile=abc` })
  ring(db, { kind: 'fire', code: 'BUY', seq: 3, detail: `vol=1000 stop=109500 entry=110000 seq=10 intent=${INTENT} profile=abc` })

  const r = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(r.written, 0, 'no fire the broker accepted, no event')
  assert.equal(r.rejects, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 0)
  assert.equal(db.prepare('SELECT risk_event_id FROM entry_intents WHERE id = ?').get(INTENT).risk_event_id, null)
  assert.equal(JSON.parse(getState(db, TICK_FIRE_LEDGER_CURSOR_KEY)).lastId, 3)

  // A fire_result whose detail carries NO breakout (an older sidecar) is
  // counted, not filled in: a reason without the prices would be the
  // tautology the table exists to refuse.
  ring(db, { seq: 4, detail: `intent=${INTENT} pos=7001 order=9001` })
  const r2 = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(r2.written, 0)
  assert.equal(r2.unattributed, 1)
  assert.ok(r2.reasons.includes('no_breakout_fact'), 'the pass NAMES why, so a lost fact is visible not silent')
})

// ---------------------------------------------------------------------------
// 3b. A fire_result whose OWN code is not 'ok' is neither a reject nor a
// refused kind — it fell through both counts and vanished from every figure
// this pass reports until this fix. Counted here under its own reason.
// ---------------------------------------------------------------------------
test('a fire_result with a non-ok code is counted as unattributed, not silently dropped', () => {
  const db = fresh()
  seedTickIntent(db)
  ring(db, { kind: 'fire_result', code: 'partial_fill', seq: 1, detail: okDetail() })

  const r = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(r.written, 0, 'a non-ok fire_result opened no approved risk')
  assert.equal(r.rejects, 0, 'it is not a fire_reject or fire_refused kind')
  assert.equal(r.unattributed, 1)
  assert.ok(r.reasons.includes('result_not_ok'), 'the pass NAMES why, so a non-ok result is visible not silent')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 0)
})

// ---------------------------------------------------------------------------
// 4. The ring is bounded and overwritten: a fire whose intent is gone.
// ---------------------------------------------------------------------------
test('a fire_result whose intent no longer exists is counted as unattributed — no crash, and the cursor still advances', () => {
  const db = fresh()
  ring(db, { seq: 11, detail: okDetail('ivanished0000') })
  const r = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(r.written, 0)
  assert.equal(r.unattributed, 1)
  assert.ok(r.reasons.includes('intent_missing'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 0)
  assert.equal(JSON.parse(getState(db, TICK_FIRE_LEDGER_CURSOR_KEY)).lastId, r.cursor.lastId)
  assert.ok(r.cursor.lastId > 0, 'a window that cannot be attributed is still passed over, never re-scanned forever')

  // And with no rows at all the pass is a no-op that does not move anything.
  const empty = runTickFireLedger(db, { now: CLOSE_MS })
  assert.equal(empty.scanned, 0)
  assert.equal(empty.written, 0)
})

// ---------------------------------------------------------------------------
// 5. THE HEALER'S PATH, not only the adoption site. repairMisfiledOwnPositions
// calls stampAdoptedFromIntent too (20-09-2026 checker round), for rows adopted
// `external` BEFORE tick fills were owned at all. Those are exactly the rows
// whose closes are still unattributed, so the fire ledger's link has to reach
// them by that door as well — an `it.risk_event_id` branch that only worked at
// the adoption site would leave the back catalogue on `missing:
// direction_reason` forever.
// ---------------------------------------------------------------------------
test('a HEALED misfiled row picks up risk_event_id from the intent the fire ledger stamped, and its close completes', () => {
  const db = fresh()
  seedTickIntent(db)
  ring(db, { detail: okDetail() })
  assert.equal(runTickFireLedger(db, { now: OPEN_MS }).written, 1)
  const reid = db.prepare('SELECT risk_event_id FROM entry_intents WHERE id = ?').get(INTENT).risk_event_id
  assert.ok(reid > 0)

  // The row as it was left before ownership existed: external, unattributed,
  // with only the label to go on.
  const label = `tick:${'a'.repeat(16)}|||||||${INTENT}`
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, source, label_raw, account_id, status, opened_at)
     VALUES ('EURUSD', 'BUY', 1.1000, 0.01, '7009', 'external', ?, ?, 'open', datetime('now'))`
  ).run(label, ACCT).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, source, label_raw, account_id, status)
     VALUES ('EURUSD', ?, 'long', 1.1000, 1.0980, 1.1060, 'External position — reconciliation import', 'external', ?, ?, 'active')`
  ).run(tradeId, label, ACCT)

  assert.equal(repairMisfiledOwnPositions(db), 1)
  const healed = db.prepare('SELECT source, origin, strategy, risk_event_id FROM trades WHERE id = ?').get(tradeId)
  assert.deepEqual(healed, { source: 'autopilot', origin: 'bot_market_dispatch', strategy: 'tick_momentum_breakout', risk_event_id: reid },
    'the healer takes the intent own event — the ±5-min window would find nothing here either')

  // And the close of a healed row now completes, which is the whole point.
  db.prepare(`UPDATE trades SET status = 'closed', exit_price = 1.1050, opened_at = ?, closed_at = ?, closed_at_ms = ?,
              hold_duration_ms = ?, gross_pnl = 50, net_pnl = 48, commission = -1, swap = -1, realised_rr = 2.5, close_reason = 'take_profit'
              WHERE id = ?`)
    .run(new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString(), CLOSE_MS, CLOSE_MS - OPEN_MS, tradeId)
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
              VALUES ('d9', '7009', ?, 'EURUSD', 'BUY', 0.01, 1.1000, 1.1050, ?, ?, 50, -1, -1, 48)`)
    .run(ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: '7009' })
  assert.deepEqual(missing, [])
  assert.match(record.direction_reason, /^tick:breakout_BUY_entry=/)
})

// ---------------------------------------------------------------------------
// 6. THE RECORD OF WHAT COULD NOT BE ATTRIBUTED IS PERSISTED, not just logged.
// "Nobody reads a log after the fact" is this repo's own lesson: the
// protection audit fired every 50 seconds while its RECORD sat a week stale.
// The ring is bounded and overwritten, so a window this pass could not
// attribute is gone — the count must outlive the pass.
// ---------------------------------------------------------------------------
test('every pass persists its own figures, and the unattributed totals accumulate by reason across passes', () => {
  const db = fresh()
  ring(db, { seq: 11, detail: okDetail('ivanished0001') })
  runTickFireLedger(db, { now: OPEN_MS })
  ring(db, { seq: 12, detail: okDetail('ivanished0002') })
  runTickFireLedger(db, { now: CLOSE_MS })

  const last = JSON.parse(getState(db, TICK_FIRE_LEDGER_LAST_KEY))
  assert.equal(last.at, new Date(CLOSE_MS).toISOString(), 'the LAST pass, not the first')
  assert.equal(last.scanned, 1)
  assert.equal(last.written, 0)
  assert.equal(last.unattributed, 1)
  assert.deepEqual(last.reasons, ['intent_missing'])
  assert.ok(last.cursor.lastId > 0)

  const totals = JSON.parse(getState(db, TICK_FIRE_LEDGER_TOTALS_KEY))
  assert.equal(totals.unattributed.intent_missing, 2, 'two fills across two passes could not be attributed')
  assert.equal(totals.written, 0)
  assert.equal(totals.unattributedTotal, 2)
  assert.ok(totals.firstAt && totals.lastAt, 'the span the totals cover is on the record, not inferred')
})

test('reasonFor refuses to invent: no side, no entry, no stop or no ref yields null rather than a shorter sentence', () => {
  assert.equal(reasonFor({ side: 'BUY', entry: 1, stop: 2, target: 3, ref: 0.5 }), 'tick:breakout_BUY_entry=1_over_ref=0.5_stop=2_target=3')
  assert.equal(reasonFor({ side: 'SELL', entry: 1, stop: 2, target: null, ref: 1.5 }), 'tick:breakout_SELL_entry=1_under_ref=1.5_stop=2')
  assert.equal(reasonFor({ side: '', entry: 1, stop: 2, target: 3, ref: 0.5 }), null)
  assert.equal(reasonFor({ side: 'BUY', entry: null, stop: 2, target: 3, ref: 0.5 }), null)
  assert.equal(reasonFor({ side: 'BUY', entry: 1, stop: null, target: 3, ref: 0.5 }), null)
  // Missing ref (an older sidecar, no ref= token) is the same refusal as a
  // missing entry/stop — absent is reported, never invented.
  assert.equal(reasonFor({ side: 'BUY', entry: 1, stop: 2, target: 3, ref: null }), null)
  assert.deepEqual(parseDetail('intent=i1 entry=5 side=SELL'), { intent: 'i1', entry: '5', side: 'SELL' })
})
