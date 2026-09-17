// agent/services/position-history-partial.test.js
//
// The owner's rule (18-09-2026): the date, time and details of a partial
// analysis must travel with it, so a future reader cannot mistake figures
// drawn from INCOMPLETE records for the proper analysis over complete ones.
//
// So most of these tests are about the caveat rather than the arithmetic: a
// number that is right but unlabelled is the failure being guarded against.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { partialAnalysis, partialAnalysisLine, CLEAN_DATA_CUTOFF } from './position-history-partial.js'
import { completenessSpan, capturePosition } from './position-history.js'

const ACCT = '47790949'
const fresh = () => initDB(':memory:')

/** A refused record, as capturePosition would have written it. */
function refused(db, { pid, symbol = 'EURUSD', strategy = 'vwap_trend', direction = 'long',
  net = 10, closedAt = Date.parse('2026-08-20T10:00:00Z'), missing = ['direction_reason'], reason = 'take_profit' } = {}) {
  db.prepare(`
    INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ACCT, String(pid), symbol, closedAt, JSON.stringify(missing), JSON.stringify({
    account_id: ACCT, ctrader_position_id: String(pid), symbol, strategy, direction,
    net_pnl: net, closed_at_ms: closedAt, close_reason: reason,
  }))
}

test('the provenance block is attached to the figures, not offered beside them', () => {
  const db = fresh()
  refused(db, { pid: 1 })
  const r = partialAnalysis(db, { now: Date.parse('2026-09-18T02:30:00Z') })

  assert.equal(r.provenance.basis, 'INCOMPLETE_RECORDS')
  assert.equal(r.provenance.generatedAtUtc, '2026-09-18T02:30:00.000Z')
  assert.match(r.provenance.generatedAtSgt, /^2026-09-18 10:30:00 SGT$/, 'both clocks, so nobody has to convert')
  assert.match(r.provenance.warning, /NOT the proper analysis/)
  assert.equal(r.provenance.records, 1)
  assert.equal(r.provenance.cleanDataCutoff.date, CLEAN_DATA_CUTOFF.date)
  // and the figures are in the SAME object — there is no way to take one
  // without the other
  assert.ok(r.totals && r.byStrategy)
})

test('every aggregate carries its own denominator', () => {
  // "vwap_trend lost $2,100" is a fact about vwap_trend only if you know how
  // many vwap_trend trades recorded both fields. Two of these four rows have
  // no strategy; the aggregate must say so rather than quietly averaging the
  // two that do.
  const db = fresh()
  refused(db, { pid: 1, strategy: 'vwap_trend', net: -50 })
  refused(db, { pid: 2, strategy: 'vwap_trend', net: 20 })
  refused(db, { pid: 3, strategy: null, net: 999 })
  refused(db, { pid: 4, strategy: '', net: 999 })

  const r = partialAnalysis(db)
  assert.equal(r.byStrategy.basedOn, 2)
  assert.equal(r.byStrategy.skippedForMissingField, 2)
  assert.equal(r.byStrategy.coveragePct, 50)
  assert.equal(r.byStrategy.rows[0].key, 'vwap_trend')
  assert.equal(r.byStrategy.rows[0].n, 2)
  assert.equal(r.byStrategy.rows[0].total, -30)
  assert.equal(r.byStrategy.rows[0].winRatePct, 50)
})

test('a row with no strategy is skipped, never folded into an "unknown" bucket', () => {
  // An `unknown` bucket would then be ranked against real strategies as
  // though it were one, and its P&L would be read as a finding about a
  // strategy that does not exist.
  const db = fresh()
  refused(db, { pid: 1, strategy: null, net: -500 })
  const r = partialAnalysis(db)
  assert.deepEqual(r.byStrategy.rows, [])
  assert.equal(r.byStrategy.skippedForMissingField, 1)
})

test('the P&L total is named as a subset, and the rows without one are counted', () => {
  const db = fresh()
  refused(db, { pid: 1, net: 100 })
  refused(db, { pid: 2, net: null })
  const r = partialAnalysis(db)
  assert.equal(r.totals.positions, 2)
  assert.equal(r.totals.withNetPnl, 1)
  assert.equal(r.totals.withoutNetPnl, 1)
  assert.equal(r.totals.netPnlOverRowsThatHaveIt, 100)
  assert.ok(!('netPnl' in r.totals), 'there is no bare `netPnl` field to quote without the caveat')
})

test('the covered period and the ranked missing fields are reported', () => {
  const db = fresh()
  refused(db, { pid: 1, closedAt: Date.parse('2026-07-01T00:00:00Z'), missing: ['direction_reason'] })
  refused(db, { pid: 2, closedAt: Date.parse('2026-09-01T00:00:00Z'), missing: ['direction_reason', 'planned_entry'] })
  const r = partialAnalysis(db)
  assert.equal(r.provenance.coveredPeriod.earliest, '2026-07-01T00:00:00.000Z')
  assert.equal(r.provenance.coveredPeriod.latest, '2026-09-01T00:00:00.000Z')
  assert.deepEqual(r.provenance.missingFields, [
    { field: 'direction_reason', n: 2 },
    { field: 'planned_entry', n: 1 },
  ])
})

test('the one-line summary leads with the warning, not with the money', () => {
  // This line goes to the boot log, which is the only place these figures can
  // be read without the bearer token. A summary opening with a P&L number
  // would be quoted without its caveat within a day.
  const db = fresh()
  refused(db, { pid: 1, strategy: 'vwap_trend', net: -50 })
  const line = partialAnalysisLine(partialAnalysis(db, { now: Date.parse('2026-09-18T02:30:00Z') }))
  assert.match(line, /^\[partial-analysis\] INCOMPLETE RECORDS ONLY — not the proper analysis/)
  assert.match(line, /generated 2026-09-18 10:30:00 SGT/)
  assert.match(line, /clean data begins 2026-09-11 \(direction_reason\)/)
  assert.ok(line.indexOf('INCOMPLETE') < line.indexOf('net '), 'the caveat precedes any figure')
})

test('an unparseable stored record is counted, not silently dropped', () => {
  const db = fresh()
  db.prepare(`
    INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
    VALUES (?, '9', 'EURUSD', 1, '[]', 'not json')
  `).run(ACCT)
  const r = partialAnalysis(db)
  assert.equal(r.provenance.unparseableRows, 1)
  assert.equal(r.provenance.records, 0)
})

test('the partial analysis never reads the clean table', () => {
  // The two streams must not mix in either direction. A complete record
  // appearing in these figures would make them partly proper and wholly
  // unquotable.
  const src = readFileSync(new URL('./position-history-partial.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/FROM position_history\b/.test(src),
    'only position_history_incomplete may be read here')
  assert.match(src, /FROM position_history_incomplete/)
})

test('the empty case produces a stamp and no figures, rather than zeros that look like findings', () => {
  const db = fresh()
  const r = partialAnalysis(db)
  assert.equal(r.provenance.records, 0)
  assert.equal(r.provenance.coveredPeriod, null)
  assert.deepEqual(r.byStrategy.rows, [])
  assert.equal(r.byStrategy.coveragePct, null, 'no rows means no coverage figure, not 0%')
})

test('completenessSpan measures where clean data begins instead of arguing it from a commit date', () => {
  // The deduction — direction_reason arrived in 8eb4e75 on 11-09, so nothing
  // earlier can be complete — is sound one way only. It says nothing about
  // whether everything AFTER is complete, and production's first run showed
  // 63 records with a reason but only 60 whole.
  const db = fresh()
  const before = Date.parse('2026-08-01T00:00:00Z')
  const after = Date.parse('2026-09-15T00:00:00Z')
  const re = db.prepare(`INSERT INTO risk_events (symbol, side, approved, proposal_json) VALUES ('EURUSD','BUY',1,?)`)
    .run(JSON.stringify({ direction_reason: 'trend' }))
  const mk = (pid, closedMs) => {
    const t = db.prepare(`
      INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, volume, opened_at, closed_at, closed_at_ms,
                          hold_duration_ms, gross_pnl, net_pnl, status, close_reason, strategy, ctrader_position_id,
                          account_id, risk_event_id, origin, commission, swap, realised_rr)
      VALUES ('EURUSD','BUY',1.1,1.105,1.098,10000,?,?,?,100,50,48,'closed','tp','vwap_trend',?,?,?,'scan_dispatch',-1,-1,2.5)
    `).run(new Date(closedMs - 100).toISOString(), new Date(closedMs).toISOString(), closedMs, String(pid), ACCT, re.lastInsertRowid)
    db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, strategy, planned_entry, planned_sl, risk_dist)
                VALUES (?, ?, 'EURUSD','BUY','vwap_trend',1.1,1.098,0.002)`).run(t.lastInsertRowid, ACCT)
    capturePosition(db, { accountId: ACCT, positionId: String(pid) })
  }
  mk(1, after)
  refused(db, { pid: 2, closedAt: after })       // post-cutoff but refused
  refused(db, { pid: 3, closedAt: before })      // pre-cutoff

  const span = completenessSpan(db)
  assert.equal(span.complete, 1)
  assert.equal(span.completeBeforeCutoff, 0, 'a complete record before the cutoff would falsify the deduction')

  // AND THE COUNTER MUST BE ABLE TO SAY OTHERWISE. Asserting only that it
  // reads 0 cannot distinguish a measurement from a hardcoded zero — which
  // is CLAUDE.md failure mode #1, and is exactly what happened when this was
  // first mutation-checked. So a pre-cutoff complete record is constructed
  // (artificial: no August trade really carries a direction_reason) purely to
  // prove the count is live.
  mk(4, before)
  const falsified = completenessSpan(db)
  assert.equal(falsified.completeBeforeCutoff, 1,
    'the counter reports a pre-cutoff complete record rather than always reading 0')
  assert.equal(falsified.completeSinceCutoff, 1, 'and the post-cutoff side is unaffected by it')
  assert.equal(span.completeSinceCutoff, 1)
  assert.equal(span.refusedSinceCutoff, 1, 'the pre-cutoff refusal is not counted here')
  assert.equal(span.completionRateSinceCutoffPct, 50,
    'the post-cutoff rate is measured, not assumed to be 100%')
})

