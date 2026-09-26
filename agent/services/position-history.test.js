// agent/services/position-history.test.js
//
// The rule under test throughout: COMPLETENESS IS A GATE. A record that is
// missing a required field must not land in the clean table with a blank, a
// zero or a plausible substitute — it must land in the refused stream with
// the missing field named. Most of these cases are the specific ways a
// "helpful" implementation would have filled a gap instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import {
  REQUIRED_FIELDS, buildPositionRecord, capturePosition, backfillPositionHistory, backfillPositionHistoryCooperatively,
  recordVerdict, positionHistoryView, directionReasonFor, managementFor,
  classifyRefusedRecord, refusedClassesPhrase, REFUSED_CLASSES, POSITION_TRADE_SQL,
  classifyFlaggedClose, FLAGGED_REFUSED_SQL, FLAGGED_COMPLETE_SQL,
} from './position-history.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'

const ACCT = '47790949'
const PID = '240505687'
const OPEN_MS = Date.parse('2026-09-15T08:00:00Z')
const CLOSE_MS = Date.parse('2026-09-15T12:00:00Z')

const fresh = () => initDB(':memory:')

test('scheduled history capture yields between positions and preserves completeness outcomes', async () => {
  const db = fresh()
  try {
    const ins = db.prepare("INSERT INTO trades (symbol,status,closed_at_ms,ctrader_position_id,account_id) VALUES ('X','closed',?,?,?)")
    for (let i = 1; i <= 12; i++) ins.run(CLOSE_MS + i, String(i), ACCT)
    let observed
    setImmediate(() => { observed = db.prepare('SELECT COUNT(*) n FROM position_history_incomplete').get().n })
    const result = await backfillPositionHistoryCooperatively(db)
    assert.ok(observed > 0 && observed < 12)
    assert.deepEqual(result, backfillPositionHistory(db))
    assert.equal(result.seen, 12)
    assert.equal(result.incomplete, 12)
  } finally { db.close() }
})

/** A position with every source row present — the complete case. */
function seedComplete(db, over = {}) {
  const riskEvent = db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, proposal_json) VALUES (?, 'BUY', 1, ?)
  `).run('EURUSD', JSON.stringify({ direction_reason: 'higher-timeframe trend up, pullback into value' }))
  const reid = riskEvent.lastInsertRowid

  const t = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, tp_price, volume,
                        opened_at, closed_at, closed_at_ms, hold_duration_ms, gross_pnl, net_pnl,
                        status, close_reason, strategy, ctrader_position_id, account_id,
                        risk_event_id, origin, commission, swap, realised_rr, conviction)
    VALUES (?, 'BUY', 1.1000, 1.1050, 1.0980, 1.1060, 10000,
            ?, ?, ?, ?, 50, 48, 'closed', 'take_profit', 'vwap_trend', ?, ?, ?, 'scan_dispatch', -1, -1, 2.5, 7)
  `).run('EURUSD', new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString(), CLOSE_MS,
    CLOSE_MS - OPEN_MS, PID, ACCT, reid)
  const tid = t.lastInsertRowid

  db.prepare(`
    INSERT INTO trade_plans (trade_id, account_id, symbol, side, strategy, family, timeframe,
                             planned_entry, planned_sl, planned_tp, planned_r, risk_dist, exit_rule)
    VALUES (?, ?, 'EURUSD', 'BUY', 'vwap_trend', 'trend', 'H1', 1.1000, 1.0980, 1.1060, 3, 0.0020, 'trail_after_1r')
  `).run(tid, ACCT)

  db.prepare(`
    INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price,
                              close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
    VALUES ('d1', ?, ?, 'EURUSD', 'BUY', 10000, 1.1000, 1.1050, ?, ?, 50, -1, -1, 48)
  `).run(PID, ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())

  for (const [kind, from, to] of over.events || [['sl_moved', 1.0980, 1.1000], ['scale_out', 10000, 5000]]) {
    db.prepare(`
      INSERT INTO position_events (account_id, position_id, trade_id, symbol, kind, from_value, to_value, reason, source)
      VALUES (?, ?, ?, 'EURUSD', ?, ?, ?, 'moved to break-even at +1R', 'position_manager')
    `).run(ACCT, PID, tid, kind, from, to)
  }
  return { tradeId: tid, riskEventId: reid }
}

test('a position with every source present builds a complete record and lands in the clean table', () => {
  const db = fresh()
  seedComplete(db)
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.deepEqual(missing, [], 'nothing required is absent')
  assert.equal(record.direction, 'long')
  assert.equal(record.direction_reason, 'higher-timeframe trend up, pullback into value')
  assert.equal(record.strategy, 'vwap_trend')
  assert.equal(record.sl_moves, 1)
  assert.equal(record.scale_outs, 1)
  assert.equal(record.tp_moves, 0)

  const r = capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(r.ok, true)
  assert.equal(r.stream, 'history')
  const row = db.prepare('SELECT * FROM position_history WHERE ctrader_position_id = ?').get(PID)
  assert.ok(row)
  assert.equal(row.verification_state, 'unverified', 'a fresh record has not been checked by anyone')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history_incomplete').get().n, 0)
})

