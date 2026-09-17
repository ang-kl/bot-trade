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
  REQUIRED_FIELDS, buildPositionRecord, capturePosition, backfillPositionHistory,
  recordVerdict, positionHistoryView, directionReasonFor, managementFor,
} from './position-history.js'

const ACCT = '47790949'
const PID = '240505687'
const OPEN_MS = Date.parse('2026-09-15T08:00:00Z')
const CLOSE_MS = Date.parse('2026-09-15T12:00:00Z')

const fresh = () => initDB(':memory:')

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
  assert.deepEqual(missing, [])
  assert.equal(record.net_pnl, 48)
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
  assert.match(loop, /backfillPositionHistory\(db, \{ sinceMs:/,
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