test('boot prints the boundary and the stamped partial line — both readable without the bearer token', () => {
  // The token has been unavailable since 07-09, and that is precisely why
  // these go to the log rather than to a route alone.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  assert.match(index, /completenessSpan\(db\)/)
  assert.match(index, /clean-data boundary/)
  assert.match(index, /before the \$\{span\.cutoff\.slice\(0, 10\)\} cutoff \(expected 0\)/,
    'the falsifying count is printed with what it should be')
  assert.match(index, /partialAnalysisLine\(pa\)/)
  assert.match(index, /if \(pa\.provenance\.records > 0\)/, 'and nothing is printed when there is nothing to say')

  const state = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(state, /router\.get\('\/position-history-partial'/)
})

test('the post-cutoff refusals are split on OPEN date, which is what explains the rate', () => {
  // Production read 60 complete / 90 refused since the cutoff — 40%, where
  // arithmetic had suggested ~95%. The hypothesis: `direction_reason` is
  // recorded AT ENTRY, so a position opened before the cutoff and closed
  // after it can never be complete, and the real boundary is an open-date
  // one measured on close date.
  //
  // The split is what settles it, so it must actually distinguish the two
  // cases rather than reporting a plausible constant.
  const db = fresh()
  const cutoff = Date.parse('2026-09-11T00:00:00Z')
  const inc = (pid, openedAt, closedAt) => {
    db.prepare(`
      INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
      VALUES (?, ?, 'EURUSD', ?, '["direction_reason"]', ?)
    `).run(ACCT, String(pid), closedAt, JSON.stringify({ opened_at_ms: openedAt, closed_at_ms: closedAt }))
  }
  inc(1, Date.parse('2026-09-05T00:00:00Z'), Date.parse('2026-09-15T00:00:00Z')) // opened before, closed after
  inc(2, Date.parse('2026-09-06T00:00:00Z'), Date.parse('2026-09-16T00:00:00Z')) // ditto
  inc(3, Date.parse('2026-09-13T00:00:00Z'), Date.parse('2026-09-16T00:00:00Z')) // opened AFTER — a live gap
  db.prepare(`
    INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
    VALUES (?, '4', 'EURUSD', ?, '["direction_reason"]', ?)
  `).run(ACCT, Date.parse('2026-09-16T00:00:00Z'), JSON.stringify({ closed_at_ms: 1 })) // no open time

  const span = completenessSpan(db, { cutoffMs: cutoff })
  assert.equal(span.refusedSinceCutoff, 4)
  assert.equal(span.refusedSinceCutoffOpenedBeforeCutoff, 2, 'history: the entry predates the field')
  assert.equal(span.refusedSinceCutoffOpenedAfterCutoff, 1, 'a live gap — an entry made after the field existed, still with no reason')
  assert.equal(span.refusedSinceCutoffOpenTimeUnknown, 1, 'and an unknown open time is its own bucket, not folded into either')
})

test('the stamp keeps the deduced cutoff and the measured first record apart', () => {
  // Production put them three days apart (11-09 deduced, 14-09 measured).
  // Printing only the deduced date beside real figures invites it to be read
  // as the measurement.
  const db = fresh()
  refused(db, { pid: 1 })
  const r = partialAnalysis(db, { measuredCleanDataStart: '2026-09-14T13:35:03.183Z' })
  assert.equal(r.provenance.cleanDataCutoff.date, '2026-09-11', 'the deduced boundary')
  assert.equal(r.provenance.cleanDataCutoff.measuredFirstCompleteRecord, '2026-09-14T13:35:03.183Z')
  assert.match(r.provenance.cleanDataCutoff.note, /earliest date a complete record COULD exist/)

  const none = partialAnalysis(db)
  assert.equal(none.provenance.cleanDataCutoff.measuredFirstCompleteRecord, null)
  assert.match(none.provenance.cleanDataCutoff.note, /no measured first complete record/,
    'and absence is stated, not left to look like 11-09')
})

test('boot prints the open-date split beside the rate', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const index = strip(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))
  assert.match(index, /refusedSinceCutoffOpenedBeforeCutoff\} OPENED before the cutoff/)
  assert.match(index, /opened after \(a live gap if this is large\)/)
  assert.match(index, /measuredCleanDataStart: span\.earliest/,
    'and the measured start reaches the stamp without the partial module querying the clean table')
})