test('EVERY required field, absent in turn, refuses the record and names that field', () => {
  // The heart of the gate. A per-field loop rather than one example, because
  // an implementation that gets nine fields right and defaults the tenth is
  // exactly what this is meant to catch — and the tenth is the one that
  // would quietly be a zero.
  const nulls = {
    // both sources blanked: `symbol` legitimately falls back to the broker row
    symbol: `UPDATE trades SET symbol = '' WHERE ctrader_position_id = '${PID}'; UPDATE broker_deals SET symbol = NULL`,
    // trade_plans.side is NOT NULL in the schema, so the plan row goes too:
    // direction is only genuinely unknown when no source states it.
    direction: `UPDATE trades SET side = NULL WHERE ctrader_position_id = '${PID}'; UPDATE broker_deals SET side = NULL; DELETE FROM trade_plans`,
    direction_reason: `UPDATE risk_events SET proposal_json = '{}'`,
    strategy: `UPDATE trades SET strategy = NULL, label_strategy = NULL WHERE ctrader_position_id = '${PID}'; UPDATE trade_plans SET strategy = NULL`,
    origin: `UPDATE trades SET origin = NULL, source = NULL WHERE ctrader_position_id = '${PID}'`,
    planned_entry: `UPDATE trade_plans SET planned_entry = NULL; UPDATE trades SET proposal_entry_price = NULL WHERE ctrader_position_id = '${PID}'`,
    planned_sl: `UPDATE trade_plans SET planned_sl = NULL; UPDATE trades SET sl_price = NULL WHERE ctrader_position_id = '${PID}'`,
    commission: `UPDATE broker_deals SET commission = NULL; UPDATE trades SET commission = NULL WHERE ctrader_position_id = '${PID}'`,
    swap: `UPDATE broker_deals SET swap = NULL; UPDATE trades SET swap = NULL WHERE ctrader_position_id = '${PID}'`,
    net_pnl: `UPDATE broker_deals SET net_pnl = NULL; UPDATE trades SET net_pnl = NULL WHERE ctrader_position_id = '${PID}'`,
    gross_pnl: `UPDATE broker_deals SET gross_pnl = NULL; UPDATE trades SET gross_pnl = NULL WHERE ctrader_position_id = '${PID}'`,
    exit_price: `UPDATE broker_deals SET close_price = NULL; UPDATE trades SET exit_price = NULL WHERE ctrader_position_id = '${PID}'`,
    close_reason: `UPDATE trades SET close_reason = NULL WHERE ctrader_position_id = '${PID}'; UPDATE trade_plans SET exit_reason = NULL`,
  }
  for (const [field, sql] of Object.entries(nulls)) {
    const db = fresh()
    seedComplete(db)
    db.exec(sql)
    const { missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
    assert.ok(missing.includes(field), `removing ${field} must make it missing, got [${missing}]`)

    const r = capturePosition(db, { accountId: ACCT, positionId: PID })
    assert.equal(r.ok, false, `${field}: the record must be refused`)
    assert.equal(r.stream, 'incomplete')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history').get().n, 0,
      `${field}: nothing may reach the clean table`)
    const inc = db.prepare('SELECT * FROM position_history_incomplete WHERE ctrader_position_id = ?').get(PID)
    assert.ok(JSON.parse(inc.missing_json).includes(field), `${field}: the refused row must name it`)
  }
})

test('a real zero is a reading, not a gap — a break-even trade is complete', () => {
  // The mirror of the rule above, and the one a naive `if (!value)` gate gets
  // wrong: a position that closed flat has net_pnl 0, no stop moves and no
  // scale-outs. Every one of those is a measurement.
  const db = fresh()
  seedComplete(db, { events: [] })
  db.exec(`UPDATE broker_deals SET net_pnl = 0, gross_pnl = 0, commission = 0, swap = 0`)
  db.exec(`UPDATE trades SET net_pnl = 0, gross_pnl = 0, realised_rr = 0 WHERE ctrader_position_id = '${PID}'`)
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.deepEqual(missing, [], 'zeros are not missing values')
  assert.equal(record.net_pnl, 0)
  assert.equal(record.commission, 0)
  assert.equal(record.sl_moves, 0)
  assert.equal(capturePosition(db, { accountId: ACCT, positionId: PID }).ok, true)
})

test('the broker figures win over the local ones, and the record says which source it used', () => {
  const db = fresh()
  seedComplete(db)
  db.exec(`UPDATE trades SET net_pnl = 999, entry_price = 9.99 WHERE ctrader_position_id = '${PID}'`)
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.net_pnl, 48, "the broker's own net is the one kept")
  assert.equal(record.entry_price, 1.1, "and the broker's fill price")
  assert.equal(JSON.parse(record.sources_json).money, 'broker_deals')
})

test('with no broker row the local figures are used and the source says so — not silently broker-flavoured', () => {
  const db = fresh()
  seedComplete(db)
  db.exec('DELETE FROM broker_deals')
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  // C·4: the money and prices fall back to the local row; the VOLUME does
  // not — trades.volume is what was asked for, and a request is not a fill.
  assert.deepEqual(missing, ['volume'])
  assert.equal(record.net_pnl, 48)
  assert.equal(record.volume, null)
  assert.equal(record.requested_volume, 10000, 'the request is kept beside the record, never as the fill')
  assert.match(JSON.parse(record.sources_json).volume, /requested size, not the fill/)
  assert.equal(JSON.parse(record.sources_json).money, 'trades',
    'a caller must be able to see this was never confirmed against the broker')
})

test('net_pnl is copied, never derived from the price move', () => {
  // CLAUDE.md failure mode #6: 26.9% of closed trades had P&L disagreeing
  // with their price move, and the money turned out to be the trustworthy
  // half. A record that computed the money from the prices would agree with
  // itself by construction and verify nothing.
  const db = fresh()
  seedComplete(db)
  db.exec('UPDATE broker_deals SET net_pnl = -7.5')   // disagrees with the +50 point move
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.deepEqual(missing, [])
  assert.equal(record.net_pnl, -7.5, 'the broker figure survives disagreeing with the prices')
})

test('realised_r is signed by direction, so a profitable short is positive', () => {
  const db = fresh()
  seedComplete(db)
  db.exec(`UPDATE trades SET side = 'SELL', realised_rr = NULL, exit_price = 1.0960 WHERE ctrader_position_id = '${PID}'`)
  db.exec('UPDATE broker_deals SET close_price = 1.0960, side = \'SELL\'')
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.direction, 'short')
  assert.ok(record.realised_r > 1.9 && record.realised_r < 2.1, `expected ~+2R, got ${record.realised_r}`)
})

