// node --test agent/services/opportunity-disposition.test.js
//
// §70.8. The load-bearing test here is the ORDER of the decision table: a
// receipt is itself an approved row, and counting it as an approval that
// landed double-counts every successful placement — the mistake
// decision-audit.js already had to unwind once. The rest is about not
// manufacturing the alarm this exists to detect.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import {
  DISPOSITIONS, DEFAULT_GRACE_MIN, dispositionFor,
  sweepDispositions, recordSubmitted, dispositionReport,
} from './opportunity-disposition.js'

const RECEIPT = JSON.stringify({ pending_order_placed: true, orderId: 352974283 })
const REFUSAL = JSON.stringify({ post_approval: true, reason: 'volume below broker minimum' })
const PLAIN = JSON.stringify({ balance: 50000, account_id: '46130058' })

function fresh() { return initDB(':memory:') }

function riskEvent(db, { approved = 1, checks = PLAIN, minsAgo = 60, symbol = 'EURUSD', account = '46130058' } = {}) {
  return db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
    VALUES (?, 'BUY', ?, NULL, ?, '{}', ?, datetime('now', ?))
  `).run(symbol, approved, checks, account, `-${minsAgo} minutes`).lastInsertRowid
}

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

test('a veto is terminal on arrival', () => {
  assert.equal(dispositionFor({ approved: 0, checksJson: PLAIN }), 'vetoed')
})

test('a RECEIPT is classified before "ordered" — this ordering is the whole test', () => {
  // A receipt is an approved row that also references nothing. Read as an
  // approval it would double-count every successful placement.
  assert.equal(dispositionFor({ approved: 1, checksJson: RECEIPT, landed: false, ageMin: 999 }), 'receipt')
  assert.equal(dispositionFor({ approved: 1, checksJson: RECEIPT, landed: true, ageMin: 999 }), 'receipt')
})

test('a post-approval refusal is its own end state, not a drop', () => {
  // It did not go nowhere. It went somewhere loud, with a named reason.
  assert.equal(dispositionFor({ approved: 1, checksJson: REFUSAL, landed: false, ageMin: 999 }), 'refused_post_approval')
})

test('an approval a row references is ordered', () => {
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: true, ageMin: 1 }), 'ordered')
})

test('an approval inside the grace window is NOT yet terminal', () => {
  // A controller that labelled a live order "dropped" would manufacture the
  // alarm it exists to detect.
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: 1 }), null)
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: DEFAULT_GRACE_MIN - 0.1 }), null)
})

test('an approval past grace with nothing referencing it is the §70.8 finding', () => {
  assert.equal(dispositionFor({ approved: 1, checksJson: PLAIN, landed: false, ageMin: DEFAULT_GRACE_MIN + 1 }), 'dropped')
})

test('every value the table can produce is in the declared set', () => {
  const produced = new Set()
  for (const approved of [0, 1]) {
    for (const checksJson of [PLAIN, RECEIPT, REFUSAL]) {
      for (const landed of [true, false]) {
        for (const ageMin of [0, 999]) {
          const d = dispositionFor({ approved, checksJson, landed, ageMin })
          if (d != null) produced.add(d)
        }
      }
    }
  }
  for (const d of produced) assert.ok(DISPOSITIONS.includes(d), `${d} is not a declared disposition`)
})

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test('the sweep settles what it can and leaves the in-flight alone', () => {
  const db = fresh()
  const dropped = riskEvent(db, { minsAgo: 60 })
  const inflight = riskEvent(db, { minsAgo: 1 })
  const vetoed = riskEvent(db, { approved: 0, minsAgo: 60 })

  const out = sweepDispositions(db)
  assert.equal(out.written, 2)
  assert.equal(out.pending, 1)
  assert.equal(out.counts.dropped, 1)
  assert.equal(out.counts.vetoed, 1)

  const get = (id) => db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition
  assert.equal(get(dropped), 'dropped')
  assert.equal(get(vetoed), 'vetoed')
  assert.equal(get(inflight), null, 'still resolving — not yet a finding')
})

test('an approval a trade references reads as ordered, not dropped', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id, account_id)
              VALUES ('EURUSD','BUY',1.1,'open',datetime('now'),?,'46130058')`).run(id)
  sweepDispositions(db)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