test('an unknown direction reason refuses the record rather than inventing one', () => {
  // Principle 4: every trade has a reason. The tempting fill is "long because
  // the strategy is long" — a tautology that would make the table look
  // complete while answering nothing.
  const db = fresh()
  seedComplete(db)
  db.exec('DELETE FROM risk_events')
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.direction_reason, null)
  assert.ok(missing.includes('direction_reason'))
  assert.equal(directionReasonFor(db, 999), null, 'a missing risk event is null, not a throw')
})

test('a record moves between the two streams and is never in both', () => {
  const db = fresh()
  seedComplete(db)
  db.exec('UPDATE risk_events SET proposal_json = \'{}\'')       // break it
  capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history_incomplete').get().n, 1)

  db.exec(`UPDATE risk_events SET proposal_json = '${JSON.stringify({ direction_reason: 'found later' })}'`)
  capturePosition(db, { accountId: ACCT, positionId: PID })     // fix it
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history_incomplete').get().n, 0,
    'the refused row is removed once the record is whole')

  db.exec('UPDATE risk_events SET proposal_json = \'{}\'')       // break it again
  capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history').get().n, 0,
    'and the clean row is removed if it stops being whole')
})

test('a verdict survives a rebuild that changes nothing, and is cleared by one that moves the money', () => {
  // Both halves matter. If a rebuild always cleared the verdict, re-running
  // the backfill would un-verify the entire table and verification would
  // never accumulate. If it never cleared it, a corrected figure would keep
  // a verdict that was passed on the old one.
  const db = fresh()
  seedComplete(db)
  capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(recordVerdict(db, { accountId: ACCT, positionId: PID, state: 'verified', host: 'demo.ctrader.com' }).ok, true)

  capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(db.prepare('SELECT verification_state FROM position_history WHERE ctrader_position_id = ?').get(PID).verification_state,
    'verified', 'an identical rebuild keeps the verdict')

  db.exec('UPDATE broker_deals SET net_pnl = 123')
  const again = capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(again.reverified, true)
  const row = db.prepare('SELECT * FROM position_history WHERE ctrader_position_id = ?').get(PID)
  assert.equal(row.verification_state, 'unverified', 'a changed figure invalidates the old verdict')
  assert.equal(row.verified_at, null)
})

test('a verdict is refused for a record that does not exist, and for a state nobody defined', () => {
  const db = fresh()
  assert.equal(recordVerdict(db, { accountId: ACCT, positionId: PID, state: 'verified' }).ok, false)
  seedComplete(db)
  capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(recordVerdict(db, { accountId: ACCT, positionId: PID, state: 'probably_fine' }).ok, false)
})