test('a pending order counts as landing too', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  db.prepare(`INSERT INTO pending_orders (symbol, dir, level, status, risk_event_id)
              VALUES ('EURUSD',1,1.1,'working',?)`).run(id)
  sweepDispositions(db)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

test('the sweep is idempotent — a settled row is not rewritten', () => {
  const db = fresh()
  riskEvent(db, { minsAgo: 60 })
  assert.equal(sweepDispositions(db).written, 1)
  assert.equal(sweepDispositions(db).written, 0, 'second pass costs one scan and no writes')
  assert.equal(sweepDispositions(db).scanned, 0, 'and stops scanning settled rows entirely')
})

test('redo re-derives, for when the derivation itself changed', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  sweepDispositions(db)
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, status, opened_at, risk_event_id)
              VALUES ('EURUSD','BUY',1.1,'open',datetime('now'),?)`).run(id)
  assert.equal(sweepDispositions(db).written, 0, 'without redo the settled row stays')
  assert.equal(sweepDispositions(db, { redo: true }).written, 1)
  assert.equal(db.prepare('SELECT disposition FROM risk_events WHERE id = ?').get(id).disposition, 'ordered')
})

// ---------------------------------------------------------------------------
// Latency and the report
// ---------------------------------------------------------------------------

test('submitted_at is written once and never overwritten', () => {
  const db = fresh()
  const id = riskEvent(db, { minsAgo: 60 })
  assert.equal(recordSubmitted(db, id, '2026-08-04T10:00:00.000Z'), true)
  recordSubmitted(db, id, '2026-08-04T11:00:00.000Z')
  assert.equal(
    db.prepare('SELECT submitted_at FROM risk_events WHERE id = ?').get(id).submitted_at,
    '2026-08-04T10:00:00.000Z',
    'a retry must not restate when the order first left',
  )
  assert.equal(recordSubmitted(db, null), false)
  assert.equal(recordSubmitted(db, 999999), false)
})

test('the report names the dropped rows rather than only counting them', () => {
  // "the counts disagree by 17" was never actionable. Seventeen ids are.
  const db = fresh()
  riskEvent(db, { minsAgo: 60, symbol: 'NAS100' })
  riskEvent(db, { minsAgo: 60, symbol: 'USDZAR' })
  riskEvent(db, { approved: 0, minsAgo: 60 })
  sweepDispositions(db)

  const rep = dispositionReport(db)
  assert.equal(rep.counts.dropped, 2)
  assert.equal(rep.counts.vetoed, 1)
  assert.equal(rep.droppedTotal, 2)
  assert.deepEqual(rep.dropped.map(d => d.symbol).sort(), ['NAS100', 'USDZAR'])
  assert.ok(rep.dropped.every(d => d.id > 0 && d.at))
})

test('approval-to-submit latency is the interval nothing timed before', () => {
  const db = fresh()
  const id = db.prepare(`
    INSERT INTO risk_events (symbol, side, approved, checks_json, proposal_json, created_at)
    VALUES ('EURUSD','BUY',1,'{}','{}','2026-08-04 10:00:00')
  `).run().lastInsertRowid
  recordSubmitted(db, id, '2026-08-04T10:00:02.500Z')
  const rep = dispositionReport(db, { days: 90 })
  assert.equal(rep.latency.n, 1)
  assert.equal(rep.latency.p50, 2500)
})

test('rows still in flight are reported as pending, not as a failure', () => {
  const db = fresh()
  riskEvent(db, { minsAgo: 1 })
  sweepDispositions(db)
  const rep = dispositionReport(db)
  assert.equal(rep.pendingNow, 1)
  assert.equal(rep.counts.dropped, undefined)
})

test('an empty database is a calm empty report', () => {
  const db = fresh()
  const rep = dispositionReport(db)
  assert.deepEqual(rep.counts, {})
  assert.deepEqual(rep.dropped, [])
  assert.equal(rep.latency, null)
})