test('the backfill writes both streams and ranks what is missing', () => {
  // The ranking is the actionable output: it names, in order, what this
  // system does not record about its own trades.
  const db = fresh()
  seedComplete(db)
  // a second position, missing its plan and its reason
  db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, exit_price, volume, opened_at, closed_at, closed_at_ms,
                        gross_pnl, net_pnl, status, close_reason, strategy, ctrader_position_id, account_id, origin, commission, swap)
    VALUES ('GBPUSD','BUY',1.3,1.31,1000,?,?,?,10,9,'closed','stop_loss','donchian','999',?, 'scan_dispatch', 0, 0)
  `).run(new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString(), CLOSE_MS, ACCT)

  const out = backfillPositionHistory(db, { sinceMs: 0 })
  assert.equal(out.seen, 2)
  assert.equal(out.complete, 1)
  assert.equal(out.incomplete, 1)
  assert.ok(out.missingCounts.direction_reason >= 1, 'the missing reason is counted')

  const view = positionHistoryView(db)
  assert.equal(view.complete, 1)
  assert.equal(view.incomplete, 1)
  assert.equal(view.verification.unverified, 1)
  assert.ok(view.missingFields.length > 0)
  assert.equal(view.missingFields[0].n >= 1, true)
  assert.equal(view.recent[0].ctrader_position_id, PID)
})

test('management events are counted by kind and carried whole', () => {
  const db = fresh()
  const { tradeId } = seedComplete(db, { events: [['sl_moved', 1, 2], ['trail_tightened', 2, 3], ['tp_moved', 5, 6], ['lot_trimmed', 10, 5]] })
  const m = managementFor(db, { accountId: ACCT, positionId: PID, tradeId })
  assert.equal(m.sl_moves, 2, 'a trail tightening is a stop move')
  assert.equal(m.tp_moves, 1)
  assert.equal(m.scale_outs, 1)
  assert.equal(m.events.length, 4, 'and every event is kept, not just the counts')
  assert.equal(m.events[0].reason, 'moved to break-even at +1R')
})

test('a position with no local trade row is skipped rather than written as an empty shell', () => {
  const db = fresh()
  const r = capturePosition(db, { accountId: null, positionId: null })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_identity')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM position_history_incomplete').get().n, 0)
})

test('the required list names the fields an analysis depends on, and omits the ones it does not', () => {
  for (const f of ['direction_reason', 'commission', 'swap', 'net_pnl', 'close_reason', 'origin']) {
    assert.ok(REQUIRED_FIELDS.includes(f), `${f} must be required`)
  }
  for (const f of ['planned_tp', 'family', 'timeframe', 'conviction', 'symbol_id']) {
    assert.ok(!REQUIRED_FIELDS.includes(f),
      `${f} must NOT be required — a runner with no target, or an ungrouped record, is not a gap`)
  }
})

test('the sweep and the route are WIRED — a builder nothing calls is a dead one', () => {
  // CLAUDE.md failure mode #4: reconcileTradePricesToBroker was reachable
  // only from a manual POST route nobody ran, and #685's early-trim shadow
  // before it. A table with a builder and no caller is the same shape: it
  // would report zero rows forever and look like "no closed positions".
  //
  // The call site is invisible from this module, so it is pinned here.
  // Comments are stripped first (failure mode #2 — a test passing by matching
  // its own prose).
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /await backfillPositionHistoryCooperatively\(db, \{ sinceMs:/,
    'the loop must run the sweep, not merely be able to')
  assert.match(loop, /name: 'position-history'/,
    'and as a named housekeeping step, so a throw in it is reported rather than silent')

  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/position-history'/, 'the record must be readable')
  assert.match(state, /positionHistoryView\(db, \{ limit/, 'through the view, with its incomplete count')
})

test('the view reports the refused stream beside the clean one, never the clean one alone', () => {
  // If the route answered with only `complete`, an operator would read "12
  // positions recorded" from a system that had refused 200. The refused
  // count and the ranked missing fields are the half that is actionable.
  const db = fresh()
  seedComplete(db)
  db.exec(`UPDATE risk_events SET proposal_json = '{}'`)
  capturePosition(db, { accountId: ACCT, positionId: PID })
  const v = positionHistoryView(db)
  assert.equal(v.complete, 0)
  assert.equal(v.incomplete, 1)
  assert.deepEqual(v.missingFields, [{ field: 'direction_reason', n: 1 }])
})

test('the history is built ONCE AT BOOT, not only on the 8-hourly band', () => {
  // WHY THIS PIN EXISTS. The housekeeping sweep alone means the first record
  // appears up to eight hours after a deploy — and the owner's ask is to read
  // two months of history NOW. A feature that is correct but silent for eight
  // hours is indistinguishable, to the person waiting, from one that does not
  // work. Measured 17-09 17:07 UTC: 34 minutes after the deploy carrying the
  // sweep, no [position-history] line had appeared, because the band was not
  // due — which is what prompted this.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  assert.match(index, /backfillPositionHistory\(db, \{ sinceMs: Date\.now\(\) - 90 \* 86400_000 \}\)/,
    'boot builds the catch-up window, wider than the sweep\'s 30 days')
  assert.match(index, /\[boot\] position history: \$\{ph\.complete\} complete · \$\{ph\.incomplete\} incomplete/,
    'and prints the incomplete count beside the complete one, never alone')
  assert.match(index, /most often missing/, 'with the ranked field list that says what is not recorded')
})

// ---------------------------------------------------------------------------
// KEEPER-TRUTH FIX (18-09-2026). cpp-verify's contract-3 pass disputed the
// keeper on two fields that were the keeper's own doing: `volume` fell back
// to the REQUESTED lot size (612.13 against a 612 fill) and `closed_at_ms`
// was the reconciler's detection stamp (16–350 s after the broker's fill).
// ---------------------------------------------------------------------------

test('keeper truth: the closing deal\'s time beats the detection stamp, and the hold follows it', () => {
  const db = fresh()
  seedComplete(db)
  capturePosition(db, { accountId: ACCT, positionId: PID })      // the record as first captured
  assert.equal(db.prepare(`SELECT rebuilt_at FROM position_history WHERE ctrader_position_id = ?`).get(PID).rebuilt_at, null, 'a first build is not a rebuild')
  const brokerClose = CLOSE_MS - 274_000                           // DOW.US: detected 274 s late
  db.prepare(`UPDATE broker_deals SET closed_at = ? WHERE position_id = ?`).run(new Date(brokerClose).toISOString(), PID)
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.closed_at_ms, brokerClose, 'the fill time, not when we noticed')
  // B1: a rebuild that moved the figures stamps rebuilt_at (the re-verify cap reads it)
  const cap = capturePosition(db, { accountId: ACCT, positionId: PID })
  assert.equal(cap.reverified, true)
  assert.ok(db.prepare(`SELECT rebuilt_at FROM position_history WHERE ctrader_position_id = ?`).get(PID).rebuilt_at, 'rebuilt_at stamped when figures moved')
  assert.equal(record.hold_ms, brokerClose - OPEN_MS, 'hold recomputed from the corrected close')
  assert.equal(JSON.parse(record.sources_json).closed_at, 'broker_deals')
})

test('keeper truth: with no deal the detection stamp is used and NAMED as such', () => {
  const db = fresh()
  seedComplete(db)
  db.prepare(`DELETE FROM broker_deals`).run()
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.closed_at_ms, CLOSE_MS)
  assert.match(JSON.parse(record.sources_json).closed_at, /detection time/)
})

test('keeper truth: a position closed in two parts records the SUM of the fills, lots-weighted exit, summed money, last close', () => {
  const db = fresh()
  seedComplete(db)
  db.prepare(`UPDATE broker_deals SET lots = 6000, close_price = 1.1040, gross_pnl = 24, net_pnl = 23, closed_at = ? WHERE deal_id = 'd1'`)
    .run(new Date(CLOSE_MS - 600_000).toISOString())
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl)
              VALUES ('d2', ?, ?, 'EURUSD', 'BUY', 4000, 1.1000, 1.1065, ?, ?, 26, -1, -1, 24)`)
    .run(PID, ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.volume, 10000, 'lots summed across the parts')
  assert.ok(Math.abs(record.exit_price - (1.1040 * 0.6 + 1.1065 * 0.4)) < 1e-9, 'exit is lots-weighted')
  assert.equal(record.gross_pnl, 50); assert.equal(record.net_pnl, 47)
  assert.equal(record.closed_at_ms, CLOSE_MS, 'the close is the LAST part')
})

test('keeper truth: a part with no lots makes the group\'s lots ABSENT, never a partial sum', () => {
  const db = fresh()
  seedComplete(db)
  db.prepare(`INSERT INTO broker_deals (deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price, opened_at, closed_at, net_pnl)
              VALUES ('d2', ?, ?, 'EURUSD', 'BUY', NULL, 1.1000, 1.1065, ?, ?, 24)`)
    .run(PID, ACCT, new Date(OPEN_MS).toISOString(), new Date(CLOSE_MS).toISOString())
  db.prepare(`UPDATE trades SET volume = 12.57 WHERE ctrader_position_id = ?`).run(PID)
  const { record, missing } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  // C·4 (COST.US, the verifier's first contract-3 dispute: ours 12.57
  // requested vs the broker's 12.5 fill): the request never stands in.
  assert.equal(record.volume, null, 'no partial sum, and no request presented as the fill')
  assert.ok(missing.includes('volume'))
  assert.equal(record.requested_volume, 12.57)
  assert.match(JSON.parse(record.sources_json).volume, /requested size, not the fill/)
})

// ---------------------------------------------------------------------------
// C·3 / C·4 (18-09-2026): the view lists the disputes with their sources, and
// the post-cutoff refusals that also OPENED after the cutoff — the "live gap"
// the boot line counted and nothing listed.
// ---------------------------------------------------------------------------
test('C·4: the view lists disputed records with the disagreeing fields and where our figure came from', () => {
  const db = fresh()
  seedComplete(db)
  assert.equal(capturePosition(db, { accountId: ACCT, positionId: PID }).ok, true)
  recordVerdict(db, { accountId: ACCT, positionId: PID, state: 'disputed', host: 'demo.ctrader.com',
    disputes: [{ field: 'volume', keeper: 12.57, broker: 12.5 }], contractVersion: 3 })
  const v = positionHistoryView(db)
  assert.equal(v.verification.disputed, 1)
  assert.equal(v.disputed.length, 1)
  assert.equal(v.disputed[0].ctrader_position_id, PID)
  assert.deepEqual(v.disputed[0].disputes, [{ field: 'volume', keeper: 12.57, broker: 12.5 }])
  assert.equal(v.disputed[0].sources.volume, 'broker_deals')
  assert.equal(v.disputed[0].requested_volume, 10000)
})

test('C·3: the view lists the refusals that opened after the cutoff, by missing field, origin and strategy', () => {
  const db = fresh()
  const cutoffMs = Date.parse('2026-09-11T00:00:00Z')
  // One refusal opened BEFORE the cutoff (history), two opened after (the gap).
  const ins = db.prepare(`INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json) VALUES (?,?,?,?,?,?)`)
  ins.run(ACCT, 'p-old', 'EURUSD', cutoffMs + 86400_000, JSON.stringify(['direction_reason']),
    JSON.stringify({ opened_at_ms: cutoffMs - 86400_000, origin: 'scan_dispatch', strategy: 'vwap_trend' }))
  ins.run(ACCT, 'p-ext', 'XRPUSD', cutoffMs + 2 * 86400_000, JSON.stringify(['direction_reason', 'strategy', 'planned_entry']),
    JSON.stringify({ opened_at_ms: cutoffMs + 3600_000, origin: 'external', strategy: null }))
  ins.run(ACCT, 'p-book', 'LLY.US', cutoffMs + 3 * 86400_000, JSON.stringify(['direction_reason']),
    JSON.stringify({ opened_at_ms: cutoffMs + 7200_000, origin: 'momentum_book', strategy: 'tsmom_long' }))
  const v = positionHistoryView(db, { cutoffMs })
  const g = v.sinceCutoff.openedAfterCutoff
  assert.equal(g.n, 2, 'the pre-cutoff opening is history, not a gap')
  assert.deepEqual(g.byMissingField[0], { field: 'direction_reason', n: 2 })
  assert.deepEqual(g.byOrigin.map(x => x.key).sort(), ['external', 'momentum_book'])
  assert.deepEqual(g.byStrategy.find(x => x.key === 'null'), { key: 'null', n: 1 })
  assert.deepEqual(g.rows.map(r => r.ctrader_position_id), ['p-book', 'p-ext'], 'newest close first')
  assert.deepEqual(g.rows[1].missing, ['direction_reason', 'strategy', 'planned_entry'])
  // The per-account view scopes the list too.
  assert.equal(positionHistoryView(db, { cutoffMs, accountId: 'other' }).sinceCutoff.openedAfterCutoff.n, 0)
})

test('C·4: the requested_volume column exists on a fresh database and on one migrated from before it', () => {
  const db = fresh()
  const cols = new Set(db.prepare(`PRAGMA table_info(position_history)`).all().map(c => c.name))
  assert.ok(cols.has('requested_volume'))
})

test('keeper truth: without a deal the volume the reconciler read off the live position beats the requested size', () => {
  const db = fresh()
  const { tradeId } = seedComplete(db)
  db.prepare(`DELETE FROM broker_deals`).run()
  db.prepare(`UPDATE trades SET volume = 612.13 WHERE id = ?`).run(tradeId)
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, thesis, initial_risk, source, status, account_id, broker_volume_units)
              VALUES ('EURUSD', ?, 'long', 1.1, 1.098, 1.106, 't', 0.002, 'autopilot', 'closed', ?, 61200000)`).run(tradeId, ACCT)
  // EURUSD: 100,000 units per lot (the registry's table, no broker declaration seeded) → 612 lots
  const { record } = buildPositionRecord(db, { accountId: ACCT, positionId: PID })
  assert.equal(record.volume, 612, 'the fill the reconciler saw, not the 612.13 requested')
  assert.equal(JSON.parse(record.sources_json).volume, 'monitored_positions.broker_volume_units')
})

// ---------------------------------------------------------------------------
// V3 B4 (P5b-3): the refused stream names why each record is refused — and
// what cannot be recovered — without moving, filling or uncounting any.
// ---------------------------------------------------------------------------
const riskEventAt = (db, createdAt) =>
  db.prepare(`INSERT INTO risk_events (symbol, side, approved, proposal_json, created_at) VALUES ('EURUSD', 'BUY', 1, '{}', ?)`).run(createdAt).lastInsertRowid

test('B4: direction_reason is classed at the exact PR-D and PR-AL seconds, dated by the approving risk event', () => {
  const db = fresh()
  const cls = (createdAt) => classifyRefusedRecord(db, { record: { risk_event_id: riskEventAt(db, createdAt), opened_at_ms: Date.parse('2026-01-01T00:00:00Z') }, missing: ['direction_reason'] })
  assert.equal(cls('2026-09-11 15:03:45').class, 'pre_contract')
  assert.equal(cls('2026-09-11 15:03:46').class, 'post_contract_pre_fix', 'PR-D had shipped: a gap this codebase built')
  assert.equal(cls('2026-09-17 19:22:18').class, 'post_contract_pre_fix')
  const live = cls('2026-09-17 19:22:19')
  assert.equal(live.class, 'live_gap', 'after PR-AL\'s fix the gap is a writer defect now')
  assert.match(live.reason, /direction_reason: live_gap \(entered 2026-09-17T19:22:19Z \(risk event\), after #934's fix 2026-09-17T19:22:19Z\)/)
  // No risk event: the open dates the entry. No date at all: never excused.
  assert.equal(classifyRefusedRecord(db, { record: { opened_at_ms: Date.parse('2026-09-11T15:03:45.999Z') }, missing: ['direction_reason'] }).class, 'pre_contract')
  const undated = classifyRefusedRecord(db, { record: {}, missing: ['direction_reason'] })
  assert.equal(undated.class, 'live_gap'); assert.match(undated.reason, /entry time unknown — not excused by a date/)
})

test('B4: the plan fields split at #857; realised_r follows its missing input; pre_contract only when EVERY field is', () => {
  const db = fresh()
  const rec = (createdAt) => ({ risk_event_id: riskEventAt(db, createdAt) })
  const pre = classifyRefusedRecord(db, { record: rec('2026-09-08 07:48:27'), missing: ['planned_entry', 'risk_dist', 'realised_r'] })
  assert.equal(pre.class, 'pre_contract')
  assert.deepEqual(pre.fields, { planned_entry: 'pre_contract', risk_dist: 'pre_contract', realised_r: 'pre_contract' })
  assert.equal(classifyRefusedRecord(db, { record: rec('2026-09-08 07:48:28'), missing: ['planned_entry'] }).class, 'live_gap')
  const mixed = classifyRefusedRecord(db, { record: rec('2026-09-09 00:00:00'), missing: ['direction_reason', 'planned_entry'] })
  assert.deepEqual(mixed.fields, { direction_reason: 'pre_contract', planned_entry: 'live_gap' })
  assert.equal(mixed.class, 'live_gap', 'one live writer gap outranks a pre-contract field')
  assert.equal(classifyRefusedRecord(db, { record: rec('2026-09-01 00:00:00'), missing: ['close_reason'] }).class, 'live_gap', 'no dated contract: never excused by a date')
})

test('B4: a missing broker figure is labelled unrecoverable only by a write-off or a final unpriceable verdict, else pending', () => {
  const db = fresh()
  let seq = 0
  const tr = (writtenOff) => db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, origin, pnl_unresolvable, pnl_unresolvable_reason, pnl_unresolvable_at)
                                         VALUES ('GBPJPY', 'BUY', 'closed', ?, ?, 'bot_market_dispatch', ?, ?, ?)`)
    .run(ACCT, String(9100 + ++seq), writtenOff ? 1 : 0, writtenOff ? 'unresolved: no broker evidence: position deal evidence invalid' : null, writtenOff ? '2026-09-02 11:00:30' : null).lastInsertRowid
  const off = classifyRefusedRecord(db, { record: { trade_id: tr(true), account_id: ACCT, ctrader_position_id: '1' }, missing: ['net_pnl', 'gross_pnl'] })
  assert.equal(off.class, 'labelled_unrecoverable')
  assert.match(off.reason, /net_pnl: labelled_unrecoverable \(written off 2026-09-02 11:00:30: unresolved: no broker evidence: position deal evidence invalid\)/)
  const ev = (pos, verdict, final, rules = EVIDENCE_RULES) => db.prepare(`INSERT INTO position_lifecycle_evidence (account_id, position_id, verdict, final, rules, read_at) VALUES (?, ?, ?, ?, ?, '2026-09-25T23:00:00Z')`).run(ACCT, pos, verdict, final, rules)
  ev('2', 'never_filled', 1); ev('3', 'unreadable', 0)
  // B4 checker nit 4 (B2 N3): a final verdict under OLDER rules is due a re-read and labels nothing.
  ev('5', 'never_filled', 1, EVIDENCE_RULES - 1)
  const stale = classifyRefusedRecord(db, { record: { trade_id: tr(false), account_id: ACCT, ctrader_position_id: '5' }, missing: ['net_pnl'] })
  assert.equal(stale.class, 'broker_evidence_pending')
  assert.match(stale.reason, new RegExp(`broker verdict never_filled \\(final under rules ${EVIDENCE_RULES - 1}, re-read due\\)`))
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr(false), account_id: ACCT, ctrader_position_id: '2' }, missing: ['net_pnl'] }).class, 'labelled_unrecoverable')
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr(false), account_id: ACCT, ctrader_position_id: '2.0' }, missing: ['net_pnl'] }).class, 'labelled_unrecoverable', 'the ".0" spelling is the same position')
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr(false), account_id: ACCT, ctrader_position_id: '3' }, missing: ['net_pnl'] }).class, 'broker_evidence_pending')
  assert.equal(classifyRefusedRecord(db, { record: { account_id: ACCT, ctrader_position_id: '4' }, missing: ['volume'] }).class, 'broker_evidence_pending')
  const both = classifyRefusedRecord(db, { record: { account_id: ACCT, ctrader_position_id: '4', opened_at_ms: Date.parse('2026-09-01T00:00:00Z') }, missing: ['direction_reason', 'volume'] })
  assert.deepEqual(both.fields, { direction_reason: 'pre_contract', volume: 'broker_evidence_pending' })
  assert.equal(both.class, 'broker_evidence_pending')
})

test('B4: a bot-side field on a position the bot did not open is outside_bot; an adoption wearing our label is judged as the bot\'s', () => {
  const db = fresh()
  const tr = (origin, label = null) => db.prepare(`INSERT INTO trades (symbol, side, status, account_id, ctrader_position_id, origin, label_raw) VALUES ('Cocoa', 'BUY', 'closed', ?, '5', ?, ?)`).run(ACCT, origin, label).lastInsertRowid
  const after = Date.parse('2026-09-25T13:21:20Z')
  const manual = classifyRefusedRecord(db, { record: { trade_id: tr('manual_broker'), opened_at_ms: after }, missing: ['direction_reason', 'strategy', 'planned_entry', 'risk_dist'] })
  assert.equal(manual.class, 'outside_bot'); assert.match(manual.reason, /origin manual_broker/)
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr('reconciler_adopted', 'someone-elses-label'), opened_at_ms: after }, missing: ['direction_reason'] }).class, 'outside_bot')
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr('reconciler_adopted', 'ap|v1|FIB|H|LN|4h|RG'), opened_at_ms: after }, missing: ['direction_reason'] }).class, 'live_gap')
  assert.equal(classifyRefusedRecord(db, { record: { trade_id: tr('bot_market_dispatch'), opened_at_ms: after }, missing: ['direction_reason'] }).class, 'live_gap')
})

test('B4: the backfill counts add up — seen = complete + incomplete + skipped — and the classes partition the incomplete', () => {
  const db = fresh()
  seedComplete(db)
  db.prepare(`INSERT INTO trades (symbol, side, status, closed_at_ms, ctrader_position_id, account_id, origin) VALUES ('X', 'BUY', 'closed', ?, 'no-acct', NULL, 'bot_market_dispatch')`).run(CLOSE_MS)
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, closed_at_ms, ctrader_position_id, account_id, origin) VALUES ('X', 'BUY', 'closed', '2026-09-01 00:00:00', ?, 'p-pre', ?, 'bot_market_dispatch')`).run(CLOSE_MS, ACCT)
  db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, closed_at_ms, ctrader_position_id, account_id, origin) VALUES ('X', 'BUY', 'closed', '2026-09-25 00:00:00', ?, 'p-live', ?, 'bot_market_dispatch')`).run(CLOSE_MS, ACCT)
  const out = backfillPositionHistory(db, { sinceMs: 0 })
  assert.deepEqual({ seen: out.seen, complete: out.complete, incomplete: out.incomplete, skipped: out.skipped }, { seen: 4, complete: 1, incomplete: 2, skipped: 1 })
  assert.equal(out.seen, out.complete + out.incomplete + out.skipped)
  assert.equal(Object.values(out.byClass).reduce((a, b) => a + b, 0), out.incomplete)
  // The boot count and the view classify the same stored records the same way.
  assert.deepEqual(Object.fromEntries(positionHistoryView(db).refused.byClass.map(c => [c.class, c.n])), out.byClass)
  assert.equal(classifyRefusedRecord(db, { record: JSON.parse(db.prepare(`SELECT partial_json FROM position_history_incomplete WHERE ctrader_position_id = 'p-live'`).get().partial_json), missing: ['direction_reason'] }).class, 'live_gap',
    'p-live: opened after every contract, missing its reason')
  assert.equal(refusedClassesPhrase(out.byClass), Object.entries(out.byClass).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', '))
  assert.equal(refusedClassesPhrase({ pre_contract: 2, live_gap: 3, outside_bot: 0 }), 'live_gap 3, pre_contract 2')
})

test('B4: a record is never built from a rejected twin, the ".0" spelling is the same position, and the lookup stays on idx_trades_position_id', () => {
  const db = fresh()
  const ins = db.prepare(`INSERT INTO trades (symbol, side, status, opened_at, ctrader_position_id, account_id, origin) VALUES ('EURUSD', 'BUY', ?, '2026-09-25 00:00:00', ?, ?, 'bot_market_dispatch')`)
  const live = ins.run('open', '907', ACCT).lastInsertRowid
  ins.run('rejected', '907', ACCT) // newer, rejected: a twin, not the record
  assert.equal(buildPositionRecord(db, { accountId: ACCT, positionId: '907' }).record.trade_id, Number(live))
  const cancelledOnly = ins.run('open', '908', ACCT).lastInsertRowid
  ins.run('cancelled', '908', ACCT)
  assert.equal(buildPositionRecord(db, { accountId: ACCT, positionId: '908' }).record.trade_id, Number(cancelledOnly))
  const dotted = ins.run('closed', '909.0', ACCT).lastInsertRowid
  assert.equal(buildPositionRecord(db, { accountId: ACCT, positionId: '909' }).record.trade_id, Number(dotted), 'a row stored as "909.0" is position 909')
  assert.equal(buildPositionRecord(db, { accountId: ACCT, positionId: '909.0' }).record.trade_id, Number(dotted))
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${POSITION_TRADE_SQL}`).all('909', '909.0', ACCT, ACCT).map(r => r.detail).join(' | ')
  assert.match(plan, /idx_trades_position_id/, `the lookup must use the index, not scan: ${plan}`)
})

test('B4: the view classes every refused record — total equals incomplete, the classes partition it, each row carries its reason', () => {
  const db = fresh()
  const cutoffMs = Date.parse('2026-09-11T00:00:00Z')
  const ins = db.prepare(`INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json) VALUES (?,?,?,?,?,?)`)
  ins.run(ACCT, 'p-old', 'EURUSD', cutoffMs + 86400_000, JSON.stringify(['direction_reason']), JSON.stringify({ opened_at_ms: cutoffMs - 86400_000 }))
  ins.run(ACCT, 'p-fix', 'COIN.US', cutoffMs + 2 * 86400_000, JSON.stringify(['direction_reason']), JSON.stringify({ opened_at_ms: Date.parse('2026-09-15T00:00:00Z') }))
  ins.run(ACCT, 'p-now', 'MSFT.US', cutoffMs + 3 * 86400_000, JSON.stringify(['direction_reason', 'planned_entry', 'risk_dist']), JSON.stringify({ opened_at_ms: Date.parse('2026-09-25T16:40:00Z') }))
  const v = positionHistoryView(db, { cutoffMs })
  assert.equal(v.incomplete, 3)
  assert.equal(v.refused.total, v.incomplete)
  assert.deepEqual(v.refused.byClass, [{ class: 'live_gap', n: 1 }, { class: 'post_contract_pre_fix', n: 1 }, { class: 'pre_contract', n: 1 }])
  assert.deepEqual(v.refused.rows.map(r => [r.ctrader_position_id, r.class]), [['p-now', 'live_gap'], ['p-fix', 'post_contract_pre_fix'], ['p-old', 'pre_contract']])
  assert.ok(v.refused.rows.every(r => typeof r.reason === 'string' && r.reason.length > 0))
  assert.deepEqual(Object.keys(v.refused.classes).sort(), Object.keys(REFUSED_CLASSES).sort())
  assert.equal(v.refused.semantics.id, 'H-P5b-3')
  assert.deepEqual(v.sinceCutoff.openedAfterCutoff.rows.map(r => [r.ctrader_position_id, r.class]), [['p-now', 'live_gap'], ['p-fix', 'post_contract_pre_fix']])
  assert.deepEqual(v.missingFields[0], { field: 'direction_reason', n: 3 }, 'the existing ranking is unchanged')
})

test('B4: the boot line and the housekeeping line print skipped beside complete and incomplete, and the refused classes', () => {
  // Source pin (failure mode #4: the call site is invisible from this module);
  // comments stripped first (failure mode #2).
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  assert.match(index, /\$\{ph\.complete\} complete · \$\{ph\.incomplete\} incomplete · \$\{ph\.skipped\} skipped \(no account identity\) of \$\{ph\.seen\}/)
  assert.match(index, /refusedClassesPhrase\(ph\.byClass\)/)
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /\$\{out\.complete\} complete · \$\{out\.incomplete\} incomplete · \$\{out\.skipped\} skipped \(no account identity\) of \$\{out\.seen\}/)
  assert.match(loop, /refusedClassesPhrase\(out\.byClass\)/)
})

// ---------------------------------------------------------------------------
// V3 B4b: a close record the order-lifecycle close rules flag (CLS-04, CLS-03)
// is classed by the SAME classifier — the stored refused record first, the
// ledger row when there is none — and nothing about it is moved or recovered.
// ---------------------------------------------------------------------------
test('B4b: a flagged close is classed from its stored refused record — either text form, "record" dropped for the named fields, the classifier\'s own answer', () => {
  const db = fresh()
  const partial = { trade_id: null, opened_at_ms: Date.parse('2026-09-25T16:40:00Z'), account_id: ACCT, ctrader_position_id: '909.0' }
  db.prepare(`INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json) VALUES (?, '909.0', 'MSFT.US', ?, ?, ?)`)
    .run(ACCT, CLOSE_MS, JSON.stringify(['direction_reason', 'planned_entry', 'risk_dist']), JSON.stringify(partial))
  const c = classifyFlaggedClose(db, { accountId: ACCT, positionId: '909', missing: ['record'] })
  assert.deepEqual([c.symbol, c.positionId, c.stored], ['MSFT.US', '909', 'refused'], 'the ".0" spelling is the same position')
  assert.deepEqual(c.missing, ['direction_reason', 'planned_entry', 'risk_dist'], 'the gave-up "record" goes when the stored record names the fields')
  const direct = classifyRefusedRecord(db, { record: { ...partial, ctrader_position_id: '909.0' }, missing: c.missing })
  assert.deepEqual({ class: c.class, fields: c.fields, reason: c.reason }, direct, 'the same classifier, the same answer')
  assert.equal(c.class, 'live_gap')
  // A flag's own field is added to what the stored record lacks.
  const both = classifyFlaggedClose(db, { accountId: ACCT, positionId: '909.0', missing: ['close_cause'] })
  assert.deepEqual(both.missing, ['direction_reason', 'planned_entry', 'risk_dist', 'close_cause'])
  assert.match(both.reason, /close_cause: live_gap \(no dated contract for this field\)/)
  // The two lookups stay on the primary keys — no SCAN of either table.
  for (const [sql, args] of [[FLAGGED_REFUSED_SQL, [ACCT, '909', '909.0', '909']], [FLAGGED_COMPLETE_SQL, [ACCT, '909', '909.0']]]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail).join(' | ')
    assert.match(plan, /USING (PRIMARY KEY|(COVERING )?INDEX sqlite_autoindex_position_history(_incomplete)?_1)/, plan)
    assert.doesNotMatch(plan, /^SCAN|\| SCAN/, plan)
  }
})

test('B4b: with no refused record the ledger row is the record — a CLS-03 close is classed on its close cause, dated by its risk event, and where it is stored is said, never taken as recovered', () => {
  const db = fresh()
  const { tradeId, riskEventId } = seedComplete(db)
  db.prepare(`UPDATE risk_events SET created_at = '2026-09-15 00:00:00' WHERE id = ?`).run(riskEventId)
  // Stored complete in the clean table, and CLS-03 still flags its generic cause.
  assert.equal(capturePosition(db, { accountId: ACCT, positionId: PID }).ok, true)
  const c = classifyFlaggedClose(db, { accountId: ACCT, positionId: PID, tradeId: Number(tradeId), missing: ['close_cause'] })
  assert.deepEqual([c.symbol, c.tradeId, c.stored, c.missing, c.class], ['EURUSD', Number(tradeId), 'complete', ['close_cause'], 'live_gap'])
  // The same classifier on the ledger's record: dated by the risk event, origin from the trade.
  const direct = classifyRefusedRecord(db, { record: { trade_id: Number(tradeId), risk_event_id: Number(riskEventId), opened_at_ms: OPEN_MS, origin: 'scan_dispatch', account_id: ACCT, ctrader_position_id: PID }, missing: ['close_cause'] })
  assert.deepEqual({ class: c.class, fields: c.fields, reason: c.reason }, direct)
  // A missing direction reason on the same row reads the risk event's date: between PR-D and PR-AL.
  assert.equal(classifyFlaggedClose(db, { accountId: ACCT, positionId: PID, missing: ['direction_reason'] }).class, 'post_contract_pre_fix')
  // Nothing known at all: the record itself is what is missing, a writer gap, never excused.
  const bare = classifyFlaggedClose(db, { accountId: ACCT, positionId: '777', missing: ['record'] })
  assert.deepEqual([bare.stored, bare.missing, bare.class, bare.symbol], ['none', ['record'], 'live_gap', null])
  // Reading never writes: both tables are exactly as they were.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_history').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM position_history_incomplete').get().n, 0)
})
